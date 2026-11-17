import { db, jsonb, ts } from "./pg";

export interface HandoffPayload {
  id?: string;
  sessionId: string;
  comboName: string;
  fromAccount: string;
  summary: string;
  keyDecisions: string[];
  taskProgress: string;
  activeEntities: string[];
  messageCount: number;
  model: string;
  lastModel?: string;
  warningThresholdPct: number;
  generatedAt: string;
  expiresAt: string;
  createdAt?: string;
}

type JsonRecord = Record<string, unknown>;

const CLEANUP_THROTTLE_MS = 30 * 60 * 1000;

let lastCleanupAt = 0;

/** Postgres rejects U+0000 in text and jsonb; upstream content can carry it. */
function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : String(item))).filter(Boolean);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => (typeof item === "string" ? item : String(item))).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function toHandoffPayload(row: JsonRecord | undefined): HandoffPayload | null {
  if (!row) return null;

  return {
    id: typeof row.id === "string" ? row.id : undefined,
    sessionId: typeof row.session_id === "string" ? row.session_id : "",
    comboName: typeof row.combo_name === "string" ? row.combo_name : "",
    fromAccount: typeof row.from_account === "string" ? row.from_account : "",
    summary: typeof row.summary === "string" ? row.summary : "",
    keyDecisions: parseJsonArray(row.key_decisions),
    taskProgress: typeof row.task_progress === "string" ? row.task_progress : "",
    activeEntities: parseJsonArray(row.active_entities),
    messageCount: Number.isFinite(Number(row.message_count)) ? Number(row.message_count) : 0,
    model: typeof row.model === "string" ? row.model : "",
    lastModel: typeof row.last_model === "string" ? row.last_model : undefined,
    warningThresholdPct: Number.isFinite(Number(row.warning_threshold_pct))
      ? Number(row.warning_threshold_pct)
      : 0.85,
    generatedAt: typeof row.generated_at === "string" ? row.generated_at : "",
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : undefined,
  };
}

export async function upsertHandoff(payload: HandoffPayload): Promise<void> {
  await db().execute(
    `INSERT INTO context_handoffs
      (session_id, combo_name, from_account, summary, key_decisions,
       task_progress, active_entities, message_count, model, last_model,
       warning_threshold_pct, generated_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (session_id, combo_name) DO UPDATE SET
       from_account = EXCLUDED.from_account,
       summary = EXCLUDED.summary,
       key_decisions = EXCLUDED.key_decisions,
       task_progress = EXCLUDED.task_progress,
       active_entities = EXCLUDED.active_entities,
       message_count = EXCLUDED.message_count,
       model = EXCLUDED.model,
       last_model = EXCLUDED.last_model,
       warning_threshold_pct = EXCLUDED.warning_threshold_pct,
       generated_at = EXCLUDED.generated_at,
       expires_at = EXCLUDED.expires_at,
       created_at = EXCLUDED.created_at`,
    [
      payload.sessionId,
      payload.comboName,
      payload.fromAccount,
      stripNul(payload.summary),
      jsonb((payload.keyDecisions || []).map((item) => stripNul(String(item)))),
      stripNul(payload.taskProgress),
      jsonb((payload.activeEntities || []).map((item) => stripNul(String(item)))),
      Math.round(payload.messageCount),
      payload.model,
      payload.lastModel || null,
      payload.warningThresholdPct,
      ts(payload.generatedAt),
      ts(payload.expiresAt),
    ]
  );
}

export async function getHandoff(
  sessionId: string,
  comboName: string
): Promise<HandoffPayload | null> {
  const row = await db().queryOne<JsonRecord>(
    `SELECT *
     FROM context_handoffs
     WHERE session_id = $1 AND combo_name = $2 AND expires_at > $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId, comboName, new Date().toISOString()]
  );

  return toHandoffPayload(row);
}

export async function deleteHandoff(sessionId: string, comboName: string): Promise<void> {
  await db().execute("DELETE FROM context_handoffs WHERE session_id = $1 AND combo_name = $2", [
    sessionId,
    comboName,
  ]);
}

export async function cleanupExpiredHandoffs(): Promise<number> {
  const nowMs = Date.now();
  if (nowMs - lastCleanupAt < CLEANUP_THROTTLE_MS) {
    return 0;
  }

  const result = await db().execute("DELETE FROM context_handoffs WHERE expires_at <= $1", [
    new Date(nowMs).toISOString(),
  ]);
  lastCleanupAt = nowMs;
  return result.changes;
}

export async function hasActiveHandoff(sessionId: string, comboName: string): Promise<boolean> {
  const row = await db().queryOne(
    `SELECT 1
     FROM context_handoffs
     WHERE session_id = $1 AND combo_name = $2 AND expires_at > $3
     LIMIT 1`,
    [sessionId, comboName, new Date().toISOString()]
  );

  return !!row;
}

/**
 * Record a model usage entry for a session/combo combination (the pin).
 * Used by context-relay to track which model was last active. One row is kept per
 * (combo, session): each call upserts it with the new model and `used_at = now()`.
 *
 * @param sessionId - The session identifier.
 * @param comboName - The combo name.
 * @param modelStr - The model string (e.g. "claude-sonnet-4-20250514").
 * @param provider - The provider identifier.
 * @param connectionId - Optional connection ID used.
 */
export async function recordSessionModelUsage(
  sessionId: string,
  comboName: string,
  modelStr: string,
  provider: string,
  connectionId?: string
): Promise<void> {
  await db().execute(
    `INSERT INTO session_model_pins (combo_name, session_id, model_str, provider, connection_id, used_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (combo_name, session_id) DO UPDATE SET
       model_str = EXCLUDED.model_str,
       provider = EXCLUDED.provider,
       connection_id = EXCLUDED.connection_id,
       used_at = now()`,
    [comboName, sessionId, modelStr, provider, connectionId || null]
  );
}

/**
 * Get the most recently used model for a session/combo combination.
 * Returns null if no usage has been recorded.
 *
 * @param sessionId - The session identifier.
 * @param comboName - The combo name.
 * @returns The model string, or null if no record exists.
 */
export async function getLastSessionModel(
  sessionId: string,
  comboName: string
): Promise<string | null> {
  const row = await db().queryOne<{ model_str: string }>(
    "SELECT model_str FROM session_model_pins WHERE combo_name = $1 AND session_id = $2",
    [comboName, sessionId]
  );

  return row?.model_str ?? null;
}

/**
 * Clear all session model pins for a given combo name.
 * Called when a combo's model targets are changed to invalidate stale context-cache pins.
 *
 * @param comboName - The combo name whose pins should be cleared.
 * @returns The number of deleted entries.
 */
export async function clearSessionModelHistoryForCombo(comboName: string): Promise<number> {
  const result = await db().execute("DELETE FROM session_model_pins WHERE combo_name = $1", [
    comboName,
  ]);
  return result.changes ?? 0;
}

/**
 * Clear the session model pin for ONE session on a given combo, leaving
 * every other session's pin on that same combo untouched.
 *
 * Unlike clearSessionModelHistoryForCombo() (combo-wide — used when the combo's
 * model targets themselves change and every pin is stale), this is the
 * session-scoped variant used by the consecutive-failure auto-clear path
 * (open-sse/services/combo/failureTracker.ts::recordComboFailure), where only
 * the failing session's pin should be dropped.
 *
 * @param sessionId - The session identifier whose pin should be cleared.
 * @param comboName - The combo name.
 * @returns The number of deleted entries.
 */
export async function deleteSessionModelHistory(
  sessionId: string,
  comboName: string
): Promise<number> {
  const result = await db().execute(
    "DELETE FROM session_model_pins WHERE combo_name = $1 AND session_id = $2",
    [comboName, sessionId]
  );
  return result.changes ?? 0;
}

/**
 * Leader-only sweep: delete pins not used for `maxAgeMs`. `used_at` is deliberately
 * unindexed (keeps the per-attempt upsert HOT), so this is a sequential scan.
 */
export async function cleanupStaleSessionModelPins(maxAgeMs: number): Promise<number> {
  const result = await db().execute("DELETE FROM session_model_pins WHERE used_at < $1", [
    new Date(Date.now() - maxAgeMs).toISOString(),
  ]);
  return result.changes ?? 0;
}
