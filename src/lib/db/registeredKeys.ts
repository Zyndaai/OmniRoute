/**
 * db/registeredKeys.ts — Registered Keys Provisioning (#464)
 *
 * Handles:
 *   - Issuing registered keys with idempotency
 *   - Per-provider and per-account quota enforcement
 *   - Key revocation
 *   - Quota status queries for rate-limiting decisions
 *
 * Tables: registered_keys, registered_key_limits (scope 'provider' | 'account').
 */

import { randomBytes } from "crypto";
import { opaqueTokenFingerprint } from "@omniroute/open-sse/utils/opaqueTokenFingerprint.ts";
import { v4 as uuidv4 } from "uuid";
import { db, ts, type DbExecutor } from "@/lib/db/pg";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RegisteredKey {
  id: string;
  keyPrefix: string;
  name: string;
  provider: string;
  accountId: string;
  isActive: boolean;
  revokedAt: string | null;
  expiresAt: string | null;
  idempotencyKey: string | null;
  dailyBudget: number | null;
  hourlyBudget: number | null;
  dailyUsed: number;
  hourlyUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegisteredKeyWithSecret extends RegisteredKey {
  /** Raw key material — only returned once on creation */
  rawKey: string;
}

export interface ProviderKeyLimit {
  provider: string;
  maxActiveKeys: number | null;
  dailyIssueLimit: number | null;
  hourlyIssueLimit: number | null;
  dailyIssued: number;
  hourlyIssued: number;
  updatedAt: string;
}

export interface AccountKeyLimit {
  accountId: string;
  maxActiveKeys: number | null;
  dailyIssueLimit: number | null;
  hourlyIssueLimit: number | null;
  dailyIssued: number;
  hourlyIssued: number;
  updatedAt: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  errorCode?: string;
  errorMessage?: string;
  provider?: string;
  accountId?: string;
  providerActiveKeys?: number;
  accountActiveKeys?: number;
}

export interface IssueKeyParams {
  name: string;
  provider?: string;
  accountId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
  dailyBudget?: number;
  hourlyBudget?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LimitScope = "provider" | "account";

function nowDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Start of the current UTC hour, as an ISO timestamp. */
function nowHour(): string {
  return new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
}

function sameInstant(a: string | null | undefined, b: string): boolean {
  return !!a && Date.parse(a) === Date.parse(b);
}

function hashKey(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  return opaqueTokenFingerprint(raw);
}

function generateRawKey(): string {
  // ork_ prefix so users can easily identify these keys
  return "ork_" + randomBytes(24).toString("base64url");
}

// ─── Row mapping ─────────────────────────────────────────────────────────────

interface RegisteredKeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  provider: string | null;
  account_id: string | null;
  is_active: boolean;
  revoked_at: string | null;
  expires_at: string | null;
  idempotency_key: string | null;
  daily_budget: number | null;
  hourly_budget: number | null;
  daily_used: number;
  hourly_used: number;
  last_reset_day: string | null;
  last_reset_hour: string | null;
  created_at: string;
  updated_at: string;
}

interface KeyLimitRow {
  scope: LimitScope;
  scope_id: string;
  max_active_keys: number | null;
  daily_issue_limit: number | null;
  hourly_issue_limit: number | null;
  daily_issued: number;
  hourly_issued: number;
  last_reset_day: string | null;
  last_reset_hour: string | null;
  updated_at: string;
}

function rowToRegisteredKey(row: RegisteredKeyRow): RegisteredKey {
  return {
    id: row.id,
    keyPrefix: row.key_prefix,
    name: row.name,
    provider: row.provider ?? "",
    accountId: row.account_id ?? "",
    isActive: row.is_active === true,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    dailyBudget: row.daily_budget,
    hourlyBudget: row.hourly_budget,
    dailyUsed: row.daily_used,
    hourlyUsed: row.hourly_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Issued counters as they stand now: a window that rolled over reads as 0 (lazy reset). */
function effectiveIssued(row: KeyLimitRow): { dailyIssued: number; hourlyIssued: number } {
  return {
    dailyIssued: row.last_reset_day === nowDay() ? row.daily_issued : 0,
    hourlyIssued: sameInstant(row.last_reset_hour, nowHour()) ? row.hourly_issued : 0,
  };
}

async function getLimitRow(
  executor: DbExecutor,
  scope: LimitScope,
  scopeId: string
): Promise<KeyLimitRow | undefined> {
  return executor.queryOne<KeyLimitRow>(
    "SELECT * FROM registered_key_limits WHERE scope = $1 AND scope_id = $2",
    [scope, scopeId]
  );
}

/** Atomically count one issuance, restarting the counters when the day or hour changed. */
async function incrementIssued(
  executor: DbExecutor,
  scope: LimitScope,
  scopeId: string
): Promise<void> {
  await executor.execute(
    `INSERT INTO registered_key_limits (scope, scope_id, daily_issued, hourly_issued, last_reset_day, last_reset_hour)
     VALUES ($1, $2, 1, 1, $3::date, $4::timestamptz)
     ON CONFLICT (scope, scope_id) DO UPDATE SET
       daily_issued = CASE WHEN registered_key_limits.last_reset_day IS DISTINCT FROM $3::date
                           THEN 1 ELSE registered_key_limits.daily_issued + 1 END,
       hourly_issued = CASE WHEN registered_key_limits.last_reset_hour IS DISTINCT FROM $4::timestamptz
                            THEN 1 ELSE registered_key_limits.hourly_issued + 1 END,
       last_reset_day = $3::date,
       last_reset_hour = $4::timestamptz,
       updated_at = now()`,
    [scope, scopeId, nowDay(), nowHour()]
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function checkScopeQuota(
  scope: LimitScope,
  scopeId: string
): Promise<QuotaCheckResult | null> {
  const column = scope === "provider" ? "provider" : "account_id";
  const label = scope === "provider" ? "provider" : "account";
  const errorCode = scope === "provider" ? "PROVIDER_QUOTA_EXCEEDED" : "ACCOUNT_QUOTA_EXCEEDED";
  const idField = scope === "provider" ? { provider: scopeId } : { accountId: scopeId };

  const row = await getLimitRow(db(), scope, scopeId);
  if (!row) return null;
  const { dailyIssued, hourlyIssued } = effectiveIssued(row);

  if (row.hourly_issue_limit !== null && hourlyIssued >= row.hourly_issue_limit) {
    return {
      allowed: false,
      errorCode,
      errorMessage: `Hourly issue limit (${row.hourly_issue_limit}) reached for ${label} '${scopeId}'`,
      ...idField,
    };
  }
  if (row.daily_issue_limit !== null && dailyIssued >= row.daily_issue_limit) {
    return {
      allowed: false,
      errorCode,
      errorMessage: `Daily issue limit (${row.daily_issue_limit}) reached for ${label} '${scopeId}'`,
      ...idField,
    };
  }
  if (row.max_active_keys !== null) {
    const counted = await db().queryOne<{ active_count: number }>(
      `SELECT COUNT(*)::int AS active_count FROM registered_keys WHERE ${column} = $1 AND is_active = true`,
      [scopeId]
    );
    const activeCount = counted?.active_count ?? 0;
    if (activeCount >= row.max_active_keys) {
      return {
        allowed: false,
        errorCode: "MAX_ACTIVE_KEYS_EXCEEDED",
        errorMessage: `Max active keys (${row.max_active_keys}) reached for ${label} '${scopeId}'`,
        ...idField,
        ...(scope === "provider"
          ? { providerActiveKeys: activeCount }
          : { accountActiveKeys: activeCount }),
      };
    }
  }
  return null;
}

/**
 * Check if a new registered key can be issued for the given provider/account.
 * Returns { allowed: true } or { allowed: false, errorCode, errorMessage }.
 */
export async function checkQuota(provider = "", accountId = ""): Promise<QuotaCheckResult> {
  if (provider) {
    const denied = await checkScopeQuota("provider", provider);
    if (denied) return denied;
  }
  if (accountId) {
    const denied = await checkScopeQuota("account", accountId);
    if (denied) return denied;
  }
  return { allowed: true };
}

/**
 * Issue a new registered key.
 * Returns the key with rawKey (only on creation) or an idempotency conflict carrying the
 * existing key when the idempotency key was already used.
 */
export async function issueRegisteredKey(
  params: IssueKeyParams
): Promise<RegisteredKeyWithSecret | { idempotencyConflict: true; existing: RegisteredKey }> {
  const {
    name,
    provider = "",
    accountId = "",
    idempotencyKey,
    expiresAt,
    dailyBudget,
    hourlyBudget,
  } = params;

  const rawKey = generateRawKey();
  const id = uuidv4();
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12); // "ork_" + 8 chars

  const outcome = await db().transaction(async (tx) => {
    // A single statement settles the idempotency race: the loser gets no row back.
    const inserted = await tx.queryOne<RegisteredKeyRow>(
      `INSERT INTO registered_keys
         (id, key_hash, key_prefix, name, provider, account_id, idempotency_key, expires_at,
          daily_budget, hourly_budget, last_reset_day, last_reset_hour)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        id,
        keyHash,
        keyPrefix,
        name,
        provider || null,
        accountId || null,
        idempotencyKey ?? null,
        ts(expiresAt),
        dailyBudget ?? null,
        hourlyBudget ?? null,
        nowDay(),
        nowHour(),
      ]
    );

    if (!inserted) {
      const existing = await tx.queryOne<RegisteredKeyRow>(
        "SELECT * FROM registered_keys WHERE idempotency_key = $1",
        [idempotencyKey ?? null]
      );
      return { existing };
    }

    // Increment provider/account issuance counters
    if (provider) await incrementIssued(tx, "provider", provider);
    if (accountId) await incrementIssued(tx, "account", accountId);
    return { created: inserted };
  });

  if ("created" in outcome) {
    return { ...rowToRegisteredKey(outcome.created), rawKey };
  }
  if (!outcome.existing) {
    throw new Error("Registered key insert was skipped without an idempotency match");
  }
  return { idempotencyConflict: true, existing: rowToRegisteredKey(outcome.existing) };
}

/**
 * Get a registered key by ID (without the raw key — only prefix is returned).
 */
export async function getRegisteredKey(id: string): Promise<RegisteredKey | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db().queryOne<RegisteredKeyRow>("SELECT * FROM registered_keys WHERE id = $1", [
    id,
  ]);
  return row ? rowToRegisteredKey(row) : null;
}

/**
 * List all registered keys (optionally filtered by provider/accountId).
 */
export async function listRegisteredKeys(
  opts: { provider?: string; accountId?: string } = {}
): Promise<RegisteredKey[]> {
  let sql = "SELECT * FROM registered_keys WHERE true";
  const args: string[] = [];
  if (opts.provider) {
    args.push(opts.provider);
    sql += ` AND provider = $${args.length}`;
  }
  if (opts.accountId) {
    args.push(opts.accountId);
    sql += ` AND account_id = $${args.length}`;
  }
  sql += " ORDER BY created_at DESC LIMIT 500";
  const rows = await db().query<RegisteredKeyRow>(sql, args);
  return rows.map(rowToRegisteredKey);
}

/**
 * Revoke a registered key by ID.
 */
export async function revokeRegisteredKey(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const result = await db().execute(
    `UPDATE registered_keys
     SET is_active = false, revoked_at = now(), updated_at = now()
     WHERE id = $1 AND is_active = true`,
    [id]
  );
  return result.changes > 0;
}

/**
 * Validate a raw registered key against stored hashes.
 * Returns the key metadata if valid, null otherwise.
 */
export async function validateRegisteredKey(rawKey: string): Promise<RegisteredKey | null> {
  const hash = hashKey(rawKey);
  if (!hash) return null;
  let row = await db().queryOne<RegisteredKeyRow>(
    `SELECT * FROM registered_keys
     WHERE key_hash = $1 AND is_active = true
       AND (expires_at IS NULL OR expires_at > now())`,
    [hash]
  );
  if (!row) return null;

  // Auto-reset budget windows if needed
  const today = nowDay();
  const hour = nowHour();
  if (row.last_reset_day !== today || !sameInstant(row.last_reset_hour, hour)) {
    const reset = await db().queryOne<RegisteredKeyRow>(
      `UPDATE registered_keys
       SET daily_used = CASE WHEN last_reset_day IS DISTINCT FROM $1::date THEN 0 ELSE daily_used END,
           hourly_used = CASE WHEN last_reset_hour IS DISTINCT FROM $2::timestamptz THEN 0 ELSE hourly_used END,
           last_reset_day = $1::date, last_reset_hour = $2::timestamptz, updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [today, hour, row.id]
    );
    if (reset) row = reset;
  }

  // Budget check
  if (row.daily_budget !== null && row.daily_used >= row.daily_budget) return null;
  if (row.hourly_budget !== null && row.hourly_used >= row.hourly_budget) return null;

  return rowToRegisteredKey(row);
}

/**
 * Increment usage counters for a registered key (called by request pipeline).
 */
export async function incrementRegisteredKeyUsage(id: string): Promise<void> {
  if (!UUID_RE.test(id)) return;
  await db().execute(
    `UPDATE registered_keys
     SET daily_used = daily_used + 1, hourly_used = hourly_used + 1, updated_at = now()
     WHERE id = $1`,
    [id]
  );
}

// ─── Provider / Account Limit Management ──────────────────────────────────────

async function setKeyLimit(
  scope: LimitScope,
  scopeId: string,
  limits: {
    maxActiveKeys?: number | null;
    dailyIssueLimit?: number | null;
    hourlyIssueLimit?: number | null;
  }
): Promise<void> {
  await db().execute(
    `INSERT INTO registered_key_limits
       (scope, scope_id, max_active_keys, daily_issue_limit, hourly_issue_limit, last_reset_day, last_reset_hour)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::timestamptz)
     ON CONFLICT (scope, scope_id) DO UPDATE SET
       max_active_keys = EXCLUDED.max_active_keys,
       daily_issue_limit = EXCLUDED.daily_issue_limit,
       hourly_issue_limit = EXCLUDED.hourly_issue_limit,
       updated_at = now()`,
    [
      scope,
      scopeId,
      limits.maxActiveKeys ?? null,
      limits.dailyIssueLimit ?? null,
      limits.hourlyIssueLimit ?? null,
      nowDay(),
      nowHour(),
    ]
  );
}

export async function setProviderKeyLimit(
  provider: string,
  limits: Partial<Omit<ProviderKeyLimit, "provider" | "dailyIssued" | "hourlyIssued" | "updatedAt">>
): Promise<void> {
  await setKeyLimit("provider", provider, limits);
}

export async function setAccountKeyLimit(
  accountId: string,
  limits: Partial<Omit<AccountKeyLimit, "accountId" | "dailyIssued" | "hourlyIssued" | "updatedAt">>
): Promise<void> {
  await setKeyLimit("account", accountId, limits);
}

export async function getProviderKeyLimit(provider: string): Promise<ProviderKeyLimit | null> {
  const row = await getLimitRow(db(), "provider", provider);
  if (!row) return null;
  return {
    provider: row.scope_id,
    maxActiveKeys: row.max_active_keys,
    dailyIssueLimit: row.daily_issue_limit,
    hourlyIssueLimit: row.hourly_issue_limit,
    ...effectiveIssued(row),
    updatedAt: row.updated_at,
  };
}

export async function getAccountKeyLimit(accountId: string): Promise<AccountKeyLimit | null> {
  const row = await getLimitRow(db(), "account", accountId);
  if (!row) return null;
  return {
    accountId: row.scope_id,
    maxActiveKeys: row.max_active_keys,
    dailyIssueLimit: row.daily_issue_limit,
    hourlyIssueLimit: row.hourly_issue_limit,
    ...effectiveIssued(row),
    updatedAt: row.updated_at,
  };
}
