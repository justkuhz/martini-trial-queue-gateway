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

export class ModelExecutionError extends Error {
  readonly errorType: ErrorType;

  constructor(message: string, errorType: ErrorType) {
    super(message);
    this.name = "ModelExecutionError";
    this.errorType = errorType;
  }
}

export function toExecutionError(
  error: unknown,
): { message: string; errorType: ErrorType; retryable: boolean } {
  if (error instanceof ModelExecutionError) {
    return {
      message: error.message,
      errorType: error.errorType,
      retryable: isRetryableErrorType(error.errorType),
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      errorType: "runner_server_error",
      retryable: true,
    };
  }

  return {
    message: "Unknown error",
    errorType: "internal_error",
    retryable: false,
  };
}
