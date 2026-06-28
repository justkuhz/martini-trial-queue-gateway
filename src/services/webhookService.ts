import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { requests } from "../db/schema";
import type { ErrorType } from "../domain";

type WebhookDeliveryParams = {
  requestId: string;
  gatewayRequestId: string;
  output?: Record<string, unknown>;
  error?: string;
  errorType?: ErrorType;
};

type WebhookDeliveryResult = {
  delivered: boolean;
  reason: "no_webhook" | "already_delivered" | "delivered" | "delivery_failed";
  error?: string;
};

const WEBHOOK_RETRY_BATCH_SIZE = 100;

async function claimWebhookTarget(
  requestId: string,
): Promise<{ webhookUrl: string } | null> {
  // Claim-first prevents duplicate sends when workers race/recover. The claim is
  // released again (webhook_delivered_at -> null) if delivery fails, so a later
  // retention sweep can re-claim and retry. This gives at-least-once delivery
  // while keeping the happy path exactly-once.
  const claimedRows = await db
    .update(requests)
    .set({
      webhookDeliveredAt: new Date(),
    })
    .where(
      and(
        eq(requests.requestId, requestId),
        isNotNull(requests.webhookUrl),
        isNull(requests.webhookDeliveredAt),
      ),
    )
    .returning({
      webhookUrl: requests.webhookUrl,
    });

  const row = claimedRows[0];
  if (!row?.webhookUrl) {
    return null;
  }

  return {
    webhookUrl: row.webhookUrl,
  };
}

async function releaseWebhookClaim(requestId: string): Promise<void> {
  // Re-open the request for a future delivery attempt.
  await db
    .update(requests)
    .set({ webhookDeliveredAt: null })
    .where(eq(requests.requestId, requestId));
}

export async function sendCompletionWebhook(
  params: WebhookDeliveryParams,
): Promise<WebhookDeliveryResult> {
  const target = await claimWebhookTarget(params.requestId);
  if (!target) {
    const existing = await db
      .select({
        webhookUrl: requests.webhookUrl,
      })
      .from(requests)
      .where(eq(requests.requestId, params.requestId))
      .limit(1);

    if (!existing[0]?.webhookUrl) {
      return { delivered: false, reason: "no_webhook" };
    }
    return { delivered: false, reason: "already_delivered" };
  }

  const payload =
    params.error || params.errorType
      ? {
          request_id: params.requestId,
          gateway_request_id: params.gatewayRequestId,
          status: "ERROR" as const,
          error: params.error ?? "Unknown error",
          payload: {
            detail: params.errorType ?? "internal_error",
          },
        }
      : {
          request_id: params.requestId,
          gateway_request_id: params.gatewayRequestId,
          status: "OK" as const,
          payload: params.output ?? {},
        };

  try {
    const response = await fetch(target.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": params.requestId,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Release so the retention sweep retries later.
      await releaseWebhookClaim(params.requestId);
      return {
        delivered: false,
        reason: "delivery_failed",
        error: `Webhook returned HTTP ${response.status}`,
      };
    }

    return {
      delivered: true,
      reason: "delivered",
    };
  } catch (error) {
    await releaseWebhookClaim(params.requestId);
    return {
      delivered: false,
      reason: "delivery_failed",
      error: error instanceof Error ? error.message : "Unknown webhook delivery error",
    };
  }
}

/**
 * Best-effort retry sweep for completed requests whose webhook has not yet been
 * delivered (e.g. the receiver was down at completion time, or the worker
 * crashed after marking COMPLETED but before delivering). Reconstructs the
 * payload from the persisted request row and re-attempts delivery. Idempotent:
 * `sendCompletionWebhook` re-claims atomically, and the `Idempotency-Key`
 * header lets receivers dedupe.
 */
export async function retryUndeliveredWebhooks(
  batchSize = WEBHOOK_RETRY_BATCH_SIZE,
): Promise<number> {
  const pending = await db
    .select({
      requestId: requests.requestId,
      gatewayRequestId: requests.latestGatewayRequestId,
      output: requests.outputJson,
      error: requests.error,
      errorType: requests.errorType,
    })
    .from(requests)
    .where(
      and(
        eq(requests.status, "COMPLETED"),
        isNotNull(requests.webhookUrl),
        isNull(requests.webhookDeliveredAt),
      ),
    )
    .limit(batchSize);

  let delivered = 0;
  for (const row of pending) {
    const result = await sendCompletionWebhook({
      requestId: row.requestId,
      gatewayRequestId: row.gatewayRequestId ?? "gwreq_unknown",
      output: (row.output as Record<string, unknown> | null) ?? undefined,
      error: row.error ?? undefined,
      errorType: row.errorType ?? undefined,
    });
    if (result.reason === "delivered") {
      delivered += 1;
    }
  }

  return delivered;
}
