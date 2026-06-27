import "dotenv/config";

import { Queue } from "bullmq";

import { env } from "../config/env";
import { REQUEST_QUEUE_JOB_NAME, type QueueJobPayload } from "../domain";

const queueConnection = {
  url: env.redisUrl,
};

export const requestQueue = new Queue<
  QueueJobPayload,
  void,
  typeof REQUEST_QUEUE_JOB_NAME
>(env.queueName, {
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
});

export async function enqueueRequest(payload: QueueJobPayload): Promise<void> {
  await requestQueue.add(REQUEST_QUEUE_JOB_NAME, payload, {
    jobId: payload.requestId,
  });
}

export async function closeQueue(): Promise<void> {
  await requestQueue.close();
}

