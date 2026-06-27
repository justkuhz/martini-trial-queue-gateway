import "dotenv/config";

import { Queue } from "bullmq";

import { env } from "../config/env";

export type QueueJobPayload = {
  requestId: string;
  modelId: string;
  input: Record<string, unknown>;
};

const queueConnection = {
  url: env.redisUrl,
};

export const requestQueue = new Queue<QueueJobPayload, void, "model-request">(
  env.queueName,
  {
    connection: queueConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 1_000,
    },
    removeOnComplete: 1000,
    removeOnFail: 1000,
    },
  },
);

export async function enqueueRequest(payload: QueueJobPayload): Promise<void> {
  await requestQueue.add("model-request", payload, {
    jobId: payload.requestId,
  });
}

export async function closeQueue(): Promise<void> {
  await requestQueue.close();
}

