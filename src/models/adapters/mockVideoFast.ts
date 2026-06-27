import type { ModelProviderAdapter, ModelRunResult } from "./base";
import { ModelExecutionError } from "../../domain";
import { sleepWithSignal } from "./utils";

const forcedRetryOnceTracker = new Set<string>();

export const mockVideoFastPrimaryProvider: ModelProviderAdapter = {
  providerId: "mock-video-primary",
  async run(input, context): Promise<ModelRunResult> {
    const startedAt = Date.now();
    await context.log("Loading video model...");
    await sleepWithSignal(600, context.signal);
    await context.log("Rendering frames...");
    await sleepWithSignal(1200, context.signal);

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

    // Intentionally fail sometimes to exercise retry behavior.
    if (Math.random() < 0.25) {
      throw new ModelExecutionError(
        "Primary video provider temporary failure.",
        "runner_server_error",
      );
    }

    const seed = Number(input.seed ?? 42);

    return {
      inferenceTimeSeconds: (Date.now() - startedAt) / 1000,
      output: {
        video: {
          url: "https://example.com/fake-video.mp4",
          content_type: "video/mp4",
          file_name: "fake-video.mp4",
        },
        prompt,
        seed,
      },
    };
  },
};

