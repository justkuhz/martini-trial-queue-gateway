import type { RegisteredModel } from "../domain/model";
import { mockImageFastAdapter } from "./adapters/mockImageFast";
import { mockVideoFastAdapter } from "./adapters/mockVideoFast";

const registry = new Map<string, RegisteredModel>([
  [
    "martini/image-fast",
    {
      modelId: "martini/image-fast",
      requestTimeoutSeconds: 30,
      adapter: mockImageFastAdapter,
    },
  ],
  [
    "martini/video-fast",
    {
      modelId: "martini/video-fast",
      requestTimeoutSeconds: 120,
      adapter: mockVideoFastAdapter,
    },
  ],
]);

export function getModel(modelId: string): RegisteredModel | undefined {
  return registry.get(modelId);
}

