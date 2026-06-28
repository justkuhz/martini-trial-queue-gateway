import {
  bigserial,
  boolean,
  doublePrecision,
  integer,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import {
  ATTEMPT_STATUSES,
  ERROR_TYPES,
  INTERNAL_REQUEST_STATUSES,
  PUBLIC_REQUEST_STATUSES,
} from "../domain";

export const requestStatusEnum = pgEnum("request_status", PUBLIC_REQUEST_STATUSES);

export const internalRequestStatusEnum = pgEnum(
  "internal_request_status",
  INTERNAL_REQUEST_STATUSES,
);

export const errorTypeEnum = pgEnum("error_type", ERROR_TYPES);

export const attemptStatusEnum = pgEnum("attempt_status", ATTEMPT_STATUSES);

export const requests = pgTable(
  "requests",
  {
    requestId: text("request_id").primaryKey(),
    modelId: text("model_id").notNull(),
    status: requestStatusEnum("status").notNull().default("IN_QUEUE"),
    internalStatus: internalRequestStatusEnum("internal_status")
      .notNull()
      .default("queued"),
    cancellationRequested: boolean("cancellation_requested")
      .notNull()
      .default(false),
    // Lower value = higher priority (mirrors BullMQ: normal=1, low=10).
    priority: integer("priority").notNull().default(1),
    // Monotonic insertion order; used as the FIFO tiebreaker for queue position.
    queueSeq: bigserial("queue_seq", { mode: "number" }).notNull(),
    inputJson: jsonb("input_json").notNull(),
    outputJson: jsonb("output_json"),
    error: text("error"),
    errorType: errorTypeEnum("error_type"),
    inferenceTimeSeconds: doublePrecision("inference_time_seconds"),
    latestGatewayRequestId: text("latest_gateway_request_id"),
    webhookUrl: text("webhook_url"),
    webhookDeliveredAt: timestamp("webhook_delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("requests_status_idx").on(table.status),
    internalStatusIdx: index("requests_internal_status_idx").on(
      table.internalStatus,
    ),
    createdAtIdx: index("requests_created_at_idx").on(table.createdAt),
    expiresAtIdx: index("requests_expires_at_idx").on(table.expiresAt),
    // Supports O(log n) queue-position counting ordered by (priority, queueSeq).
    queuePositionIdx: index("requests_queue_position_idx").on(
      table.internalStatus,
      table.priority,
      table.queueSeq,
    ),
    webhookDeliveredAtIdx: index("requests_webhook_delivered_at_idx").on(
      table.webhookDeliveredAt,
    ),
    modelAndRequestIdx: index("requests_model_request_idx").on(
      table.modelId,
      table.requestId,
    ),
  }),
);

export const requestLogs = pgTable(
  "request_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.requestId, { onDelete: "cascade" }),
    message: text("message").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    requestIdIdx: index("request_logs_request_id_idx").on(table.requestId),
  }),
);

export const requestAttempts = pgTable(
  "request_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    gatewayRequestId: text("gateway_request_id").notNull().unique(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.requestId, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: attemptStatusEnum("status").notNull().default("started"),
    error: text("error"),
    errorType: errorTypeEnum("error_type"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    requestIdIdx: index("request_attempts_request_id_idx").on(table.requestId),
    requestAndAttemptIdx: index("request_attempts_request_attempt_idx").on(
      table.requestId,
      table.attemptNumber,
    ),
  }),
);

