import type { ModelProviderAdapter, ModelRunResult } from "./base";
import { sleepWithSignal } from "./utils";

export const mockImageFastProvider: ModelProviderAdapter = {
  providerId: "mock-image-primary",
  async run(input, context): Promise<ModelRunResult> {
    const startedAt = Date.now();
    await context.log("Loading model weights...");
    await sleepWithSignal(500, context.signal);
    await context.log("Generating image...");
    await sleepWithSignal(700, context.signal);

    const prompt = String(input.prompt ?? "");
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

