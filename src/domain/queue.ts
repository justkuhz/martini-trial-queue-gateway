export const REQUEST_QUEUE_JOB_NAME = "model-request" as const;

export type QueueJobPayload = {
  requestId: string;
  modelId: string;
  input: Record<string, unknown>;
  startTimeoutSeconds?: number;
};

export type QueuePriority = "normal" | "low";
