/**
 * What happens to each SQLite table in the transfer. A table is one of:
 *  - internal: SQLite bookkeeping, never copied;
 *  - dropped: no successor (`postgres-schema-mapping.md` -> "Domain G"), counted in the receipt;
 *  - special: handled by its own code (key_value, merges);
 *  - copied: into the same-named PostgreSQL table, column by column, with the renames and
 *    per-table rules below. A source column with values that maps nowhere aborts the transfer.
 *
 * A table with rows that matches none of these aborts too. The rules here cover every table
 * production holds rows in; the same-name copy covers the rest, and its column check stops
 * the transfer if a table ever holds data in a shape no rule was written for.
 */

export interface CopySpec {
  /** source column -> target column */
  rename?: Record<string, string>;
  /** source columns with no successor; their non-NULL values are counted in the receipt */
  dropColumns?: string[];
  /** jsonb columns whose non-JSON text is kept as a JSON string (J-raw) instead of NULL */
  jsonRawColumns?: string[];
  /** target column -> value used when a value is outside the column's CHECK list */
  enumFallback?: Record<string, string>;
  /** nullable target columns set to NULL (instead of skipping the row) when outside their CHECK list */
  enumToNull?: string[];
  /** target column filled from the SQLite rowid */
  seqFromRowid?: string;
  /** rows that already exist after the migrations (seeds): upsert, source wins */
  upsertSeeds?: boolean;
  /** per-row rewrite after renames, before conversion; null skips the row (reason logged) */
  rewrite?: (row: Record<string, unknown>) => Record<string, unknown> | { skip: string };
}

export const INTERNAL_TABLES = new Set([
  "_omniroute_migrations",
  "sqlite_sequence",
  "sqlite_stat1",
  "sqlite_stat2",
  "sqlite_stat3",
  "sqlite_stat4",
]);

/** Domain G, plus the full-text and vector shadow tables of the removed memory engine. */
export const DROPPED_TABLES: Record<string, string> = {
  memories: "memory engine removed",
  memory_fts: "memory engine removed",
  memory_fts_config: "memory engine removed",
  memory_fts_data: "memory engine removed",
  memory_fts_docsize: "memory engine removed",
  memory_fts_idx: "memory engine removed",
  memory_fts_content: "memory engine removed",
  memory_vec_meta: "memory engine removed",
  vec_memories: "memory engine removed",
  badge_definitions: "gamification removed",
  community_servers: "gamification removed",
  invite_tokens: "gamification removed",
  leaderboard: "gamification removed",
  token_ledger: "gamification removed",
  user_badges: "gamification removed",
  user_levels: "gamification removed",
  xp_action_counts: "gamification removed",
  xp_audit_log: "gamification removed",
  combo_adaptation_state: "never read",
  routing_decisions: "never written",
  session_account_affinity: "superseded by the key_value namespace of the same name",
  tier_assignments: "never read",
  hourly_usage_summary: "nothing reads it",
  plugin_metrics: "no importer",
  plugin_analytics: "never written",
  middleware_logs: "never written",
  config_audit_log: "never written",
  db_meta: "constant schema_version; the PostgreSQL ledger replaces it",
  request_detail_logs: "no writer since call-log artifacts (owner: drop)",
  prompt_templates: "never imported",
  model_assessments: "never written",
  assessment_runs: "never written",
  combo_health: "never written",
  heal_actions: "never written",
  api_key_token_limits_new: "rebuild leftover",
  call_logs_v1_legacy: "legacy inline-body table",
};

/** Tables with their own code in ./transfer.ts (merges and splits). */
export const SPECIAL_TABLES = new Set([
  "key_value",
  "session_model_history",
  "api_key_quota_counters",
  "quota_consumption",
]);

/** Merges not implemented because production holds no rows in them: abort if one ever does. */
export const UNSUPPORTED_WHEN_NONEMPTY: Record<string, string> = {
  provider_key_limits: "merge into registered_key_limits",
  account_key_limits: "merge into registered_key_limits",
  radar_feed_cache: "merge into radar_cache",
  radar_referrals_cache: "merge into radar_cache",
  radar_offers_cache: "merge into radar_cache",
  radar_intel_cache: "merge into radar_cache",
  tier_config: "fold into config_entries('tier')",
};

const isBlank = (value: unknown) => typeof value !== "string" || value.trim() === "";

export const COPY_SPECS: Record<string, CopySpec> = {
  provider_connections: {
    rename: {
      group: "group_name",
      quota_window_thresholds_json: "quota_window_thresholds",
      rate_limit_overrides_json: "rate_limit_overrides",
    },
  },
  provider_nodes: {
    rename: { custom_headers_json: "custom_headers" },
    rewrite: (row) => (isBlank(row.prefix) ? { ...row, prefix: null } : row),
  },
  agentic_conversations: { dropColumns: ["last_message_count", "last_messages_hash"] },
  version_manager: { dropColumns: ["id"], enumFallback: { status: "error" } },
  provider_quota_reset_events: { dropColumns: ["raw_data"] },
  call_logs: { seqFromRowid: "seq", enumFallback: { detail_state: "missing" } },
  conversation_turn_nodes: { seqFromRowid: "seq" },
  audit_log: { jsonRawColumns: ["details", "metadata"] },
  skill_executions: { jsonRawColumns: ["output"] },
  // From key_value: an unknown discovery status must not cost the connection its model list.
  connection_model_sync: { enumToNull: ["discovery_status"] },
  // From key_value: a value that is not JSON (an old raw-text setting) is kept as a JSON string.
  config_entries: { jsonRawColumns: ["value"] },
  quota_groups: { upsertSeeds: true },
  cache_metrics: { upsertSeeds: true },
  radar_settings: { upsertSeeds: true },
  combos: {
    dropColumns: ["system_message", "tool_filter_regex"],
    rewrite: (row) => {
      // The values live in `data`; carry a column value over only when `data` lacks the key.
      let data: Record<string, unknown> = {};
      try {
        data = typeof row.data === "string" ? JSON.parse(row.data) : {};
      } catch {
        return row;
      }
      let changed = false;
      for (const [column, key] of [
        ["system_message", "system_message"],
        ["tool_filter_regex", "tool_filter_regex"],
      ] as const) {
        if (row[column] !== null && row[column] !== undefined && data[key] === undefined) {
          data[key] = row[column];
          changed = true;
        }
      }
      return changed ? { ...row, data: JSON.stringify(data) } : row;
    },
  },
};
