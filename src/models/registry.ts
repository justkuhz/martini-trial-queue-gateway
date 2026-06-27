import type { RegisteredModel } from "../domain/model";
import { mockImageFastProvider } from "./adapters/mockImageFast";
import { mockVideoFastFallbackProvider } from "./adapters/mockVideoFastFallback";
import { mockVideoFastPrimaryProvider } from "./adapters/mockVideoFast";

const registry = new Map<string, RegisteredModel>([
  [
    "martini/image-fast",
    {
      modelId: "martini/image-fast",
      requestTimeoutSeconds: 30,
      providers: [mockImageFastProvider],
    },
  ],
  [
    "martini/video-fast",
    {
      modelId: "martini/video-fast",
      requestTimeoutSeconds: 120,
      providers: [mockVideoFastPrimaryProvider, mockVideoFastFallbackProvider],
    },
  ],
]);

export function getModel(modelId: string): RegisteredModel | undefined {
  return registry.get(modelId);
}

