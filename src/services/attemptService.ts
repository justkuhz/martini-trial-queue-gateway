import { and, desc, eq } from "drizzle-orm";

import { db } from "../db/client";
import { requestAttempts, requests } from "../db/schema";
import type { AttemptStatus, ErrorType } from "../domain";
import { createGatewayRequestId } from "../utils/ids";

/**
 * Tracks per-attempt execution rows. One request (stable request_id) can have
 * many attempts; each attempt gets a fresh gateway_request_id and an
 * incrementing attempt_number, giving retry/debug visibility that is distinct
 * from the request's own identity.
 */

export async function startAttempt(params: {
  requestId: string;
  modelId: string;
}): Promise<{ gatewayRequestId: string; attemptNumber: number }> {
  const [latest] = await db
    .select({
      attemptNumber: requestAttempts.attemptNumber,
    })
    .from(requestAttempts)
    .where(eq(requestAttempts.requestId, params.requestId))
    .orderBy(desc(requestAttempts.attemptNumber))
    .limit(1);

  const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
  const gatewayRequestId = createGatewayRequestId();

  await db.insert(requestAttempts).values({
    requestId: params.requestId,
    modelId: params.modelId,
    attemptNumber,
    gatewayRequestId,
    status: "started",
  });

  await db
    .update(requests)
    .set({
      latestGatewayRequestId: gatewayRequestId,
    })
    .where(eq(requests.requestId, params.requestId));

  return { gatewayRequestId, attemptNumber };
}

export async function finishAttempt(params: {
  requestId: string;
  gatewayRequestId: string;
  status: AttemptStatus;
  error?: string;
  errorType?: ErrorType;
}): Promise<void> {
  await db
    .update(requestAttempts)
    .set({
      status: params.status,
      error: params.error,
      errorType: params.errorType,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(requestAttempts.requestId, params.requestId),
        eq(requestAttempts.gatewayRequestId, params.gatewayRequestId),
      ),
    );
}

export async function listAttemptsForRequest(requestId: string) {
  return db
    .select()
    .from(requestAttempts)
    .where(eq(requestAttempts.requestId, requestId))
    .orderBy(desc(requestAttempts.attemptNumber));
}

export async function getLatestAttempt(requestId: string) {
  const [latest] = await db
    .select()
    .from(requestAttempts)
    .where(eq(requestAttempts.requestId, requestId))
    .orderBy(desc(requestAttempts.attemptNumber))
    .limit(1);

  return latest;
}

