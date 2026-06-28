import "dotenv/config";

import { Job, Queue } from "bullmq";

import { env } from "../config/env";
import {
  REQUEST_QUEUE_JOB_NAME,
  type QueueJobPayload,
  type QueuePriority,
} from "../domain";

const queueConnection = {
  url: env.redisUrl,
};

export const DEFAULT_RETRY_ATTEMPTS = 10;

export const requestQueue = new Queue<
  QueueJobPayload,
  void,
  typeof REQUEST_QUEUE_JOB_NAME
>(env.queueName, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: DEFAULT_RETRY_ATTEMPTS,
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

const QUEUE_PRIORITY_VALUE: Record<QueuePriority, number> = {
  normal: 1,
  low: 10,
};

export async function enqueueRequest(
  payload: QueueJobPayload,
  options?: {
    noRetry?: boolean;
    priority?: QueuePriority;
  },
): Promise<void> {
  const jobOptions: {
    jobId: string;
    attempts?: number;
    priority: number;
  } = {
    jobId: payload.requestId,
    priority: options?.priority
      ? QUEUE_PRIORITY_VALUE[options.priority]
      : QUEUE_PRIORITY_VALUE.normal,
  };

  if (options?.noRetry) {
    jobOptions.attempts = 1;
  }

  await requestQueue.add(REQUEST_QUEUE_JOB_NAME, payload, jobOptions);
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

export async function checkQueueConnectivity(): Promise<void> {
  await requestQueue.getJobCounts("waiting");
}

export async function closeQueue(): Promise<void> {
  await requestQueue.close();
}

