/**
 * Database module: Webhooks
 * CRUD operations for webhook event subscriptions
 */

import crypto from "crypto";
import { db, jsonb, sqlLimit, sqlOffset } from "./pg";
import { decrypt, encrypt } from "./encryption";

export type WebhookKind = "slack" | "telegram" | "discord" | "custom";

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  enabled: boolean;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: WebhookKind;
  metadata_encrypted: string | null;
}

interface WebhookRow {
  id: string;
  url: string;
  events: unknown;
  secret: string | null;
  enabled: boolean;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: string;
  metadata_encrypted: string | null;
}

function parseEvents(value: unknown): string[] {
  let events = value;
  if (typeof events === "string") {
    try {
      events = JSON.parse(events);
    } catch {
      events = null;
    }
  }
  return Array.isArray(events) ? (events as string[]) : ["*"];
}

/** The secret is stored as an `enc:v1` envelope; callers sign payloads with the plaintext. */
function rowToWebhook(row: WebhookRow): Webhook {
  return {
    ...row,
    kind: (row.kind as WebhookKind) || "custom",
    events: parseEvents(row.events),
    secret: row.secret ? (decrypt(row.secret) ?? null) : null,
    enabled: row.enabled === true,
  };
}

export async function getWebhooks(options?: { limit?: number; offset?: number }): Promise<{
  webhooks: Webhook[];
  total: number;
}> {
  const limit = options?.limit;
  const offset = options?.offset ?? 0;
  let sql = "SELECT * FROM webhooks ORDER BY created_at DESC, id ASC";
  const params: unknown[] = [];
  if (limit !== undefined) {
    sql += " LIMIT $1 OFFSET $2";
    params.push(sqlLimit(limit), sqlOffset(offset));
  }
  const rows = await db().query<WebhookRow>(sql, params);
  const totalRow = await db().queryOne<{ cnt: number }>("SELECT count(*) AS cnt FROM webhooks");
  return { webhooks: rows.map(rowToWebhook), total: totalRow?.cnt ?? 0 };
}

export async function getWebhook(id: string): Promise<Webhook | null> {
  const row = await db().queryOne<WebhookRow>("SELECT * FROM webhooks WHERE id = $1", [id]);
  return row ? rowToWebhook(row) : null;
}

export async function getEnabledWebhooks(): Promise<Webhook[]> {
  const rows = await db().query<WebhookRow>("SELECT * FROM webhooks WHERE enabled");
  return rows.map(rowToWebhook);
}

export async function createWebhook(data: {
  url: string;
  events?: string[];
  secret?: string;
  description?: string;
  kind?: WebhookKind;
  metadataEncrypted?: string | null;
}): Promise<Webhook> {
  const id = crypto.randomUUID();
  const secret = data.secret || `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const kind = data.kind || "custom";

  const row = await db().queryOne<WebhookRow>(
    `INSERT INTO webhooks (id, url, events, secret, description, kind, metadata_encrypted)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     RETURNING *`,
    [
      id,
      data.url,
      jsonb(data.events || ["*"]),
      encrypt(secret) ?? secret,
      data.description || "",
      kind,
      data.metadataEncrypted ?? null,
    ]
  );
  return rowToWebhook(row!);
}

export async function updateWebhook(
  id: string,
  data: Partial<{
    url: string;
    events: string[];
    secret: string;
    enabled: boolean;
    description: string;
    kind: WebhookKind;
    metadataEncrypted: string | null;
  }>
): Promise<Webhook | null> {
  // Column names are fixed literals below; every value is bound.
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown, cast = "") => {
    values.push(value);
    fields.push(`${column} = $${values.length}${cast}`);
  };

  if (data.url !== undefined) set("url", data.url);
  if (data.events !== undefined) set("events", jsonb(data.events), "::jsonb");
  if (data.secret !== undefined) set("secret", encrypt(data.secret) ?? data.secret);
  if (data.enabled !== undefined) set("enabled", data.enabled);
  if (data.description !== undefined) set("description", data.description);
  if (data.kind !== undefined) set("kind", data.kind);
  if (data.metadataEncrypted !== undefined) set("metadata_encrypted", data.metadataEncrypted);

  if (fields.length === 0) return getWebhook(id);

  values.push(id);
  const row = await db().queryOne<WebhookRow>(
    `UPDATE webhooks SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return row ? rowToWebhook(row) : null;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM webhooks WHERE id = $1", [id]);
  return result.changes > 0;
}

export async function recordWebhookDelivery(
  id: string,
  status: number,
  success: boolean
): Promise<void> {
  await db().execute(
    `UPDATE webhooks
        SET last_triggered_at = now(),
            last_status = $2,
            failure_count = CASE WHEN $3::boolean THEN 0 ELSE failure_count + 1 END
      WHERE id = $1`,
    [id, Math.round(status), success]
  );
}

export async function disableWebhooksWithHighFailures(threshold = 10): Promise<number> {
  const result = await db().execute(
    "UPDATE webhooks SET enabled = false WHERE failure_count >= $1 AND enabled",
    [threshold]
  );
  return result.changes;
}
