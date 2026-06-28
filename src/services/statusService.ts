import type { RequestStatusResponse } from "../domain";
import { buildRequestUrls, toPublicStatus } from "../domain";
import { getQueuePosition } from "../queue/position";
import { listLogs } from "./logService";

type StatusRow = {
  requestId: string;
  internalStatus: "queued" | "running" | "succeeded" | "failed" | "timeout" | "cancelled";
  inferenceTimeSeconds: number | null;
  error: string | null;
  errorType:
    | "runner_server_error"
    | "runner_connection_error"
    | "timeout"
    | "bad_request"
    | "internal_error"
    | "client_cancelled"
    | null;
};

/**
 * Builds the public status response for a request: always status + request_id +
 * response_url, with logs attached only when requested, a live queue_position
 * while IN_QUEUE, and metrics / error fields once COMPLETED.
 */
export async function buildRequestStatusPayload(params: {
  row: StatusRow;
  modelId: string;
  baseUrl: string;
  includeLogs: boolean;
}): Promise<RequestStatusResponse> {
  const publicStatus = toPublicStatus(params.row.internalStatus);
  const payload: RequestStatusResponse = {
    status: publicStatus,
    request_id: params.row.requestId,
    response_url: buildRequestUrls(params.baseUrl, params.modelId, params.row.requestId)
      .response_url,
  };

  if (params.includeLogs) {
    payload.logs = (await listLogs(params.row.requestId)).map((log) => ({
      message: log.message,
      timestamp: log.timestamp.toISOString(),
    }));
  }

  if (publicStatus === "IN_QUEUE") {
    payload.queue_position = await getQueuePosition(params.row.requestId);
  }

  if (publicStatus === "COMPLETED") {
    payload.metrics =
      params.row.inferenceTimeSeconds != null
        ? { inference_time: params.row.inferenceTimeSeconds }
        : undefined;
    payload.error = params.row.error ?? undefined;
    payload.error_type = params.row.errorType ?? undefined;
  }

  return payload;
}
