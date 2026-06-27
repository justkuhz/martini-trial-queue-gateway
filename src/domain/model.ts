import type { ZodType } from "zod";

export const MODEL_IDS = ["martini/image-fast", "martini/video-fast"] as const;

export type ModelId = (typeof MODEL_IDS)[number];

export type ModelRunResult = {
  output: Record<string, unknown>;
  inferenceTimeSeconds: number;
};

export type ModelRunContext = {
  requestId: string;
  gatewayRequestId: string;
  signal: AbortSignal;
  log: (message: string) => Promise<void>;
};

export interface ModelProviderAdapter {
  providerId: string;
  run(
    input: Record<string, unknown>,
    context: ModelRunContext,
  ): Promise<ModelRunResult>;
}

export type RegisteredModel = {
  modelId: string;
  requestTimeoutSeconds: number;
  providers: ModelProviderAdapter[];
  inputSchema: ZodType<Record<string, unknown>>;
  outputSchema: ZodType<Record<string, unknown>>;
};
