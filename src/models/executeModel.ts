import {
  ModelExecutionError,
  isRetryableErrorType,
  toExecutionError,
  type ModelRunContext,
  type ModelRunResult,
  type RegisteredModel,
} from "../domain";

/**
 * Runs a model's providers in order (primary first, then fallbacks), advancing
 * to the next only on a retryable error and when fallback is enabled. A
 * non-retryable error, the last provider, or `disableFallback` stops the chain
 * and rethrows the failure to the worker.
 */
export async function executeModelWithProviders(
  model: RegisteredModel,
  input: Record<string, unknown>,
  context: ModelRunContext,
  options?: {
    disableFallback?: boolean;
  },
): Promise<ModelRunResult> {
  let lastError: unknown;

  for (let index = 0; index < model.providers.length; index += 1) {
    const provider = model.providers[index];
    try {
      await context.log(`Using provider: ${provider.providerId}`);
      return await provider.run(input, context);
    } catch (error) {
      lastError = error;
      const normalized = toExecutionError(error);
      await context.log(
        `Provider ${provider.providerId} failed (${normalized.errorType}).`,
      );

      const isLastProvider =
        options?.disableFallback || index === model.providers.length - 1;
      if (isLastProvider || !isRetryableErrorType(normalized.errorType)) {
        throw error;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new ModelExecutionError(
    "All model providers failed.",
    "runner_server_error",
  );
}
