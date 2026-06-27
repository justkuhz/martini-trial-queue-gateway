export const ERROR_TYPES = [
  "runner_server_error",
  "runner_connection_error",
  "timeout",
  "bad_request",
  "internal_error",
  "client_cancelled",
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

const RETRYABLE_ERROR_TYPE_SET: ReadonlySet<ErrorType> = new Set([
  "runner_server_error",
  "runner_connection_error",
  "timeout",
]);

export function isRetryableErrorType(errorType: ErrorType): boolean {
  return RETRYABLE_ERROR_TYPE_SET.has(errorType);
}
