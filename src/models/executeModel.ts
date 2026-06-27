import {
  ModelExecutionError,
  isRetryableErrorType,
  toExecutionError,
  type ModelRunContext,
  type ModelRunResult,
  type RegisteredModel,
} from "../domain";

export async function executeModelWithProviders(
  model: RegisteredModel,
  input: Record<string, unknown>,
  context: ModelRunContext,
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

      const isLastProvider = index === model.providers.length - 1;
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
