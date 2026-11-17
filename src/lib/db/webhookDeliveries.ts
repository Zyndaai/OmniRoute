import { db } from "./pg";
import { stripNul } from "./pgJsonText";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export interface WebhookDelivery {
  id: number;
  webhook_id: string;
  event_type: string;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  payload_snapshot: string | null;
  created_at: string;
}

/** Safe projection for the deliveries list API — excludes `payload_snapshot`
 *  by default so audit-list responses never leak the captured request body. */
export type WebhookDeliverySafe = Omit<WebhookDelivery, "payload_snapshot">;

const MAX_DELIVERIES_PER_WEBHOOK = 100;

export async function insertDelivery(opts: {
  webhookId: string;
  eventType: string;
  status: string;
  httpStatus?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  payloadSnapshot?: string | null;
}): Promise<void> {
  // Sanitize the error before persistence so raw stack traces, hostnames or
  // upstream-internal messages never enter the audit log. The audit log is
  // read back via the deliveries API and rendered in the dashboard.
  const sanitizedError = opts.error != null ? sanitizeErrorMessage(opts.error) || null : null;
  try {
    await insertDeliveryRow(opts, sanitizedError);
  } catch (error) {
    // The webhook was deleted while its delivery was in flight: its history goes with it.
    const { kind, code } = error as { kind?: string; code?: string };
    if (kind === "foreign_key_violation" || code === "23503") return;
    throw error;
  }
}

async function insertDeliveryRow(
  opts: {
    webhookId: string;
    eventType: string;
    status: string;
    httpStatus?: number | null;
    latencyMs?: number | null;
    payloadSnapshot?: string | null;
  },
  sanitizedError: string | null
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO webhook_deliveries
         (webhook_id, event_type, status, http_status, latency_ms, error, payload_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        opts.webhookId,
        opts.eventType,
        opts.status,
        opts.httpStatus ?? null,
        opts.latencyMs == null ? null : Math.round(opts.latencyMs),
        sanitizedError === null ? null : stripNul(sanitizedError),
        opts.payloadSnapshot == null ? null : stripNul(opts.payloadSnapshot),
      ]
    );
    await tx.execute(
      `DELETE FROM webhook_deliveries
       WHERE webhook_id = $1
         AND id NOT IN (
           SELECT id FROM webhook_deliveries
           WHERE webhook_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2
         )`,
      [opts.webhookId, MAX_DELIVERIES_PER_WEBHOOK]
    );
  });
}

/** List recent deliveries excluding `payload_snapshot` (default — used by UI). */
export async function getDeliveries(
  webhookId: string,
  limit: number
): Promise<WebhookDeliverySafe[]> {
  return db().query<WebhookDeliverySafe>(
    `SELECT id, webhook_id, event_type, status, http_status, latency_ms, error, created_at
       FROM webhook_deliveries
       WHERE webhook_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
    [webhookId, limit]
  );
}
