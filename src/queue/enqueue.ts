import "dotenv/config";

import { Job, Queue } from "bullmq";

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
    attempts: 10,
    backoff: {
      type: "exponential",
      delay: 1_000,
    },
    removeOnComplete: {
      age: 60 * 60,
      count: 1000,
    },
    removeOnFail: {
      age: 3 * 24 * 60 * 60,
      count: 5000,
    },
  },
});

export async function enqueueRequest(payload: QueueJobPayload): Promise<void> {
  await requestQueue.add(REQUEST_QUEUE_JOB_NAME, payload, {
    jobId: payload.requestId,
  });
}

async function getRequestJob(
  requestId: string,
): Promise<Job<QueueJobPayload, void, typeof REQUEST_QUEUE_JOB_NAME> | undefined> {
  const job = await requestQueue.getJob(requestId);
  return job ?? undefined;
}

export async function removeQueuedRequestJob(requestId: string): Promise<boolean> {
  const job = await getRequestJob(requestId);
  if (!job) {
    return false;
  }

  const state = await job.getState();
  if (state === "waiting" || state === "delayed" || state === "prioritized") {
    await job.remove();
    return true;
  }

  return false;
}

export async function hasActiveRequestJob(requestId: string): Promise<boolean> {
  const job = await getRequestJob(requestId);
  if (!job) {
    return false;
  }

  const state = await job.getState();
  return state === "active";
}

export async function cleanupQueueHistory(): Promise<{
  completedRemoved: number;
  failedRemoved: number;
}> {
  const completedRemoved = (
    await requestQueue.clean(60 * 60 * 1000, 5000, "completed")
  ).length;
  const failedRemoved = (
    await requestQueue.clean(3 * 24 * 60 * 60 * 1000, 5000, "failed")
  ).length;

  return {
    completedRemoved,
    failedRemoved,
  };
}

export async function closeQueue(): Promise<void> {
  await requestQueue.close();
}

