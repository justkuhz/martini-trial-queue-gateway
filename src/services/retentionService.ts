/**
 * Periodic housekeeping run on an interval from the worker: expire completed
 * requests (FK-cascades to logs/attempts), reconcile stuck `running` rows to
 * `timeout`, trim BullMQ history, and retry undelivered webhooks.
 */
import { and, eq, inArray, lte } from "drizzle-orm";

import { db } from "../db/client";
import { requests } from "../db/schema";
import { cleanupQueueHistory } from "../queue/enqueue";
import { toPublicStatus } from "../domain";
import { retryUndeliveredWebhooks } from "./webhookService";

const REQUEST_RETENTION_BATCH_SIZE = 1000;
const RUNNING_RECONCILE_BUFFER_MS = 30 * 1000;

export async function cleanupExpiredRequestsBatch(
  batchSize = REQUEST_RETENTION_BATCH_SIZE,
): Promise<number> {
  const now = new Date();
  const expiredRows = await db
    .select({ requestId: requests.requestId })
    .from(requests)
    .where(
      and(
        eq(requests.status, "COMPLETED"),
        lte(requests.expiresAt, now),
      ),
    )
    .limit(batchSize);

  if (expiredRows.length === 0) {
    return 0;
  }

  const expiredIds = expiredRows.map((row) => row.requestId);
  await db.delete(requests).where(inArray(requests.requestId, expiredIds));
  return expiredIds.length;
}

export async function reconcileStuckRunningRequests(params: {
  maxRunningSeconds: number;
  requestTtlMs: number;
}): Promise<number> {
  const timeoutThreshold = new Date(
    Date.now() - params.maxRunningSeconds * 1000 - RUNNING_RECONCILE_BUFFER_MS,
  );
  const expiresAt = new Date(Date.now() + params.requestTtlMs);

  const updatedRows = await db
    .update(requests)
    .set({
      status: toPublicStatus("timeout"),
      internalStatus: "timeout",
      error: "Request exceeded maximum running time and was reconciled.",
      errorType: "timeout",
      completedAt: new Date(),
      expiresAt,
    })
    .where(
      and(
        eq(requests.internalStatus, "running"),
        lte(requests.startedAt, timeoutThreshold),
      ),
    )
    .returning({ requestId: requests.requestId });

  return updatedRows.length;
}

export async function runRetentionCycle(params: {
  maxRunningSeconds: number;
  requestTtlMs: number;
}): Promise<{
  expiredRequestsRemoved: number;
  stuckRunningReconciled: number;
  queueCompletedRemoved: number;
  queueFailedRemoved: number;
  webhooksRetried: number;
}> {
  const [
    expiredRequestsRemoved,
    stuckRunningReconciled,
    queueCleanup,
    webhooksRetried,
  ] = await Promise.all([
    cleanupExpiredRequestsBatch(),
    reconcileStuckRunningRequests(params),
    cleanupQueueHistory(),
    retryUndeliveredWebhooks(),
  ]);

  return {
    expiredRequestsRemoved,
    stuckRunningReconciled,
    queueCompletedRemoved: queueCleanup.completedRemoved,
    queueFailedRemoved: queueCleanup.failedRemoved,
    webhooksRetried,
  };
}
