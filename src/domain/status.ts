// Public statuses are the only ones the API exposes. Internal statuses carry
// richer detail (succeeded / failed / timeout / cancelled) and are mapped down
// via toPublicStatus(), so internal state never leaks to clients.
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

export function toPublicStatus(
  internalStatus: InternalRequestStatus,
): PublicRequestStatus {
  if (internalStatus === "queued") {
    return "IN_QUEUE";
  }
  if (internalStatus === "running") {
    return "IN_PROGRESS";
  }

  return "COMPLETED";
}
