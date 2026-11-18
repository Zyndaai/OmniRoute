/**
 * db/apiKeys.js — API key management.
 */

import {
  parseApiKeyCodexServiceMode,
  type ApiKeyCodexServiceMode,
} from "../../shared/constants/codexServiceMode";
import { opaqueTokenFingerprint } from "@omniroute/open-sse/utils/opaqueTokenFingerprint.ts";
import { v4 as uuidv4 } from "uuid";
import { db, jsonb, ts } from "@/lib/db/pg";
import { rowToCamel } from "./caseMapping";
import { registerDbStateResetter } from "./stateReset";
import { invalidateReasoningRoutingRuleCache } from "./reasoningRoutingRules";
import { checkKeyModelAccess } from "./apiKeyGroups";
import { deleteOverridesForApiKey } from "./autoCandidateOverrides";
import { SYNTHETIC_ENV_API_KEY_ID } from "@/shared/constants/apiKeyIdentities";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";
import { onBusResync, onInvalidation, publishInvalidation } from "@/lib/cluster/bus";
import {
  appendUsageLimitUpdates,
  hasUsageLimitUpdate,
  parseApiKeyUsageLimitFields,
} from "./apiKeyUsageLimitFields";
import { setNoLog } from "../compliance/noLog";
import { resolveModelAlias } from "@omniroute/open-sse/services/modelDeprecation.ts";
import { stripNoThinkingAlias } from "@omniroute/open-sse/utils/noThinkingAlias.ts";
import { getProviderAlias, resolveProviderId } from "@/shared/constants/providers";
import { evaluateModelAccess } from "@/domain/modelAccessPolicy";
import { isSelfLoopBearer, selfLoopKeyOverrides } from "./apiKeys/selfLoopKey";
import {
  backfillApiKeySecretsAtRest,
  decryptApiKeySecret,
  encryptApiKeySecret,
} from "./apiKeys/secretAtRest";
import {
  findPublishedModel,
  isDeniedUnderCanonicalProvider,
  isPublishedModelHidden,
} from "./apiKeys/publishedModelLookup";
import {
  CLAUDE_CODE_PROVIDER_PREFIXES,
  preferClaudeCodeForUnprefixedClaudeModels,
  stripExtendedContextSuffix,
  isPotentialUnprefixedClaudeCodeModel,
  addModelCandidate,
  addProviderAliasScopedCandidates,
  modelPatternMatches,
  matchesWildcardPattern,
} from "./apiKeys/modelPermissions";
import { ALL_COMBOS_ACCESS_RULE } from "@/shared/constants/comboAccess";
import {
  parseAllowedModels,
  parseAllowedCombos,
  parseNoLog,
  parseAutoResolve,
  parseDisableNonPublicModels,
  parseAllowUsageCommand,
  parseIsActive,
  parseAccessSchedule,
  parseRateLimits,
  parseAllowedConnections,
  parseAllowedQuotas,
  parseStringList,
  parseNullableTimestamp,
  parseIsBanned,
  parseStreamDefaultMode,
  parseCacheDefaultMode,
  parseChaosModeEnabled,
  parseCompressionEnabled,
  parseAllowAutoCombos,
  parseAllowCcDiscoveryAliases,
  parseCatalogScope,
  parseForcedModel,
  parseModelAccessMode,
} from "./apiKeys/rowParsers";
import {
  clearModelPermissionCache,
  getCachedModelPermission,
  setCachedModelPermission,
  evictModelPermissionCache,
} from "./apiKeys/modelPermissionCache";
import type { ModelAccessMode } from "./apiKeys/modelAccessMode";
import {
  normalizeApiKeyPermissionsUpdate,
  type ApiKeyPermissionsUpdate,
} from "./apiKeys/permissionsUpdate";
import { getModelCatalogCacheVersion, invalidateModelCatalogCache } from "./readCache";
import type { AccessSchedule, RateLimitRule } from "./apiKeys/types";

// ──────────────── Performance Optimizations ────────────────

// The plaintext-secret pass runs once per process (and again after a state reset)
let _secretsSecured = false;

type JsonRecord = Record<string, unknown>;

interface CacheEntry<TValue> {
  timestamp: number;
  value: TValue;
}

interface CreateApiKeyOptions {
  modelAccessMode?: ModelAccessMode;
  allowedModels?: string[];
  allowedCombos?: string[];
  allowedConnections?: string[];
  preferredConnections?: string[];
  expiresAt?: string | null;
}

export type { AccessSchedule, RateLimitRule } from "./apiKeys/types";

interface ApiKeyMetadata {
  id: string;
  name: string;
  machineId: string | null;
  modelAccessMode: ModelAccessMode;
  allowedModels: string[];
  blockedModels: string[];
  allowedCombos: string[];
  allowedConnections: string[];
  preferredConnections: string[];
  allowedQuotas: string[];
  noLog: boolean;
  autoResolve: boolean;
  isActive: boolean;
  accessSchedule: AccessSchedule | null;
  maxRequestsPerDay: number | null;
  maxRequestsPerMinute: number | null;
  throttleDelayMs: number | null;
  rateLimits: RateLimitRule[] | null;
  maxSessions: number;
  revokedAt: string | null;
  expiresAt: string | null;
  ipAllowlist: string[];
  scopes: string[];
  isBanned: boolean;
  keyHash: string | null;
  proxyId: string | null;
  allowedEndpoints: string[];
  streamDefaultMode: "legacy" | "json";
  codexServiceMode: ApiKeyCodexServiceMode;
  cacheDefaultMode: "legacy" | "bypass";
  disableNonPublicModels: boolean;
  allowUsageCommand: boolean;
  usageLimitEnabled: boolean;
  dailyUsageLimitUsd: number | null;
  weeklyUsageLimitUsd: number | null;
  chaosModeEnabled: boolean;
  compressionEnabled: boolean;
  allowAutoCombos: boolean;
  allowCcDiscoveryAliases: boolean;
  catalogScope: "all" | "combos" | "models";
  forcedModel: string | null;
}

interface ApiKeyRow extends JsonRecord {
  id?: unknown;
  name?: unknown;
  key?: unknown;
  machine_id?: unknown;
  machineId?: unknown;
  allowed_models?: unknown;
  allowedModels?: unknown;
  model_access_mode?: unknown;
  modelAccessMode?: unknown;
  blocked_models?: unknown;
  blockedModels?: unknown;
  allowed_combos?: unknown;
  allowedCombos?: unknown;
  allowed_connections?: unknown;
  allowedConnections?: unknown;
  preferred_connections?: unknown;
  preferredConnections?: unknown;
  allowed_quotas?: unknown;
  allowedQuotas?: unknown;
  no_log?: unknown;
  noLog?: unknown;
  auto_resolve?: unknown;
  autoResolve?: unknown;
  is_active?: unknown;
  isActive?: unknown;
  access_schedule?: unknown;
  accessSchedule?: unknown;
  rate_limits?: unknown;
  rateLimits?: unknown;
  proxy_id?: unknown;
  stream_default_mode?: unknown;
  streamDefaultMode?: unknown;
  codex_service_mode?: unknown;
  codexServiceMode?: unknown;
  cache_default_mode?: unknown;
  cacheDefaultMode?: unknown;
  allow_usage_command?: unknown;
  allowUsageCommand?: unknown;
  usage_limit_enabled?: unknown;
  usageLimitEnabled?: unknown;
  daily_usage_limit_usd?: unknown;
  dailyUsageLimitUsd?: unknown;
  weekly_usage_limit_usd?: unknown;
  weeklyUsageLimitUsd?: unknown;
  chaos_mode_enabled?: unknown;
  chaosModeEnabled?: unknown;
  compression_enabled?: unknown;
  compressionEnabled?: unknown;
  allow_auto_combos?: unknown;
  allowAutoCombos?: unknown;
  allow_cc_discovery_aliases?: unknown;
  allowCcDiscoveryAliases?: unknown;
  catalog_scope?: unknown;
  catalogScope?: unknown;
  forced_model?: unknown;
  forcedModel?: unknown;
}

interface ApiKeyView extends JsonRecord {
  id?: string;
  modelAccessMode: ModelAccessMode;
  allowedModels: string[];
  blockedModels: string[];
  allowedCombos: string[];
  allowedConnections: string[];
  preferredConnections: string[];
  allowedQuotas: string[];
  noLog: boolean;
  autoResolve: boolean;
  isActive: boolean;
  accessSchedule: AccessSchedule | null;
  throttleDelayMs?: number | null;
  rateLimits: RateLimitRule[] | null;
  scopes: string[];
  proxyId?: string | null;
  isBanned?: boolean;
  expiresAt?: string | null;
  allowedEndpoints: string[];
  streamDefaultMode: "legacy" | "json";
  codexServiceMode: ApiKeyCodexServiceMode;
  cacheDefaultMode: "legacy" | "bypass";
  disableNonPublicModels?: boolean;
  allowUsageCommand?: boolean;
  usageLimitEnabled?: boolean;
  dailyUsageLimitUsd?: number | null;
  weeklyUsageLimitUsd?: number | null;
  chaosModeEnabled?: boolean;
  compressionEnabled: boolean;
  allowAutoCombos: boolean;
  allowCcDiscoveryAliases: boolean;
  catalogScope: "all" | "combos" | "models";
  forcedModel: string | null;
}

// LRU cache for API key validation (valid keys only)
const _keyValidationCache = new Map<string, { valid: boolean; timestamp: number }>();
const _keyMetadataCache = new Map<string, CacheEntry<ApiKeyMetadata>>();
const _lastUsedUpdateCache = new Map<string, number>();
// Writes clear these caches at once in every process (cluster bus, scope "api-keys"); the
// TTL only bounds how long a revoked key survives if a bus message is lost.
const CACHE_TTL = 30 * 1000;
const LAST_USED_UPDATE_TTL = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;
const EXCLUSIVE_LEASE_SCOPE = "lease:exclusive";

export class ApiKeyPolicyInvariantError extends Error {
  readonly code = "LEASE_KEY_POLICY_INVALID";
}

function assertExclusiveLeaseKeyPolicy(
  scopes: readonly string[],
  allowedConnections: readonly string[]
): void {
  if (scopes.includes(EXCLUSIVE_LEASE_SCOPE) && allowedConnections.length === 0) {
    throw new ApiKeyPolicyInvariantError("lease:exclusive requires explicit allowedConnections");
  }
}

const KEY_METADATA_COLUMNS =
  "id, name, machine_id, model_access_mode, allowed_models, blocked_models, allowed_combos, allowed_connections, preferred_connections, allowed_quotas, no_log, auto_resolve, is_active, access_schedule, max_requests_per_day, max_requests_per_minute, throttle_delay_ms, max_sessions, revoked_at, expires_at, ip_allowlist, scopes, rate_limits, is_banned, key_hash, allowed_endpoints, stream_default_mode, cache_default_mode, codex_service_mode, disable_non_public_models, allow_usage_command, usage_limit_enabled, daily_usage_limit_usd, weekly_usage_limit_usd, chaos_mode_enabled, compression_enabled, allow_auto_combos, allow_cc_discovery_aliases, catalog_scope, forced_model, proxy_id";

/** A timestamptz parameter from a caller-supplied expiry; a non-empty value must parse. */
/** Integer columns carry CHECK >= 0: round fractions, map negatives/NaN to null (no limit). */
function toIntColumn(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded < 0 ? null : rounded;
}

function expiryParam(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = ts(value);
  if (parsed === null) throw new Error(`Invalid expiresAt: ${value}`);
  return parsed;
}

/** The row parsers read JSON text; jsonb columns arrive already parsed. */
function asJsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Clear all caches (called on key create/update/delete), here and in every other cluster
 * process: a revoked or deleted key must stop working everywhere, not after a cache TTL.
 */
function invalidateCaches() {
  invalidateCachesLocal();
  publishInvalidation(API_KEYS_BUS_SCOPE);
}

function invalidateCachesLocal() {
  _keyValidationCache.clear();
  _keyMetadataCache.clear();
  clearModelPermissionCache();
  _lastUsedUpdateCache.clear();
}

// Received from another process: local twin only (never republished). Cleared again after
// a second in case the writer published before its transaction committed.
const API_KEYS_BUS_SCOPE = "api-keys";
onInvalidation(API_KEYS_BUS_SCOPE, () => {
  invalidateCachesLocal();
  setTimeout(invalidateCachesLocal, 1_000).unref?.();
});
onBusResync(invalidateCachesLocal);

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function isConfiguredEnvApiKey(key: string): boolean {
  const envKey = process.env.OMNIROUTE_API_KEY || process.env.ROUTER_API_KEY;
  return Boolean(envKey && timingSafeCompare(key, envKey));
}

function isRedisAuthCacheEnabled(): boolean {
  return process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE !== "1" && process.env.NODE_ENV !== "test";
}

async function deleteRedisAuthCacheEntry(keyHash: unknown): Promise<void> {
  if (!isRedisAuthCacheEnabled() || typeof keyHash !== "string" || keyHash.trim() === "") return;

  try {
    const { getRedisClient, isRedisConfigured } = await import("@/shared/utils/rateLimiter");
    if (!isRedisConfigured()) return;
    const redis = await getRedisClient();
    await redis.del(`auth:api_key:${keyHash}`);
  } catch {
    // Redis is an optimization for auth caching; the database remains authoritative.
  }
}

async function deleteRedisAuthCacheEntries(...keyHashes: unknown[]): Promise<void> {
  await Promise.all(keyHashes.map((keyHash) => deleteRedisAuthCacheEntry(keyHash)));
}

async function deleteRedisAuthCacheForKeyId(id: string): Promise<void> {
  if (!isRedisAuthCacheEnabled()) return;

  const row = await db().queryOne<{ key_hash: string | null }>(
    "SELECT key_hash FROM api_keys WHERE id = $1",
    [id]
  );
  await deleteRedisAuthCacheEntry(row?.key_hash);
}

async function markApiKeyUsed(id: unknown, now: number): Promise<void> {
  if (typeof id !== "string" || id.trim() === "") return;

  const lastUpdate = _lastUsedUpdateCache.get(id);
  if (lastUpdate && now - lastUpdate < LAST_USED_UPDATE_TTL) return;

  try {
    await db().execute("UPDATE api_keys SET last_used_at = $1 WHERE id = $2", [
      new Date(now).toISOString(),
      id,
    ]);
    _lastUsedUpdateCache.set(id, now);
  } catch {
    // A failed usage stamp must not reject a valid key.
  }
}

/** Turns `@name` placeholders into `$n` and collects the matching values in order. */
function bindNamedParams(
  sql: string,
  params: Record<string, unknown>
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const positions = new Map<string, number>();
  const text = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    let position = positions.get(name);
    if (position === undefined) {
      values.push(params[name] ?? null);
      position = values.length;
      positions.set(name, position);
    }
    return `$${position}`;
  });
  return { sql: text, values };
}

function evictIfNeeded<TKey, TValue>(cache: Map<TKey, TValue>) {
  if (cache.size > MAX_CACHE_SIZE) {
    const entriesToRemove = Math.floor(MAX_CACHE_SIZE * 0.2);
    let i = 0;
    for (const key of cache.keys()) {
      if (i++ >= entriesToRemove) break;
      cache.delete(key);
    }
  }
}

async function getModelPermissionCandidates(modelId: string): Promise<string[]> {
  const candidates = new Set<string>();
  addModelCandidate(candidates, modelId);

  const cleanModelId = stripExtendedContextSuffix(modelId.trim());
  if (!cleanModelId) return Array.from(candidates);

  if (cleanModelId.includes("/")) {
    const firstSlash = cleanModelId.indexOf("/");
    const providerOrAlias = cleanModelId.slice(0, firstSlash);
    const providerScopedModel = cleanModelId.slice(firstSlash + 1);
    if (CLAUDE_CODE_PROVIDER_PREFIXES.has(providerOrAlias) && providerScopedModel) {
      addModelCandidate(candidates, providerScopedModel);
      addModelCandidate(candidates, `cc/${providerScopedModel}`);
      addModelCandidate(candidates, `claude/${providerScopedModel}`);
    }
    if (providerScopedModel) {
      addProviderAliasScopedCandidates(
        candidates,
        providerOrAlias,
        providerScopedModel,
        resolveProviderId,
        getProviderAlias
      );
    }
    return Array.from(candidates);
  }

  if (
    isPotentialUnprefixedClaudeCodeModel(cleanModelId) &&
    (await preferClaudeCodeForUnprefixedClaudeModels())
  ) {
    addModelCandidate(candidates, `cc/${cleanModelId}`);
    addModelCandidate(candidates, `claude/${cleanModelId}`);
  }

  return Array.from(candidates);
}

export async function isModelBlockedByPatterns(
  blockedModels: string[] | null | undefined,
  modelId: string
): Promise<boolean> {
  if (!blockedModels?.length) return false;
  const candidates = await getModelPermissionCandidates(modelId);
  return blockedModels.some((pattern) => modelPatternMatches(pattern, candidates));
}

async function getPublishedModelLookupTarget(
  modelId: string
): Promise<{ providerId: string; modelId: string } | null> {
  const cleanModelId = stripExtendedContextSuffix(modelId.trim());
  if (!cleanModelId) return null;

  if (cleanModelId.includes("/")) {
    const firstSlash = cleanModelId.indexOf("/");
    const providerOrAlias = cleanModelId.slice(0, firstSlash);
    const providerScopedModel = cleanModelId.slice(firstSlash + 1);
    if (!providerScopedModel) return null;
    const providerId = CLAUDE_CODE_PROVIDER_PREFIXES.has(providerOrAlias)
      ? "claude"
      : providerOrAlias;
    return { providerId, modelId: providerScopedModel };
  }

  if (
    isPotentialUnprefixedClaudeCodeModel(cleanModelId) &&
    (await preferClaudeCodeForUnprefixedClaudeModels())
  ) {
    return { providerId: "claude", modelId: cleanModelId };
  }

  return null;
}

/**
 * Moves any plaintext secret into the enc:v1 envelope once per process, before the first
 * read. Auth never depends on it: lookups go by `key_hash`, which is NOT NULL.
 */
async function ensureApiKeySecretsSecured(): Promise<void> {
  if (_secretsSecured) return;

  try {
    await backfillApiKeySecretsAtRest();
    _secretsSecured = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[DB] Failed to secure api_keys secrets:", message);
  }
}

/**
 * Blank the secret of an SSO-provisioned shadow key before it leaves the DB
 * layer. Its holder authenticates with an Entra token; the row's `key` is an
 * internal implementation detail. Surfacing it would mint a permanent static
 * credential that bypasses SSO — usable after the user is offboarded in Entra,
 * and invisible to the group policy that is supposed to govern them.
 */
function redactSsoSecret(view: ApiKeyView): ApiKeyView {
  if ((view as JsonRecord).source === "sso") {
    (view as JsonRecord).key = "";
  }
  return view;
}

function hydrateApiKeyRow(row: ApiKeyRow): ApiKeyView {
  const camelRow = toRecord(rowToCamel(row)) as ApiKeyView;
  // Raw secret for the operator-only JSON export and internal probes; stored encrypted.
  camelRow.key = decryptApiKeySecret(camelRow.key);
  camelRow.modelAccessMode = parseModelAccessMode(camelRow.modelAccessMode, camelRow.allowedModels);
  camelRow.allowedModels = parseAllowedModels(camelRow.allowedModels);
  camelRow.blockedModels = parseAllowedModels(camelRow.blockedModels);
  camelRow.allowedCombos = parseAllowedCombos(camelRow.allowedCombos);
  camelRow.allowedConnections = parseAllowedConnections(camelRow.allowedConnections);
  camelRow.preferredConnections = parseAllowedConnections(camelRow.preferredConnections);
  camelRow.allowedQuotas = parseAllowedQuotas(asJsonText((camelRow as JsonRecord).allowedQuotas));
  camelRow.noLog = parseNoLog(camelRow.noLog);
  camelRow.autoResolve = parseAutoResolve(camelRow.autoResolve);
  camelRow.isActive = parseIsActive(camelRow.isActive);
  camelRow.accessSchedule = parseAccessSchedule(asJsonText(camelRow.accessSchedule));
  camelRow.rateLimits = parseRateLimits(asJsonText(camelRow.rateLimits));
  camelRow.isBanned = parseIsBanned(camelRow.isBanned);
  camelRow.scopes = parseStringList((camelRow as JsonRecord).scopes);
  camelRow.allowedEndpoints = parseStringList((camelRow as JsonRecord).allowedEndpoints);
  camelRow.streamDefaultMode = parseStreamDefaultMode((camelRow as JsonRecord).streamDefaultMode);
  camelRow.codexServiceMode = parseApiKeyCodexServiceMode(
    (camelRow as JsonRecord).codexServiceMode
  );
  camelRow.cacheDefaultMode = parseCacheDefaultMode((camelRow as JsonRecord).cacheDefaultMode);
  camelRow.disableNonPublicModels = parseDisableNonPublicModels(
    (camelRow as JsonRecord).disableNonPublicModels
  );
  camelRow.allowUsageCommand = parseAllowUsageCommand((camelRow as JsonRecord).allowUsageCommand);
  camelRow.chaosModeEnabled = parseChaosModeEnabled((camelRow as JsonRecord).chaosModeEnabled);
  camelRow.compressionEnabled = parseCompressionEnabled(
    (camelRow as JsonRecord).compressionEnabled
  );
  camelRow.allowAutoCombos = parseAllowAutoCombos((camelRow as JsonRecord).allowAutoCombos);
  camelRow.allowCcDiscoveryAliases = parseAllowCcDiscoveryAliases(
    (camelRow as JsonRecord).allowCcDiscoveryAliases
  );
  camelRow.catalogScope = parseCatalogScope((camelRow as JsonRecord).catalogScope);
  camelRow.forcedModel = parseForcedModel((camelRow as JsonRecord).forcedModel);
  Object.assign(camelRow, parseApiKeyUsageLimitFields(camelRow));
  if (typeof camelRow.id === "string" && camelRow.id.length > 0) {
    setNoLog(camelRow.id, camelRow.noLog === true);
  }
  return redactSsoSecret(camelRow);
}

export async function getApiKeys(limit?: number, offset?: number) {
  await ensureApiKeySecretsSecured();
  const rows =
    limit !== undefined
      ? await db().query<ApiKeyRow>(
          "SELECT * FROM api_keys ORDER BY created_at LIMIT $1 OFFSET $2",
          [limit, offset ?? 0]
        )
      : await db().query<ApiKeyRow>("SELECT * FROM api_keys ORDER BY created_at");
  return rows.map(hydrateApiKeyRow);
}

export async function getApiKeysCount(): Promise<number> {
  const row = await db().queryOne<{ cnt: number }>("SELECT count(*)::int AS cnt FROM api_keys");
  return row?.cnt ?? 0;
}

/** Derived lease-only membership from existing key policy, not a second pool store. */
export async function getExclusiveLeaseConnectionIds(): Promise<Set<string>> {
  await ensureApiKeySecretsSecured();
  const rows = await db().query<ApiKeyRow>(
    `SELECT allowed_connections FROM api_keys
       WHERE is_active = true AND is_banned = false AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > $1::timestamptz) AND scopes @> $2::jsonb`,
    [new Date().toISOString(), jsonb([EXCLUSIVE_LEASE_SCOPE])]
  );
  return new Set(rows.flatMap((row) => parseAllowedConnections(row.allowed_connections)));
}

/**
 * Select an API key for internal OmniRoute operations (combo health checks,
 * cloud-sync verify pings, etc.).
 *
 * Naive selection of `getApiKeys()[0]` is unsafe because the first row is
 * whatever happened to be inserted first — usually a regular `self:usage`
 * key with a restricted model allowlist. Internal probes that reuse that
 * key to call `/v1/chat/completions` then hit
 *   Model "X" is not allowed for this API key
 * from `shared/utils/apiKeyPolicy.ts` even when the upstream combo path is
 * healthy. Likewise, cloud-sync verify pings flip to "disconnected"
 * because the arbitrary key is rejected upstream.
 *
 * Selection rules (first match wins):
 *   1. Active, non-revoked key whose `scopes` includes "manage"
 *      (management keys are by policy not subject to model allowlists).
 *   2. Active, non-revoked key with empty allowedModels (allow-all).
 *   3. Active, non-revoked key with the most recent `lastUsedAt`.
 *   4. First active, non-revoked key (legacy fallback — preserves prior
 *      behavior when no key matches the better rules above).
 *
 * The selector is deliberately conservative: it never promotes a revoked,
 * inactive, banned, or hard-lease key, and it never widens a key's allowedModels.
 */
export async function pickApiKeyForInternalUse(
  purpose: "combo-health-check" | "cloud-sync-verify" | "internal-probe" = "internal-probe"
): Promise<string | null> {
  try {
    const keys = (await getApiKeys()) as Array<{
      key?: string;
      isActive?: boolean;
      revokedAt?: string | null;
      isBanned?: boolean;
      scopes?: string[];
      modelAccessMode?: ModelAccessMode;
      allowedModels?: string[];
      lastUsedAt?: string | number | null;
    }>;

    const isUsable = (k: (typeof keys)[number]) =>
      Boolean(k.key) &&
      k.isActive !== false &&
      !k.revokedAt &&
      k.isBanned !== true &&
      !k.scopes?.includes(EXCLUSIVE_LEASE_SCOPE);

    // 1. Management-scoped key (preferred for any internal probe).
    const manageKey = keys.find(
      (k) => isUsable(k) && Array.isArray(k.scopes) && k.scopes.includes("manage")
    );
    if (manageKey?.key) return manageKey.key;

    // 2. Allow-all key (empty allowedModels means no model restrictions).
    const allowAllKey = keys.find(
      (k) =>
        isUsable(k) &&
        k.modelAccessMode !== "restricted" &&
        Array.isArray(k.allowedModels) &&
        k.allowedModels.length === 0
    );
    if (allowAllKey?.key) return allowAllKey.key;

    // 3. Most recently used (proxy for "the user actually wants this one
    //    working right now").
    const byRecency = [...keys].filter(isUsable).sort((a, b) => {
      const aT = typeof a.lastUsedAt === "number" ? a.lastUsedAt : 0;
      const bT = typeof b.lastUsedAt === "number" ? b.lastUsedAt : 0;
      return bT - aT;
    });
    if (byRecency[0]?.key) return byRecency[0].key;

    // 4. Legacy fallback: first active key. Keeps the function working
    //    for setups with no managed/allow-all/recently-used key.
    const firstActive = keys.find(isUsable);
    return firstActive?.key ?? null;
  } catch {
    return null;
  }
}

export async function getApiKeyById(id: string) {
  await ensureApiKeySecretsSecured();
  const row = await db().queryOne<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $1", [id]);
  if (!row) return null;
  return hydrateApiKeyRow(row);
}

async function hashKey(key: string): Promise<string> {
  if (!key || typeof key !== "string") return "";
  // Fast SHA-256 fingerprint on purpose, NOT password hashing: API keys are high-entropy
  // random tokens validated on every request. The rationale and the single CodeQL sink live
  // in open-sse/utils/opaqueTokenFingerprint.ts.
  return opaqueTokenFingerprint(key);
}

export async function createApiKey(
  name: string,
  machineId: string,
  scopes: string[] = [],
  options: CreateApiKeyOptions = {}
) {
  if (!machineId) {
    throw new Error("machineId is required");
  }
  const allowedConnections = options.allowedConnections ?? [];
  const preferredConnections = options.preferredConnections ?? [];
  const modelAccess = normalizeApiKeyPermissionsUpdate({
    modelAccessMode: options.modelAccessMode,
    allowedModels: options.allowedModels,
  });
  const modelAccessMode = modelAccess.modelAccessMode ?? "all";
  const allowedModels = modelAccess.allowedModels ?? [];
  const allowedCombos = options.allowedCombos ?? [ALL_COMBOS_ACCESS_RULE];
  assertExclusiveLeaseKeyPolicy(scopes, allowedConnections);

  await ensureApiKeySecretsSecured();
  const now = new Date().toISOString();

  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);

  const apiKey = {
    id: uuidv4(),
    name: name,
    key: result.key,
    machineId: machineId,
    modelAccessMode,
    allowedModels,
    allowedCombos,
    allowedConnections,
    preferredConnections,
    noLog: false,
    allowUsageCommand: false,
    createdAt: now,
    expiresAt: options.expiresAt ?? null,
    scopes,
  };

  const expiresAtParam = expiryParam(apiKey.expiresAt);
  // The secret is stored through the enc:v1: envelope (reversible for the admin reveal and
  // the operator export); auth matches key_hash only. See apiKeys/secretAtRest.ts.
  await db().execute(
    `INSERT INTO api_keys (id, name, key, machine_id, model_access_mode, allowed_models, allowed_combos, allowed_connections, preferred_connections, no_log, created_at, key_prefix, key_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11, $12, $13, $14)`,
    [
      apiKey.id,
      apiKey.name,
      encryptApiKeySecret(apiKey.key),
      apiKey.machineId,
      apiKey.modelAccessMode,
      jsonb(apiKey.allowedModels),
      jsonb(apiKey.allowedCombos),
      jsonb(allowedConnections),
      jsonb(preferredConnections),
      apiKey.createdAt,
      apiKey.key.slice(0, 12),
      await hashKey(apiKey.key),
      jsonb(scopes),
      expiresAtParam,
    ]
  );
  setNoLog(apiKey.id, false);

  return apiKey;
}

export async function regenerateApiKey(id: string) {
  await ensureApiKeySecretsSecured();
  const row = await db().queryOne<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $1", [id]);
  if (!row) return null;

  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const machineId = (row.machine_id || row.machineId || "0000000000000000") as string;
  const { key: newKey } = generateApiKeyWithMachine(machineId);
  const newHash = await hashKey(newKey);
  const newPrefix = newKey.slice(0, 12);

  // Update in DB
  await db().execute("UPDATE api_keys SET key = $1, key_hash = $2, key_prefix = $3 WHERE id = $4", [
    encryptApiKeySecret(newKey),
    newHash,
    newPrefix,
    id,
  ]);

  // Invalidate all caches
  clearApiKeyCaches();

  await deleteRedisAuthCacheEntries(row.key_hash, newHash);

  const { logAuditEvent } = await import("@/lib/compliance");
  void logAuditEvent({
    action: "apiKey.regenerate",
    target: id,
    details: { name: String(row.name || "") },
  });

  return { id, key: newKey };
}

export async function updateApiKeyPermissions(
  id: string,
  update: string[] | ApiKeyPermissionsUpdate
) {
  await ensureApiKeySecretsSecured();

  const normalized = normalizeApiKeyPermissionsUpdate(update);
  const shouldInvalidateModelCatalog =
    normalized.modelAccessMode !== undefined ||
    normalized.allowedModels !== undefined ||
    normalized.blockedModels !== undefined ||
    normalized.allowedCombos !== undefined ||
    normalized.allowedConnections !== undefined ||
    normalized.preferredConnections !== undefined ||
    normalized.allowedQuotas !== undefined ||
    normalized.disableNonPublicModels !== undefined ||
    normalized.allowAutoCombos !== undefined ||
    normalized.allowCcDiscoveryAliases !== undefined ||
    normalized.catalogScope !== undefined ||
    normalized.forcedModel !== undefined;

  if (
    normalized.name === undefined &&
    normalized.modelAccessMode === undefined &&
    normalized.allowedModels === undefined &&
    normalized.blockedModels === undefined &&
    normalized.allowedCombos === undefined &&
    normalized.allowedConnections === undefined &&
    normalized.preferredConnections === undefined &&
    (normalized as Record<string, unknown>).allowedQuotas === undefined &&
    normalized.noLog === undefined &&
    normalized.autoResolve === undefined &&
    normalized.isActive === undefined &&
    normalized.accessSchedule === undefined &&
    normalized.maxRequestsPerDay === undefined &&
    normalized.maxRequestsPerMinute === undefined &&
    normalized.throttleDelayMs === undefined &&
    normalized.rateLimits === undefined &&
    normalized.isBanned === undefined &&
    normalized.expiresAt === undefined &&
    (normalized as Record<string, unknown>).maxSessions === undefined &&
    (normalized as Record<string, unknown>).scopes === undefined &&
    (normalized as Record<string, unknown>).proxyId === undefined &&
    (normalized as Record<string, unknown>).allowedEndpoints === undefined &&
    (normalized as Record<string, unknown>).streamDefaultMode === undefined &&
    normalized.codexServiceMode === undefined &&
    (normalized as Record<string, unknown>).cacheDefaultMode === undefined &&
    normalized.disableNonPublicModels === undefined &&
    normalized.allowUsageCommand === undefined &&
    normalized.chaosModeEnabled === undefined &&
    normalized.compressionEnabled === undefined &&
    normalized.allowAutoCombos === undefined &&
    normalized.allowCcDiscoveryAliases === undefined &&
    normalized.catalogScope === undefined &&
    normalized.forcedModel === undefined &&
    !hasUsageLimitUpdate(normalized as Record<string, unknown>)
  ) {
    return false;
  }

  const updates: string[] = [];
  const params: {
    id: string;
    name?: string;
    modelAccessMode?: ModelAccessMode;
    allowedModels?: string;
    blockedModels?: string;
    allowedCombos?: string;
    allowedConnections?: string;
    preferredConnections?: string;
    allowedQuotas?: string;
    noLog?: number;
    autoResolve?: number;
    isActive?: number;
    accessSchedule?: string | null;
    maxRequestsPerDay?: number | null;
    maxRequestsPerMinute?: number | null;
    throttleDelayMs?: number | null;
    rateLimits?: string | null;
    isBanned?: number;
    maxSessions?: number;
    expiresAt?: string | null;
    scopes?: string;
    proxyId?: string | null;
    streamDefaultMode?: "legacy" | "json";
    codexServiceMode?: ApiKeyCodexServiceMode;
    cacheDefaultMode?: "legacy" | "bypass";
    disableNonPublicModels?: number;
    allowUsageCommand?: number;
    usageLimitEnabled?: number;
    dailyUsageLimitUsd?: number | null;
    weeklyUsageLimitUsd?: number | null;
    chaosModeEnabled?: number;
    compressionEnabled?: number;
    allowAutoCombos?: number;
    allowCcDiscoveryAliases?: number;
    catalogScope?: string;
    forcedModel?: string | null;
  } = { id };

  if (normalized.name !== undefined) {
    updates.push("name = @name");
    params.name = normalized.name;
  }

  if (normalized.modelAccessMode !== undefined) {
    updates.push("model_access_mode = @modelAccessMode");
    params.modelAccessMode = normalized.modelAccessMode;
  }
  if (normalized.allowedModels !== undefined) {
    updates.push("allowed_models = @allowedModels");
    params.allowedModels = JSON.stringify(normalized.allowedModels);
  }

  if (normalized.blockedModels !== undefined) {
    // Deny-list patterns always take precedence over allowed_models.
    updates.push("blocked_models = @blockedModels");
    params.blockedModels = JSON.stringify(normalized.blockedModels || []);
  }

  if (normalized.allowedCombos !== undefined) {
    // Empty array denies all combos; combo/* explicitly allows all combos.
    updates.push("allowed_combos = @allowedCombos");
    params.allowedCombos = JSON.stringify(normalized.allowedCombos || []);
  }

  if (normalized.allowedConnections !== undefined) {
    // Empty array means all connections are allowed
    updates.push("allowed_connections = @allowedConnections");
    params.allowedConnections = JSON.stringify(normalized.allowedConnections || []);
  }

  if (normalized.preferredConnections !== undefined) {
    // Ordered preference only; access/health/quota gates still define eligibility.
    updates.push("preferred_connections = @preferredConnections");
    params.preferredConnections = JSON.stringify(normalized.preferredConnections || []);
  }

  const allowedQuotasUpdate = (normalized as Record<string, unknown>).allowedQuotas;
  if (allowedQuotasUpdate !== undefined) {
    // Empty array means no quota-pool restriction; non-empty restricts to listed pools
    updates.push("allowed_quotas = @allowedQuotas");
    const nextQuotas: string[] = Array.isArray(allowedQuotasUpdate)
      ? (allowedQuotasUpdate as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    params.allowedQuotas = JSON.stringify(nextQuotas);
  }

  if (normalized.noLog !== undefined) {
    updates.push("no_log = @noLog");
    params.noLog = normalized.noLog ? 1 : 0;
  }

  if (normalized.autoResolve !== undefined) {
    updates.push("auto_resolve = @autoResolve");
    params.autoResolve = normalized.autoResolve ? 1 : 0;
  }

  if (normalized.isActive !== undefined) {
    updates.push("is_active = @isActive");
    params.isActive = normalized.isActive ? 1 : 0;
  }

  if (normalized.accessSchedule !== undefined) {
    updates.push("access_schedule = @accessSchedule");
    params.accessSchedule =
      normalized.accessSchedule !== null ? JSON.stringify(normalized.accessSchedule) : null;
  }

  if (normalized.maxRequestsPerDay !== undefined) {
    updates.push("max_requests_per_day = @maxRequestsPerDay");
    params.maxRequestsPerDay = toIntColumn(normalized.maxRequestsPerDay);
  }

  if (normalized.maxRequestsPerMinute !== undefined) {
    updates.push("max_requests_per_minute = @maxRequestsPerMinute");
    params.maxRequestsPerMinute = toIntColumn(normalized.maxRequestsPerMinute);
  }

  if (normalized.throttleDelayMs !== undefined) {
    updates.push("throttle_delay_ms = @throttleDelayMs");
    params.throttleDelayMs = toIntColumn(normalized.throttleDelayMs);
  }

  if (normalized.rateLimits !== undefined) {
    updates.push("rate_limits = @rateLimits");
    params.rateLimits =
      normalized.rateLimits !== null ? JSON.stringify(normalized.rateLimits) : null;
  }

  if (normalized.isBanned !== undefined) {
    updates.push("is_banned = @isBanned");
    params.isBanned = normalized.isBanned ? 1 : 0;
  }

  if (normalized.expiresAt !== undefined) {
    updates.push("expires_at = @expiresAt");
    params.expiresAt = expiryParam(normalized.expiresAt);
  }

  if (normalized.disableNonPublicModels !== undefined) {
    updates.push("disable_non_public_models = @disableNonPublicModels");
    params.disableNonPublicModels = normalized.disableNonPublicModels ? 1 : 0;
  }

  if (normalized.allowUsageCommand !== undefined) {
    updates.push("allow_usage_command = @allowUsageCommand");
    params.allowUsageCommand = normalized.allowUsageCommand ? 1 : 0;
  }

  if (normalized.chaosModeEnabled !== undefined) {
    updates.push("chaos_mode_enabled = @chaosModeEnabled");
    params.chaosModeEnabled = normalized.chaosModeEnabled ? 1 : 0;
  }

  if (normalized.compressionEnabled !== undefined) {
    updates.push("compression_enabled = @compressionEnabled");
    params.compressionEnabled = normalized.compressionEnabled ? 1 : 0;
  }

  if (normalized.allowAutoCombos !== undefined) {
    updates.push("allow_auto_combos = @allowAutoCombos");
    params.allowAutoCombos = normalized.allowAutoCombos ? 1 : 0;
  }

  if (normalized.allowCcDiscoveryAliases !== undefined) {
    updates.push("allow_cc_discovery_aliases = @allowCcDiscoveryAliases");
    params.allowCcDiscoveryAliases = normalized.allowCcDiscoveryAliases ? 1 : 0;
  }

  if (normalized.catalogScope !== undefined) {
    updates.push("catalog_scope = @catalogScope");
    params.catalogScope = normalized.catalogScope;
  }

  if (normalized.forcedModel !== undefined) {
    updates.push("forced_model = @forcedModel");
    params.forcedModel = parseForcedModel(normalized.forcedModel);
  }

  appendUsageLimitUpdates(normalized as Record<string, unknown>, updates, params);

  const maxSessionsUpdate = (normalized as Record<string, unknown>).maxSessions;
  if (maxSessionsUpdate !== undefined) {
    updates.push("max_sessions = @maxSessions");
    params.maxSessions = typeof maxSessionsUpdate === "number" ? Math.max(0, maxSessionsUpdate) : 0;
  }

  const proxyIdUpdate = (normalized as Record<string, unknown>).proxyId;
  if (proxyIdUpdate !== undefined) {
    updates.push("proxy_id = @proxyId");
    params.proxyId =
      typeof proxyIdUpdate === "string" && proxyIdUpdate.trim() !== "" ? proxyIdUpdate : null;
  }

  const allowedEndpointsUpdate = (normalized as Record<string, unknown>).allowedEndpoints;
  if (allowedEndpointsUpdate !== undefined) {
    updates.push("allowed_endpoints = @allowedEndpoints");
    const nextEndpoints: string[] = Array.isArray(allowedEndpointsUpdate)
      ? (allowedEndpointsUpdate as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    (params as Record<string, unknown>).allowedEndpoints = JSON.stringify(nextEndpoints);
  }

  const streamDefaultModeUpdate = (normalized as Record<string, unknown>).streamDefaultMode;
  if (streamDefaultModeUpdate !== undefined) {
    updates.push("stream_default_mode = @streamDefaultMode");
    params.streamDefaultMode = parseStreamDefaultMode(streamDefaultModeUpdate);
  }

  if (normalized.codexServiceMode !== undefined) {
    updates.push("codex_service_mode = @codexServiceMode");
    params.codexServiceMode = parseApiKeyCodexServiceMode(normalized.codexServiceMode);
  }
  const cacheDefaultModeUpdate = (normalized as Record<string, unknown>).cacheDefaultMode;
  if (cacheDefaultModeUpdate !== undefined) {
    updates.push("cache_default_mode = @cacheDefaultMode");
    params.cacheDefaultMode = parseCacheDefaultMode(cacheDefaultModeUpdate);
  }

  const scopesUpdate = (normalized as Record<string, unknown>).scopes;
  const nextScopes: string[] = Array.isArray(scopesUpdate)
    ? (scopesUpdate as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  // Capture previous scopes BEFORE the UPDATE so we can compare for the audit
  // event below. We only fetch when the caller is actually changing scopes —
  // a privileged change ("manage" grants management API surface access) that
  // must always leave an audit trail per OWASP A09 / SOC2 CC7.2.
  //
  // The previous-scopes SELECT (row-locked) and the UPDATE share one transaction so a
  // concurrent writer cannot slip in between and make the audit log lie about what changed.
  let previousScopes: string[] = [];
  let changedRows = 0;
  if (scopesUpdate !== undefined) {
    updates.push("scopes = @scopes");
    params.scopes = JSON.stringify(nextScopes);
  }
  const bound = bindNamedParams(`UPDATE api_keys SET ${updates.join(", ")} WHERE id = @id`, params);

  if (scopesUpdate !== undefined || normalized.allowedConnections !== undefined) {
    // Either side of the lease:exclusive invariant is changing, so read the other side
    // under the same row lock.
    const outcome = await db().transaction(async (tx) => {
      const prevRow = await tx.queryOne<{ scopes: unknown; allowed_connections: unknown }>(
        "SELECT scopes, allowed_connections FROM api_keys WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!prevRow) return null;
      const previous = parseStringList(prevRow.scopes);
      const effectiveScopes = scopesUpdate !== undefined ? nextScopes : previous;
      const effectiveConnections =
        normalized.allowedConnections === undefined
          ? parseAllowedConnections(prevRow.allowed_connections)
          : normalized.allowedConnections;
      assertExclusiveLeaseKeyPolicy(effectiveScopes, effectiveConnections);
      const upd = await tx.execute(bound.sql, bound.values);
      return { previous, changes: upd.changes ?? 0 };
    });
    if (!outcome) return false;
    previousScopes = outcome.previous;
    changedRows = outcome.changes;
  } else {
    const upd = await db().execute(bound.sql, bound.values);
    changedRows = upd.changes ?? 0;
  }

  if (changedRows === 0) return false;

  const { logAuditEvent } = await import("@/lib/compliance");

  if (normalized.isBanned !== undefined) {
    void logAuditEvent({
      action: normalized.isBanned ? "apiKey.ban" : "apiKey.unban",
      target: id,
    });
  }

  if (normalized.isActive !== undefined) {
    void logAuditEvent({
      action: normalized.isActive ? "apiKey.activate" : "apiKey.deactivate",
      target: id,
    });
  }

  if (scopesUpdate !== undefined) {
    // Compare prev vs next scope sets and emit a dedicated audit event when
    // the privileged "manage" scope is granted or revoked. Other scope
    // mutations also emit a generic "apiKey.scopes.update" so the audit log
    // captures the full change history (action + details).
    const hadManage = previousScopes.includes("manage");
    const hasManage = nextScopes.includes("manage");
    if (!hadManage && hasManage) {
      void logAuditEvent({
        action: "apiKey.scopes.grant",
        target: id,
        details: { scopes: nextScopes, previous: previousScopes },
      });
    } else if (hadManage && !hasManage) {
      void logAuditEvent({
        action: "apiKey.scopes.revoke",
        target: id,
        details: { scopes: nextScopes, previous: previousScopes },
      });
    } else if (
      previousScopes.length !== nextScopes.length ||
      previousScopes.some((s) => !nextScopes.includes(s)) ||
      nextScopes.some((s) => !previousScopes.includes(s))
    ) {
      void logAuditEvent({
        action: "apiKey.scopes.update",
        target: id,
        details: { scopes: nextScopes, previous: previousScopes },
      });
    }
  }

  if (normalized.noLog !== undefined) {
    setNoLog(id, normalized.noLog);
  }

  // Invalidate per-key policy and filtered model-catalog caches after the atomic write.
  invalidateCaches();
  if (shouldInvalidateModelCatalog) invalidateModelCatalogCache();

  await deleteRedisAuthCacheForKeyId(id);

  return true;
}

export async function deleteApiKey(id: string) {
  const deleted = await db().transaction(async (tx) => {
    const row = await tx.queryOne<{ key_hash: string | null }>(
      "DELETE FROM api_keys WHERE id = $1 RETURNING key_hash",
      [id]
    );
    if (!row) return null;

    // Children with an FK (groups, context sources, limits, sso, sync tokens...) cascade.
    // These two tables and the override table deliberately have no FK to api_keys.
    await tx.execute("DELETE FROM domain_budgets WHERE api_key_id = $1", [id]);
    await tx.execute("DELETE FROM domain_cost_history WHERE api_key_id = $1", [id]);
    await deleteOverridesForApiKey(id, tx);
    return row;
  });

  if (!deleted) return false;
  setNoLog(id, false);

  // Invalidate caches since a key was removed
  invalidateCaches();
  invalidateReasoningRoutingRuleCache();
  await deleteRedisAuthCacheEntry(deleted.key_hash);

  return true;
}

/**
 * Revoke an API key by id. Logical, not destructive: the row stays so it can
 * be audited, but validateApiKey() rejects it immediately after caches expire
 * (or sooner because invalidateCaches() runs here).
 */
export async function revokeApiKey(id: string): Promise<boolean> {
  await ensureApiKeySecretsSecured();

  const result = await db().execute(
    "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()), is_active = false WHERE id = $1",
    [id]
  );

  if ((result.changes ?? 0) === 0) return false;

  invalidateCaches();
  await deleteRedisAuthCacheForKeyId(id);
  return true;
}

/**
 * Set or clear the expiry of an API key. Pass null to remove the expiry.
 */
export async function setApiKeyExpiry(id: string, expiresAt: string | null): Promise<boolean> {
  await ensureApiKeySecretsSecured();

  const result = await db().execute("UPDATE api_keys SET expires_at = $1 WHERE id = $2", [
    expiryParam(expiresAt),
    id,
  ]);

  if ((result.changes ?? 0) === 0) return false;

  invalidateCaches();
  await deleteRedisAuthCacheForKeyId(id);
  return true;
}

/**
 * Validate API key with lifecycle gates and caching.
 *
 * A key is valid only when ALL of the following are true:
 *   - the row exists,
 *   - is_active = 1,
 *   - revoked_at IS NULL,
 *   - expires_at IS NULL OR expires_at > now.
 *
 * Cache TTL is short (CACHE_TTL) and the metadata cache is also invalidated
 * by revokeApiKey/updateApiKeyPermissions/deleteApiKey, so a revoke takes
 * effect within at most CACHE_TTL even without an explicit clear in the
 * caller.
 */
export async function validateApiKey(key: string | null | undefined) {
  if (!key || typeof key !== "string") return false;

  if (isConfiguredEnvApiKey(key) || isSelfLoopBearer(key)) return true;

  const now = Date.now();
  const hashedKey = await hashKey(key);
  const cacheKey = hashedKey;

  const cached = _keyValidationCache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.valid;
  }

  // A Redis hit never authorizes on its own (GHSA-66vh-35g3-78qv): eviction on regenerate/revoke
  // is best-effort and a late SET can resurrect an evicted entry, so the entry could keep a
  // retired credential valid for its whole TTL. The database is the source of truth for identity and
  // lifecycle; the lookup below is a single indexed read.

  await ensureApiKeySecretsSecured();
  const row = await db().queryOne<JsonRecord>(
    "SELECT id, expires_at, revoked_at, is_active, is_banned FROM api_keys WHERE key_hash = $1",
    [hashedKey]
  );

  if (!row) return false;

  const isBanned = parseIsBanned(row.is_banned ?? row.isBanned);
  if (isBanned) return false;

  const isActive = parseIsActive(row.is_active ?? row.isActive);
  if (!isActive) return false;

  const revokedAt = row.revoked_at ?? row.revokedAt;
  if (typeof revokedAt === "string" && revokedAt.trim() !== "") return false;

  const expiresAt = row.expires_at ?? row.expiresAt;
  if (typeof expiresAt === "string" && expiresAt.trim() !== "") {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= now) return false;
  }

  evictIfNeeded(_keyValidationCache);
  _keyValidationCache.set(cacheKey, { valid: true, timestamp: now });

  if (isRedisAuthCacheEnabled()) {
    // Update Redis cache for fast validation
    try {
      const { getRedisClient, isRedisConfigured } = await import("@/shared/utils/rateLimiter");
      if (isRedisConfigured()) {
        const redis = await getRedisClient();
        const redisKey = `auth:api_key:${hashedKey}`;
        await redis.set(
          redisKey,
          JSON.stringify({
            id: row.id,
            isBanned: parseIsBanned(row.is_banned),
            isActive: parseIsActive(row.is_active),
            expiresAt: row.expires_at,
            revokedAt: row.revoked_at,
          }),
          "EX",
          3600 // 1 hour cache
        );
      }
    } catch {
      // Redis cache update failures do not block successful validation.
    }
  }

  await markApiKeyUsed(row.id, now);

  return true;
}

/**
 * Get API key metadata with caching for performance
 */
export async function getApiKeyMetadata(
  key: string | null | undefined
): Promise<ApiKeyMetadata | null> {
  if (!key || typeof key !== "string") return null;

  const now = Date.now();

  // persistent env-var key support (persistent passthrough keys) (#1350)
  if (isConfiguredEnvApiKey(key) || isSelfLoopBearer(key)) {
    // ─── Env-key management-scope bypass ──────────────────────────────────
    // The deployment-time env key (`OMNIROUTE_API_KEY` / `ROUTER_API_KEY`)
    // is granted the "manage" scope unconditionally. This is intentional:
    //
    //   1. The env key never exists in the SQLite `api_keys` table, so the
    //      DB-backed scopes column does not apply. We synthesize the
    //      metadata record here.
    //   2. The operator who set the env var is presumed to be the deployment
    //      owner; rotating (or unsetting) the env var is the only way to
    //      rotate this privilege. There is no UI to change it.
    //   3. Management API access via the env key still passes through
    //      `requireManagementAuth` → `hasManageScope`, so policy decisions
    //      remain centralised in `src/server/authz/*`.
    //   4. Requests authenticated by the env key are tagged with
    //      `id: "env-key"` for downstream audit-log emitters, making it
    //      possible to distinguish env-key activity from user-created keys
    //      that happen to also hold "manage".
    //
    // DO NOT remove "manage" from this list — that would break the
    // deployment-time bootstrap path that operators rely on for headless
    // / CI / first-boot scenarios. If you need to disable env-key access,
    // unset the env var instead.
    return {
      id: SYNTHETIC_ENV_API_KEY_ID,
      name: "Environment Key",
      machineId: "server-env",
      modelAccessMode: "all",
      allowedModels: [],
      blockedModels: [],
      allowedCombos: [ALL_COMBOS_ACCESS_RULE],
      allowedConnections: [],
      preferredConnections: [],
      allowedQuotas: [],
      noLog: false,
      autoResolve: true,
      isActive: true,
      accessSchedule: null,
      rateLimits: null,
      maxRequestsPerDay: null,
      maxRequestsPerMinute: null,
      throttleDelayMs: null,
      maxSessions: 0,
      revokedAt: null,
      expiresAt: null,
      ipAllowlist: [],
      isBanned: false,
      keyHash: null,
      scopes: ["manage"],
      proxyId: null,
      allowedEndpoints: [],
      streamDefaultMode: "legacy",
      codexServiceMode: "inherit",
      cacheDefaultMode: "legacy",
      disableNonPublicModels: false,
      allowUsageCommand: false,
      usageLimitEnabled: false,
      dailyUsageLimitUsd: null,
      weeklyUsageLimitUsd: null,
      chaosModeEnabled: false,
      compressionEnabled: true,
      allowAutoCombos: true,
      allowCcDiscoveryAliases: true,
      catalogScope: "all",
      forcedModel: null,
      ...selfLoopKeyOverrides(key),
    };
  }

  // Check cache first
  const hashedKey = await hashKey(key);
  const cached = _keyMetadataCache.get(hashedKey);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }

  await ensureApiKeySecretsSecured();
  const row = await db().queryOne<ApiKeyRow>(
    `SELECT ${KEY_METADATA_COLUMNS} FROM api_keys WHERE key_hash = $1`,
    [hashedKey]
  );

  if (!row) return null;

  const record = toRecord(row) as ApiKeyRow;
  const metadataId = typeof record.id === "string" ? record.id : "";
  const metadataName = typeof record.name === "string" ? record.name : "";
  const machineIdRaw = record.machine_id ?? record.machineId;
  const metadataMachineId = typeof machineIdRaw === "string" ? machineIdRaw : null;

  const rawMaxRPD = record.max_requests_per_day ?? record.maxRequestsPerDay;
  const rawMaxRPM = record.max_requests_per_minute ?? record.maxRequestsPerMinute;
  const rawThrottleDelayMs = record.throttle_delay_ms ?? (record as JsonRecord).throttleDelayMs;

  const rawMaxSessions = record.max_sessions ?? record.maxSessions;

  const rawAllowedModels = record.allowed_models ?? record.allowedModels;
  const metadata: ApiKeyMetadata = {
    id: metadataId,
    name: metadataName,
    machineId: metadataMachineId,
    modelAccessMode: parseModelAccessMode(
      record.model_access_mode ?? record.modelAccessMode,
      rawAllowedModels
    ),
    allowedModels: parseAllowedModels(rawAllowedModels),
    blockedModels: parseAllowedModels(record.blocked_models ?? record.blockedModels),
    allowedCombos: parseAllowedCombos(record.allowed_combos ?? record.allowedCombos),
    allowedConnections: parseAllowedConnections(
      record.allowed_connections ?? record.allowedConnections
    ),
    preferredConnections: parseAllowedConnections(
      record.preferred_connections ?? record.preferredConnections
    ),
    allowedQuotas: parseAllowedQuotas(
      asJsonText((record as JsonRecord).allowed_quotas ?? (record as JsonRecord).allowedQuotas)
    ),
    noLog: parseNoLog(record.no_log ?? record.noLog),
    autoResolve: parseAutoResolve(record.auto_resolve ?? record.autoResolve),
    isActive: parseIsActive(record.is_active ?? record.isActive),
    accessSchedule: parseAccessSchedule(
      asJsonText(record.access_schedule ?? record.accessSchedule)
    ),
    rateLimits: parseRateLimits(
      asJsonText(record.rate_limits ?? (record as JsonRecord).rateLimits)
    ),
    maxRequestsPerDay: typeof rawMaxRPD === "number" && rawMaxRPD > 0 ? rawMaxRPD : null,
    maxRequestsPerMinute: typeof rawMaxRPM === "number" && rawMaxRPM > 0 ? rawMaxRPM : null,
    throttleDelayMs:
      typeof rawThrottleDelayMs === "number" && rawThrottleDelayMs > 0 ? rawThrottleDelayMs : null,
    // T08: max concurrent sessions; 0 = unlimited (default & backward-compatible)
    maxSessions: typeof rawMaxSessions === "number" && rawMaxSessions > 0 ? rawMaxSessions : 0,
    revokedAt: parseNullableTimestamp(record.revoked_at ?? (record as JsonRecord).revokedAt),
    expiresAt: parseNullableTimestamp(record.expires_at ?? (record as JsonRecord).expiresAt),
    ipAllowlist: parseStringList(record.ip_allowlist ?? (record as JsonRecord).ipAllowlist),
    scopes: parseStringList((record as JsonRecord).scopes),
    isBanned: parseIsBanned(record.is_banned ?? (record as JsonRecord).isBanned),
    keyHash: (record.key_hash ?? (record as JsonRecord).keyHash) as string | null,
    proxyId:
      typeof record.proxy_id === "string" && record.proxy_id.trim() !== "" ? record.proxy_id : null,
    allowedEndpoints: parseStringList(
      (record as JsonRecord).allowed_endpoints ?? (record as JsonRecord).allowedEndpoints
    ),
    streamDefaultMode: parseStreamDefaultMode(
      (record as JsonRecord).stream_default_mode ?? (record as JsonRecord).streamDefaultMode
    ),
    codexServiceMode: parseApiKeyCodexServiceMode(
      record.codex_service_mode ?? record.codexServiceMode
    ),
    cacheDefaultMode: parseCacheDefaultMode(
      (record as JsonRecord).cache_default_mode ?? (record as JsonRecord).cacheDefaultMode
    ),
    disableNonPublicModels: parseDisableNonPublicModels(
      (record as JsonRecord).disable_non_public_models ??
        (record as JsonRecord).disableNonPublicModels
    ),
    allowUsageCommand: parseAllowUsageCommand(
      (record as JsonRecord).allow_usage_command ?? (record as JsonRecord).allowUsageCommand
    ),
    chaosModeEnabled: parseChaosModeEnabled(
      (record as JsonRecord).chaos_mode_enabled ?? (record as JsonRecord).chaosModeEnabled
    ),
    compressionEnabled: parseCompressionEnabled(
      (record as JsonRecord).compression_enabled ?? (record as JsonRecord).compressionEnabled
    ),
    allowAutoCombos: parseAllowAutoCombos(
      (record as JsonRecord).allow_auto_combos ?? (record as JsonRecord).allowAutoCombos
    ),
    allowCcDiscoveryAliases: parseAllowCcDiscoveryAliases(
      (record as JsonRecord).allow_cc_discovery_aliases ??
        (record as JsonRecord).allowCcDiscoveryAliases
    ),
    catalogScope: parseCatalogScope(
      (record as JsonRecord).catalog_scope ?? (record as JsonRecord).catalogScope
    ),
    forcedModel: parseForcedModel(record.forced_model ?? record.forcedModel),
    ...parseApiKeyUsageLimitFields(record as JsonRecord),
  };

  if (!metadata.id) {
    return null;
  }

  setNoLog(metadata.id, metadata.noLog === true);

  // Cache the result
  evictIfNeeded(_keyMetadataCache);
  _keyMetadataCache.set(hashedKey, { value: metadata, timestamp: now });

  return metadata;
}

/**
 * Check if a model is allowed for a given API key
 * @param {string} key - The API key
 * @param {string} modelId - The model ID to check
 * @returns {boolean} - true if allowed, false if not
 */
export async function isModelAllowedForKey(
  key: string | null | undefined,
  modelId: string | null | undefined,
  resolvedModelId?: string | null
): Promise<boolean> {
  // If no key provided, allow (request may be using different auth method like JWT)
  // If no modelId provided, deny (invalid request)
  if (!key) return true;
  if (!modelId) return false;
  // `no-think/<provider>/<model>` is stripped before the chat handler's key check, so
  // judge it as the real model. The catalog then lists exactly the variants that dispatch.
  modelId = stripNoThinkingAlias(modelId);
  if (!modelId) return false;

  // Create cache key
  const cacheKey = resolvedModelId
    ? JSON.stringify([key, modelId, resolvedModelId])
    : `${key}:${modelId}`;
  const now = Date.now();
  const catalogGeneration = getModelCatalogCacheVersion();
  const usesSettingDependentClaudeRouting =
    isPotentialUnprefixedClaudeCodeModel(modelId) ||
    (typeof resolvedModelId === "string" && isPotentialUnprefixedClaudeCodeModel(resolvedModelId));

  // Check permission cache
  const cached = getCachedModelPermission(cacheKey, now, catalogGeneration);
  if (!usesSettingDependentClaudeRouting && cached !== undefined) {
    return cached;
  }

  const metadata = await getApiKeyMetadata(key);
  // SECURITY: Key not found in database = deny access (invalid/non-existent key)
  if (!metadata) return false;

  const decision = await evaluateModelAccess(
    metadata,
    { modelId, resolvedModelId },
    {
      getCandidates: getModelPermissionCandidates,
      resolveAlias: resolveModelAlias,
      getPublishedTarget: getPublishedModelLookupTarget,
      findPublishedModel,
      isPublishedModelHidden,
      checkGroupAccess: checkKeyModelAccess,
      isDeniedUnderCanonicalProvider,
    }
  );

  // Preserve the cache boundary: early block/publication denials were never cached.
  if (decision.reason === "permissions" && !usesSettingDependentClaudeRouting) {
    evictModelPermissionCache();
    setCachedModelPermission(cacheKey, decision.allowed, now, catalogGeneration);
  }

  return decision.allowed;
}

/**
 * Clear all caches (exported for testing/debugging)
 */
export function clearApiKeyCaches() {
  invalidateCaches();
}

/**
 * Reset all cached state for a database reset/restore.
 */
export function resetApiKeyState() {
  _secretsSecured = false;
  clearApiKeyCaches();
}

registerDbStateResetter(resetApiKeyState);
