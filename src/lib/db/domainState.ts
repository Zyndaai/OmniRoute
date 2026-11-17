/**
 * Domain State Persistence — Phase 5 Foundation
 *
 * CRUD operations for persisting domain layer state in PostgreSQL, shared by
 * every OmniRoute process.
 *
 * Tables: domain_fallback_chains, domain_budgets, domain_budget_reset_logs,
 *         domain_cost_history, domain_lockout_state, domain_circuit_breakers.
 * The budget's unpriced-usage marker is `domain_budgets.unpriced_usage_since`.
 *
 * Epoch-millisecond numbers stay the API shape; they are stored as timestamptz.
 *
 * @module lib/db/domainState
 */

import { db, jsonb, toMs } from "./pg";

type JsonRecord = Record<string, unknown>;
type BudgetResetInterval = "daily" | "weekly" | "monthly";

interface BudgetConfigRecord {
  dailyLimitUsd: number;
  weeklyLimitUsd: number;
  monthlyLimitUsd: number;
  warningThreshold: number;
  resetInterval: BudgetResetInterval;
  resetTime: string;
  budgetResetAt: number | null;
  lastBudgetResetAt: number | null;
  warningEmittedAt: number | null;
  warningPeriodStart: number | null;
}

interface BudgetResetLogRecord {
  apiKeyId: string;
  resetInterval: BudgetResetInterval;
  previousSpend: number;
  resetAt: number;
  nextResetAt: number;
  periodStart: number;
  periodEnd: number;
}

interface FallbackChainEntry {
  provider: string;
  priority: number;
  enabled: boolean;
}

interface LockoutStateRecord {
  attempts: number[];
  lockedUntil: number | null;
}

interface CircuitBreakerStateRecord {
  state: string;
  failureCount: number;
  lastFailureTime: number | null;
  options?: JsonRecord | null;
}

const BUDGET_WINDOW_FIELDS = [
  ["budgetResetAt", "budget_reset_at"],
  ["lastBudgetResetAt", "last_budget_reset_at"],
  ["warningEmittedAt", "warning_emitted_at"],
  ["warningPeriodStart", "warning_period_start"],
] as const;
const TIME_RE =/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const BREAKER_STATES = new Set(["CLOSED", "DEGRADED", "OPEN", "HALF_OPEN"]);

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** Epoch ms to an ISO string. Used instead of ts() so small test values are not read as seconds. */
function msIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 0, null and undefined store NULL (a "not set" ms value); anything else is epoch ms. */
function msOrNull(ms: number | null | undefined): string | null {
  return ms ? msIso(ms) : null;
}

function toBudgetConfig(record: JsonRecord): BudgetConfigRecord {
  return {
    dailyLimitUsd: toNumber(record.daily_limit_usd),
    weeklyLimitUsd: toNumber(record.weekly_limit_usd),
    monthlyLimitUsd: toNumber(record.monthly_limit_usd),
    warningThreshold: toNumber(record.warning_threshold, 0.8),
    resetInterval:
      typeof record.reset_interval === "string"
        ? (record.reset_interval as BudgetResetInterval)
        : "daily",
    resetTime: typeof record.reset_time === "string" ? record.reset_time.slice(0, 5) : "00:00",
    budgetResetAt: toMs(record.budget_reset_at as string | null) || null,
    lastBudgetResetAt: toMs(record.last_budget_reset_at as string | null) || null,
    warningEmittedAt: toMs(record.warning_emitted_at as string | null) || null,
    warningPeriodStart: toMs(record.warning_period_start as string | null) || null,
  };
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ──────────────── Fallback Chains ────────────────

/**
 * Save a fallback chain for a model.
 * @param {string} model
 * @param {Array<{provider: string, priority: number, enabled: boolean}>} chain
 */
export async function saveFallbackChain(model: string, chain: FallbackChainEntry[]) {
  await db().execute(
    `INSERT INTO domain_fallback_chains (model, chain) VALUES ($1, $2::jsonb)
     ON CONFLICT (model) DO UPDATE SET chain = EXCLUDED.chain`,
    [model, jsonb(chain)]
  );
}

/**
 * Load a fallback chain for a model.
 * @param {string} model
 * @returns {Array<{provider: string, priority: number, enabled: boolean}> | null}
 */
export async function loadFallbackChain(model: string): Promise<FallbackChainEntry[] | null> {
  const row = await db().queryOne("SELECT chain FROM domain_fallback_chains WHERE model = $1", [
    model,
  ]);
  const chain = parseJsonIfString(asRecord(row).chain);
  return Array.isArray(chain) ? (chain as FallbackChainEntry[]) : null;
}

/**
 * Load all fallback chains.
 * @returns {Record<string, Array<{provider: string, priority: number, enabled: boolean}>>}
 */
export async function loadAllFallbackChains() {
  const rows = await db().query("SELECT model, chain FROM domain_fallback_chains");
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const record = asRecord(row);
    const model = typeof record.model === "string" ? record.model : null;
    const chain = parseJsonIfString(record.chain);
    if (!model || !Array.isArray(chain)) continue;
    result[model] = chain;
  }
  return result;
}

/**
 * Delete a fallback chain.
 * @param {string} model
 * @returns {boolean}
 */
export async function deleteFallbackChain(model: string) {
  const info = await db().execute("DELETE FROM domain_fallback_chains WHERE model = $1", [model]);
  return info.changes > 0;
}

/**
 * Delete all fallback chains.
 */
export async function deleteAllFallbackChains() {
  await db().execute("DELETE FROM domain_fallback_chains");
}

// ──────────────── Budgets ────────────────

/**
 * Save a budget config for an API key. Replaces the config fields but keeps the
 * row's unpriced-usage marker, which is a separate fact with its own writer.
 * @param {string} apiKeyId
 * @param {{ dailyLimitUsd: number, monthlyLimitUsd?: number, warningThreshold?: number }} config
 */
export async function saveBudget(apiKeyId: string, config: Partial<BudgetConfigRecord>) {
  // A window field the caller did not pass (undefined) keeps the stored value, so an operator's
  // config save cannot revert a rollover another process just wrote; null clears it.
  const writes = BUDGET_WINDOW_FIELDS.map(([field]) => config[field] !== undefined);
  const resetTime =
    typeof config.resetTime === "string" && TIME_RE.test(config.resetTime)
      ? config.resetTime
      : "00:00";
  const resetInterval =
    config.resetInterval === "weekly" || config.resetInterval === "monthly"
      ? config.resetInterval
      : "daily";
  await db().execute(
    `INSERT INTO domain_budgets (
       api_key_id, daily_limit_usd, weekly_limit_usd, monthly_limit_usd, warning_threshold,
       reset_interval, reset_time, budget_reset_at, last_budget_reset_at,
       warning_emitted_at, warning_period_start
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::time, $8, $9, $10, $11)
     ON CONFLICT (api_key_id) DO UPDATE SET
       daily_limit_usd = EXCLUDED.daily_limit_usd,
       weekly_limit_usd = EXCLUDED.weekly_limit_usd,
       monthly_limit_usd = EXCLUDED.monthly_limit_usd,
       warning_threshold = EXCLUDED.warning_threshold,
       reset_interval = EXCLUDED.reset_interval,
       reset_time = EXCLUDED.reset_time,
       budget_reset_at = CASE WHEN $12 THEN EXCLUDED.budget_reset_at
                              ELSE domain_budgets.budget_reset_at END,
       last_budget_reset_at = CASE WHEN $13 THEN EXCLUDED.last_budget_reset_at
                                   ELSE domain_budgets.last_budget_reset_at END,
       warning_emitted_at = CASE WHEN $14 THEN EXCLUDED.warning_emitted_at
                                 ELSE domain_budgets.warning_emitted_at END,
       warning_period_start = CASE WHEN $15 THEN EXCLUDED.warning_period_start
                                   ELSE domain_budgets.warning_period_start END`,
    [
      apiKeyId,
      toNumber(config.dailyLimitUsd),
      toNumber(config.weeklyLimitUsd),
      toNumber(config.monthlyLimitUsd),
      toNumber(config.warningThreshold, 0.8),
      resetInterval,
      resetTime,
      msOrNull(config.budgetResetAt),
      msOrNull(config.lastBudgetResetAt),
      msOrNull(config.warningEmittedAt),
      msOrNull(config.warningPeriodStart),
      ...writes,
    ]
  );
}

/**
 * Write only the rollover/warning window fields of an existing budget row. Limits, threshold and
 * reset schedule are left untouched, so a process holding a stale config cache cannot revert an
 * operator's edit when it records a rollover or a warning. Fields not passed are not touched;
 * null clears one. No-op when the key has no budget row.
 */
export async function saveBudgetWindowState(
  apiKeyId: string,
  state: Partial<
    Pick<
      BudgetConfigRecord,
      "budgetResetAt" | "lastBudgetResetAt" | "warningEmittedAt" | "warningPeriodStart"
    >
  >
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [apiKeyId];
  for (const [field, column] of BUDGET_WINDOW_FIELDS) {
    if (state[field] === undefined) continue;
    params.push(msOrNull(state[field]));
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return false;
  const info = await db().execute(
    `UPDATE domain_budgets SET ${sets.join(", ")} WHERE api_key_id = $1`,
    params
  );
  return info.changes > 0;
}

/**
 * Load a budget config.
 * @param {string} apiKeyId
 * @returns {{ dailyLimitUsd: number, monthlyLimitUsd: number, warningThreshold: number } | null}
 */
export async function loadBudget(apiKeyId: string): Promise<BudgetConfigRecord | null> {
  const row = await db().queryOne("SELECT * FROM domain_budgets WHERE api_key_id = $1", [
    apiKeyId,
  ]);
  return row ? toBudgetConfig(asRecord(row)) : null;
}

/**
 * Load all budget configs.
 * @returns {Record<string, BudgetConfigRecord>}
 */
export async function loadAllBudgets() {
  const rows = await db().query("SELECT * FROM domain_budgets ORDER BY api_key_id");
  const result: Record<string, BudgetConfigRecord> = {};

  for (const row of rows) {
    const record = asRecord(row);
    const apiKeyId = typeof record.api_key_id === "string" ? record.api_key_id : "";
    if (!apiKeyId) continue;
    result[apiKeyId] = toBudgetConfig(record);
  }

  return result;
}

/**
 * Persist a budget reset log entry. A rollover is logged once per
 * (api key, period start), even when several processes detect it.
 * @param {BudgetResetLogRecord} entry
 */
export async function saveBudgetResetLog(entry: BudgetResetLogRecord) {
  await db().execute(
    `INSERT INTO domain_budget_reset_logs
       (api_key_id, reset_interval, previous_spend, reset_at, next_reset_at, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (api_key_id, period_start) DO NOTHING`,
    [
      entry.apiKeyId,
      entry.resetInterval,
      entry.previousSpend,
      msIso(entry.resetAt),
      msIso(entry.nextResetAt),
      msIso(entry.periodStart),
      msIso(entry.periodEnd),
    ]
  );
}

/**
 * Load recent budget reset logs for an API key.
 * @param {string} apiKeyId
 * @param {number} [limit=10]
 * @returns {Array<BudgetResetLogRecord & { id: number }>}
 */
export async function loadBudgetResetLogs(apiKeyId: string, limit = 10) {
  const rows = await db().query(
    `SELECT id, api_key_id, reset_interval, previous_spend, reset_at, next_reset_at, period_start, period_end
     FROM domain_budget_reset_logs
     WHERE api_key_id = $1
     ORDER BY reset_at DESC, id DESC
     LIMIT $2`,
    [apiKeyId, Math.max(1, Math.floor(limit))]
  );
  return rows
    .map((row) => {
      const record = asRecord(row);
      return {
        id: toNumber(record.id),
        apiKeyId: typeof record.api_key_id === "string" ? record.api_key_id : "",
        resetInterval:
          typeof record.reset_interval === "string"
            ? (record.reset_interval as BudgetResetInterval)
            : "daily",
        previousSpend: toNumber(record.previous_spend),
        resetAt: toMs(record.reset_at as string) ?? 0,
        nextResetAt: toMs(record.next_reset_at as string) ?? 0,
        periodStart: toMs(record.period_start as string) ?? 0,
        periodEnd: toMs(record.period_end as string) ?? 0,
      };
    })
    .filter((entry) => entry.apiKeyId.length > 0);
}

/**
 * Delete a budget config (its reset logs and unpriced-usage marker go with the row).
 * @param {string} apiKeyId
 */
export async function deleteBudget(apiKeyId: string) {
  await db().execute("DELETE FROM domain_budgets WHERE api_key_id = $1", [apiKeyId]);
}

// ──────────────── Budget Unpriced Usage ────────────────

/**
 * The budget period in which a key used a metered model it could not price (no
 * pricing row and no provider-reported cost). Stored on the budget row
 * (`unpriced_usage_since`); a key without a budget has nothing to flag, so
 * saving the marker for it is a no-op.
 */

/**
 * Start of the budget period that recorded unpriced usage for a key, or null.
 * @param {string} apiKeyId
 */
export async function loadBudgetUnpricedPeriodStart(apiKeyId: string): Promise<number | null> {
  const row = await db().queryOne<{ unpriced_usage_since: string | null }>(
    "SELECT unpriced_usage_since FROM domain_budgets WHERE api_key_id = $1",
    [apiKeyId]
  );
  const periodStart = toMs(row?.unpriced_usage_since) ?? 0;
  return periodStart > 0 ? periodStart : null;
}

/**
 * Record that a key's budget saw unpriced usage in the period starting at `periodStartAt`.
 * @param {string} apiKeyId
 * @param {number} periodStartAt
 */
export async function saveBudgetUnpricedPeriodStart(apiKeyId: string, periodStartAt: number) {
  await db().execute(
    "UPDATE domain_budgets SET unpriced_usage_since = $2 WHERE api_key_id = $1",
    [apiKeyId, msIso(periodStartAt)]
  );
}

/**
 * Forget a key's unpriced-usage period.
 * @param {string} apiKeyId
 */
export async function deleteBudgetUnpricedPeriodStart(apiKeyId: string) {
  await db().execute(
    "UPDATE domain_budgets SET unpriced_usage_since = NULL WHERE api_key_id = $1",
    [apiKeyId]
  );
}

// ──────────────── Cost History ────────────────

/**
 * Record a cost entry.
 * @param {string} apiKeyId
 * @param {number} cost
 * @param {number} [timestamp]
 */
export async function saveCostEntry(apiKeyId: string, cost: number, timestamp = Date.now()) {
  await db().execute(
    'INSERT INTO domain_cost_history (api_key_id, cost, "timestamp") VALUES ($1, $2, $3)',
    [apiKeyId, cost, msIso(timestamp)]
  );
}

export async function batchSaveCostEntries(
  entries: Array<{ apiKeyId: string; cost: number; timestamp: number }>
) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  await db().execute(
    `INSERT INTO domain_cost_history (api_key_id, cost, "timestamp")
     SELECT * FROM unnest($1::text[], $2::numeric[], $3::timestamptz[])`,
    [
      entries.map((e) => e.apiKeyId),
      entries.map((e) => e.cost),
      entries.map((e) => msIso(e.timestamp)),
    ]
  );
}

export async function loadCostTotal(apiKeyId: string, sinceTimestamp: number) {
  const row = await db().queryOne<{ total?: number }>(
    `SELECT COALESCE(SUM(cost), 0) AS total FROM domain_cost_history
     WHERE api_key_id = $1 AND "timestamp" >= $2`,
    [apiKeyId, msIso(sinceTimestamp)]
  );
  return Number(row?.total || 0);
}

/**
 * Load cost entries for an API key within a time window.
 * @param {string} apiKeyId
 * @param {number} sinceTimestamp
 * @returns {Array<{cost: number, timestamp: number}>}
 */
export async function loadCostEntries(apiKeyId: string, sinceTimestamp: number) {
  const rows = await db().query<{ cost: number; timestamp: string }>(
    `SELECT cost, "timestamp" FROM domain_cost_history
     WHERE api_key_id = $1 AND "timestamp" >= $2 ORDER BY "timestamp"`,
    [apiKeyId, msIso(sinceTimestamp)]
  );
  return rows.map((r) => ({ cost: Number(r.cost), timestamp: toMs(r.timestamp) ?? 0 }));
}

/**
 * Load cost entries for an API key within a bounded time window.
 * @param {string} apiKeyId
 * @param {number} sinceTimestamp
 * @param {number} untilTimestamp
 * @returns {Array<{cost: number, timestamp: number}>}
 */
export async function loadCostEntriesInRange(
  apiKeyId: string,
  sinceTimestamp: number,
  untilTimestamp: number
) {
  const rows = await db().query<{ cost: number; timestamp: string }>(
    `SELECT cost, "timestamp"
     FROM domain_cost_history
     WHERE api_key_id = $1 AND "timestamp" >= $2 AND "timestamp" < $3
     ORDER BY "timestamp"`,
    [apiKeyId, msIso(sinceTimestamp), msIso(untilTimestamp)]
  );
  return rows.map((r) => ({ cost: Number(r.cost), timestamp: toMs(r.timestamp) ?? 0 }));
}

/**
 * Delete old cost entries (cleanup).
 * @param {number} olderThanTimestamp
 * @returns {number} deleted count
 */
export async function cleanOldCostEntries(olderThanTimestamp: number) {
  const info = await db().execute('DELETE FROM domain_cost_history WHERE "timestamp" < $1', [
    msIso(olderThanTimestamp),
  ]);
  return info.changes;
}

/**
 * Delete all cost data for an API key.
 * @param {string} apiKeyId
 */
export async function deleteCostEntries(apiKeyId: string) {
  await db().execute("DELETE FROM domain_cost_history WHERE api_key_id = $1", [apiKeyId]);
}

/**
 * Delete all cost data (cost history, budgets with their reset logs and unpriced markers).
 */
export async function deleteAllCostData() {
  await db().transaction(async (tx) => {
    await tx.execute("DELETE FROM domain_cost_history");
    await tx.execute("DELETE FROM domain_budget_reset_logs");
    await tx.execute("DELETE FROM domain_budgets");
  });
}

// ──────────────── Lockout State ────────────────

/** Attempts as epoch ms; reading through epoch avoids driver-specific timestamptz[] parsing. */
const LOCKOUT_COLUMNS = `identifier, locked_until,
  (SELECT COALESCE(array_agg(round(extract(epoch FROM a) * 1000)::float8 ORDER BY ord), '{}')
     FROM unnest(attempts) WITH ORDINALITY AS t(a, ord)) AS attempts_ms`;

function toLockoutState(row: JsonRecord): LockoutStateRecord {
  const attempts = Array.isArray(row.attempts_ms) ? row.attempts_ms.map(Number) : [];
  return { attempts, lockedUntil: toMs(row.locked_until as string | null) };
}

/**
 * Save lockout state for an identifier.
 * @param {string} identifier
 * @param {{ attempts: number[], lockedUntil: number|null }} state
 */
export async function saveLockoutState(identifier: string, state: LockoutStateRecord) {
  await db().execute(
    `INSERT INTO domain_lockout_state (identifier, attempts, locked_until)
     VALUES ($1, $2::timestamptz[], $3)
     ON CONFLICT (identifier) DO UPDATE SET
       attempts = EXCLUDED.attempts,
       locked_until = EXCLUDED.locked_until`,
    [identifier, state.attempts.map(msIso), state.lockedUntil ? msIso(state.lockedUntil) : null]
  );
}

/**
 * Atomically append one failed attempt (epoch ms) to an identifier's attempts and
 * return the resulting attempts. Unlike load + save it cannot lose an attempt
 * recorded by another process in between.
 */
export async function appendLockoutAttempt(
  identifier: string,
  attemptMs: number
): Promise<number[]> {
  const row = await db().queryOne(
    `WITH upserted AS (
       INSERT INTO domain_lockout_state (identifier, attempts)
       VALUES ($1, ARRAY[$2::timestamptz])
       ON CONFLICT (identifier) DO UPDATE
         SET attempts = array_append(domain_lockout_state.attempts, $2::timestamptz)
       RETURNING identifier, locked_until, attempts
     )
     SELECT identifier, locked_until,
       (SELECT COALESCE(array_agg(round(extract(epoch FROM a) * 1000)::float8 ORDER BY ord), '{}')
          FROM unnest(attempts) WITH ORDINALITY AS t(a, ord)) AS attempts_ms
     FROM upserted`,
    [identifier, msIso(attemptMs)]
  );
  return row ? toLockoutState(asRecord(row)).attempts : [];
}

/**
 * Load lockout state for an identifier.
 * @param {string} identifier
 * @returns {{ attempts: number[], lockedUntil: number|null } | null}
 */
export async function loadLockoutState(identifier: string): Promise<LockoutStateRecord | null> {
  const row = await db().queryOne(
    `SELECT ${LOCKOUT_COLUMNS} FROM domain_lockout_state WHERE identifier = $1`,
    [identifier]
  );
  return row ? toLockoutState(asRecord(row)) : null;
}

/**
 * Delete lockout state for an identifier.
 * @param {string} identifier
 */
export async function deleteLockoutState(identifier: string) {
  await db().execute("DELETE FROM domain_lockout_state WHERE identifier = $1", [identifier]);
}

/**
 * Get all locked identifiers.
 * @returns {Array<{identifier: string, lockedUntil: number}>}
 */
export async function loadAllLockedIdentifiers() {
  const rows = await db().query(
    `SELECT identifier, locked_until FROM domain_lockout_state
     WHERE locked_until IS NOT NULL AND locked_until > $1`,
    [msIso(Date.now())]
  );
  return rows
    .map((row) => {
      const record = asRecord(row);
      return {
        identifier: typeof record.identifier === "string" ? record.identifier : "",
        lockedUntil: toMs(record.locked_until as string | null) ?? 0,
      };
    })
    .filter((row) => row.identifier.length > 0);
}

// ──────────────── Circuit Breakers ────────────────

/**
 * Save circuit breaker state.
 * @param {string} name
 * @param {{ state: string, failureCount: number, lastFailureTime: number|null, options?: object }} cbState
 */
export async function saveCircuitBreakerState(name: string, cbState: CircuitBreakerStateRecord) {
  await db().execute(
    `INSERT INTO domain_circuit_breakers (name, state, failure_count, last_failure_time, options, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (name) DO UPDATE SET
       state = EXCLUDED.state,
       failure_count = EXCLUDED.failure_count,
       last_failure_time = EXCLUDED.last_failure_time,
       options = EXCLUDED.options,
       updated_at = now()`,
    [
      name,
      BREAKER_STATES.has(cbState.state) ? cbState.state : "CLOSED",
      Math.round(cbState.failureCount),
      msOrNull(cbState.lastFailureTime),
      cbState.options ? jsonb(cbState.options) : null,
    ]
  );
}

/**
 * Load circuit breaker state.
 * @param {string} name
 * @returns {{ state: string, failureCount: number, lastFailureTime: number|null, options?: object } | null}
 */
export async function loadCircuitBreakerState(
  name: string
): Promise<CircuitBreakerStateRecord | null> {
  const row = await db().queryOne("SELECT * FROM domain_circuit_breakers WHERE name = $1", [name]);
  if (!row) return null;
  const record = asRecord(row);
  const options = parseJsonIfString(record.options);
  return {
    state: typeof record.state === "string" ? record.state : "CLOSED",
    failureCount: toNumber(record.failure_count),
    lastFailureTime: toMs(record.last_failure_time as string | null) || null,
    options: options && typeof options === "object" ? (options as JsonRecord) : null,
  };
}

/**
 * Load all circuit breaker states.
 * @returns {Array<{name: string, state: string, failureCount: number, lastFailureTime: number|null}>}
 */
export async function loadAllCircuitBreakerStates() {
  const rows = await db().query(
    "SELECT name, state, failure_count, last_failure_time FROM domain_circuit_breakers ORDER BY name"
  );
  return rows
    .map((row) => {
      const record = asRecord(row);
      return {
        name: typeof record.name === "string" ? record.name : "",
        state: typeof record.state === "string" ? record.state : "CLOSED",
        failureCount: toNumber(record.failure_count),
        lastFailureTime: toMs(record.last_failure_time as string | null) || null,
      };
    })
    .filter((row) => row.name.length > 0);
}

/**
 * Delete a circuit breaker state.
 * @param {string} name
 */
export async function deleteCircuitBreakerState(name: string) {
  await db().execute("DELETE FROM domain_circuit_breakers WHERE name = $1", [name]);
}

/**
 * Delete all circuit breaker states.
 */
export async function deleteAllCircuitBreakerStates() {
  await db().execute("DELETE FROM domain_circuit_breakers");
}
