import { and, eq, lt, or, sql } from "drizzle-orm";

import { db } from "../db/client";
import { requests } from "../db/schema";

/**
 * Returns the 0-based number of still-queued requests that will be processed
 * before `requestId`.
 *
 * This is a single indexed COUNT against Postgres (index:
 * `requests_queue_position_idx` on internal_status, priority, queue_seq) rather
 * than scanning every job in Redis. Ordering mirrors how the worker drains the
 * queue: higher priority first (lower `priority` value), then FIFO by insertion
 * order (`queueSeq`). Cost is O(log n + matched) and scales to large backlogs.
 *
 * Returns 0 once the request leaves the queue (running/terminal) or is absent.
 */
export async function getQueuePosition(requestId: string): Promise<number> {
  const [me] = await db
    .select({
      priority: requests.priority,
      queueSeq: requests.queueSeq,
      internalStatus: requests.internalStatus,
    })
    .from(requests)
    .where(eq(requests.requestId, requestId))
    .limit(1);

  if (!me || me.internalStatus !== "queued") {
    return 0;
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(requests)
    .where(
      and(
        eq(requests.internalStatus, "queued"),
        or(
          lt(requests.priority, me.priority),
          and(
            eq(requests.priority, me.priority),
            lt(requests.queueSeq, me.queueSeq),
          ),
        ),
      ),
    );

  return count ?? 0;
}
