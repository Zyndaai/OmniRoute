/**
 * db/providers.js — Provider connections and nodes CRUD.
 */

import { v4 as uuidv4 } from "uuid";

import { isCommonChatGptWebRetiredProviderId } from "@/shared/constants/chatgptWebRetirement";
import { db, ts, type DbExecutor } from "./pg";
import {
  applyRetiredProviderTombstone,
  assertRetiredProviderIdentityPreserved,
} from "./providers/retiredProviders";
import { jsonValueParam, stripNul } from "./pgJsonText";
import { rowToCamel, cleanNulls } from "./caseMapping";
import { encryptConnectionFields, decryptConnectionFields } from "./encryption";
import { createLazyRowProxy } from "./providers/lazyConnectionView";
import { invalidateDbCache, getCachedRawProviderConnections } from "./readCache";
import { invalidateConnectionUpdate, type UpdateOpts } from "./readCache";
import { reorderConnections } from "./providers/deletion";
import { normalizeConnectionProviderSpecificData } from "./providers/providerSpecificData";
import { mergeConnectionProviderSpecificData } from "./providers/providerSpecificDataMerge";
import { registerConnectionStore } from "@omniroute/open-sse/utils/registeredConnectionStore.ts";
import { applyAutomaticDisableMarker } from "@/lib/providers/operatorDisable";
import { isRetestAutoDisabledEnabled } from "@/lib/credentialHealth/retestAutoDisabledFlag";
import { ensureProviderSpecificDataSecretsEncrypted } from "./providers/migrations";
import { bumpProxyConfigGeneration, getSettings } from "./settings";
import {
  getStoredManagementPassword,
  isBcryptHash,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import {
  webSessionCredentialKey,
  parseProviderSpecificData,
  isMatchingOauthIdentity,
  isWebCookieProviderId,
} from "./webSessionDedup";
import { LOCAL_PROVIDERS } from "@/shared/constants/providers";
import { pickCodexConnectionForUser } from "@/lib/oauth/utils/codexConnectionSelection";
import { isMicrosoftDesignerWebRetiredProviderId } from "@/shared/constants/designerWebRetirement";
import { reconcileCodexUsageHistory } from "./providers/usageIdentityReconciliation";
import { isRuntimeRetiredProviderId } from "@/shared/constants/providerRetirement";
import { applyCodexChildCooldownClearOnUpdate } from "./providers/codexAccountState";

import {
  withNullableMaxConcurrent,
  withNullableQuotaWindowThresholds,
  withNullableRateLimitOverrides,
  normalizeBooleanColumn,
  sanitizeRateLimitOverrides,
  toRecord,
  sanitizeQuotaWindowThresholds,
  toStringOrNull,
} from "./providers/columns";

type JsonRecord = Record<string, unknown>;

const CONNECTION_CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken"] as const;

/** Thrown when a write would store the dashboard login password as a provider credential. */
export class ManagementPasswordAsCredentialError extends Error {
  readonly code = "MANAGEMENT_PASSWORD_AS_CREDENTIAL" as const;

  constructor() {
    super(
      "That value is the dashboard login password, not a provider API key. Storing it would " +
        "send it upstream on every request routed through this connection."
    );
    this.name = "ManagementPasswordAsCredentialError";
  }
}

/**
 * Refuse to store the dashboard login password as a connection API key.
 *
 * A browser that autofills the management password into the API-key field
 * produces a connection whose credential authenticates against nothing, and
 * every request routed through it comes back 401. Rejecting it in the form
 * would not be enough: the same autofill fires again while an operator is
 * repairing the connection by hand, so the refusal has to sit on the write
 * path that all of those forms funnel into.
 *
 * Only an actual match blocks the write. A settings row that cannot be read,
 * or a bcrypt call that throws, logs and allows -- a guard against one specific
 * operator mistake must not become a way to lock out every connection write.
 *
 * Deliberately narrower than CONNECTION_CREDENTIAL_FIELDS. The OAuth tokens
 * arrive from a provider's token endpoint, and the refresh path writes them
 * back through updateProviderConnection on every renewal, so checking them
 * would put a bcrypt round on a renewal path to defend a field no autofill
 * reaches. apiKey is the only credential an operator types into a form.
 */
async function assertApiKeyIsNotManagementPassword(apiKey: unknown): Promise<void> {
  if (typeof apiKey !== "string") return;
  const trimmed = apiKey.trim();
  if (!trimmed) return;

  try {
    const settings = (await getSettings()) as JsonRecord;
    const stored = getStoredManagementPassword(settings);
    // Only a stored bcrypt hash is comparable. A fresh install that has never
    // bootstrapped a password has nothing to collide with.
    if (!isBcryptHash(stored)) return;
    // Both forms of the value, because neither the login route nor the
    // set-password route trims: a paste carries whitespace the password does
    // not have, and a password is allowed to carry whitespace of its own. The
    // second comparison only runs when the first fails on a different string.
    const matches =
      (await verifyManagementPassword(trimmed, stored)) ||
      (trimmed !== apiKey && (await verifyManagementPassword(apiKey, stored)));
    if (!matches) return;
  } catch (err) {
    console.warn(
      "[Providers] could not check the credential against the dashboard password:",
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  throw new ManagementPasswordAsCredentialError();
}

/** `rowToCamel` plus the `group_name` column surfaced under its historical `group` key. */
function connectionRowToCamel(row: unknown): JsonRecord {
  const camel = (rowToCamel(row) ?? {}) as JsonRecord;
  if (Object.hasOwn(camel, "groupName")) {
    camel.group = camel.groupName;
    delete camel.groupName;
  }
  return camel;
}

/** Whole numbers only: integer columns reject 12.5 where SQLite stored it. */
function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Legacy column names that callers still pass in the `columns` projection,
// mapped to the PostgreSQL column that replaced them.
const LEGACY_COLUMN_ALIASES: Record<string, string> = {
  group: "group_name",
  quota_window_thresholds_json: "quota_window_thresholds",
  rate_limit_overrides_json: "rate_limit_overrides",
};

// Real column set for provider_connections (must match the CREATE TABLE in
// 0001_init.sql). getProviderConnections()'s optional `columns`
// projection is interpolated directly into the SELECT clause, so every
// requested name must be validated against this allowlist before use —
// there is no current caller that passes untrusted input, but the
// projection API itself must never accept an arbitrary string.
export const PROVIDER_CONNECTIONS_COLUMNS = new Set([
  "id",
  "provider",
  "auth_type",
  "name",
  "email",
  "priority",
  "is_active",
  "access_token",
  "refresh_token",
  "expires_at",
  "token_expires_at",
  "scope",
  "project_id",
  "test_status",
  "error_code",
  "last_error",
  "last_error_at",
  "last_error_type",
  "last_error_source",
  "backoff_level",
  "rate_limited_until",
  "health_check_interval",
  "last_health_check_at",
  "last_tested",
  "api_key",
  "id_token",
  "provider_specific_data",
  "expires_in",
  "display_name",
  "global_priority",
  "default_model",
  "token_type",
  "consecutive_use_count",
  "rate_limit_protection",
  "last_used_at",
  "group",
  "group_name",
  "max_concurrent",
  "proxy_enabled",
  "per_key_proxy_enabled",
  "quota_visible",
  "quota_window_thresholds",
  "rate_limit_overrides",
  "quota_window_thresholds_json",
  "rate_limit_overrides_json",
  "created_at",
  "updated_at",
  "synced_models_at",
]);

// ──────────────── Provider Connections ────────────────

/**
 * Returns provider connections as lazy-decrypting proxies: encrypted
 * credential fields (apiKey, accessToken, refreshToken, idToken) are only
 * decrypted on first property access, not eagerly for every row. Column-
 * projected reads (`columns` passed) bypass the raw-row cache — the cache
 * key doesn't account for projection, so a projected read could otherwise
 * poison the cache for a subsequent full-row read of the same filter.
 *
 * When `limit`/`offset` are provided, the cache is also bypassed since
 * the cache key doesn't account for pagination.
 */
export async function getProviderConnections(
  filter: JsonRecord = {},
  limit?: number,
  offset?: number,
  columns?: string[]
) {
  const useCache = !columns?.length && limit === undefined && offset === undefined;
  const raw = useCache
    ? await getCachedRawProviderConnections(filter)
    : await getRawProviderConnections(filter, limit, offset, columns);
  return raw.map(createLazyRowProxy);
}

/**
 * Same as getProviderConnections but WITHOUT decryptConnectionFields.
 * Returns raw rows with encrypted credential fields intact — callers
 * that only need metadata (id, priority, backoffLevel, etc.) avoid
 * the O(n) AES-GCM decrypt cost on every cache fill.
 *
 * Used by the lazy-decryption path in auth selection (auth.ts) where
 * 10k+ connections are filtered in JS but only 1 needs its apiKey
 * decrypted.
 *
 * @param limit — Optional SQL LIMIT clause to cap rows returned
 * @param offset — Optional SQL OFFSET for pagination
 */
export async function getRawProviderConnections(
  filter: JsonRecord = {},
  limit?: number,
  offset?: number,
  columns?: string[]
) {
  await ensureProviderSpecificDataSecretsEncrypted();
  let selectCols = "*";
  if (columns?.length) {
    const invalidColumns = columns.filter((col) => !PROVIDER_CONNECTIONS_COLUMNS.has(col));
    if (invalidColumns.length > 0) {
      throw new Error(
        `getProviderConnections: invalid column(s) requested: ${invalidColumns.join(", ")}`
      );
    }
    selectCols = columns.map((col) => LEGACY_COLUMN_ALIASES[col] ?? col).join(", ");
  }
  const { where, params } = buildConnectionFilter(filter);
  let sql = `SELECT ${selectCols} FROM provider_connections${where} ORDER BY priority ASC, updated_at DESC`;
  if (limit !== undefined) {
    params.push(limit, offset ?? 0);
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }

  const rows = await db().query(sql, params);
  return rows.map((r) => {
    const camelRow = connectionRowToCamel(r);
    return withNullableRateLimitOverrides(
      withNullableQuotaWindowThresholds(
        withNullableMaxConcurrent(cleanNulls(camelRow), camelRow),
        camelRow
      ),
      camelRow
    );
  });
}

function buildConnectionFilter(filter: JsonRecord): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.provider) {
    params.push(filter.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (filter.isActive !== undefined) {
    params.push(Boolean(filter.isActive));
    conditions.push(`is_active = $${params.length}`);
  }
  if (filter.authType) {
    params.push(filter.authType);
    conditions.push(`auth_type = $${params.length}`);
  }
  return { where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "", params };
}

export async function getProviderConnectionsCount(filter: JsonRecord = {}): Promise<number> {
  const { where, params } = buildConnectionFilter(filter);
  const row = await db().queryOne<{ cnt: number }>(
    `SELECT count(*) AS cnt FROM provider_connections${where}`,
    params
  );
  return Number(row?.cnt ?? 0);
}

export async function getProviderConnectionById(id: string) {
  await ensureProviderSpecificDataSecretsEncrypted();
  const row = await db().queryOne("SELECT * FROM provider_connections WHERE id = $1", [id]);
  if (!row) return null;

  const camelRow = connectionRowToCamel(row);
  return decryptConnectionFields(
    withNullableRateLimitOverrides(
      withNullableQuotaWindowThresholds(
        withNullableMaxConcurrent(cleanNulls(camelRow), camelRow),
        camelRow
      ),
      camelRow
    )
  );
}

export interface ProviderConnectionDisplayMetadata {
  id: string;
  name: string | null;
  displayName: string | null;
  email: string | null;
}

/**
 * Reads only the non-credential fields needed by account display-name resolvers.
 *
 * This avoids decrypting provider credentials when a dashboard only needs labels.
 */
export async function getProviderConnectionDisplayMetadata(
  connectionIds: readonly string[]
): Promise<ProviderConnectionDisplayMetadata[]> {
  const ids = [...new Set(connectionIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return [];

  const rows = await db().query(
    "SELECT id, name, display_name, email FROM provider_connections WHERE id = ANY($1::text[])",
    [ids]
  );

  return rows.map((row) => {
    const view = rowToCamel(row) as JsonRecord;
    return {
      id: toStringOrNull(view.id) || "",
      name: toStringOrNull(view.name),
      displayName: toStringOrNull(view.displayName),
      email: toStringOrNull(view.email),
    };
  });
}

// #3368 PR6 — dedup web-session cookie/token credentials on connection create.
// Re-importing the same session (e.g. via bulk web-session import) under a
// different or blank name must update the existing connection instead of
// inserting a duplicate, mirroring the apikey dedup (#3023). Extracted from
// createProviderConnection to keep that function below the complexity baseline.
// provider_specific_data is plaintext JSON, so the value is compared directly
// without decryption.
/**
 * #12173 — the API-key-value dedup (#3023) matches purely on `provider +
 * apiKey`, which is correct for hosted providers where the key alone is the
 * account identity. Local/self-hosted providers (LM Studio, Ollama, vLLM,
 * llama.cpp, ...) commonly ship an optional/cosmetic API key, so users
 * legitimately reuse the same placeholder value (e.g. "lm-studio") across two
 * physically distinct servers that are actually distinguished by base URL.
 * Gate the extra baseUrl check to this provider set only — hosted-provider
 * dedup must stay untouched.
 */
function isLocalProviderId(providerId: unknown): boolean {
  return (
    typeof providerId === "string" &&
    Object.prototype.hasOwnProperty.call(LOCAL_PROVIDERS, providerId)
  );
}

/** Trim + strip a trailing slash so cosmetic differences don't defeat the match. */
function normalizeBaseUrlForDedup(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

/**
 * Find the cookie connection an incoming import should overwrite.
 *
 * #15159 / B-01 — the credential is the identity; `name` is not. This used to try
 * the name FIRST ("name-based upsert for parity with the apikey path"), so
 * re-importing under an existing name returned that row and the caller's
 * `merged = { ...decryptedExisting, ...data }` wrote the new cookie over it.
 * Because `name` is a user-editable display label, two different accounts
 * legitimately share one — and the second import silently destroyed the first
 * account's stored session, unrecoverably.
 *
 * This is the same hazard the OAuth branch of this file already fixed
 * (:532-540): "two different IdPs ... can share the same email address; matching
 * on email alone would silently overwrite the other account's connection on the
 * second login." The cookie branch was never given the same treatment.
 *
 * The name lookup is now only a fallback for rows with no derivable credential
 * key — there the name is genuinely all there is to match on. Every other import
 * matches on its credential, and one with a different credential gets its own row.
 *
 * Trade-off, stated plainly: a *rotated* cookie under a stable name now creates a
 * second row instead of updating in place. That is the intended direction of the
 * error — a caller can delete a stale row, but cannot recover a session that was
 * already overwritten. #3368's actual goal (same cookie under a different name
 * dedupes) is unaffected: that was always the credential loop's job.
 */
/**
 * Cookie-session identity checks must use plaintext for both sides.
 * #16836 encrypts selected providerSpecificData cookies with randomized AES-GCM,
 * so matching a new plaintext cookie against the raw JSON column would always
 * miss the same session and create duplicate provider connections.
 * Preserve the existing fallback behavior for legacy unencrypted metadata.
 */
function storedCookieCredentialKey(raw: unknown): string | null {
  const parsed = parseProviderSpecificData(raw);
  if (!parsed) return null;
  return webSessionCredentialKey(
    decryptConnectionFields({ providerSpecificData: parsed }).providerSpecificData
  );
}

async function findExistingCookieConnection(
  q: DbExecutor,
  provider: unknown,
  name: unknown,
  normalizedProviderSpecificData: unknown
): Promise<JsonRecord | null> {
  // 1) Credential-value dedup — the authoritative identity for a web session.
  const newCredKey = webSessionCredentialKey(normalizedProviderSpecificData);
  if (newCredKey) {
    const cookieRows = await q.query<JsonRecord>(
      "SELECT * FROM provider_connections WHERE provider = $1 AND auth_type = 'cookie'",
      [provider]
    );
    for (const row of cookieRows) {
      if (storedCookieCredentialKey(row.provider_specific_data) === newCredKey) return row;
    }
  }

  // 2) Name fallback, only when this import carries no credential to compare
  //    against AND the candidate row itself has none. Matching a credential-less
  //    import onto a row that *does* hold a credential would clobber it with
  //    nothing — the same data loss, reached from the other direction.
  if (name && !newCredKey) {
    const byName =
      (await q.queryOne<JsonRecord>(
        "SELECT * FROM provider_connections WHERE provider = $1 AND auth_type = 'cookie' AND name = $2 LIMIT 1",
        [provider, name]
      )) || null;
    if (byName && !storedCookieCredentialKey(byName.provider_specific_data)) {
      return byName;
    }
  }

  return null;
}

export async function createProviderConnection(data: JsonRecord) {
  await assertApiKeyIsNotManagementPassword(data.apiKey);
  await ensureProviderSpecificDataSecretsEncrypted();

  // Creates for one provider run one at a time, from the duplicate lookup to the
  // renumbering: two overlapping creates of the same key or account would otherwise both
  // miss each other's row and insert twice. A matched row is then locked until the write.
  const outcome = await db().transaction(async (tx) => {
    await tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `provider_connections:${toStringOrNull(data.provider) ?? ""}`,
    ]);
    return createOrMergeConnection(tx, data);
  });
  invalidateDbCache("connections"); // Bust connections read cache
  if (outcome.reloadId) {
    return (await getProviderConnectionById(outcome.reloadId)) ?? outcome.connection;
  }
  return outcome.connection;
}

async function createOrMergeConnection(
  tx: DbExecutor,
  data: JsonRecord
): Promise<{ connection: JsonRecord | null; reloadId: string | null }> {
  const now = new Date().toISOString();
  const normalizedProviderSpecificData = normalizeConnectionProviderSpecificData(
    toStringOrNull(data.provider),
    data.providerSpecificData,
    data
  );

  let existing: JsonRecord | null = null;
  let promotedCodexIdentity = false;

  const providerSpecificData = toRecord(data.providerSpecificData);
  const workspaceId = toStringOrNull(providerSpecificData.workspaceId);
  const chatgptUserId = toStringOrNull(providerSpecificData.chatgptUserId);

  if (data.authType === "oauth" && data.provider === "codex" && chatgptUserId) {
    const strongSql = workspaceId
      ? "SELECT * FROM provider_connections WHERE provider = $1 AND auth_type = 'oauth' AND provider_specific_data->>'workspaceId' = $2 AND provider_specific_data->>'chatgptUserId' = $3 LIMIT 1"
      : "SELECT * FROM provider_connections WHERE provider = $1 AND auth_type = 'oauth' AND (provider_specific_data->>'workspaceId' IS NULL OR provider_specific_data->>'workspaceId' = '') AND provider_specific_data->>'chatgptUserId' = $2 LIMIT 1";
    existing =
      (await tx.queryOne<JsonRecord>(
        strongSql,
        workspaceId ? [data.provider, workspaceId, chatgptUserId] : [data.provider, chatgptUserId]
      )) || null;

    if (!existing && workspaceId) {
      const workspaceMatches = await tx.query<JsonRecord>(
        `SELECT * FROM provider_connections
         WHERE provider = $1 AND auth_type = 'oauth'
           AND provider_specific_data->>'workspaceId' = $2
         ORDER BY created_at`,
        [data.provider, workspaceId]
      );
      existing = pickCodexConnectionForUser(
        workspaceMatches,
        chatgptUserId,
        toStringOrNull(data.email)
      );
      promotedCodexIdentity = existing !== null;
    }
  } else if (data.authType === "oauth" && data.email) {
    if (data.provider === "codex") {
      if (workspaceId) {
        existing =
          (await tx.queryOne<JsonRecord>(
            `SELECT * FROM provider_connections
             WHERE provider = $1 AND auth_type = 'oauth'
               AND provider_specific_data->>'workspaceId' = $2
               AND email = $3
             LIMIT 1`,
            [data.provider, workspaceId, data.email]
          )) || null;
      }
    } else {
      // For other providers (or Codex without workspaceId), match on email —
      // disambiguated by providerSpecificData.username and/or
      // providerSpecificData.profileArn when present on both sides. Two
      // different IdPs (or two distinct Kiro/AWS profiles authenticated via
      // the same email-carrying IdP) can share the same email address;
      // matching on email alone would silently overwrite the other
      // account's connection on the second login. Only fall back to the
      // bare email-only match when neither side carries a username/profileArn
      // (legacy rows created before this disambiguation existed).
      const incomingUsername = toStringOrNull(providerSpecificData.username);
      const incomingProfileArn = toStringOrNull(providerSpecificData.profileArn);
      // Claude: one identity reaches its personal workspace and every Team
      // organization with the same email and the same accountUUID, so
      // organizationUUID is what separates the accounts.
      const incomingOrganizationUuid = toStringOrNull(providerSpecificData.organizationUUID);
      const emailMatches = await tx.query<JsonRecord>(
        "SELECT * FROM provider_connections WHERE provider = $1 AND auth_type = 'oauth' AND email = $2",
        [data.provider, data.email]
      );
      existing =
        emailMatches.find((row) =>
          isMatchingOauthIdentity(
            row,
            incomingUsername,
            incomingProfileArn,
            incomingOrganizationUuid
          )
        ) || null;
    }
  } else if (data.authType === "apikey") {
    if (data.name && !isWebCookieProviderId(data.provider)) {
      existing =
        (await tx.queryOne<JsonRecord>(
          "SELECT * FROM provider_connections WHERE provider = $1 AND auth_type = 'apikey' AND name = $2 LIMIT 1",
          [data.provider, data.name]
        )) || null;
    }
    // #3023 — dedup by API key value: re-adding the same key (under a different
    // or blank name) must update the existing connection, not insert a duplicate
    // row. Stored keys use non-deterministic AES-GCM, so ciphertext can't be
    // compared directly — decrypt each apikey row for this provider and match the
    // plaintext (trimmed) instead.
    const newApiKey = typeof data.apiKey === "string" ? data.apiKey.trim() : "";
    if (!existing && newApiKey) {
      const isLocal = isLocalProviderId(data.provider);
      const newBaseUrl = normalizeBaseUrlForDedup(providerSpecificData.baseUrl);
      const apiKeyRows = await tx.query<JsonRecord>(
        "SELECT * FROM provider_connections WHERE provider = $1 AND auth_type = 'apikey'",
        [data.provider]
      );
      for (const row of apiKeyRows) {
        const decrypted = decryptConnectionFields(toRecord(rowToCamel(row)));
        if (toStringOrNull(decrypted.apiKey)?.trim() !== newApiKey) continue;
        // #12173 — for local/self-hosted providers, a differing base URL means
        // this is a different physical server, not the same account; fall
        // through to inserting a new connection even though the apiKey matches.
        if (isLocal) {
          const existingBaseUrl = normalizeBaseUrlForDedup(
            parseProviderSpecificData(row.provider_specific_data)?.baseUrl
          );
          if (existingBaseUrl !== newBaseUrl) continue;
        }
        existing = row;
        break;
      }
    }
  } else if (data.authType === "cookie") {
    existing = await findExistingCookieConnection(
      tx,
      data.provider,
      data.name,
      normalizedProviderSpecificData
    );
  } else if (data.authType === "access_token") {
    // #1290 — bare access-token imports (e.g. a raw ChatGPT website access
    // token with no refresh token) are intentionally never deduped: every
    // import creates a new connection. Unlike oauth (workspace+email) or
    // apikey (key-value) imports, a bare access token has no refresh token
    // and no stable long-lived identity to safely dedup against — matching
    // on email alone here would risk silently overwriting an existing full
    // oauth connection for the same account.
  }

  if (existing) {
    const matchedId = toStringOrNull(existing.id);
    if (!matchedId) return { connection: null, reloadId: null };
    // Lock the matched row and merge into its current state, so a concurrent
    // updateProviderConnection is not overwritten by a copy read before it committed.
    const locked = await tx.queryOne<JsonRecord>(
      "SELECT * FROM provider_connections WHERE id = $1 FOR UPDATE",
      [matchedId]
    );
    if (!locked) return { connection: null, reloadId: null };
    existing = locked;
    const existingId = matchedId;
    const rawExisting = connectionRowToCamel(existing);
    const decryptedExisting = decryptConnectionFields({ ...rawExisting });
    const merged: JsonRecord = { ...decryptedExisting, ...data, updatedAt: now };
    merged.providerSpecificData = normalizeConnectionProviderSpecificData(
      toStringOrNull(merged.provider),
      merged.providerSpecificData,
      merged,
      decryptedExisting.providerSpecificData
    );
    const persistence: JsonRecord = { ...merged };
    for (const field of CONNECTION_CREDENTIAL_FIELDS) {
      if (!Object.hasOwn(data, field)) {
        persistence[field] = rawExisting[field];
      }
    }
    if (promotedCodexIdentity) {
      await reconcileCodexUsageHistory(tx, {
        connectionId: existingId,
        existing,
        merged,
        matchedExistingCodexByWorkspace: true,
      });
    }
    await _updateConnectionRow(tx, existingId, encryptConnectionFields(persistence));
    const returnedConnection = withNullableRateLimitOverrides(
      withNullableQuotaWindowThresholds(
        withNullableMaxConcurrent(cleanNulls(merged), merged),
        merged
      ),
      merged
    );

    if (
      isMicrosoftDesignerWebRetiredProviderId(merged.provider) ||
      isRuntimeRetiredProviderId(merged.provider) ||
      isCommonChatGptWebRetiredProviderId(merged.provider)
    ) {
      return { connection: returnedConnection, reloadId: existingId };
    }

    return { connection: returnedConnection, reloadId: null };
  }

  // Generate name: prefer explicit name, then email, then a stable short-ID label.
  // Avoid sequential "Account N" — it reassigns when accounts are deleted/reordered.
  let connectionName = data.name || null;
  if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
    if (data.email) {
      connectionName = data.email as string;
    } else if (data.displayName) {
      connectionName = data.displayName as string;
    }
    // Otherwise leave null — UI will fall back to getAccountDisplayName() → "Account #<id>"
  }

  const connection: Record<string, unknown> = {
    id: uuidv4(),
    provider: data.provider,
    authType: data.authType || "oauth",
    name: connectionName,
    priority: data.priority,
    isActive: data.isActive !== undefined ? data.isActive : true,
    createdAt: now,
    updatedAt: now,
    proxyEnabled: normalizeBooleanColumn(data.proxyEnabled, true),
    perKeyProxyEnabled: normalizeBooleanColumn(data.perKeyProxyEnabled, false),
    quotaVisible: normalizeBooleanColumn(data.quotaVisible, true),
  };

  // Optional fields
  const optionalFields = [
    "displayName",
    "email",
    "globalPriority",
    "defaultModel",
    "accessToken",
    "refreshToken",
    "expiresAt",
    // #5326's payload sets this and _insertConnectionRow binds it, but it was
    // missing from this allowlist — so every created row stored NULL however good
    // the payload was. The update path already carries it (`data.tokenExpiresAt`).
    "tokenExpiresAt",
    "tokenType",
    "scope",
    "idToken",
    "projectId",
    "apiKey",
    "testStatus",
    "lastTested",
    "lastError",
    "lastErrorAt",
    "lastErrorType",
    "lastErrorSource",
    "rateLimitedUntil",
    "expiresIn",
    "errorCode",
    "consecutiveUseCount",
    "rateLimitProtection",
    "group",
    "maxConcurrent",
    "proxyEnabled",
    "perKeyProxyEnabled",
    "quotaVisible",
    "quotaWindowThresholds",
    "rateLimitOverrides",
    "healthCheckInterval",
  ];
  for (const field of optionalFields) {
    if (data[field] !== undefined && data[field] !== null) {
      connection[field] = data[field];
    }
  }
  if (normalizedProviderSpecificData && Object.keys(normalizedProviderSpecificData).length > 0) {
    connection.providerSpecificData = normalizedProviderSpecificData;
  }
  // Sanitize the window-thresholds map up front so the in-memory `connection`
  // matches the row we're about to insert. The serialize path runs the same
  // sanitizer on the way to SQLite. Assigning null (when sanitize collapses
  // to no-overrides) keeps the field present on the returned object so the
  // UI can tell "field was read, no overrides" apart from "field absent."
  if ("quotaWindowThresholds" in connection) {
    const result = sanitizeQuotaWindowThresholds(connection.quotaWindowThresholds);
    if (result.rejected.length > 0) {
      throw new Error(
        `Refusing to persist quotaWindowThresholds with rejected keys: ${result.rejected.join(", ")}`
      );
    }
    connection.quotaWindowThresholds = result.sanitized;
  }

  // Same sanitization for rateLimitOverrides — keep in-memory representation
  // in sync with what gets persisted. Reject (don't silently drop) invalid
  // keys/values so a direct DB writer can't lose operator intent.
  if ("rateLimitOverrides" in connection) {
    const result = sanitizeRateLimitOverrides(connection.rateLimitOverrides);
    if (result.rejected.length > 0) {
      throw new Error(
        `Refusing to persist rateLimitOverrides with rejected keys: ${result.rejected.join(", ")}`
      );
    }
    connection.rateLimitOverrides = result.sanitized;
  }

  const providerId = toStringOrNull(data.provider);
  connection.priority = await _insertConnectionRow(tx, encryptConnectionFields({ ...connection }));
  if (providerId) await reorderConnections(tx, providerId);

  const returnedConnection = withNullableRateLimitOverrides(
    withNullableQuotaWindowThresholds(
      withNullableMaxConcurrent(cleanNulls(connection), connection),
      connection
    ),
    connection
  );

  if (
    isMicrosoftDesignerWebRetiredProviderId(data.provider) ||
    isRuntimeRetiredProviderId(providerId) ||
    isCommonChatGptWebRetiredProviderId(providerId)
  ) {
    return { connection: returnedConnection, reloadId: String(connection.id) };
  }

  return { connection: returnedConnection, reloadId: null };
}

/**
 * The writable provider_connections columns with the value each takes from a
 * camelCase connection record. Insert and update share it, so the two can no
 * longer drift apart. `id`, `created_at` and `priority` are handled by the callers.
 */
function connectionColumnValues(conn: JsonRecord): Array<[column: string, value: unknown]> {
  // Postgres text and jsonb reject U+0000, and error messages arrive from upstream.
  const str = (value: unknown) =>
    value ? (typeof value === "string" ? stripNul(value) : value) : null;
  return [
    ["provider", conn.provider],
    ["auth_type", str(conn.authType)],
    ["name", str(conn.name)],
    ["email", str(conn.email)],
    ["is_active", conn.isActive !== false],
    ["access_token", str(conn.accessToken)],
    ["refresh_token", str(conn.refreshToken)],
    ["expires_at", ts(conn.expiresAt as string | number | Date | null | undefined)],
    ["token_expires_at", ts(conn.tokenExpiresAt as string | number | Date | null | undefined)],
    ["scope", str(conn.scope)],
    ["project_id", str(conn.projectId)],
    ["test_status", str(conn.testStatus)],
    ["error_code", str(conn.errorCode)],
    ["last_error", str(conn.lastError)],
    ["last_error_at", ts(conn.lastErrorAt as string | number | Date | null | undefined)],
    ["last_error_type", str(conn.lastErrorType)],
    ["last_error_source", str(conn.lastErrorSource)],
    ["backoff_level", toIntOrNull(conn.backoffLevel) ?? 0],
    ["rate_limited_until", ts(conn.rateLimitedUntil as string | number | Date | null | undefined)],
    ["health_check_interval", toIntOrNull(conn.healthCheckInterval)],
    [
      "last_health_check_at",
      ts(conn.lastHealthCheckAt as string | number | Date | null | undefined),
    ],
    ["last_tested", ts(conn.lastTested as string | number | Date | null | undefined)],
    ["api_key", str(conn.apiKey)],
    ["id_token", str(conn.idToken)],
    [
      "provider_specific_data",
      jsonValueParam(conn.providerSpecificData ? conn.providerSpecificData : null),
    ],
    ["expires_in", toIntOrNull(conn.expiresIn) || null],
    ["display_name", str(conn.displayName)],
    ["global_priority", toIntOrNull(conn.globalPriority) || null],
    ["default_model", str(conn.defaultModel)],
    ["token_type", str(conn.tokenType)],
    ["consecutive_use_count", toIntOrNull(conn.consecutiveUseCount) ?? 0],
    ["rate_limit_protection", conn.rateLimitProtection === true || conn.rateLimitProtection === 1],
    ["last_used_at", ts(conn.lastUsedAt as string | number | Date | null | undefined)],
    ["group_name", str(conn.group)],
    ["max_concurrent", toIntOrNull(conn.maxConcurrent)],
    ["proxy_enabled", normalizeBooleanColumn(conn.proxyEnabled, true)],
    ["per_key_proxy_enabled", normalizeBooleanColumn(conn.perKeyProxyEnabled, false)],
    ["quota_visible", normalizeBooleanColumn(conn.quotaVisible, true)],
    ["quota_window_thresholds", jsonValueParam(objectOrNull(conn.quotaWindowThresholds))],
    ["rate_limit_overrides", jsonValueParam(objectOrNull(conn.rateLimitOverrides))],
    ["last_ping_at", ts(conn.lastPingAt as string | number | Date | null | undefined)],
    ["last_pinged_reset_key", str(conn.lastPingedResetKey)],
  ];
}

function objectOrNull(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/** Inserts the row and returns the stored priority (an unset one becomes the provider's max + 1). */
async function _insertConnectionRow(tx: DbExecutor, input: JsonRecord): Promise<number> {
  const conn = applyRetiredProviderTombstone(input);
  const columns = connectionColumnValues(conn);
  const names = ["id", "created_at", "updated_at", "priority", ...columns.map(([name]) => name)];
  const now = ts(conn.updatedAt as string) ?? new Date().toISOString();
  const values: unknown[] = [
    conn.id,
    ts(conn.createdAt as string) ?? now,
    now,
    toIntOrNull(conn.priority) || 0,
    ...columns.map(([, value]) => value),
  ];
  const placeholders = names.map((_, index) => `$${index + 1}`);
  // priority is $4: an unset one takes the provider's next slot inside this statement,
  // so two concurrent creates cannot both read the same max.
  placeholders[3] =
    "COALESCE(NULLIF($4::integer, 0), (SELECT COALESCE(MAX(priority), 0) + 1 FROM provider_connections WHERE provider = $5::text))";
  const row = await tx.queryOne<{ priority: number }>(
    `INSERT INTO provider_connections (${names.join(", ")}) VALUES (${placeholders.join(", ")})
     RETURNING priority`,
    values
  );
  return row?.priority ?? 0;
}

async function _updateConnectionRow(tx: DbExecutor, id: string, input: JsonRecord) {
  const data = applyRetiredProviderTombstone(input);
  const columns = connectionColumnValues(data);
  const now = ts(data.updatedAt as string) ?? new Date().toISOString();
  const assignments = ["priority", "updated_at", ...columns.map(([name]) => name)].map(
    (name, index) => `${name} = $${index + 2}`
  );
  await tx.execute(`UPDATE provider_connections SET ${assignments.join(", ")} WHERE id = $1`, [
    id,
    toIntOrNull(data.priority) || 0,
    now,
    ...columns.map(([, value]) => value),
  ]);
}

export type ProviderConnectionUpdateOpts = UpdateOpts & {
  /** #16190: this isActive:false write is the permanent-ban auto-disable (never retested). */
  permanentBan?: boolean;
};

function buildUpdatedConnection(
  existing: JsonRecord,
  data: JsonRecord,
  opts?: ProviderConnectionUpdateOpts
): JsonRecord {
  const existingCamel = connectionRowToCamel(existing);
  const merged: JsonRecord = {
    ...existingCamel,
    ...data,
    updatedAt: new Date().toISOString(),
  };
  merged.providerSpecificData = applyCodexChildCooldownClearOnUpdate(
    data,
    normalizeConnectionProviderSpecificData(
      toStringOrNull(merged.provider),
      merged.providerSpecificData,
      merged,
      existingCamel.providerSpecificData
    )
  );
  // #16190: with CREDENTIAL_HEALTH_RETEST_AUTO_DISABLED on, an automated switch-off is
  // marked so the health sweep can retest it; a permanent-ban switch-off is always marked
  // so that sweep never retests it, whenever the flag is turned on.
  if (typeof data.isActive === "boolean") {
    merged.providerSpecificData = applyAutomaticDisableMarker(
      merged.providerSpecificData,
      existingCamel.isActive,
      data.isActive,
      undefined,
      {
        stampAutomatic: data.isActive === false && isRetestAutoDisabledEnabled(),
        permanentBan: opts?.permanentBan === true,
      }
    );
  }
  // Mirror the sanitization the create path applies — keep the returned
  // object in lockstep with what we persist.
  if ("quotaWindowThresholds" in merged) {
    const result = sanitizeQuotaWindowThresholds(merged.quotaWindowThresholds);
    if (result.rejected.length > 0) {
      throw new Error(
        `Refusing to persist quotaWindowThresholds with rejected keys: ${result.rejected.join(", ")}`
      );
    }
    // For updates we always carry the key forward (even as null) so the read
    // path surfaces the cleared state to callers that merged it.
    merged.quotaWindowThresholds = result.sanitized;
  }
  if ("rateLimitOverrides" in merged) {
    const result = sanitizeRateLimitOverrides(merged.rateLimitOverrides);
    if (result.rejected.length > 0) {
      throw new Error(
        `Refusing to persist rateLimitOverrides with rejected keys: ${result.rejected.join(", ")}`
      );
    }
    merged.rateLimitOverrides = result.sanitized;
  }
  return merged;
}

export async function updateProviderConnection(
  id: string,
  data: JsonRecord,
  opts?: ProviderConnectionUpdateOpts
) {
  // The incoming value only. A connection that already holds the password has
  // to stay editable, or an operator cannot repair the one this guard exists
  // to prevent -- and re-checking the merged value would spend a bcrypt round
  // on every unrelated field edit.
  if (typeof data.apiKey === "string" && data.apiKey.trim()) {
    const present = await db().queryOne(
      "SELECT 1 AS present FROM provider_connections WHERE id = $1",
      [id]
    );
    if (!present) return null;
    await assertApiKeyIsNotManagementPassword(data.apiKey);
  }
  await ensureProviderSpecificDataSecretsEncrypted();

  // The row is locked from the read to the write: two concurrent updates of
  // different fields both start from the other's result instead of losing one.
  const outcome = await db().transaction(async (tx) => {
    const existing = await tx.queryOne<JsonRecord>(
      "SELECT * FROM provider_connections WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!existing) return null;
    const built = buildUpdatedConnection(existing, data, opts);
    assertRetiredProviderIdentityPreserved(existing.provider, built.provider);
    await reconcileCodexUsageHistory(tx, { connectionId: id, existing, merged: built });
    await _updateConnectionRow(tx, id, encryptConnectionFields({ ...built }));
    return { merged: built, existing };
  });
  if (!outcome) return null;
  const { merged, existing } = outcome;
  invalidateConnectionUpdate(id, data, opts);
  await bumpProxyConfigGeneration();

  // Zero is the internal move-to-top sentinel. Explicit positive priorities
  // are operator-selected values, not ranks to compact after every edit.
  if (data.priority === 0) {
    const providerId =
      typeof existing.provider === "string" ? existing.provider : String(existing.provider || "");
    await reorderConnections(db(), providerId);
    return getProviderConnectionById(id);
  }

  // The write path keeps existing ciphertext in merged.providerSpecificData
  // to avoid re-encrypting unchanged values. Return a decrypted copy instead:
  // callers of updateProviderConnection must never see enc:v1 metadata as the
  // usable console credentials (#16836).
  const returned = decryptConnectionFields({ ...merged });
  const returnedConnection = withNullableRateLimitOverrides(
    withNullableQuotaWindowThresholds(
      withNullableMaxConcurrent(cleanNulls(returned), returned),
      returned
    ),
    returned
  );

  if (
    isMicrosoftDesignerWebRetiredProviderId(merged.provider) ||
    isRuntimeRetiredProviderId(merged.provider) ||
    isCommonChatGptWebRetiredProviderId(merged.provider)
  ) {
    return (await getProviderConnectionById(id)) ?? returnedConnection;
  }

  return returnedConnection;
}

export { mergeConnectionProviderSpecificData } from "./providers/providerSpecificDataMerge";

// open-sse may not import this module (boundary ratchet). Code there that reads
// one connection by id and patches its providerSpecificData gets both functions
// from this registration instead (open-sse/utils/registeredConnectionStore.ts).
registerConnectionStore({
  getProviderConnectionById,
  mergeConnectionProviderSpecificData,
});

export {
  updateCodexScopedQuotaState,
  updateCodexScopeCooldown,
  applyCodexChildCooldownClearOnUpdate,
  stripCodexChildCooldownFields,
  stripCodexChildCooldownsFromConnection,
  hasCodexScopeCooldown,
  liftCodexScopeCooldownOnHeadroom,
} from "./providers/codexAccountState";

/**
 * Lightweight stat bump — updates lastUsedAt and consecutiveUseCount without
 * SELECT, re-encrypt, cache invalidation, or file backup.
 * Safe for the hot getProviderCredentials path where only usage stats change.
 * Fixes the cache-thrashing bug where every credential selection invalidated
 * the 5s TTL cache and paid 3000-row decryption cost on the next request.
 */
export async function touchConnectionLastUsed(
  id: string,
  consecutiveUseCount: number
): Promise<void> {
  if (!id) return;
  const now = new Date().toISOString();
  await db().execute(
    `UPDATE provider_connections SET
      last_used_at = $1,
      consecutive_use_count = $2,
      updated_at = $1
    WHERE id = $3`,
    [now, toIntOrNull(consecutiveUseCount) ?? 0, id]
  );
}

/**
 * #12849: stamp when a connection's synced model catalog was last written.
 * getActiveSyncedCatalog reads this to stop treating a synced catalog as
 * authoritative forever — a connection synced once and never refreshed
 * silently pinned routing to that point-in-time snapshot with no staleness
 * check. Lightweight targeted UPDATE, mirrors touchConnectionLastUsed.
 */
export async function touchConnectionSyncedModelsAt(id: string): Promise<void> {
  if (!id) return;
  const now = new Date().toISOString();
  await db().execute(
    `UPDATE provider_connections SET
      synced_models_at = $1,
      updated_at = $1
    WHERE id = $2`,
    [now, id]
  );
  // New successful-sync timestamp must be visible without waiting for the
  // connection row cache to expire.
  invalidateDbCache("connections", id, { skipModelCatalog: true });
}

/**
 * Lightweight backoff reset — runs a targeted UPDATE without SELECT or re-encrypt.
 * Follows the `clearConnectionErrorIfUnchanged` pattern but without the CAS check,
 * since the caller already verified the connection is eligible for reset.
 * Resets all backoff/error columns so the connection re-enters the selection pool.
 * Does invalidateDbCache + bumpProxyConfigGeneration since backoff affects priority.
 * #13389: `skipModelCatalog` — the catalog builder never reads backoff/error
 * state, so this must not bust the expensive-to-rebuild `/v1/models` cache.
 */
export async function resetConnectionBackoff(id: string): Promise<void> {
  if (!id) return;
  await db().execute(
    `UPDATE provider_connections SET
      backoff_level = 0,
      test_status = 'active',
      last_error = NULL,
      last_error_at = NULL,
      last_error_type = NULL,
      last_error_source = NULL,
      error_code = NULL,
      updated_at = $1
    WHERE id = $2`,
    [new Date().toISOString(), id]
  );
  invalidateDbCache("connections", id, { skipModelCatalog: true });
  await bumpProxyConfigGeneration();
}

export async function cleanupProviderConnections() {
  return 0;
}

export async function getDistinctGroups(): Promise<string[]> {
  const rows = await db().query<{ group_name: string | null }>(
    "SELECT DISTINCT group_name FROM provider_connections WHERE group_name IS NOT NULL ORDER BY group_name"
  );
  return rows.map((r) => String(r.group_name ?? "")).filter(Boolean);
}

export { autoMigrateLegacyEncryptedConnections, getGheCopilotHosts } from "./providers/migrations";
export {
  deleteProviderConnection,
  deleteProviderConnections,
  deleteProviderConnectionsByProvider,
  reorderProviderConnections,
} from "./providers/deletion";

// ──────────────── Re-exports from leaf modules ────────────────

export {
  getProviderNodes,
  getProviderNodesCount,
  getProviderNodeById,
  resolveProviderNodeForConnection,
  createProviderNode,
  updateProviderNode,
  deleteProviderNode,
} from "./providers/nodes";
export {
  setConnectionRateLimitUntil,
  markConnectionRateLimitedUntil,
  clearConnectionRateLimit,
  getEffectiveQuotaUsage,
  clearStaleCrashCooldowns,
  formatResetCountdown,
  isConnectionRateLimited,
  getRateLimitedConnections,
  clearConnectionErrorIfUnchanged,
} from "./providers/rateLimit";
