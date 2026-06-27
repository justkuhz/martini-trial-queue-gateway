import type { ModelAdapter, ModelRunResult } from "./base";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const mockImageFastAdapter: ModelAdapter = {
  async run(input: Record<string, unknown>): Promise<ModelRunResult> {
    const startedAt = Date.now();
    await sleep(1200);

    const prompt = String(input.prompt ?? "");
    const seed = Number(input.seed ?? 42);

    return {
      logs: ["Loading model weights...", "Generating image...", "Done."],
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

