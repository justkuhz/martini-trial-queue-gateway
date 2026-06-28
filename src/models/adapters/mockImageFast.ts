import type { ModelProviderAdapter, ModelRunResult } from "./base";
import { ModelExecutionError } from "../../domain";
import { sleepWithSignal } from "./utils";

const forcedRetryOnceTracker = new Set<string>();

export const mockImageFastProvider: ModelProviderAdapter = {
  providerId: "mock-image-primary",
  async run(input, context): Promise<ModelRunResult> {
    const startedAt = Date.now();
    await context.log("Loading model weights...");
    await sleepWithSignal(500, context.signal);
    await context.log("Generating image...");
    await sleepWithSignal(700, context.signal);

    const prompt = String(input.prompt ?? "");
    if (
      prompt.includes("__force_retry_once") &&
      !forcedRetryOnceTracker.has(context.requestId)
    ) {
      forcedRetryOnceTracker.add(context.requestId);
      throw new ModelExecutionError(
        "Forced one-time retryable error for testing.",
        "runner_server_error",
      );
    }
    if (prompt.includes("__force_bad_request")) {
      throw new ModelExecutionError(
        "Forced bad request error for testing.",
        "bad_request",
      );
    }

    const seed = Number(input.seed ?? 42);

    return {
      inferenceTimeSeconds: (Date.now() - startedAt) / 1000,
      output: {
        images: [
          {
            url: "https://example.com/fake-image.png",
            width: 1024,
            height: 1024,
            content_type: "image/png",
          },
        ],
        prompt,
        seed,
      },
    };
  },
};

