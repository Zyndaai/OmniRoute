/**
 * The SQLite `key_value` table, dispatched by namespace to its PostgreSQL homes
 * (`docs/architecture/postgres-schema-mapping.md` -> "Domain B"). Each namespace yields rows
 * for a target table in source-value form (JSON as text, timestamps as stored); the table
 * conversion in ./transfer.ts types them like any other row.
 *
 * Every namespace has a disposition. An unknown namespace with rows aborts the transfer, so
 * nothing can be dropped by accident.
 */
import { DEFAULT_DATABASE_SETTINGS } from "@/types/databaseSettings";

export interface KeyValueRow {
  namespace: string;
  key: string;
  value: string;
}

export interface DispatchedRow {
  table: string;
  row: Record<string, unknown>;
}

export interface KeyValueResult {
  rows: DispatchedRow[];
  /** namespace -> rows deliberately not copied, with the reason */
  dropped: Array<{ namespace: string; count: number; reason: string }>;
  /** namespace -> keys skipped individually (expired, unmatched, invalid), with the reason */
  skipped: Array<{ namespace: string; key: string; reason: string }>;
  /** The resolved database settings written to config_entries('databaseSettings'). */
  effectiveDatabaseSettings: Record<string, Record<string, unknown>>;
}

/** Plain config_entries namespaces whose values are JSON text (J). */
const CONFIG_JSON = new Set([
  "proxyConfig",
  "secrets",
  "ipFilter",
  "pii_settings",
  "provider_param_filters",
  "interception_rules",
  "compression",
  "obsidian",
  "notion",
  "sync",
  "conductor",
  "local_corpus",
  "cliToolLastConfig",
  "cliToolInitialConfig",
  "serviceModels",
  "antigravityCreditBalance",
]);

/** config_entries namespaces whose values are raw text, stored as JSON strings (J-raw). */
const CONFIG_RAW = new Set(["feature_flags", "ccDiscoveryAliases", "functionalGatewayMirrors"]);

const DROPPED_NAMESPACES: Record<string, string> = {
  scheduler: "SQLite VACUUM scheduler state",
  walMaintenance: "SQLite WAL maintenance state",
  dbBackup: "SQLite file-backup state (pg_dump replaces it)",
  apiKeySelfService: "run-once SQLite migration marker",
  "gamification:streaks": "gamification was removed (owner: drop)",
};

/** `settings` keys that move to config_entries('job_state'). */
const SETTINGS_TO_JOB_STATE = new Set([
  "model_sync_last_run",
  "provider_limits_auto_sync_last_run",
  "codex_catalog_revalidated_version",
  "maxaiSigningConstants",
  "learnedRateLimits",
]);

/** `settings` keys that are not copied; the database-settings blobs are resolved first. */
function droppedSettingsKey(key: string): string | null {
  if (key.startsWith("memory")) return "memory engine removed";
  if (key.startsWith("qdrant")) return "memory engine removed";
  if (key === "chatAdmissionSettings") return "dead module";
  if (["databaseSettings", "backup", "optimization", "cache"].includes(key)) {
    return "legacy database-settings blob, resolved into config_entries('databaseSettings')";
  }
  return null;
}

/** Sections written to config_entries('databaseSettings'); backup and optimization are SQLite-only. */
const DATABASE_SETTINGS_SECTIONS = ["logs", "cache", "retention", "aggregation"] as const;
const ALL_SECTIONS = Object.keys(DEFAULT_DATABASE_SETTINGS) as Array<
  keyof typeof DEFAULT_DATABASE_SETTINGS
>;

/** The old flat key names, frozen verbatim from src/lib/db/databaseSettings.ts at 8435e220^. */
const LEGACY_FLAT_ALIASES: Record<string, Record<string, string[]>> = {
  logs: {
    detailedLogsEnabled: ["detailedLogsEnabled"],
    callLogPipelineEnabled: ["callLogPipelineEnabled"],
    maxDetailSizeKb: ["maxDetailSizeKb"],
    ringBufferSize: ["ringBufferSize"],
  },
  backup: {
    autoBackupEnabled: ["autoBackupEnabled"],
    autoBackupFrequency: ["autoBackupFrequency"],
    keepLastNBackups: ["keepLastNBackups"],
  },
  cache: {
    semanticCacheEnabled: ["semanticCacheEnabled"],
    semanticCacheMaxSize: ["semanticCacheMaxSize"],
    semanticCacheTTL: ["semanticCacheTTL"],
    semanticCacheVectorEnabled: ["semanticCacheVectorEnabled"],
    semanticCacheBackend: ["semanticCacheBackend"],
    semanticCacheThreshold: ["semanticCacheThreshold"],
    semanticCacheEmbeddingProvider: ["semanticCacheEmbeddingProvider"],
    semanticCacheEmbeddingModel: ["semanticCacheEmbeddingModel"],
    semanticCacheEmbeddingDimension: ["semanticCacheEmbeddingDimension"],
    semanticCacheEmbeddingBaseUrl: ["semanticCacheEmbeddingBaseUrl"],
    semanticCacheEmbeddingApiKey: ["semanticCacheEmbeddingApiKey"],
    semanticCacheRedisUrl: ["semanticCacheRedisUrl"],
    semanticCacheRedisPrefix: ["semanticCacheRedisPrefix"],
    semanticCacheRequireZeroTemp: ["semanticCacheRequireZeroTemp"],
    promptCacheEnabled: ["promptCacheEnabled"],
    promptCacheStrategy: ["promptCacheStrategy"],
    alwaysPreserveClientCache: ["alwaysPreserveClientCache"],
    modelCatalogCacheTtlMs: ["modelCatalogCacheTtlMs"],
  },
  retention: {
    quotaSnapshots: ["quotaSnapshots"],
    compressionAnalytics: ["compressionAnalytics"],
    mcpAudit: ["mcpAudit"],
    configAudit: ["configAudit"],
    a2aEvents: ["a2aEvents"],
    callLogs: ["callLogs"],
    conversationTurnNodes: ["conversationTurnNodes"],
    usageHistory: ["usageHistory"],
    memoryEntries: ["memoryEntries"],
    domainCostHistory: ["domainCostHistory"],
    compressionCacheStats: ["compressionCacheStats"],
    compressionRunTelemetry: ["compressionRunTelemetry"],
    autoCleanupEnabled: ["autoCleanupEnabled"],
  },
  aggregation: {
    enabled: ["aggregationEnabled", "enabled"],
    rawDataRetentionDays: ["rawDataRetentionDays"],
    granularity: ["granularity"],
  },
  optimization: {
    autoVacuumMode: ["autoVacuumMode"],
    scheduledVacuum: ["scheduledVacuum"],
    vacuumHour: ["vacuumHour"],
    pageSize: ["pageSize"],
    cacheSize: ["cacheSize"],
    optimizeOnStartup: ["optimizeOnStartup"],
  },
};

function parseStored(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toBooleanSetting(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return !Number.isNaN(value) && value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

/**
 * The effective database settings exactly as the SQLite-era `getUserDatabaseSettings()`
 * resolved them (src/lib/db/databaseSettings.ts at 8435e220^), minus the cache-secret
 * decryption: stored values are copied as stored. Precedence, later wins:
 * defaults -> settings.databaseSettings blob -> settings.<section> blobs ->
 * databaseSettings namespace (flat aliases, then `<section>.<name>`) -> the runtime log flags
 * settings.call_log_pipeline_enabled / settings.detailed_logs_enabled.
 */
export function resolveLegacyDatabaseSettings(
  settings: Record<string, unknown>,
  databaseSettings: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  const out = structuredClone(DEFAULT_DATABASE_SETTINGS) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const mergeSections = (values: Record<string, unknown>) => {
    for (const section of ALL_SECTIONS) {
      const value = values[section];
      if (!isRecord(value)) continue;
      for (const name of Object.keys(out[section])) {
        if (value[name] !== undefined) out[section][name] = value[name];
      }
    }
  };
  if (isRecord(settings.databaseSettings)) mergeSections(settings.databaseSettings);
  mergeSections(settings);
  for (const section of ALL_SECTIONS) {
    for (const name of Object.keys(out[section])) {
      for (const alias of LEGACY_FLAT_ALIASES[section]?.[name] ?? []) {
        if (databaseSettings[alias] !== undefined) out[section][name] = databaseSettings[alias];
      }
      const nested = `${section}.${name}`;
      if (databaseSettings[nested] !== undefined) out[section][name] = databaseSettings[nested];
    }
  }
  const pipeline = toBooleanSetting(settings.call_log_pipeline_enabled);
  if (pipeline !== null) out.logs.callLogPipelineEnabled = pipeline;
  const detailed = toBooleanSetting(settings.detailed_logs_enabled);
  if (detailed !== null) out.logs.detailedLogsEnabled = detailed;
  return out;
}

/** Splits `<provider>:<connectionId>` at the first colon. */
function splitProviderKey(key: string): { provider: string; connectionId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { provider: key.slice(0, at), connectionId: key.slice(at + 1) };
}

export function dispatchKeyValue(
  input: KeyValueRow[],
  options: { now?: number; connectionIds: ReadonlySet<string> }
): KeyValueResult {
  const now = options.now ?? Date.now();
  const rows: DispatchedRow[] = [];
  const dropped = new Map<string, { count: number; reason: string }>();
  const skipped: KeyValueResult["skipped"] = [];
  const unknown = new Map<string, number>();

  const byNamespace = new Map<string, KeyValueRow[]>();
  for (const row of input) {
    const list = byNamespace.get(row.namespace) ?? [];
    list.push(row);
    byNamespace.set(row.namespace, list);
  }
  const values = (ns: string) =>
    Object.fromEntries((byNamespace.get(ns) ?? []).map((r) => [r.key, parseStored(r.value)]));

  const config = (namespace: string, key: string, jsonText: string) =>
    rows.push({ table: "config_entries", row: { namespace, key, value: jsonText } });
  const asJsonString = (raw: string) => JSON.stringify(raw);

  // Rows merged into one target row per key.
  const catalog = new Map<string, Record<string, unknown>>();
  const catalogRow = (provider: string) => {
    let row = catalog.get(provider);
    if (!row) {
      row = { provider };
      catalog.set(provider, row);
    }
    return row;
  };
  const sync = new Map<string, Record<string, unknown>>();
  const syncRow = (provider: string, connectionId: string) => {
    let row = sync.get(connectionId);
    if (!row) {
      row = { connection_id: connectionId, provider };
      sync.set(connectionId, row);
    }
    return row;
  };
  const aliases = new Map<string, Record<string, unknown>>();

  const effective = resolveLegacyDatabaseSettings(values("settings"), values("databaseSettings"));

  for (const [namespace, list] of byNamespace) {
    if (DROPPED_NAMESPACES[namespace]) {
      dropped.set(namespace, { count: list.length, reason: DROPPED_NAMESPACES[namespace] });
      continue;
    }
    for (const { key, value } of list) {
      if (namespace === "settings") {
        const reason = droppedSettingsKey(key);
        if (reason) skipped.push({ namespace, key, reason });
        else if (SETTINGS_TO_JOB_STATE.has(key)) config("job_state", key, value);
        else config("settings", key, value);
      } else if (namespace === "databaseSettings") {
        // Replaced wholesale by the resolved values below.
      } else if (CONFIG_JSON.has(namespace)) {
        config(namespace, key, value);
      } else if (CONFIG_RAW.has(namespace)) {
        config(namespace, key, asJsonString(value));
      } else if (namespace === "pricing_sync_status") {
        config("job_state", `${namespace}.${key}`, value);
      } else if (namespace === "arena_elo" || namespace === "free_proxies") {
        config("job_state", `${namespace}.${key}`, asJsonString(value));
      } else if (namespace === "customModels") {
        catalogRow(key).custom_models = value;
      } else if (namespace === "modelCompatOverrides") {
        if (key.includes("::"))
          skipped.push({ namespace, key, reason: "dead provider::model key" });
        else catalogRow(key).compat_overrides = value;
      } else if (namespace === "providerAliases") {
        catalogRow(key).provider_aliases = value;
      } else if (namespace === "syncedAvailableModels" || namespace === "discoveryState") {
        const split = splitProviderKey(key);
        if (!split || !options.connectionIds.has(split.connectionId)) {
          skipped.push({ namespace, key, reason: "no matching provider connection" });
          continue;
        }
        const target = syncRow(split.provider, split.connectionId);
        if (namespace === "syncedAvailableModels") {
          target.models = value;
        } else {
          const record = parseStored(value);
          if (isRecord(record)) {
            target.discovery_status = record.status ?? null;
            target.discovery_cause = record.cause ?? null;
            target.discovery_at = record.at ?? null;
          } else {
            skipped.push({ namespace, key, reason: "not a {status, cause, at} record" });
          }
        }
      } else if (namespace === "providerLimitsCache") {
        if (!options.connectionIds.has(key)) {
          skipped.push({ namespace, key, reason: "no matching provider connection" });
        } else {
          rows.push({ table: "connection_limits_cache", row: { connection_id: key, data: value } });
        }
      } else if (
        namespace === "pricing" ||
        namespace === "pricing_synced" ||
        namespace === "models_dev_pricing"
      ) {
        const source = {
          pricing: "user",
          pricing_synced: "litellm",
          models_dev_pricing: "models_dev",
        }[namespace];
        rows.push({ table: "model_pricing", row: { source, provider: key, models: value } });
      } else if (namespace === "modelAliases") {
        aliases.set(key, { alias: key, target: value, managed: false });
      } else if (namespace === "managedModelAliasNames") {
        // Applied after every modelAliases row is known (below).
      } else if (namespace === "lkgp") {
        const pin = parseStored(value);
        if (!isRecord(pin) || typeof pin.provider !== "string") {
          skipped.push({ namespace, key, reason: "not a {provider, connectionId} record" });
        } else {
          rows.push({
            table: "lkgp_pins",
            row: { pin_key: key, provider: pin.provider, connection_id: pin.connectionId ?? null },
          });
        }
      } else if (namespace === "mitmAlias") {
        const pairs = parseStored(value);
        if (!isRecord(pairs)) {
          skipped.push({ namespace, key, reason: "not a {source: target} object" });
          continue;
        }
        for (const [source, target] of Object.entries(pairs)) {
          if (typeof target !== "string") continue;
          rows.push({
            table: "agent_bridge_mappings",
            row: { agent_id: key, source_model: source, target_model: target },
            // agent_bridge_mappings rows already in SQLite win; see dedupe in transfer.ts.
          });
        }
      } else if (namespace === "gemini_thought_signatures") {
        const entry = parseStored(value);
        if (typeof entry === "string") {
          rows.push({
            table: "gemini_thought_signatures",
            row: { signature_key: key, signature: entry, expires_at: now + 30 * 86_400_000 },
          });
        } else if (isRecord(entry) && typeof entry.signature === "string") {
          const expiresAt =
            typeof entry.expiresAt === "number" ? entry.expiresAt : now + 30 * 86_400_000;
          if (expiresAt <= now) {
            skipped.push({ namespace, key, reason: "expired" });
            continue;
          }
          rows.push({
            table: "gemini_thought_signatures",
            row: {
              signature_key: key,
              signature: entry.signature,
              created_at: typeof entry.createdAt === "number" ? entry.createdAt : null,
              expires_at: expiresAt,
            },
          });
        } else {
          skipped.push({ namespace, key, reason: "invalid signature entry" });
        }
      } else if (namespace === "muse_session_ownership") {
        rows.push({
          table: "muse_session_ownership",
          row: { key, value, touched_at: key.startsWith("touched:") ? value : null },
        });
      } else if (namespace === "ccDiscoveryMetrics") {
        const count = Number(value);
        if (!Number.isInteger(count))
          skipped.push({ namespace, key, reason: "non-integer count -> 0" });
        rows.push({
          table: "cc_discovery_metrics",
          row: { metric_key: key, count: Number.isInteger(count) ? count : 0 },
        });
      } else {
        unknown.set(namespace, (unknown.get(namespace) ?? 0) + 1);
      }
    }
  }

  if (unknown.size > 0) {
    const names = [...unknown].map(([ns, n]) => `${ns} (${n})`).join(", ");
    throw new Error(`transfer: key_value namespaces without a disposition: ${names}`);
  }

  const managed = values("managedModelAliasNames");
  for (const list of Object.values(managed)) {
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      const alias = typeof name === "string" ? aliases.get(name) : undefined;
      if (alias) alias.managed = true;
      else
        skipped.push({
          namespace: "managedModelAliasNames",
          key: String(name),
          reason: "no alias row",
        });
    }
  }
  for (const row of aliases.values()) rows.push({ table: "model_aliases", row });
  for (const row of catalog.values()) rows.push({ table: "provider_model_catalog", row });
  for (const row of sync.values()) rows.push({ table: "connection_model_sync", row });

  for (const section of DATABASE_SETTINGS_SECTIONS) {
    for (const [name, value] of Object.entries(effective[section])) {
      config("databaseSettings", `${section}.${name}`, JSON.stringify(value ?? null));
    }
  }

  return {
    rows,
    dropped: [...dropped].map(([namespace, d]) => ({ namespace, ...d })),
    skipped,
    effectiveDatabaseSettings: Object.fromEntries(
      DATABASE_SETTINGS_SECTIONS.map((s) => [s, effective[s]])
    ),
  };
}
