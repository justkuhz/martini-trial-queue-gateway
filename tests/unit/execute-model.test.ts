import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { ModelExecutionError } from "../../src/domain";
import type { ModelProviderAdapter, ModelRunContext } from "../../src/models/adapters/base";
import { executeModelWithProviders } from "../../src/models/executeModel";

const genericSchema = z.record(z.string(), z.unknown());

function createContext(): ModelRunContext {
  return {
    requestId: "req_unit_test",
    gatewayRequestId: "gwreq_unit_test",
    signal: new AbortController().signal,
    log: async () => {},
  };
}

test("executeModelWithProviders falls back on retryable provider error", async () => {
  const providers: ModelProviderAdapter[] = [
    {
      providerId: "primary",
      run: async () => {
        throw new ModelExecutionError(
          "temporary provider issue",
          "runner_server_error",
        );
      },
    },
    {
      providerId: "fallback",
      run: async () => ({
        output: { ok: true, provider: "fallback" },
        inferenceTimeSeconds: 0.1,
      }),
    },
  ];

  const result = await executeModelWithProviders(
    {
      modelId: "martini/video-fast",
      requestTimeoutSeconds: 120,
      providers,
      inputSchema: genericSchema,
      outputSchema: genericSchema,
    },
    { prompt: "unit test" },
    createContext(),
  );

  assert.equal(result.output.provider, "fallback");
});

test("executeModelWithProviders does not fallback on non-retryable error", async () => {
  const providers: ModelProviderAdapter[] = [
    {
      providerId: "primary",
      run: async () => {
        throw new ModelExecutionError("bad input", "bad_request");
      },
    },
    {
      providerId: "fallback",
      run: async () => ({
        output: { ok: true, provider: "fallback" },
        inferenceTimeSeconds: 0.1,
      }),
    },
  ];

  await assert.rejects(
    () =>
      executeModelWithProviders(
        {
          modelId: "martini/video-fast",
          requestTimeoutSeconds: 120,
          providers,
          inputSchema: genericSchema,
          outputSchema: genericSchema,
        },
        { prompt: "unit test" },
        createContext(),
      ),
    /bad input/,
  );
});
