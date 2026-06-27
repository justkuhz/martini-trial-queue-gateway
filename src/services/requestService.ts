import { and, eq, ne } from "drizzle-orm";

import { db } from "../db/client";
import { requests } from "../db/schema";
import type { ErrorType, InternalRequestStatus } from "../domain";

export async function createRequest(params: {
  requestId: string;
  modelId: string;
  input: Record<string, unknown>;
}): Promise<void> {
  await db.insert(requests).values({
    requestId: params.requestId,
    modelId: params.modelId,
    status: "IN_QUEUE",
    internalStatus: "queued",
    inputJson: params.input,
  });
}

export async function getRequest(requestId: string, modelId: string) {
  const rows = await db
    .select()
    .from(requests)
    .where(and(eq(requests.requestId, requestId), eq(requests.modelId, modelId)))
    .limit(1);
  return rows[0];
}

export async function markCancellationRequested(
  requestId: string,
): Promise<void> {
  await db
    .update(requests)
    .set({ cancellationRequested: true })
    .where(eq(requests.requestId, requestId));
}

export async function markInProgress(requestId: string): Promise<void> {
  await db
    .update(requests)
    .set({
      status: "IN_PROGRESS",
      internalStatus: "running",
      startedAt: new Date(),
    })
    .where(eq(requests.requestId, requestId));
}

export async function markInProgressIfNotCompleted(
  requestId: string,
): Promise<boolean> {
  // Guard transition so a recovered/duplicate worker cannot reopen terminal requests.
  const updatedRows = await db
    .update(requests)
    .set({
      status: "IN_PROGRESS",
      internalStatus: "running",
      startedAt: new Date(),
    })
    .where(and(eq(requests.requestId, requestId), ne(requests.status, "COMPLETED")))
    .returning({ requestId: requests.requestId });

  return updatedRows.length > 0;
}

export async function markCompleted(params: {
  requestId: string;
  output?: Record<string, unknown>;
  error?: string;
  errorType?: ErrorType;
  internalStatus?: InternalRequestStatus;
  inferenceTimeSeconds?: number;
  expiresAt?: Date;
}): Promise<void> {
  const internalStatus = params.internalStatus ?? "succeeded";
  await db
    .update(requests)
    .set({
      status: "COMPLETED",
      internalStatus,
      outputJson: params.output,
      error: params.error,
      errorType: params.errorType,
      inferenceTimeSeconds: params.inferenceTimeSeconds,
      completedAt: new Date(),
      expiresAt: params.expiresAt,
    })
    .where(eq(requests.requestId, params.requestId));
}

export async function markCompletedIfNotCompleted(params: {
  requestId: string;
  output?: Record<string, unknown>;
  error?: string;
  errorType?: ErrorType;
  internalStatus?: InternalRequestStatus;
  inferenceTimeSeconds?: number;
  expiresAt?: Date;
}): Promise<boolean> {
  // Guard terminal write to keep completion idempotent across retries/crash recovery.
  const internalStatus = params.internalStatus ?? "succeeded";
  const updatedRows = await db
    .update(requests)
    .set({
      status: "COMPLETED",
      internalStatus,
      outputJson: params.output,
      error: params.error,
      errorType: params.errorType,
      inferenceTimeSeconds: params.inferenceTimeSeconds,
      completedAt: new Date(),
      expiresAt: params.expiresAt,
    })
    .where(
      and(eq(requests.requestId, params.requestId), ne(requests.status, "COMPLETED")),
    )
    .returning({ requestId: requests.requestId });

  return updatedRows.length > 0;
}

