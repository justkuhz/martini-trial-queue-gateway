export const MODEL_IDS = ["martini/image-fast", "martini/video-fast"] as const;

export type ModelId = (typeof MODEL_IDS)[number];

export type ModelRunResult = {
  output: Record<string, unknown>;
  logs: string[];
  inferenceTimeSeconds: number;
};

export interface ModelAdapter {
  run(input: Record<string, unknown>): Promise<ModelRunResult>;
}

export type RegisteredModel = {
  modelId: string;
  requestTimeoutSeconds: number;
  adapter: ModelAdapter;
};
