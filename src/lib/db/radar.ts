/**
 * radar.ts — Radar client local DB module
 *
 * Provides local cache + settings storage for the OmniRoute Radar client.
 * Nothing here talks to the network (that's the sync layer).
 *
 * Tables:
 *   - radar_cache: one signed document per feed kind ('feed' = catalog,
 *     'referrals' = `GET /v1/referrals/latest`, 'offers' = live offers,
 *     'intel' = live Intel plus a one-way supporter identity used for local
 *     recognition). `payload` is kept byte-exact for signature checks.
 *   - radar_settings: singleton (id = 1) with opt-in + encrypted supporter key
 *   - radar_local_model_state: operator-owned display/enabled overrides and
 *     deletion tombstones, keyed by provider + model ID.
 *
 * The supporter key is encrypted at rest with AES-256-GCM using the same
 * `encrypt()`/`decrypt()` helpers from `./encryption.ts` that protect
 * provider connection credentials.
 */

import { db, ts, type DbExecutor } from "@/lib/db/pg";
import { encrypt, decrypt } from "./encryption";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RadarCache {
  version: string;
  /** Date the feed's data was built, from the feed itself. Null when unknown. */
  generatedAt: string | null;
  tier: string;
  payload: string;
  signature: string;
  fetchedAt: string;
}

export interface RadarSettings {
  optIn: boolean;
  supporterKey: string | null;
  updatedAt: string;
}

export interface RadarReferralsCache {
  generatedAt: string;
  tier: string;
  payload: string;
  signature: string;
  fetchedAt: string;
}

export interface RadarOffersCache {
  version: string;
  tier: "live";
  payload: string;
  signature: string;
  fetchedAt: string;
}

export interface RadarIntelCache {
  version: string;
  tier: "live";
  payload: string;
  signature: string;
  supporterIdentity: string;
  fetchedAt: string;
}

export interface RadarLocalModelState {
  provider: string;
  modelId: string;
  displayName: string | null;
  enabled: boolean | null;
  tombstoned: boolean;
  updatedAt: string;
}

export interface RadarLocalModelOverridePatch {
  displayName?: string | null;
  enabled?: boolean | null;
}

export interface RadarLocalMergeState {
  localOverrides: Map<string, { displayName?: string; enabled?: boolean }>;
  tombstones: Set<string>;
}

interface RadarLocalModelStateRow {
  provider: string;
  model_id: string;
  display_name: string | null;
  enabled: boolean | null;
  tombstoned: boolean;
  updated_at: string;
}

type RadarCacheKind = "feed" | "referrals" | "offers" | "intel";

/** Postgres rejects U+0000; the signed payloads are JSON text that never carries it. */
function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
}

// ---------------------------------------------------------------------------
// radar_cache (one row per feed kind)
// ---------------------------------------------------------------------------

async function upsertRadarCache(
  kind: RadarCacheKind,
  entry: {
    version: string | null;
    generatedAt: string | null;
    tier: string;
    payload: string;
    signature: string;
    supporterIdentity?: string | null;
    fetchedAt?: string;
  }
): Promise<void> {
  const fetchedAt = ts(entry.fetchedAt) ?? new Date().toISOString();
  await db().execute(
    `INSERT INTO radar_cache
       (kind, version, generated_at, tier, payload, signature, supporter_identity, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (kind) DO UPDATE SET
       version            = EXCLUDED.version,
       generated_at       = EXCLUDED.generated_at,
       tier               = EXCLUDED.tier,
       payload            = EXCLUDED.payload,
       signature          = EXCLUDED.signature,
       supporter_identity = EXCLUDED.supporter_identity,
       fetched_at         = EXCLUDED.fetched_at`,
    [
      kind,
      entry.version,
      entry.generatedAt,
      entry.tier,
      stripNul(entry.payload),
      entry.signature,
      entry.supporterIdentity ?? null,
      fetchedAt,
    ]
  );
}

/**
 * Read the cached Radar feed. Returns null when no feed has been cached yet.
 */
export async function getRadarCache(): Promise<RadarCache | null> {
  const row = await db().queryOne<RadarCache>(
    `SELECT version, generated_at AS "generatedAt", tier, payload, signature,
            fetched_at AS "fetchedAt" FROM radar_cache WHERE kind = 'feed'`
  );
  return row ?? null;
}

/**
 * Upsert the Radar feed cache (single row).  Replaces any existing entry.
 * If `fetchedAt` is omitted, the current ISO timestamp is used.
 */
export async function setRadarCache(entry: {
  version: string;
  generatedAt?: string | null;
  tier: string;
  payload: string;
  signature: string;
  fetchedAt?: string;
}): Promise<void> {
  await upsertRadarCache("feed", {
    version: entry.version,
    generatedAt: entry.generatedAt ?? null,
    tier: entry.tier,
    payload: entry.payload,
    signature: entry.signature,
    fetchedAt: entry.fetchedAt,
  });
}

// ---------------------------------------------------------------------------
// radar_settings
// ---------------------------------------------------------------------------

/**
 * Read the Radar settings. The supporter key is decrypted on read.
 * The settings row is seeded by the schema migration; a missing row reads as defaults.
 */
export async function getRadarSettings(): Promise<RadarSettings> {
  const row = await db().queryOne<{
    opt_in: boolean;
    supporter_key_encrypted: string | null;
    updated_at: string | null;
  }>("SELECT opt_in, supporter_key_encrypted, updated_at FROM radar_settings WHERE id = 1");

  return {
    optIn: row?.opt_in === true,
    supporterKey: decrypt(row?.supporter_key_encrypted ?? null) ?? null,
    updatedAt: row?.updated_at ?? new Date(0).toISOString(),
  };
}

/**
 * Set the Radar opt-in state.
 */
export async function setRadarOptIn(optIn: boolean): Promise<void> {
  await db().execute(
    `INSERT INTO radar_settings (id, opt_in, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET opt_in = EXCLUDED.opt_in, updated_at = EXCLUDED.updated_at`,
    [optIn]
  );
}

/**
 * Set (or clear) the Radar supporter key.  The key is encrypted at rest
 * using the same AES-256-GCM mechanism as provider credentials.
 * Pass `null` to clear.
 */
export async function setRadarKey(key: string | null): Promise<void> {
  const encrypted = key !== null ? encrypt(key) : null;

  await db().transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO radar_settings (id, supporter_key_encrypted, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET
         supporter_key_encrypted = EXCLUDED.supporter_key_encrypted,
         updated_at = EXCLUDED.updated_at`,
      [encrypted]
    );
    // All signed feeds are entitlement-sensitive. Clearing their cached
    // variants forces the next sync/read to resolve the new key server-side
    // instead of serving data fetched under the previous entitlement.
    await tx.execute("DELETE FROM radar_cache");
  });
}

// ---------------------------------------------------------------------------
// radar_cache kind = 'referrals'
// ---------------------------------------------------------------------------

/**
 * Read the cached Radar referrals feed (`GET /v1/referrals/latest`).
 * Returns null when no referrals feed has been cached yet — separate from,
 * and never falling back to, the catalog's 'feed' row.
 */
export async function getRadarReferralsCache(): Promise<RadarReferralsCache | null> {
  const row = await db().queryOne<RadarReferralsCache>(
    `SELECT generated_at AS "generatedAt", tier, payload, signature, fetched_at AS "fetchedAt"
       FROM radar_cache WHERE kind = 'referrals'`
  );
  return row ?? null;
}

/**
 * Upsert the Radar referrals feed cache (single row). Replaces any existing
 * entry. If `fetchedAt` is omitted, the current ISO timestamp is used.
 */
export async function setRadarReferralsCache(entry: {
  generatedAt: string;
  tier: string;
  payload: string;
  signature: string;
  fetchedAt?: string;
}): Promise<void> {
  await upsertRadarCache("referrals", {
    version: null,
    generatedAt: entry.generatedAt,
    tier: entry.tier,
    payload: entry.payload,
    signature: entry.signature,
    fetchedAt: entry.fetchedAt,
  });
}

// ---------------------------------------------------------------------------
// radar_cache kind = 'offers'
// ---------------------------------------------------------------------------

export async function getRadarOffersCache(): Promise<RadarOffersCache | null> {
  const row = await db().queryOne<RadarOffersCache>(
    `SELECT version, tier, payload, signature, fetched_at AS "fetchedAt"
       FROM radar_cache WHERE kind = 'offers'`
  );
  return row ?? null;
}

export async function setRadarOffersCache(entry: {
  version: string;
  tier: "live";
  payload: string;
  signature: string;
  fetchedAt?: string;
}): Promise<void> {
  await upsertRadarCache("offers", {
    version: entry.version,
    generatedAt: null,
    tier: entry.tier,
    payload: entry.payload,
    signature: entry.signature,
    fetchedAt: entry.fetchedAt,
  });
}

// ---------------------------------------------------------------------------
// radar_cache kind = 'intel'
// ---------------------------------------------------------------------------

export async function getRadarIntelCache(): Promise<RadarIntelCache | null> {
  const row = await db().queryOne<RadarIntelCache>(
    `SELECT version, tier, payload, signature, supporter_identity AS "supporterIdentity",
            fetched_at AS "fetchedAt" FROM radar_cache WHERE kind = 'intel'`
  );
  return row ?? null;
}

export async function setRadarIntelCache(entry: {
  version: string;
  tier: "live";
  payload: string;
  signature: string;
  supporterIdentity: string;
  fetchedAt?: string;
}): Promise<void> {
  await upsertRadarCache("intel", {
    version: entry.version,
    generatedAt: null,
    tier: entry.tier,
    payload: entry.payload,
    signature: entry.signature,
    supporterIdentity: entry.supporterIdentity,
    fetchedAt: entry.fetchedAt,
  });
}

// ---------------------------------------------------------------------------
// radar_local_model_state
// ---------------------------------------------------------------------------

const RADAR_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function normalizeRadarIdentity(
  provider: unknown,
  modelId: unknown
): { provider: string; modelId: string } | null {
  const normalizedProvider = typeof provider === "string" ? provider.trim() : "";
  const normalizedModelId = typeof modelId === "string" ? modelId.trim() : "";
  if (!RADAR_PROVIDER_PATTERN.test(normalizedProvider)) return null;
  if (
    normalizedModelId.length < 1 ||
    normalizedModelId.length > 200 ||
    CONTROL_CHARACTER_PATTERN.test(normalizedModelId)
  ) {
    return null;
  }
  return { provider: normalizedProvider, modelId: normalizedModelId };
}

function normalizeDisplayName(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 160 ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function rowToRadarLocalModelState(row: RadarLocalModelStateRow): RadarLocalModelState {
  return {
    provider: row.provider,
    modelId: row.model_id,
    displayName: row.display_name,
    enabled: row.enabled,
    tombstoned: row.tombstoned,
    updatedAt: row.updated_at,
  };
}

/**
 * Locks the model for the read-modify-write that follows, so two writers cannot lose each
 * other. FOR UPDATE alone cannot lock a row that does not exist yet, hence the advisory lock.
 */
async function readRadarLocalModelStateRow(
  tx: DbExecutor,
  provider: string,
  modelId: string
): Promise<RadarLocalModelStateRow | null> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `radar_local_model_state:${provider}:${modelId}`,
  ]);
  return (
    (await tx.queryOne<RadarLocalModelStateRow>(
      `SELECT provider, model_id, display_name, enabled, tombstoned, updated_at
         FROM radar_local_model_state WHERE provider = $1 AND model_id = $2 FOR UPDATE`,
      [provider, modelId]
    )) ?? null
  );
}

async function persistRadarLocalModelState(
  tx: DbExecutor,
  input: {
    provider: string;
    modelId: string;
    displayName: string | null;
    enabled: boolean | null;
    tombstoned: boolean;
  }
): Promise<void> {
  if (input.displayName === null && input.enabled === null && !input.tombstoned) {
    await tx.execute("DELETE FROM radar_local_model_state WHERE provider = $1 AND model_id = $2", [
      input.provider,
      input.modelId,
    ]);
    return;
  }

  await tx.execute(
    `INSERT INTO radar_local_model_state
       (provider, model_id, display_name, enabled, tombstoned, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider, model_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       enabled = EXCLUDED.enabled,
       tombstoned = EXCLUDED.tombstoned,
       updated_at = EXCLUDED.updated_at`,
    [input.provider, input.modelId, input.displayName, input.enabled, input.tombstoned]
  );
}

/** List every persisted override/tombstone for UI editing and restore controls. */
export async function listRadarLocalModelState(): Promise<RadarLocalModelState[]> {
  const rows = await db().query<RadarLocalModelStateRow>(
    `SELECT provider, model_id, display_name, enabled, tombstoned, updated_at
       FROM radar_local_model_state ORDER BY provider, model_id`
  );
  return rows.map(rowToRadarLocalModelState);
}

/**
 * Merge a validated partial override into the existing row. `null` clears a
 * field; `undefined` preserves it. Tombstone state is never changed here.
 */
export async function setRadarLocalModelOverride(
  provider: unknown,
  modelId: unknown,
  patch: RadarLocalModelOverridePatch
): Promise<boolean> {
  const identity = normalizeRadarIdentity(provider, modelId);
  if (!identity || !patch || typeof patch !== "object") return false;
  const keys = Object.keys(patch);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "displayName" && key !== "enabled") ||
    (Object.hasOwn(patch, "enabled") &&
      patch.enabled !== null &&
      typeof patch.enabled !== "boolean")
  ) {
    return false;
  }

  const normalizedDisplayName = normalizeDisplayName(patch.displayName);
  if (Object.hasOwn(patch, "displayName") && normalizedDisplayName === undefined) return false;

  await db().transaction(async (tx) => {
    const current = await readRadarLocalModelStateRow(tx, identity.provider, identity.modelId);
    await persistRadarLocalModelState(tx, {
      ...identity,
      displayName: Object.hasOwn(patch, "displayName")
        ? (normalizedDisplayName ?? null)
        : (current?.display_name ?? null),
      enabled: Object.hasOwn(patch, "enabled") ? (patch.enabled ?? null) : (current?.enabled ?? null),
      tombstoned: current?.tombstoned === true,
    });
  });
  return true;
}

/** Clear both editable fields while preserving an independent tombstone. */
export async function clearRadarLocalModelOverride(
  provider: unknown,
  modelId: unknown
): Promise<boolean> {
  const identity = normalizeRadarIdentity(provider, modelId);
  if (!identity) return false;

  await db().transaction(async (tx) => {
    const current = await readRadarLocalModelStateRow(tx, identity.provider, identity.modelId);
    await persistRadarLocalModelState(tx, {
      ...identity,
      displayName: null,
      enabled: null,
      tombstoned: current?.tombstoned === true,
    });
  });
  return true;
}

/** Hide or restore one model without modifying its editable local fields. */
export async function setRadarModelTombstone(
  provider: unknown,
  modelId: unknown,
  tombstoned: boolean
): Promise<boolean> {
  const identity = normalizeRadarIdentity(provider, modelId);
  if (!identity || typeof tombstoned !== "boolean") return false;

  await db().transaction(async (tx) => {
    const current = await readRadarLocalModelStateRow(tx, identity.provider, identity.modelId);
    await persistRadarLocalModelState(tx, {
      ...identity,
      displayName: current?.display_name ?? null,
      enabled: current?.enabled ?? null,
      tombstoned,
    });
  });
  return true;
}

/** Convert persisted rows into the exact read-time merge structures. */
export async function getRadarLocalMergeState(): Promise<RadarLocalMergeState> {
  const localOverrides = new Map<string, { displayName?: string; enabled?: boolean }>();
  const tombstones = new Set<string>();

  for (const state of await listRadarLocalModelState()) {
    const key = `${state.provider}:${state.modelId}`;
    const override: { displayName?: string; enabled?: boolean } = {};
    if (state.displayName !== null) override.displayName = state.displayName;
    if (state.enabled !== null) override.enabled = state.enabled;
    if (Object.keys(override).length > 0) localOverrides.set(key, override);
    if (state.tombstoned) tombstones.add(key);
  }

  return { localOverrides, tombstones };
}
