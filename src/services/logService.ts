import { and, asc, eq, gte } from "drizzle-orm";

import { db } from "../db/client";
import { requestLogs } from "../db/schema";

export async function appendLog(
  requestId: string,
  message: string,
): Promise<void> {
  await db.insert(requestLogs).values({
    requestId,
    message,
  });
}

export async function listLogs(requestId: string) {
  return db
    .select({
      message: requestLogs.message,
      timestamp: requestLogs.timestamp,
    })
    .from(requestLogs)
    .where(eq(requestLogs.requestId, requestId))
    .orderBy(asc(requestLogs.timestamp));
}

export async function listLogsSince(
  requestId: string,
  since: Date,
): Promise<Array<{ message: string; timestamp: Date }>> {
  return db
    .select({
      message: requestLogs.message,
      timestamp: requestLogs.timestamp,
    })
    .from(requestLogs)
    .where(and(eq(requestLogs.requestId, requestId), gte(requestLogs.timestamp, since)))
    .orderBy(asc(requestLogs.timestamp));
}

