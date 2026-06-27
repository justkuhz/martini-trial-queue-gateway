import { and, desc, eq } from "drizzle-orm";

import { db } from "../db/client";
import { requestAttempts, requests } from "../db/schema";
import type { AttemptStatus, ErrorType } from "../domain";
import { createGatewayRequestId } from "../utils/ids";

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

