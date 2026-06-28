import "dotenv/config";

import { UnrecoverableError, Worker } from "bullmq";

import { env } from "../config/env";
import type { ModelRunContext, QueueJobPayload } from "../domain";
import { toExecutionError } from "../domain";
import { executeModelWithProviders } from "../models/executeModel";
import { getModel } from "../models/registry";
import { DEFAULT_RETRY_ATTEMPTS } from "../queue/enqueue";
import { finishAttempt, startAttempt } from "../services/attemptService";
import { appendLog } from "../services/logService";
import { runRetentionCycle } from "../services/retentionService";
import {
  getRequest,
  markCompletedIfNotCompleted,
  markInProgressIfNotCompleted,
} from "../services/requestService";
import { sendCompletionWebhook } from "../services/webhookService";

const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RUNNING_SECONDS_BEFORE_RECONCILE = 10 * 60;

async function deliverCompletionWebhook(params: {
  requestId: string;
  gatewayRequestId: string;
  output?: Record<string, unknown>;
  error?: string;
  errorType?:
    | "runner_server_error"
    | "runner_connection_error"
    | "timeout"
    | "bad_request"
    | "internal_error"
    | "client_cancelled";
}): Promise<void> {
  const result = await sendCompletionWebhook(params);
  if (result.reason === "delivered") {
    await appendLog(params.requestId, "Completion webhook delivered.");
  } else if (result.reason === "delivery_failed") {
    await appendLog(
      params.requestId,
      `Completion webhook delivery failed: ${result.error ?? "unknown error"}`,
    );
  }
}

const worker = new Worker<QueueJobPayload>(
  env.queueName,
  async (job) => {
    const { requestId, modelId, input, startTimeoutSeconds } = job.data;
    const existingRequest = await getRequest(requestId, modelId);
    if (!existingRequest) {
      throw new UnrecoverableError(`Missing request row: ${requestId}`);
    }
    if (existingRequest.status === "COMPLETED") {
      throw new UnrecoverableError(`Request already terminal: ${requestId}`);
    }

    const model = getModel(modelId);
    if (!model) {
      await markCompletedIfNotCompleted({
        requestId,
        error: `Unknown model: ${modelId}`,
        errorType: "bad_request",
        internalStatus: "failed",
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      });
      const fallbackGatewayRequestId = existingRequest.latestGatewayRequestId ?? "gwreq_unknown";
      await deliverCompletionWebhook({
        requestId,
        gatewayRequestId: fallbackGatewayRequestId,
        error: `Unknown model: ${modelId}`,
        errorType: "bad_request",
      });
      throw new UnrecoverableError(`Unknown model: ${modelId}`);
    }
    if (existingRequest?.cancellationRequested) {
      await markCompletedIfNotCompleted({
        requestId,
        error: "Request was cancelled by the client.",
        errorType: "client_cancelled",
        internalStatus: "cancelled",
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      });
      await appendLog(requestId, "Request cancelled before processing started.");
      const fallbackGatewayRequestId = existingRequest.latestGatewayRequestId ?? "gwreq_unknown";
      await deliverCompletionWebhook({
        requestId,
        gatewayRequestId: fallbackGatewayRequestId,
        error: "Request was cancelled by the client.",
        errorType: "client_cancelled",
      });
      throw new UnrecoverableError("Request cancelled before processing.");
    }

    if (startTimeoutSeconds) {
      const queueWaitMs = Date.now() - existingRequest.createdAt.getTime();
      if (queueWaitMs > startTimeoutSeconds * 1000) {
        await markCompletedIfNotCompleted({
          requestId,
          error: "Request timed out before starting execution.",
          errorType: "timeout",
          internalStatus: "timeout",
          expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
        });
        await appendLog(
          requestId,
          `Request start timeout exceeded (${startTimeoutSeconds}s) while waiting in queue.`,
        );
        const fallbackGatewayRequestId = existingRequest.latestGatewayRequestId ?? "gwreq_unknown";
        await deliverCompletionWebhook({
          requestId,
          gatewayRequestId: fallbackGatewayRequestId,
          error: "Request timed out before starting execution.",
          errorType: "timeout",
        });
        throw new UnrecoverableError("Start timeout exceeded before processing.");
      }
    }

    // Conditional transition protects lifecycle integrity if BullMQ redelivers after crash.
    const movedToInProgress = await markInProgressIfNotCompleted(requestId);
    if (!movedToInProgress) {
      throw new UnrecoverableError(`Request already completed: ${requestId}`);
    }

    const { gatewayRequestId, attemptNumber } = await startAttempt({
      requestId,
      modelId,
    });

    await appendLog(
      requestId,
      `Worker started processing (attempt ${attemptNumber}, ${gatewayRequestId}).`,
    );

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, model.requestTimeoutSeconds * 1000);

    try {
      const runContext: ModelRunContext = {
        requestId,
        gatewayRequestId,
        signal: abortController.signal,
        log: async (message: string) => {
          await appendLog(requestId, message);
        },
      };
      const result = await executeModelWithProviders(model, input, runContext);
      clearTimeout(timeoutHandle);
      await appendLog(requestId, "Done.");

      const currentRow = await getRequest(requestId, modelId);
      if (currentRow?.cancellationRequested) {
        await finishAttempt({
          requestId,
          gatewayRequestId,
          status: "failed",
          error: "Request was cancelled by the client.",
          errorType: "client_cancelled",
        });
        await markCompletedIfNotCompleted({
          requestId,
          error: "Request was cancelled by the client.",
          errorType: "client_cancelled",
          internalStatus: "cancelled",
          inferenceTimeSeconds: result.inferenceTimeSeconds,
          expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
        });
        await appendLog(requestId, "Request cancelled before completion.");
        throw new UnrecoverableError("Request cancelled by client.");
      }

      await finishAttempt({
        requestId,
        gatewayRequestId,
        status: "succeeded",
      });
      await markCompletedIfNotCompleted({
        requestId,
        output: result.output,
        internalStatus: "succeeded",
        inferenceTimeSeconds: result.inferenceTimeSeconds,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      });
      await appendLog(requestId, "Request completed successfully.");
      await deliverCompletionWebhook({
        requestId,
        gatewayRequestId,
        output: result.output,
      });
    } catch (error) {
      clearTimeout(timeoutHandle);
      if (error instanceof UnrecoverableError) {
        throw error;
      }

      const normalizedError = toExecutionError(error);
      await finishAttempt({
        requestId,
        gatewayRequestId,
        status: normalizedError.errorType === "timeout" ? "timeout" : "failed",
        error: normalizedError.message,
        errorType: normalizedError.errorType,
      });

      const maxAttempts = job.opts.attempts ?? DEFAULT_RETRY_ATTEMPTS;
      const attemptsUsed = job.attemptsMade + 1;
      const hasRetryRemaining = normalizedError.retryable && attemptsUsed < maxAttempts;

      if (hasRetryRemaining) {
        await appendLog(
          requestId,
          `Attempt ${attemptNumber} failed (${normalizedError.errorType}). Retrying (${attemptsUsed}/${maxAttempts}).`,
        );
        throw error instanceof Error
          ? error
          : new Error(normalizedError.message);
      }

      // Conditional completion keeps terminal writes idempotent across retries.
      await markCompletedIfNotCompleted({
        requestId,
        error: normalizedError.message,
        errorType: normalizedError.errorType,
        internalStatus: normalizedError.errorType === "timeout" ? "timeout" : "failed",
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      });
      await appendLog(requestId, `Request failed: ${normalizedError.message}`);
      await deliverCompletionWebhook({
        requestId,
        gatewayRequestId,
        error: normalizedError.message,
        errorType: normalizedError.errorType,
      });

      throw new UnrecoverableError(normalizedError.message);
    }
  },
  {
    connection: {
      url: env.redisUrl,
    },
    concurrency: 2,
  },
);

worker.on("ready", () => {
  // eslint-disable-next-line no-console
  console.log(`Worker listening on queue "${env.queueName}"`);
});

worker.on("failed", (job, error) => {
  // eslint-disable-next-line no-console
  console.error(`Job ${job?.id ?? "unknown"} failed`, error);
});

// Periodic retention keeps DB/Redis lean without impacting request flow.
const retentionTimer = setInterval(() => {
  void runRetentionCycle({
    maxRunningSeconds: MAX_RUNNING_SECONDS_BEFORE_RECONCILE,
    requestTtlMs: REQUEST_TTL_MS,
  }).then((summary) => {
    // Only emit logs when work was actually done to reduce noise.
    if (
      summary.expiredRequestsRemoved > 0 ||
      summary.stuckRunningReconciled > 0 ||
      summary.queueCompletedRemoved > 0 ||
      summary.queueFailedRemoved > 0
    ) {
      // eslint-disable-next-line no-console
      console.log("Retention cycle summary", summary);
    }
  });
}, RETENTION_INTERVAL_MS);
retentionTimer.unref();

process.on("SIGINT", async () => {
  clearInterval(retentionTimer);
  await worker.close();
  process.exit(0);
});

