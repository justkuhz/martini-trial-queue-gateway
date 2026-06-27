import type { ModelProviderAdapter, ModelRunResult } from "./base";
import { sleepWithSignal } from "./utils";

export const mockVideoFastFallbackProvider: ModelProviderAdapter = {
  providerId: "mock-video-fallback",
  async run(input, context): Promise<ModelRunResult> {
    const startedAt = Date.now();
    await context.log("Falling back to backup video provider...");
    await sleepWithSignal(800, context.signal);
    await context.log("Backup provider rendering frames...");
    await sleepWithSignal(1300, context.signal);

    const prompt = String(input.prompt ?? "");
    const seed = Number(input.seed ?? 42);

    return {
      inferenceTimeSeconds: (Date.now() - startedAt) / 1000,
      output: {
        video: {
          url: "https://example.com/fake-video-fallback.mp4",
          content_type: "video/mp4",
          file_name: "fake-video-fallback.mp4",
        },
        prompt,
        seed,
      },
    };
  },
};
