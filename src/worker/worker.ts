import "dotenv/config";

import { UnrecoverableError, Worker } from "bullmq";

import { env } from "../config/env";
import type { ModelRunContext, QueueJobPayload } from "../domain";
import { toExecutionError } from "../domain";
import { executeModelWithProviders } from "../models/executeModel";
import { getModel } from "../models/registry";
import { finishAttempt, startAttempt } from "../services/attemptService";
import { appendLog } from "../services/logService";
import { getRequest, markCompleted, markInProgress } from "../services/requestService";

const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const worker = new Worker<QueueJobPayload>(
  env.queueName,
  async (job) => {
    const { requestId, modelId, input } = job.data;
    const model = getModel(modelId);
    if (!model) {
      await markCompleted({
        requestId,
        error: `Unknown model: ${modelId}`,
        errorType: "bad_request",
        internalStatus: "failed",
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      });
      throw new UnrecoverableError(`Unknown model: ${modelId}`);
    }

    const { gatewayRequestId, attemptNumber } = await startAttempt({
      requestId,
      modelId,
    });

    const existingRequest = await getRequest(requestId, modelId);
    if (existingRequest?.cancellationRequested) {
      await finishAttempt({
        requestId,
        gatewayRequestId,
        status: "failed",
        error: "Request was cancelled by the client.",
        errorType: "client_cancelled",
      });
      await markCompleted({
        requestId,
        error: "Request was cancelled by the client.",
        errorType: "client_cancelled",
        internalStatus: "cancelled",
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      });
      await appendLog(requestId, "Request cancelled before processing started.");
      throw new UnrecoverableError("Request cancelled before processing.");
    }

    await markInProgress(requestId);
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
        await markCompleted({
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
      await markCompleted({
        requestId,
        output: result.output,
        internalStatus: "succeeded",
        inferenceTimeSeconds: result.inferenceTimeSeconds,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      });
      await appendLog(requestId, "Request completed successfully.");
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

      const maxAttempts = job.opts.attempts ?? 1;
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

      await markCompleted({
        requestId,
        error: normalizedError.message,
        errorType: normalizedError.errorType,
        internalStatus: normalizedError.errorType === "timeout" ? "timeout" : "failed",
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      });
      await appendLog(requestId, `Request failed: ${normalizedError.message}`);

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

process.on("SIGINT", async () => {
  await worker.close();
  process.exit(0);
});

