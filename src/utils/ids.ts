import { randomUUID } from "crypto";

export function createRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function createGatewayRequestId(): string {
  return `gwreq_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

