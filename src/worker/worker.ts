import "dotenv/config";

import { Worker } from "bullmq";

import { env } from "../config/env";
import type { QueueJobPayload } from "../domain";
import { getModel } from "../models/registry";
import { finishAttempt, startAttempt } from "../services/attemptService";
import { appendLog } from "../services/logService";
import { getRequest, markCompleted, markInProgress } from "../services/requestService";

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
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      return;
    }

    const { gatewayRequestId, attemptNumber } = await startAttempt({
      requestId,
      modelId,
    });

    await markInProgress(requestId);
    await appendLog(
      requestId,
      `Worker started processing (attempt ${attemptNumber}, ${gatewayRequestId}).`,
    );

    try {
      const result = await model.adapter.run(input);
      for (const logLine of result.logs) {
        await appendLog(requestId, logLine);
      }

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
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        await appendLog(requestId, "Request cancelled before completion.");
        return;
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
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      await appendLog(requestId, "Request completed successfully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await finishAttempt({
        requestId,
        gatewayRequestId,
        status: "failed",
        error: message,
        errorType: "runner_server_error",
      });
      await markCompleted({
        requestId,
        error: message,
        errorType: "runner_server_error",
        internalStatus: "failed",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      await appendLog(requestId, `Request failed: ${message}`);
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

