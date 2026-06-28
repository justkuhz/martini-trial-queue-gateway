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

async function claimWebhookTarget(
  requestId: string,
): Promise<{ webhookUrl: string } | null> {
  // Claim-first prevents duplicate sends when workers race/recover.
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
    return {
      delivered: false,
      reason: "delivery_failed",
      error: error instanceof Error ? error.message : "Unknown webhook delivery error",
    };
  }
}

