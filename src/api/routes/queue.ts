import type { FastifyPluginAsync } from "fastify";

import { env } from "../../config/env";
import type {
  RequestCancelResponse,
  RequestStatusResponse,
  SubmitRequestResponse,
} from "../../domain";
import { buildRequestUrls, toPublicStatus } from "../../domain";
import { getModel } from "../../models/registry";
import {
  enqueueRequest,
  hasActiveRequestJob,
  removeQueuedRequestJob,
} from "../../queue/enqueue";
import { getQueuePosition } from "../../queue/position";
import { appendLog } from "../../services/logService";
import {
  createRequest,
  getRequest,
  markCompletedIfNotCompleted,
  markCancellationRequested,
} from "../../services/requestService";
import { buildRequestStatusPayload } from "../../services/statusService";
import { createRequestId } from "../../utils/ids";

type ModelParams = {
  modelOwner: string;
  modelName: string;
};

type RequestParams = ModelParams & {
  requestId: string;
};

const LOCAL_TEST_API_KEY = "test_key";

function toModelId(params: ModelParams): string {
  return `${params.modelOwner}/${params.modelName}`;
}

export const queueRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const expectedHeader = `Key ${LOCAL_TEST_API_KEY}`;

    if (authHeader !== expectedHeader) {
      return reply.code(401).send({
        error: "Unauthorized",
        error_type: "authentication_error",
        detail: `Expected Authorization header format: ${expectedHeader}`,
      });
    }
  });

  app.post<{
    Params: ModelParams;
    Body: Record<string, unknown>;
    Querystring: { fal_webhook?: string };
  }>(
    "/v1/queue/:modelOwner/:modelName",
    async (request, reply) => {
      const modelId = toModelId(request.params);
      const model = getModel(modelId);
      if (!model) {
        return reply.code(404).send({
          error: "Unknown model_id",
        });
      }

      const requestId = createRequestId();
      let webhookUrl: string | undefined;
      if (request.query.fal_webhook) {
        try {
          webhookUrl = new URL(request.query.fal_webhook).toString();
        } catch {
          return reply.code(400).send({
            error: "Invalid fal_webhook URL.",
            error_type: "bad_request",
          });
        }
      }

      const parsedInput = model.inputSchema.safeParse(request.body ?? {});
      if (!parsedInput.success) {
        return reply.code(400).send({
          error: "Invalid request body.",
          error_type: "bad_request",
          details: parsedInput.error.flatten(),
        });
      }

      await createRequest({
        requestId,
        modelId,
        input: parsedInput.data,
        webhookUrl,
      });
      await appendLog(requestId, "Request accepted and queued.");
      await enqueueRequest({
        requestId,
        modelId,
        input: parsedInput.data,
      });

      const queuePosition = await getQueuePosition(requestId);
      const response: SubmitRequestResponse = {
        request_id: requestId,
        queue_position: queuePosition,
        ...buildRequestUrls(env.baseUrl, modelId, requestId),
      };
      return reply.code(202).send(response);
    },
  );

  app.get<{ Params: RequestParams; Querystring: { logs?: string } }>(
    "/v1/queue/:modelOwner/:modelName/requests/:requestId/status",
    async (request, reply) => {
      const modelId = toModelId(request.params);
      const row = await getRequest(request.params.requestId, modelId);
      if (!row) {
        return reply.code(404).send({
          status: "NOT_FOUND",
          request_id: request.params.requestId,
        });
      }

      const payload = await buildRequestStatusPayload({
        row,
        modelId,
        baseUrl: env.baseUrl,
        includeLogs: request.query.logs === "1",
      });

      return reply.send(payload);
    },
  );

  app.get<{ Params: RequestParams; Querystring: { logs?: string } }>(
    "/v1/queue/:modelOwner/:modelName/requests/:requestId/status/stream",
    async (request, reply) => {
      const modelId = toModelId(request.params);
      const model = getModel(modelId);
      if (!model) {
        return reply.code(404).send({
          error: "Unknown model_id",
        });
      }

      const initialRow = await getRequest(request.params.requestId, modelId);
      if (!initialRow) {
        return reply.code(404).send({
          status: "NOT_FOUND",
          request_id: request.params.requestId,
        });
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      let closed = false;
      let inFlight = false;

      const writeStatusEvent = async (): Promise<void> => {
        if (closed || inFlight) {
          return;
        }
        inFlight = true;

        try {
          const row = await getRequest(request.params.requestId, modelId);
          if (!row) {
            reply.raw.write(
              `event: error\ndata: ${JSON.stringify({
                status: "NOT_FOUND",
                request_id: request.params.requestId,
              })}\n\n`,
            );
            closed = true;
            clearInterval(intervalId);
            reply.raw.end();
            return;
          }

          const payload = await buildRequestStatusPayload({
            row,
            modelId,
            baseUrl: env.baseUrl,
            includeLogs: request.query.logs === "1",
          });

          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          if (payload.status === "COMPLETED") {
            closed = true;
            clearInterval(intervalId);
            reply.raw.end();
          }
        } finally {
          inFlight = false;
        }
      };

      const intervalId = setInterval(() => {
        void writeStatusEvent();
      }, 1000);

      request.raw.on("close", () => {
        closed = true;
        clearInterval(intervalId);
      });

      await writeStatusEvent();
      return reply;
    },
  );

  app.get<{ Params: RequestParams }>(
    "/v1/queue/:modelOwner/:modelName/requests/:requestId/response",
    async (request, reply) => {
      const modelId = toModelId(request.params);
      const model = getModel(modelId);
      if (!model) {
        return reply.code(404).send({
          error: "Unknown model_id",
        });
      }

      const row = await getRequest(request.params.requestId, modelId);
      if (!row) {
        return reply.code(404).send({
          status: "NOT_FOUND",
          request_id: request.params.requestId,
        });
      }

      const publicStatus = toPublicStatus(row.internalStatus);
      if (publicStatus !== "COMPLETED") {
        return reply.code(409).send({
          error: "Response not ready yet.",
          request_id: row.requestId,
          status: publicStatus,
        });
      }

      if (row.error) {
        return reply.code(422).send({
          error: row.error,
          error_type: row.errorType ?? "internal_error",
          request_id: row.requestId,
        });
      }

      const parsedOutput = model.outputSchema.safeParse(row.outputJson ?? {});
      if (!parsedOutput.success) {
        return reply.code(500).send({
          error: "Stored response payload failed model output validation.",
          error_type: "internal_error",
          request_id: row.requestId,
        });
      }

      return reply.send(parsedOutput.data);
    },
  );

  app.put<{ Params: RequestParams }>(
    "/v1/queue/:modelOwner/:modelName/requests/:requestId/cancel",
    async (request, reply) => {
      const modelId = toModelId(request.params);
      const row = await getRequest(request.params.requestId, modelId);
      if (!row) {
        return reply.code(404).send({
          status: "NOT_FOUND",
          request_id: request.params.requestId,
        });
      }

      const publicStatus = toPublicStatus(row.internalStatus);
      if (publicStatus === "COMPLETED") {
        return reply.send({
          status: "ALREADY_COMPLETED",
          request_id: row.requestId,
        });
      }

      await markCancellationRequested(row.requestId);

      const removedQueuedJob = await removeQueuedRequestJob(row.requestId);
      if (removedQueuedJob) {
        await markCompletedIfNotCompleted({
          requestId: row.requestId,
          error: "Request was cancelled by the client.",
          errorType: "client_cancelled",
          internalStatus: "cancelled",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        await appendLog(row.requestId, "Queued request cancelled before execution.");
      } else if (await hasActiveRequestJob(row.requestId)) {
        await appendLog(
          row.requestId,
          "Cancellation requested while request is in progress.",
        );
      } else {
        await appendLog(
          row.requestId,
          "Cancellation requested; worker will honor on next check.",
        );
      }

      const response: RequestCancelResponse = {
        status: "CANCELLATION_REQUESTED",
        request_id: row.requestId,
      };
      return reply.send(response);
    },
  );
};

