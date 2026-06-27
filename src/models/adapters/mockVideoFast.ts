import type { ModelAdapter, ModelRunResult } from "./base";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const mockVideoFastAdapter: ModelAdapter = {
  async run(input: Record<string, unknown>): Promise<ModelRunResult> {
    const startedAt = Date.now();
    await sleep(1800);

    const prompt = String(input.prompt ?? "");
    const seed = Number(input.seed ?? 42);

    return {
      logs: ["Loading video model...", "Rendering frames...", "Done."],
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

