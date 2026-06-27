export const PUBLIC_REQUEST_STATUSES = [
  "IN_QUEUE",
  "IN_PROGRESS",
  "COMPLETED",
] as const;

export type PublicRequestStatus = (typeof PUBLIC_REQUEST_STATUSES)[number];

export const INTERNAL_REQUEST_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
] as const;

export type InternalRequestStatus = (typeof INTERNAL_REQUEST_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  "started",
  "succeeded",
  "failed",
  "timeout",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
