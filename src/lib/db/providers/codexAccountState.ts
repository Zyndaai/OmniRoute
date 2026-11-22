import { db } from "../pg";
import { rowToCamel } from "../caseMapping";
import { invalidateDbCache } from "../readCache";
import { jsonValueParam } from "../pgJsonText";
import { toRecord } from "./columns";

type JsonRecord = Record<string, unknown>;

type CodexScopedQuotaPatch = {
  quotaState?: JsonRecord;
  exhaustedWindow?: "5h" | "7d" | null;
  rateLimitedUntil?: string | null;
  rateLimitSource?: "fallback" | "quota_reset" | "quota_preflight";
};

const CODEX_CHILD_COOLDOWN_KEYS = [
  "codexScopeRateLimitedUntil",
  "codexScopeRateLimitSource",
] as const;

function omitEmptyRecord(record: JsonRecord): JsonRecord | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}

/** Drop nested Codex child cooldowns; keep quota snapshots and unrelated keys. */
export function stripCodexChildCooldownFields(psd: JsonRecord): JsonRecord {
  if (!connectionHasCodexChildCooldown(psd)) return psd;
  const next = { ...psd };
  for (const key of CODEX_CHILD_COOLDOWN_KEYS) delete next[key];
  return next;
}

/** PUT/CAS payload that clears the parent column must also drop nested maps. */
export function applyCodexChildCooldownClearOnUpdate<T extends JsonRecord | undefined>(
  data: JsonRecord,
  psd: T
): T {
  if (psd == null) return psd;
  if (!Object.hasOwn(data, "rateLimitedUntil")) return psd;
  if (data.rateLimitedUntil != null && data.rateLimitedUntil !== "") return psd;
  return stripCodexChildCooldownFields(psd) as T;
}

function connectionHasCodexChildCooldown(psd: JsonRecord): boolean {
  return "codexScopeRateLimitedUntil" in psd || "codexScopeRateLimitSource" in psd;
}

/**
 * Persist a full-parent cooldown lift into the nested Codex child maps.
 * When `alsoClearTopLevel` is set, the parent `rate_limited_until` column is
 * nulled in the same transaction so a crash between the two writes cannot
 * leave a nested child map behind a cleared parent column.
 */
export async function stripCodexChildCooldownsFromConnection(
  id: string,
  options?: { alsoClearTopLevel?: boolean }
): Promise<void> {
  if (typeof id !== "string" || id.length === 0) return;
  const alsoClearTopLevel = options?.alsoClearTopLevel === true;

  const wrote = await db().transaction(async (tx) => {
    const existing = await tx.queryOne(
      "SELECT provider, provider_specific_data FROM provider_connections WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!existing) return false;
    const existingRecord = toRecord(rowToCamel(existing));
    const providerSpecificData = toRecord(existingRecord.providerSpecificData);
    const stripNested =
      existingRecord.provider === "codex" && connectionHasCodexChildCooldown(providerSpecificData);
    if (!alsoClearTopLevel && !stripNested) return false;

    const now = new Date().toISOString();
    if (alsoClearTopLevel && stripNested) {
      await tx.execute(
        `UPDATE provider_connections
         SET rate_limited_until = NULL,
             provider_specific_data = $1,
             updated_at = $2
         WHERE id = $3`,
        [jsonValueParam(stripCodexChildCooldownFields(providerSpecificData)), now, id]
      );
      return true;
    }
    if (alsoClearTopLevel) {
      await tx.execute(
        `UPDATE provider_connections
         SET rate_limited_until = NULL, updated_at = $1
         WHERE id = $2`,
        [now, id]
      );
      return true;
    }
    await tx.execute(
      `UPDATE provider_connections
       SET provider_specific_data = $1, updated_at = $2
       WHERE id = $3`,
      [jsonValueParam(stripCodexChildCooldownFields(providerSpecificData)), now, id]
    );
    return true;
  });
  // Touches only rate_limited_until and codex-scope cooldown keys inside
  // provider_specific_data — none are read by the /v1/models catalog builder.
  if (wrote) invalidateDbCache("connections", id, { skipModelCatalog: true });
}

/**
 * Atomically merge one virtual Codex child's quota evidence into its persisted parent.
 * The transaction reads the latest row so sibling child state cannot be lost.
 */
export async function updateCodexScopedQuotaState(
  id: string,
  scope: "codex" | "spark",
  patch: CodexScopedQuotaPatch
): Promise<JsonRecord | null> {
  const persisted = await db().transaction(async (tx) => {
    const existing = await tx.queryOne(
      "SELECT provider, provider_specific_data FROM provider_connections WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!existing) return null;

    const existingRecord = toRecord(rowToCamel(existing));
    if (existingRecord.provider !== "codex") return null;
    const providerSpecificData = toRecord(existingRecord.providerSpecificData);
    const nextProviderSpecificData: JsonRecord = { ...providerSpecificData };

    if (patch.quotaState) {
      const quotaByScope = toRecord(providerSpecificData.codexQuotaStateByScope);
      nextProviderSpecificData.codexQuotaStateByScope = {
        ...quotaByScope,
        [scope]: patch.quotaState,
      };
      nextProviderSpecificData.codexQuotaState = {
        ...patch.quotaState,
        scope,
        updatedAt: patch.quotaState.observedAt,
      };
    }

    if (patch.exhaustedWindow !== undefined) {
      const exhaustedByScope = { ...toRecord(providerSpecificData.codexExhaustedWindowByScope) };
      if (patch.exhaustedWindow) exhaustedByScope[scope] = patch.exhaustedWindow;
      else delete exhaustedByScope[scope];
      nextProviderSpecificData.codexExhaustedWindowByScope = exhaustedByScope;
      if (patch.exhaustedWindow) {
        nextProviderSpecificData.codexExhaustedWindow = patch.exhaustedWindow;
      } else {
        delete nextProviderSpecificData.codexExhaustedWindow;
      }
    }

    if (patch.rateLimitedUntil !== undefined) {
      const scopeCooldowns = { ...toRecord(providerSpecificData.codexScopeRateLimitedUntil) };
      const sourceByScope = { ...toRecord(providerSpecificData.codexScopeRateLimitSource) };
      if (patch.rateLimitedUntil) {
        const existingCooldownMs =
          typeof scopeCooldowns[scope] === "string"
            ? new Date(scopeCooldowns[scope] as string).getTime()
            : NaN;
        // A local text quota preflight must not downgrade an existing upstream
        // or legacy cooldown; only another preflight may replace a preflight.
        const existingIsAuthoritative =
          Number.isFinite(existingCooldownMs) &&
          existingCooldownMs > Date.now() &&
          ((sourceByScope[scope] === "quota_reset" && patch.rateLimitSource !== "quota_reset") ||
            (patch.rateLimitSource === "quota_preflight" &&
              sourceByScope[scope] !== "quota_preflight"));
        scopeCooldowns[scope] = existingIsAuthoritative
          ? scopeCooldowns[scope]
          : patch.rateLimitedUntil;
        sourceByScope[scope] = existingIsAuthoritative
          ? sourceByScope[scope]
          : (patch.rateLimitSource ?? "fallback");
      } else {
        delete scopeCooldowns[scope];
        delete sourceByScope[scope];
      }
      const nextCooldowns = omitEmptyRecord(scopeCooldowns);
      const nextSources = omitEmptyRecord(sourceByScope);
      if (nextCooldowns) nextProviderSpecificData.codexScopeRateLimitedUntil = nextCooldowns;
      else delete nextProviderSpecificData.codexScopeRateLimitedUntil;
      if (nextSources) nextProviderSpecificData.codexScopeRateLimitSource = nextSources;
      else delete nextProviderSpecificData.codexScopeRateLimitSource;
    }

    await tx.execute(
      `UPDATE provider_connections
       SET provider_specific_data = $1, updated_at = $2
       WHERE id = $3`,
      [jsonValueParam(nextProviderSpecificData),new Date().toISOString(), id]
    );
    return nextProviderSpecificData;
  });

  // Codex-scope quota/cooldown keys only (codexQuotaState*, codexExhaustedWindow*,
  // codexScopeRateLimit*) — routing metadata the /v1/models builder never reads.
  if (persisted) invalidateDbCache("connections", id, { skipModelCatalog: true });
  return persisted;
}

/** Grace window absorbing clock skew against the upstream quota server. */
const QUOTA_RESET_CLOCK_SKEW_GRACE_MS = 30_000;

/** Cheap probe: does this connection+scope currently carry a child cooldown? */
export async function hasCodexScopeCooldown(
  id: string,
  scope: "codex" | "spark"
): Promise<boolean> {
  if (typeof id !== "string" || id.length === 0) return false;
  const row = await db().queryOne(
    "SELECT provider, provider_specific_data FROM provider_connections WHERE id = $1",
    [id]
  );
  if (!row) return false;
  const record = toRecord(rowToCamel(row));
  if (record.provider !== "codex") return false;
  const psd = toRecord(record.providerSpecificData);
  return Boolean(toRecord(psd.codexScopeRateLimitedUntil)[scope]);
}

/**
 * #12860: When fresh quota snapshot data demonstrates headroom on a scope,
 * lift any fallback-sourced cooldown (e.g. parked by quota preflight).
 * Cooldowns sourced from upstream 429 quota_reset retain their authority
 * until their reset timestamp has elapsed.
 */
export async function liftCodexScopeCooldownOnHeadroom(
  id: string,
  scope: "codex" | "spark"
): Promise<boolean> {
  if (typeof id !== "string" || id.length === 0) return false;

  // Cheap eligibility probe so the row lock is only taken when a write is plausible.
  // The transaction below re-reads under lock and remains the authority.
  if (!(await hasCodexScopeCooldown(id, scope))) return false;

  const wrote = await db().transaction(async (tx) => {
    const existing = await tx.queryOne(
      "SELECT provider, provider_specific_data FROM provider_connections WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!existing) return false;
    const existingRecord = toRecord(rowToCamel(existing));
    if (existingRecord.provider !== "codex") return false;
    const currentPsd = toRecord(existingRecord.providerSpecificData);
    const currentCooldowns = { ...toRecord(currentPsd.codexScopeRateLimitedUntil) };
    if (!currentCooldowns[scope]) return false;

    const currentSources = { ...toRecord(currentPsd.codexScopeRateLimitSource) };
    const curSource = currentSources[scope];
    const curUntilMs =
      typeof currentCooldowns[scope] === "string"
        ? new Date(currentCooldowns[scope] as string).getTime()
        : NaN;
    // An upstream-authoritative `quota_reset` deadline outranks a local snapshot:
    // the grace window absorbs clock skew against the quota server, so a fast
    // local clock cannot lift a cooldown upstream still considers active.
    if (
      curSource === "quota_reset" &&
      Number.isFinite(curUntilMs) &&
      curUntilMs > Date.now() - QUOTA_RESET_CLOCK_SKEW_GRACE_MS
    ) {
      return false;
    }

    delete currentCooldowns[scope];
    delete currentSources[scope];

    const nextPsd: JsonRecord = { ...currentPsd };
    const nextCooldowns = omitEmptyRecord(currentCooldowns);
    const nextSources = omitEmptyRecord(currentSources);
    if (nextCooldowns) nextPsd.codexScopeRateLimitedUntil = nextCooldowns;
    else delete nextPsd.codexScopeRateLimitedUntil;
    if (nextSources) nextPsd.codexScopeRateLimitSource = nextSources;
    else delete nextPsd.codexScopeRateLimitSource;

    const exhaustedByScope = { ...toRecord(currentPsd.codexExhaustedWindowByScope) };
    if (exhaustedByScope[scope]) {
      delete exhaustedByScope[scope];
      const nextExhausted = omitEmptyRecord(exhaustedByScope);
      if (nextExhausted) {
        nextPsd.codexExhaustedWindowByScope = nextExhausted;
      } else {
        delete nextPsd.codexExhaustedWindowByScope;
        delete nextPsd.codexExhaustedWindow;
      }
    }

    await tx.execute(
      `UPDATE provider_connections
       SET provider_specific_data = $1, updated_at = $2
       WHERE id = $3`,
      [jsonValueParam(nextPsd),new Date().toISOString(), id]
    );
    return true;
  });

  // Codex-scope cooldown/exhaustion keys only — routing metadata the
  // /v1/models builder never reads.
  if (wrote) invalidateDbCache("connections", id, { skipModelCatalog: true });
  return wrote;
}

/** Persist one child cooldown through the shared scoped quota-state transaction. */
export async function updateCodexScopeCooldown(
  id: string,
  scope: "codex" | "spark",
  rateLimitedUntil: string,
  source: "fallback" | "quota_preflight" = "fallback"
): Promise<JsonRecord | null> {
  return updateCodexScopedQuotaState(id, scope, {
    rateLimitedUntil,
    rateLimitSource: source,
  });
}
