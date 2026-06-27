import type { ErrorType } from "./errors";
import type { PublicRequestStatus } from "./status";
import type { RequestUrls } from "./url";

export type RequestLogDto = {
  message: string;
  timestamp: string;
};

export type SubmitRequestResponse = {
  request_id: string;
  queue_position: number;
} & RequestUrls;

export type RequestStatusResponse = {
  status: PublicRequestStatus;
  request_id: string;
  response_url: string;
  queue_position?: number;
  logs?: RequestLogDto[];
  metrics?: {
    inference_time: number;
  };
  error?: string;
  error_type?: ErrorType;
};

export type RequestCancelResponse =
  | {
      status: "CANCELLATION_REQUESTED";
      request_id: string;
    }
  | {
      status: "ALREADY_COMPLETED";
      request_id: string;
    }
  | {
      status: "NOT_FOUND";
      request_id: string;
    };
