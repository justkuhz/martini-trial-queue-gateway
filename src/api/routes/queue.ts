import type { FastifyPluginAsync } from "fastify";

import { env } from "../../config/env";
import { getModel } from "../../models/registry";
import { enqueueRequest } from "../../queue/enqueue";
import { getQueuePosition } from "../../queue/position";
import { appendLog, listLogs } from "../../services/logService";
import {
  createRequest,
  getRequest,
  markCancellationRequested,
} from "../../services/requestService";
import { createRequestId } from "../../utils/ids";

type ModelParams = {
  modelOwner: string;
  modelName: string;
};

type RequestParams = ModelParams & {
  requestId: string;
};

function toModelId(params: ModelParams): string {
  return `${params.modelOwner}/${params.modelName}`;
}

function buildRequestUrls(modelId: string, requestId: string) {
  const base = `${env.baseUrl}/v1/queue/${modelId}/requests/${requestId}`;
  return {
    response_url: `${base}/response`,
    status_url: `${base}/status`,
    cancel_url: `${base}/cancel`,
  };
}

export const queueRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: ModelParams; Body: Record<string, unknown> }>(
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
      await createRequest({
        requestId,
        modelId,
        input: request.body ?? {},
      });
      await appendLog(requestId, "Request accepted and queued.");
      await enqueueRequest({
        requestId,
        modelId,
        input: request.body ?? {},
      });

      const queuePosition = await getQueuePosition(requestId);
      return reply.code(202).send({
        request_id: requestId,
        queue_position: queuePosition,
        ...buildRequestUrls(modelId, requestId),
      });
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

      const payload: Record<string, unknown> = {
        status: row.status,
        request_id: row.requestId,
        response_url: buildRequestUrls(modelId, row.requestId).response_url,
      };

      if (request.query.logs === "1") {
        payload.logs = (await listLogs(row.requestId)).map((log) => ({
          message: log.message,
          timestamp: log.timestamp.toISOString(),
        }));
      }

      if (row.status === "IN_QUEUE") {
        payload.queue_position = await getQueuePosition(row.requestId);
      }

      if (row.status === "COMPLETED") {
        payload.metrics = row.inferenceTimeSeconds
          ? { inference_time: row.inferenceTimeSeconds }
          : undefined;
        payload.error = row.error ?? undefined;
        payload.error_type = row.errorType ?? undefined;
      }

      return reply.send(payload);
    },
  );

  app.get<{ Params: RequestParams }>(
    "/v1/queue/:modelOwner/:modelName/requests/:requestId/response",
    async (request, reply) => {
      const modelId = toModelId(request.params);
      const row = await getRequest(request.params.requestId, modelId);
      if (!row) {
        return reply.code(404).send({
          status: "NOT_FOUND",
          request_id: request.params.requestId,
        });
      }

      if (row.status !== "COMPLETED") {
        return reply.code(409).send({
          error: "Response not ready yet.",
          request_id: row.requestId,
          status: row.status,
        });
      }

      if (row.error) {
        return reply.code(422).send({
          error: row.error,
          error_type: row.errorType ?? "internal_error",
          request_id: row.requestId,
        });
      }

      return reply.send(row.outputJson ?? {});
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

      if (row.status === "COMPLETED") {
        return reply.send({
          status: "ALREADY_COMPLETED",
          request_id: row.requestId,
        });
      }

      await markCancellationRequested(row.requestId);
      await appendLog(row.requestId, "Cancellation requested by client.");
      return reply.send({
        status: "CANCELLATION_REQUESTED",
        request_id: row.requestId,
      });
    },
  );
};

