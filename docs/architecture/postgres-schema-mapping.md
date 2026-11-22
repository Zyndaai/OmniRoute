---
title: "SQLite to PostgreSQL schema mapping"
status: proposed
lastUpdated: 2026-11-16
---

# SQLite to PostgreSQL schema mapping

This is the row-level contract between today's SQLite schema and `src/lib/db/backends/postgres/migrations/0001_init.sql`. It has one entry for every SQLite table: the 143 tables in `sqlite-schema-snapshot.sql`, the 11 tables the app creates at runtime, and 2 leftovers that only exist in old databases. Each entry gives the new table or tables, the column changes, the conversion rule the one-way transfer tool must apply, and the source files that query the table, so code-rewrite agents can be assigned per domain. The reasons behind the changes are in [`postgres-schema.md`](postgres-schema.md).

## Contents

- [Count reconciliation](#count-reconciliation)
- [Abbreviations](#abbreviations)
- [General conversion rules](#general-conversion-rules)
- [Transfer procedure](#transfer-procedure)
- [Domain A: control plane](#domain-a-control-plane)
- [Domain B: model catalog and the key_value split](#domain-b-model-catalog-and-the-key_value-split)
- [Domain C: coordination and runtime state](#domain-c-coordination-and-runtime-state)
- [Domain D: records and logs](#domain-d-records-and-logs)
- [Domain E: caches](#domain-e-caches)
- [Domain F: skills, plugins, agents, evals, batches, files, misc](#domain-f-skills-plugins-agents-evals-batches-files-misc)
- [Domain G: dropped tables](#domain-g-dropped-tables)
- [Behaviour changes code agents must carry](#behaviour-changes-code-agents-must-carry)

## Count reconciliation

| Source | Count |
|---|---|
| `sqlite-schema-snapshot.sql` entries | 144 |
| minus `_omniroute_migrations` (the Postgres runner owns its own ledger) | 143 |
| plus tables created at runtime, not in the snapshot: `cloud_agent_tasks`, `compression_run_telemetry`, `compression_engine_breakdown`, `audit_log`, `cache_metrics`, `prompt_templates`, `model_assessments`, `assessment_runs`, `combo_health`, `heal_actions`, `vec_memories` | 11 |
| plus leftovers found only in old databases: `api_key_token_limits_new` (rebuild leftover), `call_logs_v1_legacy` | 2 |
| **Source tables covered here** | **156** |
| dropped with no successor ([Domain G](#domain-g-dropped-tables)) | 35 |
| surviving source tables (`session_model_history` survives as `session_model_pins`) | 121 |
| net effect of splits and merges: `key_value` becomes 11 tables (+10), `tier_config` folds into `config_entries` (−1), `provider_key_limits` + `account_key_limits` become `registered_key_limits` (−1), `quota_consumption` + `api_key_quota_counters` become `quota_counters` (−1), 4 `radar_*_cache` tables become `radar_cache` (−3) | +4 |
| **Tables in `0001_init.sql`** (122 plain plus 3 partitioned parents; partitions not counted) | **125** |

Runtime-added columns that are also missing from the snapshot are included in the column lists below:
- `api_keys`: the 19 columns from `apiKeyColumnFallbacks.ts`, `key_hash` among them.
- `sync_tokens.expires_at` and `sync_tokens.issued_by`.
- Five `compression_analytics` columns: `rtk_raw_output_*` and `skip_reason`.

## Abbreviations

Paths: `db/` = `src/lib/db/`, `usage/` = `src/lib/usage/`, `oss/` = `open-sse/`, `api/` = `src/app/api/`, `quota/` = `src/lib/quota/`, `proxySub/` = `src/lib/proxySubscription/`.

Rule codes used in the tables:

| Code | Meaning |
|---|---|
| TS | text/integer timestamp to `timestamptz`, see [rules](#general-conversion-rules) |
| TS-ms, TS-s | integer epoch milliseconds, seconds |
| TS-mix | the column holds more than one format; detect per value |
| B | 0/1 to `boolean` |
| J | JSON text to `jsonb` |
| J-raw | raw (non-JSON) text to a JSON string (`to_jsonb(text)`) |
| M | REAL money to `numeric(20,10)` |
| U | text UUID to `uuid` |
| ID | copy explicit identity values, then `setval` |
| FK-del | delete child rows whose parent is missing, and log the count |
| FK-null | set the reference to NULL when the parent is missing, and log |

## General conversion rules

The transfer tool must apply these to every value. Per-table exceptions are listed in the domain tables.

1. **Timestamps (TS).** Parse per value, not per column. Several columns mix formats, because writers changed over time.
   - ISO 8601 with `Z` or an offset (`toISOString()`): parse as given.
   - `YYYY-MM-DD HH:MM:SS` (SQLite `datetime('now')`, `CURRENT_TIMESTAMP`): parse as **UTC**, never as local time.
   - Integer, or a numeric string, in a column documented as epoch ms (TS-ms) or epoch seconds (TS-s): convert with that unit. For TS-mix columns, a numeric value `>= 1e11` is milliseconds and a smaller one is seconds.
   - `''` becomes NULL.
   - An unparseable value becomes NULL and is logged. If the column is `NOT NULL`, apply the per-table fallback; when none is listed, use the row's `created_at` if it has one, else skip the row and log it.
2. **Dates.** `YYYY-MM-DD` becomes `date`. `YYYY-MM-DDTHH` hour keys become `timestamptz` (the start of that UTC hour).
3. **Booleans (B).**
   - `1`, `'1'`, `true` become true; `0`, `'0'`, `false` become false.
   - NULL becomes the column default when the column is `NOT NULL`, and stays NULL when the column is nullable (tri-state columns are marked).
4. **JSON (J).**
   - Parse the text. Invalid JSON becomes NULL and is logged.
   - For a `NOT NULL` jsonb column, use the default (`'[]'` or `'{}'`, as in the DDL) and log.
   - A JSON document that is itself a JSON string holding JSON (double-encoded) is kept as the outer string. Do not unwrap it silently.
5. **Raw text into jsonb (J-raw).** Becomes a JSON string (`to_jsonb(value)`). Readers use `value #>> '{}'`.
6. **Money (M).** `round(value::numeric, 10)`. NaN or infinity becomes NULL, or 0 if the column is `NOT NULL`, and is logged.
7. **UUID (U).** Cast. A value that is not a UUID **aborts that table's transfer** with a report. These columns were always written by `crypto.randomUUID()`, so a bad value means something unexpected that needs a human.
8. **Integers.** SQLite stored REAL values in INTEGER columns because the app passed non-integer numbers (for example token counts after a ratio, `usageWriteRetry.ts:206-216`).
   - Non-integers are **rounded** (`round()`), never NULLed: many integer columns are `NOT NULL`.
   - A non-numeric value takes the column default, or NULL if the column is nullable, and is logged.
   - Columns that became `integer` (int4) are checked for values `> 2^31-1`, which are clamped and logged.
9. **Identities (ID).** Insert the SQLite id explicitly (`GENERATED BY DEFAULT` allows it). After the table is loaded, run `SELECT setval(pg_get_serial_sequence('<t>','<col>'), COALESCE(max(<col>),0)+1, false) FROM <t>`.
10. **Orphans.** Every new foreign key lists its rule (FK-del or FK-null). SQLite rarely enforced FKs (driver-dependent, see the design doc), so expect orphans in:
    - every child of `api_keys` and `provider_connections`;
    - `quota_allocations` and `quota_allocation_model_caps`;
    - `relay_*` (`token_id = 'unknown'`);
    - `conversation_turn_nodes`.
11. **Enum CHECKs.** A value outside a new CHECK set is mapped where a rule is listed. Otherwise the row is skipped and logged. The tool never widens a constraint.
12. **Plaintext secrets get encrypted (owner decision).** The tool runs `encrypt()` (`enc:v1`, `STORAGE_ENCRYPTION_KEY`) over these when they are not already envelopes, and the rewritten writers do the same:
    - `config_entries('settings', 'skillsmpApiKey' | 'cliproxyapi_api_key')`;
    - `proxy_registry.password`, `version_manager.api_key` and `management_key`;
    - `webhooks.secret`, `config_entries('notion','integration_token')`, `config_entries('sync','omniroute_sync_token')`;
    - `api_key_context_sources.token`.
13. **NUL characters.** U+0000 is stripped from every text and JSON string value. Postgres rejects it in `text` and `jsonb`, while SQLite stored it. Each strip is logged per table.

## Transfer procedure

The tool is `src/lib/db/backends/transfer/` (command line `cli.ts`, bundled into the image as
`src/lib/db/backends/transfer/cli.js`; test `tests/unit/db/transfer-sqlite-to-postgres.test.ts`).
It implements this procedure with these choices:

- The target must be a new, empty database; the tool runs the migrations. It refuses a
  non-empty target and a live source (a non-empty `-wal`), and reads a private copy of the source,
  so a WAL-mode snapshot needs no writable folder and the original is never touched.
- Values are converted by the target column's type, read from PostgreSQL's catalog. Numeric
  timestamps use the TS-mix rule for every column (`>= 1e11` is ms, else seconds; outside
  2000–2100 is not an event time and becomes NULL). Per-table rules are in `registry.ts`.
- Orphans follow each foreign key's ON DELETE action (SET NULL nulls the reference; any other
  action deletes the child). Everything loads in ONE transaction.
- Verification reads every touched table back and compares each value with what the tool meant
  to write; the receipt records counts, every skip and adjustment with its reason, dropped tables
  and namespaces with row counts, a sha256 per table, the effective database settings, and checks
  that every API key's `key_hash` matches its key and every encrypted credential decrypts.
- `discoveryState` with a status outside the CHECK list keeps the row (the synced models) and
  nulls the status. Unimplemented merges (`provider_key_limits`, `account_key_limits`, the four
  `radar_*_cache`, `tier_config`) abort if the source ever holds rows in them.

Production dry run, 2026-11-22 (backup-API snapshot, throwaway PostgreSQL 18 on an internal
network, app never started): 82.5 MB, migrations 222, 25 s, every table verified; 4/4 key hashes
match, 15/15 credentials decrypt, retention callLogs 90 / usageHistory 365.

1. Create the database (collation `C`) and apply migrations with `runPostgresMigrations`.
2. Create the historical partitions: `SELECT omniroute_ensure_daily_partitions('<t>', <min day>, <max day>)` for `call_logs`, `usage_history` and `proxy_logs`, using the min and max UTC day found in SQLite.
   - Run it in a transaction that starts with `SET LOCAL statement_timeout = '600s'`. The pool's 5 s timeout is too short: 365 days of partitions take about 7 s.
   - Alternatively, call the function one day at a time.
3. In one transaction per domain, `SET CONSTRAINTS ALL DEFERRED` (every FK is `DEFERRABLE`), load parents before children with `COPY`, then apply the FK-del and FK-null rules before `COMMIT`.
4. Run `setval` for every identity (rule 9), then `ANALYZE`.
5. Print the log: for every table, the counts of skipped rows, nulled values and orphans.

## Domain A: control plane

| SQLite table | New table | Column changes | Transfer rules | Source files (inventory) |
|---|---|---|---|---|
| `provider_nodes` | `provider_nodes` | `custom_headers_json`→`custom_headers` J. `daily_quota_reset_hour` smallint 0..23. `type` and `api_type` CHECKed. New unique `lower(btrim(prefix))`, plus a CHECK that the prefix is not blank. | TS. `''` or whitespace-only `prefix` → NULL. Duplicate prefixes (case- and space-insensitive): keep the lowest id, NULL the others' `prefix`, log. | db/core.ts, db/providers/nodes.ts, db/providers/nodePrefix.ts, db/providerStats.ts, db/backup.ts, db/jsonMigration.ts, db/validatedModels.ts, usage/callLogs.ts, usage/callLogExportQueries.ts |
| `provider_connections` | `provider_connections` | `"group"`→`group_name`. `is_active`, `rate_limit_protection`, `proxy_enabled`, `per_key_proxy_enabled`, `quota_visible` B. `provider_specific_data`, `quota_window_thresholds_json`→`quota_window_thresholds`, `rate_limit_overrides_json`→`rate_limit_overrides` J. `priority`, `backoff_level`, `consecutive_use_count` NOT NULL default 0. All `*_at`, `expires_at`, `token_expires_at`, `last_tested` TS. Credentials stay enc text. | TS-mix for `rate_limited_until` (epoch ms number or ISO). `expires_at`/`token_expires_at` TS-mix. NULL ints → 0. Retired-provider triggers are not ported. Rows with `provider IN ('cgpt-web','chatgpt-web','felo-web','felo','qwen-web','qw','microsoft-designer-web','msdesigner')` are copied as-is (already deactivated). | db/providers.ts, db/providers/* (codexAccountRecovery, codexAccountState, deletion, migrations, providerSpecificDataMerge, rateLimit, usageIdentityReconciliation), db/core.ts, db/backup.ts, db/callLogStats.ts, db/exclusiveConnectionLeases.ts, db/healthCheck.ts, db/migrationRunner.ts, db/models.ts, db/providerStats.ts, db/proxies.ts, db/proxies/guards.ts, db/proxies/rotation.ts, db/quotaPools.ts, db/recovery.ts, db/settings.ts, db/validatedModels.ts, src/lib/cache/semanticCacheDbBridge.ts, src/lib/omnirouteStatus.ts, usage/callLogExportQueries.ts, usage/callLogFilterOptions.ts, usage/callLogs.ts, usage/migrations.ts, usage/usageWriteRetry.ts, src/sse/services/auth.ts, bin/cli/provider-store.mjs |
| `api_keys` (+19 runtime columns) | `api_keys` | `key` loses UNIQUE (randomized ciphertext). `key_hash` NOT NULL UNIQUE. Booleans B: `no_log`, `disable_non_public_models`, `usage_limit_enabled`, `compression_enabled`, `auto_resolve`, `is_active`, `is_banned`, `allow_usage_command`, `chaos_mode_enabled`, `allow_auto_combos`, `allow_cc_discovery_aliases`. J: `allowed_models`, `blocked_models`, `allowed_combos`, `allowed_connections`, `preferred_connections`, `allowed_quotas`, `allowed_endpoints`, `scopes`, `ip_allowlist`, `access_schedule`, `rate_limits`. M: `daily_usage_limit_usd`, `weekly_usage_limit_usd`. TS: `created_at`, `revoked_at`, `expires_at`, `last_used_at`. CHECKs on `source`, `stream_default_mode`, `cache_default_mode`, `catalog_scope`, `model_access_mode`, `codex_service_mode`. | **`key_hash` backfill:** a row with an empty `key_hash` gets `sha256_hex(raw key)`. The raw key is `key`, decrypted with `STORAGE_ENCRYPTION_KEY` when it starts `enc:v1:` (same as `backfillApiKeySecretsAtRest`). The tool needs the storage key; without it, those rows are skipped and logged. Duplicate `key_hash`: keep the newest `created_at` and log. J columns: invalid JSON in a JSON-array column (`scopes`, `ip_allowlist`, `allowed_endpoints`) is treated as a legacy comma list and split into a JSON array; elsewhere it becomes NULL + log. | db/apiKeys.ts, db/apiKeys/comboGrantRevocation.ts, db/apiKeys/secretAtRest.ts, db/apiKeyColumnFallbacks.ts, db/backup.ts, db/core.ts, db/healthCheck.ts, db/quotaPools.ts, db/settings.ts, db/ssoIdentities.ts, db/teams.ts, db/usageModelGroups.ts, src/lib/compliance/noLog.ts |
| `api_key_context_sources` | same | `enabled` B, TS. FK `api_key_id`→`api_keys` CASCADE. | FK-del. | db/apiKeyContextSources.ts |
| `teams` | `teams` | `COLLATE NOCASE UNIQUE` → unique index `lower(name)`. `max_budget_usd` M. TS. | Case-insensitive name collisions cannot exist (NOCASE was enforced). | db/teams.ts, db/jsonMigration.ts, usage/teamUsageLimits.ts, api/teams/[id]/route.ts, api/teams/[id]/members/route.ts |
| `api_key_billing_team_history` | same | `id` U. `valid_from`, `valid_to`, `created_at` TS. FKs `api_key_id` CASCADE, `team_id` RESTRICT. | FK-del (both parents). | db/teams.ts, db/jsonMigration.ts |
| `key_groups` | same | `is_active` B. TS (mixed: `updateKeyGroup` wrote `datetime('now')`). | TS-mix. | db/apiKeyGroups.ts |
| `key_group_members` | same | TS. FKs CASCADE. | FK-del. | db/apiKeyGroups.ts |
| `group_model_permissions` | same | TS. FK CASCADE. | FK-del. | db/apiKeyGroups.ts |
| `sso_identities` | same | `last_groups` J. TS. FK CASCADE. | FK-del. | db/ssoIdentities.ts |
| `combos` | `combos` | `data` J (NOT NULL). `context_cache_protection` B NOT NULL. Unique moves from `name` to `lower(name)`. CHECK `length(btrim(name)) BETWEEN 1 AND 300` only: the charset stays in zod, because system-built names (quota combos `qtSd/<slug>/<provider>/<model>`, copilot tools) contain `:`, `@`, `+` and run past 100 characters. **Dropped:** `system_message`, `tool_filter_regex` (never read as columns; the values live in `data`). | **Case collisions** (`A` vs `a`): keep the most recently updated row, rename the others to `<name>-dup-<n>` (also inside `data.name`), and log them. The owner accepted this. Before dropping `system_message`/`tool_filter_regex`, copy any non-NULL value into `data` when `data` lacks the key. | db/combos.ts, db/repositories/sqliteComboRepository.ts, db/repositories/sqliteModelComboMappingRepository.ts, db/apiKeys/comboGrantRevocation.ts, db/backup.ts, db/core.ts, db/healthCheck.ts, db/jsonMigration.ts, db/settings.ts, src/lib/quota/quotaCombos.ts, src/lib/a2a/skills/quotaManagement.ts, src/lib/api/modelTestRunner.ts, oss/services/combo/comboStructure.ts, oss/mcp-server/tools/advancedTools.ts, oss/mcp-server/tools/pickFastestModel.ts, oss/mcp-server/coercions.ts, api/db-backups/exportAll, api/db-backups/import, api/providers/[id]/sync-models (UI files in the inventory only match the word) |
| `model_combo_mappings` | same | `priority` NOT NULL, `enabled` B NOT NULL, `description` NOT NULL. FK CASCADE. | FK-del. NULLs → defaults. | db/repositories/sqliteModelComboMappingRepository.ts |
| `reasoning_routing_rules` | same | `enabled` B, `request_tags` J, TS. FKs replace triggers `trg_reasoning_rules_*`. | FK-del. | db/reasoningRoutingRules.ts, db/backup.ts |
| `auto_candidate_overrides` | same | `id` U. `excluded` B. TS. **No FK** (`api_key_id` may be `env-key`/`self-loop`, `connection_id` may be the synthetic `noauth`). | Copy as-is. Code must delete overrides on key/connection delete (today it does not). | db/autoCandidateOverrides.ts |
| `registered_keys` | `registered_keys` | `id` U. `key`→`key_hash` (it always held the sha256). `provider`/`account_id` `''`→NULL. `is_active` B. `last_reset_day` date, `last_reset_hour` TS (hour start). `''` → NULL. | `''` → NULL. `revoked_at`/`expires_at` TS-mix. | db/registeredKeys.ts |
| `provider_key_limits` | `registered_key_limits` (`scope='provider'`, `scope_id=provider`) | merged | `last_reset_day`/`_hour` as above. | db/registeredKeys.ts |
| `account_key_limits` | `registered_key_limits` (`scope='account'`, `scope_id=account_id`) | merged | as above | db/registeredKeys.ts |
| `sync_tokens` (+2 runtime columns) | same | `expires_at`, `issued_by` added to DDL. TS-mix. **New FK** `sync_api_key_id`→`api_keys` CASCADE. | `sync_api_key_id = 'env-key'` (legitimate, `src/lib/sync/tokens.ts:112-115`) → NULL, which the code reads as "no linked key"; the writer must store NULL for it too. Any other missing key: FK-del (a token bound to a deleted key cannot authenticate). | db/syncTokens.ts |
| `cli_access_tokens` | same | `scope` CHECK. TS. | — | db/accessTokens.ts |
| `proxy_registry` | same | `google_access` B. `port` CHECK. `type` CHECK (`http`, `https`, `socks4`, `socks5`, `vercel`, `deno`, `cloudflare`), `family` CHECK. TS-mix. **New FK** `subscription_id`→`proxy_subscriptions` SET NULL. | FK-null. | db/proxies.ts, db/proxies/guards.ts, db/proxies/rotation.ts, db/freeProxies.ts, db/oneproxy.ts, db/proxyLogs.ts, db/proxyOperatorEgress.ts, db/settings.ts, proxySub/selectorTrigger.ts, proxySub/staleNodes.ts, proxySub/subscriptionService.ts |
| `proxy_assignments` | same | `id` ID. `scope` CHECK. `scope_id` NOT NULL; global uses `'__global__'`. FK `proxy_id` RESTRICT. | `scope_id` NULL → `'__global__'` for `scope='global'`. The incoming API scope `key` was already stored as `account`. FK-del. | db/proxies.ts, db/proxies/guards.ts, db/proxies/rotation.ts, db/providers/deletion.ts, db/proxyLogs.ts, db/proxySubscriptions.ts, db/repositories/sqliteComboRepository.ts, proxySub/subscriptionService.ts |
| `proxy_scope_rotation` | same | `strategy`, `scope` CHECK. TS. | — | db/proxies.ts, db/proxies/rotation.ts |
| `proxy_subscriptions` | same | `enabled` B. `rule_providers`, `last_nodes`, `selector_last_switch_by_selector` J. `mode`, `status` CHECK. TS-mix. | Invalid `last_nodes` → NULL. | db/proxies.ts, proxySub/reloadSecret.ts, proxySub/selectorTrigger.ts, proxySub/subscriptionRows.ts, proxySub/subscriptionService.ts |
| `free_proxies` | same | **Dropped** `in_pool` (derived: `pool_proxy_id IS NOT NULL`). **New FK** `pool_proxy_id`→`proxy_registry` SET NULL, replacing trigger `trg_free_proxies_clear_pool_proxy_id`. TS. | FK-null. | db/freeProxies.ts |
| `free_proxy_sync_errors` | same | `errors` J (string[]). | A raw string becomes `[value]`. | db/freeProxies.ts |
| `proxy_operator_egress` | same | `observed_at` TS. | — | db/proxyOperatorEgress.ts (rowid tie-breaks become `address`) |
| `upstream_proxy_config` | same | **PK** moves to `provider_id`, surrogate `id` dropped. `enabled` B. `cliproxyapi_model_mapping` J. CHECKs on `mode`, `family`, `fallback_backend`. | — | db/upstreamProxy.ts, db/validatedModels.ts |
| `version_manager` | same | **PK** `tool`, surrogate `id` dropped. B: `auto_update`, `auto_start`, `provider_expose`, `auto_restart_adopted`. `config_overrides` J. `status`, `health_status` CHECK. TS-mix. | Unknown `status` → `'error'`. | db/versionManager.ts |
| `cloud_agent_credentials` | same | `provider_id` CHECK. TS. | — | src/lib/cloudAgent/credentials.ts |
| `cloud_agent_tasks` (runtime) | same | `source`, `options`, `result`, `activities` J. `status`, `provider_id` CHECK. TS-mix (ISO on insert, `datetime('now')` on update). | `source` invalid → skip + log. | src/lib/cloudAgent/db.ts |
| `webhooks` | same | `events` J. `enabled` B. `kind` CHECK. `metadata_encrypted` BLOB→text (UTF-8 envelope). TS. | A BLOB that is not valid UTF-8 → NULL + log. | db/webhooks.ts |
| `log_export_destinations` | same | `cursor_row_id`→`cursor_seq` (`call_logs.seq`). `enabled`, `include_bodies` B. `config` J. TS. | `cursor_seq` keeps its value, because `call_logs.seq` is loaded from the SQLite rowid. | db/logExportDestinations.ts, src/lib/logExport/runner.ts, src/lib/logExport/exportChild.ts |
| `middleware_hooks` | same | `enabled` B. `run_count` bigint. TS-mix. | — | db/middleware.ts |
| `compression_combos` | same | `pipeline`, `language_packs`, `output_styles` J. `output_mode`, `is_default` B. New unique partial index: at most one default. | Several defaults → keep the newest `updated_at`, clear the others, log. | db/compressionCombos.ts |
| `compression_combo_assignments` | same | **PK** `routing_combo_id` (was UNIQUE); surrogate `id` dropped. FK `compression_combo_id` CASCADE. | FK-del. | db/compressionCombos.ts, oss/handlers/chatCore.ts (lookup) |
| `jobs` | same | `enabled` B. `config` J. TS-mix. | — | db/jobRegistryDb.ts |
| `tier_config` | `config_entries` (`namespace='tier'`, `key='tier_config'`) | folded | `value` J. | db/tierConfig.ts, api/settings/tier-config |

## Domain B: model catalog and the key_value split

`key_value(namespace, key, value)` is dispatched by namespace. Each row lands in exactly one place.

| key_value namespace | New home | Key and value mapping | Transfer rule | Source files |
|---|---|---|---|---|
| `settings` | `config_entries('settings', key)` | one row per setting, value J. **Moved out**: `model_sync_last_run`, `provider_limits_auto_sync_last_run`, `codex_catalog_revalidated_version`, `maxaiSigningConstants`, `learnedRateLimits` go to `config_entries('job_state', '<same key>')`. **Dropped keys**: `memory*` (memory engine), `qdrant*`, `chatAdmissionSettings` (dead module), the legacy nested blobs `databaseSettings`/`backup`/`optimization`/`cache` (merged first, see `databaseSettings`). | J; invalid → J-raw + log. `_settingsRevision` kept. | db/settings.ts, db/settings/*, db/combos.ts, db/rootLayoutSettings.ts, db/proxies/guards.ts, db/cacheSecrets.ts, db/validatedModels.ts, db/backup.ts, db/optimizationSettings.ts, proxySub/subscriptionService.ts, bin/cli/settings-store.mjs, bin/cli/sqlite.mjs |
| `proxyConfig` | `config_entries('proxyConfig', key)` | J | — | db/settings.ts, db/proxies.ts, db/proxies/guards.ts |
| `secrets` | `config_entries('secrets', key)` | J (string holding the `enc:v1` envelope) | — | db/secrets.ts |
| `ipFilter` | `config_entries('ipFilter','config')` | J | — | oss/services/ipFilter.ts |
| `feature_flags` | `config_entries('feature_flags', flag)` | **J-raw** (`"true"`, enum text) | J-raw. | db/featureFlags.ts, proxySub/selectorGuard.ts, db/ccDiscoveryAliases.ts, db/functionalGatewayMirrors.ts |
| `pii_settings` | `config_entries('pii_settings', key)` | J | — | db/piiSettings.ts |
| `provider_param_filters` | `config_entries('provider_param_filters', provider or '__global__')` | J | — | db/paramFilters.ts |
| `interception_rules` | `config_entries('interception_rules', provider)` | J | — | db/interceptionRules.ts |
| `compression` | `config_entries('compression', key)` | J | — | db/compression.ts, oss/mcp-server/server.ts, db/compressionDetailNormalizers.ts |
| `databaseSettings` | `config_entries('databaseSettings', key)` | J. **Dropped keys** (SQLite only): `optimization.*`, flat `autoVacuumMode`/`scheduledVacuum`/`vacuumHour`/`pageSize`/`cacheSize`/`optimizeOnStartup`, `mmapSize`, `integrity.lastCheck`, `backup.*` (file-copy backups; pg_dump replaces them). | Before copying, resolve the four-source precedence (`getUserDatabaseSettings`) once and write the effective `retention.*`, `logs.*`, `cache.*`, `aggregation.*` keys. | db/databaseSettings.ts, db/backup.ts, db/backupRetention.ts, db/optimizationSettings.ts, db/cacheSecrets.ts, db/core.ts |
| `ccDiscoveryAliases` | `config_entries('ccDiscoveryAliases', key)` | **J-raw** (`on`/`off`) | J-raw. | db/ccDiscoveryAliases.ts |
| `functionalGatewayMirrors` | `config_entries('functionalGatewayMirrors', key)` | **J-raw** | J-raw. | db/functionalGatewayMirrors.ts |
| `obsidian`, `notion`, `sync`, `conductor`, `local_corpus`, `cliToolLastConfig`, `cliToolInitialConfig`, `serviceModels`, `antigravityCreditBalance` | `config_entries(<same namespace>, key)` | J | — | db/obsidian.ts, src/lib/obsidian/api.ts, scripts/dev/webdav-handler.mjs, db/notion.ts, db/conductorBridge.ts, db/localCorpus.ts, db/cliToolState.ts, db/serviceModels.ts, db/creditBalance.ts, oss/executors/antigravity.ts |
| `pricing_sync_status`, `arena_elo`, `free_proxies` | `config_entries('job_state', '<namespace>.<key>')` | `pricing_sync_status` is J. `arena_elo.*` and `free_proxies.last_sync_at` are **J-raw**. | J-raw where raw. | src/lib/pricingSync.ts, src/lib/arenaEloSync.ts, db/freeProxies.ts |
| `customModels` | `provider_model_catalog.custom_models` (row = provider) | J array | Upsert the provider row. | db/models.ts, db/models/customVisionOverride.ts, db/validatedModels.ts, db/jsonMigration.ts |
| `modelCompatOverrides` | `provider_model_catalog.compat_overrides` | J array. Rows keyed `provider::model` are dead reads and are dropped. | Skip `::` keys + log. | db/models/compat.ts, db/models/modelPreserveVideoUrl.ts, db/models.ts |
| `providerAliases` | `provider_model_catalog.provider_aliases` | J object | — | db/models/aliases.ts |
| `syncedAvailableModels` | `connection_model_sync.models` (row = connection) | key `'<provider>:<connectionId>'` is split at the first `:` | No matching `provider_connections.id` → drop + log (FK-del). | db/models.ts, db/models/syncedAvailableModel*.ts, db/models/activeSyncedCatalog.ts |
| `discoveryState` | `connection_model_sync.discovery_status/cause/at` | J `{status, cause, at}` | as above | db/discoveryState.ts |
| `providerLimitsCache` | `connection_limits_cache(connection_id, data)` | J | FK-del. | db/providerLimits.ts, usage/providerLimits.ts, usage/providerWindowCosts.ts |
| `pricing` | `model_pricing('user', provider)` | J | — | db/settings/pricing.ts, src/lib/catalogUserPricing.ts, oss/services/tierResolver.ts |
| `pricing_synced` | `model_pricing('litellm', provider)` | J | — | src/lib/pricingSync.ts |
| `models_dev_pricing` | `model_pricing('models_dev', provider)` | J | — | src/lib/modelsDevSync.ts |
| `modelAliases` | `model_aliases(alias, target)` | J | — | db/models/aliases.ts, src/lib/modelAliasResolver.ts, src/sse/services/model.ts, db/jsonMigration.ts |
| `managedModelAliasNames` | `model_aliases.managed = true` for the listed names | J string[] | Names without an alias row are ignored + logged. | db/models/aliases.ts |
| `lkgp` | `lkgp_pins(pin_key, provider, connection_id)` | J `{provider, connectionId?}`. No FK (`noauth` pins exist). | Copy as-is. `deleteLKGPByConnectionIds` becomes `DELETE ... WHERE connection_id = ANY($1)` (indexed). | db/settings/lkgp.ts, db/readCache.ts, oss/services/combo/recordLkgpPin.ts |
| `mitmAlias` | `agent_bridge_mappings(agent_id, source_model, target_model)` | J `{source: target}` expanded to one row per pair; `"*"` kept as `source_model='*'` | Pairs already in `agent_bridge_mappings` win (it was the source of the mirror). | db/models/mitmAlias.ts, db/agentBridgeMappings.ts, src/mitm/_internal/standaloneRouting.cjs |
| `session_account_affinity` | `session_affinities` | key `'<provider>:<hash>'` → `provider`, `session_hash`. Value J → `connection_id`, `account_identity`, `created_at`, `last_used_at`, `expires_at` (TS). No FK (`noauth`). | Expired rows (`expiresAt <= now`) are not copied. | db/sessionAffinity/sqliteStore.ts (+ redisStore.ts) |
| `gemini_thought_signatures` | `gemini_thought_signatures(signature_key, signature, created_at, expires_at)` | J `{signature, createdAt, expiresAt}`. A legacy bare string becomes signature with `expires_at = now()+30d`. | Expired rows are not copied. | oss/services/geminiThoughtSignatureStore.ts |
| `muse_session_ownership` | `muse_session_ownership(key, value)` | value kept as **text**. For `touched:` rows, `touched_at` = TS-ms(value). | — | db/museSessionOwnership.ts, src/sse/services/museSessionOwnership.ts |
| `ccDiscoveryMetrics` | `cc_discovery_metrics(metric_key, count)` | raw integer text → bigint | Non-integer → 0 + log. | db/ccDiscoveryMetrics.ts |
| `budgetUnpricedUsage` | `domain_budgets.unpriced_usage_since` | TS-ms | No budget row → drop + log. | db/domainState.ts, src/domain/costRules.ts |
| `keyQuotaUnpricedUsage` | `api_key_quota_limits.unpriced_usage_since` | TS-ms | No limits row → drop + log. | db/keyQuota.ts, src/domain/keyQuota.ts |
| `scheduler`, `walMaintenance`, `dbBackup`, `apiKeySelfService` | **dropped** | SQLite VACUUM/WAL/file-backup state and a run-once migration marker | not copied | db/vacuumScheduler.ts, db/walMaintenance.ts, db/backupRetention.ts |
| `gamification:streaks` | **dropped** | Gamification was removed (commit df35513d); production still held 11 rows. Owner: drop. | not copied | — |
| any other namespace | — | none exists today | The tool aborts on an unknown namespace, so a missed one cannot be dropped silently. | — |

Catalog tables that were already tables:

| SQLite table | New table | Column changes | Transfer rules | Source files |
|---|---|---|---|---|
| `model_capabilities` (also runtime DDL) | same | BOOLEAN columns → `boolean` (tri-state NULL kept). `modalities_input/_output` J NOT NULL default `[]`. `reasoning_efforts` J. `last_synced` TS. `knowledge_cutoff`/`release_date`/`last_updated` stay text (models.dev strings). | — | src/lib/modelsDevSync.ts, db/models/capabilityModalities.ts, oss/services/autoCombo/taskFitness.ts |
| `model_capability_overrides` | same | `override_value` J. `override_key` CHECK. TS. | — | db/modelCapabilityOverrides.ts |
| `model_context_overrides` | same | `source` CHECK. TS. | — | db/modelContextOverrides.ts |
| `model_intelligence` | same | `score` CHECK 0..1. `synced_at` TS (`datetime('now')`), `expires_at` TS (ISO). `source` CHECK. | — | db/modelIntelligence.ts, db/modelIntelligenceGeneration.ts, src/lib/arenaEloSync.ts, src/lib/freeProviderRankings.ts, oss/services/autoCombo/taskFitness.ts |

## Domain C: coordination and runtime state

| SQLite table | New table | Column changes | Transfer rules | Source files |
|---|---|---|---|---|
| `connection_runtime_state` | same | **Dropped** dead `refresh_circuit_streak`, `refresh_circuit_until`, `refresh_last_fail_at`. TS. fillfactor 80. | FK-del. | db/connectionRuntimeState.ts, src/lib/warmupScheduler.ts |
| `provider_quota_state` | same | `window_start`, `window_reset` TS-ms. `tokens_used`, `token_limit` bigint. No FK (round-robin may target `noauth`). | Rows whose `window_reset < now()` may be skipped (expired windows). Code adds `DELETE ... WHERE connection_id = $1` to connection deletion. | quota/providerQuotaState.ts, quota/quotaAnalytics.ts, quota/quotaResetTimers.ts |
| `quota_consumption` | `quota_counters` | same key. `consumed` numeric(24,10). `updated_at` TS-ms. | Copy as-is (dimension keys never start with `key-quota:`). | db/quotaConsumption.ts, quota/sqliteQuotaStore.ts, quota/enforce.ts |
| `api_key_quota_counters` | `quota_counters` | merged; `dimension_key` already `key-quota:tpm/rpm` | Rows with `bucket_index < floor(now/60000) - 1` (older than the previous minute) may be skipped: they can no longer affect enforcement. | db/keyQuota.ts |
| `api_key_quota_limits` | same | `monthly_amount_usd` M (0 → NULL). Adds `unpriced_usage_since`. **New FK** CASCADE. TS. | FK-del. | db/keyQuota.ts, src/domain/keyQuota.ts |
| `api_key_token_limits` | same | `id` U. `token_limit` bigint. `reset_time` `'HH:MM'` → `time`. `enabled` B. **New FK** `api_key_id` CASCADE. TS. | FK-del. Invalid `reset_time` → NULL. | db/tokenLimits.ts |
| `api_key_token_counters` | same | `limit_id` U. `window_start` epoch-ms **text** → TS-ms. `tokens_used` bigint. TS. | FK-del. | db/tokenLimits.ts, oss/services/tokenLimitCounter.ts |
| `api_key_token_limit_reset_logs` | same | `id` ID. `window_start` TS-ms (text). `reset_at` TS. New unique `(limit_id, window_start)`. | Duplicates → keep the lowest id. FK-del. | db/tokenLimits.ts |
| `quota_groups` | same | TS. Seed `group-demo` is created by 0001. | Insert with `ON CONFLICT (id) DO UPDATE SET name` so the seed row takes the SQLite name. | db/quotaGroups.ts |
| `quota_pools` | same | **Dropped** `connection_id` (duplicate of membership position 0). `group_id` NOT NULL default `'group-demo'`, FK RESTRICT. | NULL or `''` `group_id` → `'group-demo'`. Unknown group → `'group-demo'` + log. The old `connection_id` is inserted into `quota_pool_connections` at `position 0` if it is missing there. | db/quotaPools.ts, db/quotaGroups.ts |
| `quota_pool_connections` | same | Adds `position` (rank by `created_at`, the old `connection_id` first) with `UNIQUE (pool_id, position) DEFERRABLE INITIALLY DEFERRED`. The `updatePool` rewrite (delete all, re-insert, `quotaPools.ts:518-530`) must assign `position` = array index; it stays valid because the check runs at commit. TS. **New FKs** pool CASCADE, connection CASCADE. | FK-del. Positions renumbered 0..n-1 per pool. | db/quotaPools.ts |
| `quota_allocations` | same | `weight`, `cap_value` double. **New FK** `api_key_id` CASCADE. | FK-del (pool and key). | db/quotaPools.ts |
| `quota_allocation_model_caps` | same | **New FK** `(pool_id, api_key_id)` → `quota_allocations` CASCADE. | FK-del. | db/quotaModelCaps.ts |
| `quota_schedules` | same | `days` CSV text → `smallint[]`. `reserves` J. `enabled` B. **New FK** pool CASCADE. TS. | FK-del. Invalid days → skip + log. | db/quotaSchedules.ts, quota/schedules.ts |
| `quota_recovery_tickets` | same | `id` U. TS. No FK (env-key traffic can open tickets). | Copy as-is. | db/quotaRecoveryTickets.ts, quota/quotaSessionRecovery.ts |
| `provider_plans` | same | `dimensions_json`→`dimensions` J. **New FK** CASCADE. TS. | FK-del. | db/providerPlans.ts |
| `domain_budgets` | same | M for the three limits. `reset_time` → `time`. `budget_reset_at`, `last_budget_reset_at`, `warning_emitted_at`, `warning_period_start` TS-ms (0 → NULL). Adds `unpriced_usage_since`. No FK (`healthCheck.ts` keeps budgets for the synthetic `env-key`/`self-loop` owners). | Copy as-is; `deleteApiKey` keeps its manual delete. | db/domainState.ts, db/apiKeys.ts, db/jsonMigration.ts, db/usageAnalytics.ts, src/domain/costRules.ts |
| `domain_budget_reset_logs` | same | `id` ID. M. TS-ms columns. New unique `(api_key_id, period_start)`. **New FK** → `domain_budgets` CASCADE. | Duplicates → keep the lowest id. FK-del. | db/domainState.ts |
| `domain_circuit_breakers` | same | `last_failure_time` TS-ms. `options` J. `state` CHECK. Adds `updated_at`. | Breakers whose name embeds a missing connection id are copied (no FK). | db/domainState.ts, src/shared/utils/circuitBreaker.ts, db/healthCheck.ts |
| `domain_fallback_chains` | same | `chain` J NOT NULL. | Invalid → skip + log. | db/domainState.ts, src/domain/fallbackPolicy.ts |
| `domain_lockout_state` | same | `attempts` JSON array of epoch ms → `timestamptz[]`. `locked_until` TS-ms. | — | db/domainState.ts, src/domain/lockoutPolicy.ts |
| `exclusive_connection_leases` | same | `id` ID. TS (ISO). `end_reason` CHECK. **New FK** `connection_id` CASCADE. The 8 lease retire triggers are not ported. | FK-del. Unknown `end_reason` → NULL + log. | db/exclusiveConnectionLeases.ts, oss/services/managedLeaseFence.ts |
| `context_handoffs` | same | `key_decisions`, `active_entities` J. TS. Default id generator becomes `md5`-based (16 hex). | — | db/contextHandoffs.ts, oss/services/contextHandoff.ts |
| `session_model_history` | `session_model_pins` | One row per `(combo_name, session_id)` (PK); the surrogate `id` goes. `used_at` TS. `fillfactor=80`, no `used_at` index. The writer becomes an upsert (`ON CONFLICT (combo_name, session_id) DO UPDATE`), and reads use the PK. The leader sweeps old pins like `session_affinities`. | Keep only the latest row per `(session_id, combo_name)` (max `used_at`, then max `id`). | db/contextHandoffs.ts:192-253, oss/services/combo/executeTargetAttempt.ts:298,621,636, oss/services/combo/comboAttemptLoop.ts:898 (clear) |
| `codex_wakeup_tasks` | same | `id` U. `connection_ids`, `schedule` J. `enabled` B. TS. | — | db/codexWakeups.ts, src/lib/services/codexWakeups.ts |
| `codex_wakeup_runs` | same | `id`, `task_id` U. `results` J. `lease_expires_at` TS-ms. New partial unique `(task_id) WHERE status='running'`. **New FK** CASCADE. | Several running runs for one task → mark all but the newest `interrupted`. FK-del. | db/codexWakeups.ts |
| `command_code_auth_sessions` | same | `id` U. `metadata_json`→`metadata` J. TS. | — | db/commandCodeAuth.ts |
| `server_tool_executions` | same | `id` U. TS-mix (`claim_expires_at` ISO, others `datetime('now')`). | — | db/skillExecutionFence.ts, src/lib/skills/toolExecutionFence.ts |
| `relay_tokens` | same | `allowed_models`, `metadata` J. `enabled` B. `max_cost_per_day` M. All `*_at` TS-s. | — | db/relayProxies.ts |
| `relay_rate_limits` | same | `window_start` TS-s. `cost` M. | Rows with `token_id='unknown'` or a missing token are dropped (FK-del). Rows older than 1 day may be skipped. | db/relayProxies.ts |

## Domain D: records and logs

| SQLite table | New table | Column changes | Transfer rules | Source files |
|---|---|---|---|---|
| `call_logs` | `call_logs` (partitioned by day) | PK `(id, "timestamp")`. Adds `seq` (export cursor). `timestamp` TS. `detail_pending_until` TS-ms. B: `has_request_body`, `has_response_body`, `has_pipeline_details`, `model_pinned`, `video_content_removed`. Tri-state B: `has_content`, `reasoning_encrypted`. J: `request_summary`, `resilience_actions`. `detail_state` CHECK. `cache_source` default `'upstream'`. | **`seq` = SQLite `rowid`** (keeps `log_export_destinations.cursor_seq` valid); setval afterwards. Create partitions for min..max day first. `artifact_relpath` copied as stored (NULL stays NULL; new rows get it at insert). `detail_state` outside the set → `'missing'`. `request_summary` invalid JSON → NULL. | usage/callLogs.ts, usage/callLogsBoundedQueries.ts, usage/callLogExportQueries.ts, usage/callLogFilterOptions.ts, usage/callLogRotation.ts, usage/callLogArtifacts.ts, usage/comboHealth.ts, usage/cacheHealth.ts, usage/completedRequestDetails.ts, usage/migrations.ts, usage/usageHistory.ts, db/callLogDetails.ts, db/callLogStats.ts, db/cleanup.ts, db/cleanup/usagePurge.ts, db/comboForecast.ts, db/core.ts, db/costLedger.ts, db/providerStats.ts, db/proxyLogs.ts, db/reasoningEffortCompliance.ts, db/responsesContinuationStore.ts, db/usageLogs.ts, db/agenticConversations.ts, src/lib/logExport/exportChild.ts, src/lib/logExport/runner.ts, src/lib/monitoring/providerHealthMatrix.ts, oss/services/conversationTurnContent.ts, api/db-backups/exportAll |
| `usage_history` | `usage_history` (partitioned by day) | PK `(id, "timestamp")`, `id` ID. `timestamp`, `team_rollup_processed_at` TS. `success` B NOT NULL (NULL → true). Token columns NOT NULL default 0. M: `provider_credits`, `provider_cost_usd`. The expression dedup index is replaced by the plain `timestamp` index. | Partitions first. NULL tokens → 0. | usage/usageHistory.ts, usage/usageHistory/duplicateEntry.ts, usage/usageStats.ts, usage/aggregateHistory.ts, usage/apiKeyUsageLimits.ts, usage/apiKeySelfService.ts, usage/connectionSpeedStats.ts, usage/migrations.ts, usage/providerWindowCosts.ts, usage/teamUsageLimits.ts, usage/usageWriteRetry.ts, db/usageAnalytics.ts, db/usageAnalytics/sources.ts, db/usageSummary.ts, db/usageModelGroups.ts, db/teamUsageAnalytics.ts, db/settings/cacheMetrics.ts, db/providers/usageIdentityReconciliation.ts, db/jsonMigration.ts, db/cleanup.ts, src/lib/compliance/index.ts, oss/services/tokenLimitCounter.ts, oss/services/usage/antigravity.ts |
| `proxy_logs` | `proxy_logs` (partitioned by day) | PK `(id, "timestamp")`. `tls_fingerprint` B. TS. | Partitions first. | db/proxyLogs.ts, db/proxyLatency.ts, db/proxies.ts, db/cleanup.ts, src/lib/proxyLogger.ts, src/lib/compliance/index.ts, src/sse/services/auth.ts |
| `daily_usage_summary` | same | Surrogate `id` dropped; PK `(provider, model, date)`. `date` date. Totals bigint. `total_cost` M. The five duplicate indexes are gone. | Duplicate keys cannot exist (unique index). | usage/aggregateHistory.ts, usage/usageStats.ts, db/usageSummary.ts, db/usageAnalytics/sources.ts, db/usageAnalytics.ts |
| `daily_team_usage_summary` | same | `date` date. Totals bigint. `token_shapes_json`→`token_shapes`, `successful_token_shapes_json`→`successful_token_shapes` J. FK team RESTRICT. | FK-del (team missing). | db/teamUsageAnalytics.ts, db/teams.ts, db/usageAnalytics.ts, db/jsonMigration.ts, usage/aggregateHistory.ts, usage/teamUsageLimits.ts |
| `request_cost_ledger` | same | `id` ID. `timestamp` TS. M for prices and amount. `success` B. | — | db/costLedger.ts |
| `domain_cost_history` | same | `id` ID. `cost` M. `timestamp` TS-ms. | — | db/domainState.ts, db/apiKeys.ts, db/usageAnalytics.ts, db/jsonMigration.ts, db/cleanup.ts, usage/providerWindowCosts.ts |
| `quota_snapshots` | same | `id` ID. `is_exhausted` B. `raw_data` J. TS. **New FK** connection CASCADE (it replaces the manual delete in `providers/deletion.ts`). | FK-del. | db/quotaSnapshots.ts, db/quotaResetEvents.ts, db/providers/deletion.ts, db/healthCheck.ts, db/cleanup.ts, usage/aggregateHistory.ts, usage/apiKeyUsageLimits.ts, src/domain/quotaCache.ts |
| `provider_quota_reset_events` | same | `id` ID. **Dropped** `raw_data` (always NULL). TS. **New FK** CASCADE. | FK-del. | db/quotaResetEvents.ts, usage/providerLimits.ts |
| `compression_analytics` (+5 runtime columns) | same | `id` ID. `timestamp` TS. `validation_fallback` B. `estimated_usd_saved` M. `rtk_raw_output_pointers` J. | — | db/compressionAnalytics.ts, db/cleanup.ts, oss/handlers/chatCore/compressionAnalyticsWrite.ts |
| `compression_engine_breakdown` (runtime) | same | `id` ID. TS. | — | db/compressionAnalytics.ts |
| `compression_cache_stats` | same | `id` ID. B. `created_at` TS (`CURRENT_TIMESTAMP` = UTC). | — | db/compressionCacheStats.ts, db/cleanup.ts |
| `compression_run_telemetry` (runtime) | same | `id` ID. `timestamp` TS-ms. `output_styles` J. `cost_delta` M. | — | db/compressionRunTelemetry.ts |
| `mcp_tool_audit` | same | `id` ID. `success` B. `created_at` TS. | — | oss/mcp-server/audit.ts, src/lib/compliance/index.ts, db/cleanup.ts |
| `audit_log` (runtime) | same | `id` ID. `timestamp` TS-mix. `details`, `metadata` J (a non-JSON value → J-raw). The six single-column indexes are reduced to three. | — | src/lib/compliance/index.ts (`logAuditEvent` callers across api/ and oss/handlers/chatCore) |
| `webhook_deliveries` | same | `id` ID. TS. `payload_snapshot` stays text (truncated JSON). | FK-del. | db/webhookDeliveries.ts |
| `job_runs` | same | `id` ID. TS-mix. `status` CHECK. | FK-del. | db/jobRegistryDb.ts |
| `relay_logs` | same | `id` ID. `created_at` TS-s. `cost` M. `token_id` nullable: `'unknown'` → NULL. FK CASCADE. `status` CHECK. | `'unknown'` or a missing token → NULL (FK-null). | db/relayProxies.ts |
| `agentic_conversations` | same | **Dropped** dead `last_message_count`, `last_messages_hash`. TS. | — | db/agenticConversations.ts, db/cleanup.ts |
| `conversation_turn_nodes` | same | Adds `seq` = SQLite `rowid` (the page cursor the API exposes). TS. **New FK** `conversation_id` CASCADE. | `seq` = rowid; setval. FK-del. | db/agenticConversations.ts, db/cleanup.ts |

## Domain E: caches

| SQLite table | New table | Column changes | Transfer rules | Source files |
|---|---|---|---|---|
| `semantic_cache` | same | **PK** `signature` (surrogate `id` dropped). `response` stays text (returned verbatim). TS. | Expired rows are not copied. | db/semanticCache.ts, src/lib/semanticCache.ts |
| `cache_metrics` (runtime) | same | `value` bigint. TS. Seeded by 0001. | Upsert the 3 rows. | src/lib/semanticCache.ts |
| `reasoning_cache` | same | `created_at` TS. `expires_at` TS-mix (epoch s or ISO). | Expired rows are not copied. | db/reasoningCache.ts, oss/services/reasoningCache.ts |
| `ccr_blocks` | same | `created_at`, `last_accessed_at`, `expires_at` TS-ms. | Expired rows are not copied. | db/ccrBlocks.ts, oss/services/compression/engines/ccr/index.ts |
| `radar_feed_cache` | `radar_cache(kind='feed')` | merged; `fetched_at` TS. `payload`/`signature` text, byte-exact. | Skip if `payload` or `signature` is NULL. | db/radar.ts |
| `radar_referrals_cache` | `radar_cache(kind='referrals')` | merged | same | db/radar.ts |
| `radar_offers_cache` | `radar_cache(kind='offers')` | merged | same | db/radar.ts |
| `radar_intel_cache` | `radar_cache(kind='intel')` | merged; keeps `supporter_identity` | same | db/radar.ts |
| `radar_settings` | same | `id` smallint. `opt_in` B. TS. Seeded by 0001. | Upsert id 1. | db/radar.ts |
| `radar_local_model_state` | same | `enabled` tri-state B, `tombstoned` B. TS. | — | db/radar.ts |

## Domain F: skills, plugins, agents, evals, batches, files, misc

| SQLite table | New table | Column changes | Transfer rules | Source files |
|---|---|---|---|---|
| `skills` | same | `schema`, `tags` J. `enabled` B. `mode`, `source_provider` CHECK. TS-mix. | — | db/skills.ts, src/lib/skills/registry.ts, src/lib/skills/builtins.ts, oss/mcp-server/tools/githubSkillTools.ts |
| `skill_executions` | same | `input` J NOT NULL, `output` J (non-JSON → J-raw). TS. | FK-del. | src/lib/skills/executor.ts |
| `plugins` | same | **Dropped** `enabled` (derived: `status = 'active'`). J: `tags`, `manifest`, `config`, `config_schema`, `hooks`, `permissions`. TS. | `enabled=1` with `status<>'active'` → log only (status wins). | db/plugins.ts, db/validatedModels.ts, src/lib/plugins/manager.ts, src/lib/plugins/scanner.ts, oss/mcp-server/tools/pluginTools.ts |
| `a2a_tasks` | same | `input_json`→`input`, `output_json`→`output` J. **Dropped** dead `cost_estimated`, `cost_actual`, `routing_explanation`, `resilience_trace`, `policy_verdict`, `expires_at`. TS. | — | db/a2aTasks.ts, src/lib/a2a/taskManager.ts |
| `a2a_task_events` | same | `id` ID. `data_json`→`data` J. TS (`datetime('now')`). | FK-del. | db/a2aTasks.ts, db/cleanup.ts |
| `eval_suites` | same | TS. | — | db/evals.ts |
| `eval_cases` | same | `input_json`→`input`, `tags_json`→`tags` J. CHECK `expected_strategy`. **New FK** suite CASCADE. | FK-del. | db/evals.ts |
| `eval_runs` | same | `summary_json`→`summary`, `results_json`→`results`, `outputs_json`→`outputs` J. **Dropped** `pass_rate`, `total`, `passed`, `failed` (duplicates of `summary`). | When `summary` lacks `total`/`passed`/`failed`/`passRate`, fill them from the dropped columns first. | db/evals.ts, src/lib/evals/runtime.ts, oss/services/evalRouting.ts |
| `files` | same | `content` BLOB → bytea. `bytes` bigint. `created_at`, `expires_at`, `deleted_at` TS-s. | Stream large BLOBs (up to 512 MB each). | db/files.ts, db/backupRetention.ts, src/lib/usage/callLogDetailResolver.ts, src/lib/localCorpus/index.ts, oss/services/compression/summarizer.ts, oss/mcp-server/tools/pluginTools.ts, src/lib/copilot/codegraphKnowledge.ts |
| `batches` | same | All `*_at` TS-s. J: `metadata`, `errors`, `usage`. `status` CHECK. **Dropped** `expires_at` (never written; `expired_at` is the real column). Counts NOT NULL. | FKs to files: missing file → skip the batch + log (the batch cannot run). | db/batches.ts, oss/services/batchProcessor.ts, api/v1/batches/delete-completed |
| `batch_item_checkpoints` | same | `result_json`→`result`, `error_json`→`error` J. TS-s. | FK-del. | db/batches.ts |
| `inspector_sessions` | same | TS. | — | db/inspectorSessions.ts |
| `inspector_session_requests` | same | `payload` J. | Invalid payload → skip + log (the reader already drops invalid rows). FK-del. | db/inspectorSessions.ts |
| `inspector_custom_hosts` | same | `enabled` B. **Dropped** dead `last_seen_at`. TS. | — | db/inspectorCustomHosts.ts |
| `agent_bridge_state` | same | B (`dns_enabled`, `cert_trusted`, `setup_completed`). `last_started_at` TS. All columns are kept. `upsertAgentBridgeState` writes whichever fields a caller passes, and the UI reads `cert_trusted`, so the columns are live API surface even though no current caller sets the last three. | — | db/agentBridgeState.ts |
| `agent_bridge_mappings` | same | TS. Also receives `mitmAlias` (Domain B). | — | db/agentBridgeMappings.ts |
| `agent_bridge_bypass` | same | TS. | — | db/agentBridgeBypass.ts |
| `playground_presets` | same | `id` U. `params_json`→`params` J. TS. | — | db/playgroundPresets.ts |
| `discovery_results` | same | `id` ID. `models` J. `feasibility` smallint. TS. Unique `NULLS NOT DISTINCT`. | Duplicates with a NULL endpoint → keep the newest. | db/discoveryResults.ts (db/discovery.ts is dead) |

## Domain G: dropped tables

None of these get a table. "Readers to delete" lists code that the rewrite must remove instead of porting.

| SQLite table | Evidence | Readers/writers to delete |
|---|---|---|
| `memories`, `memory_fts`, `memory_fts_config`, `memory_fts_data`, `memory_fts_docsize`, `memory_fts_idx`, `memory_vec_meta`, `vec_memories` (runtime) | Owner decision: the memory engine is deleted. | src/lib/memory/*, db/memoryVec.ts, `cleanupMemoryEntries` in db/cleanup.ts |
| `badge_definitions`, `community_servers`, `invite_tokens`, `leaderboard`, `token_ledger`, `user_badges`, `user_levels`, `xp_action_counts`, `xp_audit_log` | Commit df35513d removed all gamification code ("tables remain, unused"). `rg` finds them only in migrations 060/176, the snapshot/baseline and tests. | none in src (tests: sqlite-planner-stats*) |
| `combo_adaptation_state` | No reference outside migration 002/151. | — |
| `routing_decisions` | Nothing inserts or selects it; `src/lib/a2a/routingLogger.ts` keeps decisions in memory. | entry in `RESET_TARGETS` (db/cleanup.ts) |
| `session_account_affinity` (table) | The live store is the key_value namespace of the same name (→ `session_affinities`). | migration bookkeeping only |
| `tier_assignments` | No reference in src/ or open-sse/. | — |
| `hourly_usage_summary` | Only writer is the manual `src/scripts/backfillAggregation.ts`; nothing reads it. | `rollupHourlyQuota` in usage/aggregateHistory.ts, `RESET_TARGETS` entry |
| `plugin_metrics` | db/pluginMetrics.ts has no importer; its header says it is not called. | db/pluginMetrics.ts |
| `plugin_analytics` | Its only writer `recordPluginExecution` has no caller, so it is always empty. | `plugin_executions` MCP tool query (oss/mcp-server/tools/pluginTools.ts), `recordPluginExecution` |
| `middleware_logs` | No writer; the live middleware registry logs in memory. | `getHookLogs` in db/middleware.ts, together with its callers in api/middleware/hooks/route.ts:8 and api/middleware/hooks/[name]/route.ts:8 (return the in-memory registry log instead, or drop the field) |
| `config_audit_log` | `recordChange` (src/domain/configAudit.ts) has no caller outside its module, so the table is never written. `audit_log` is the live audit table. | src/domain/configAudit.ts, `cleanupConfigAudit` |
| `db_meta` | Holds the constant `schema_version='1'`; the PG migration ledger replaces it. | db/core.ts, db/healthCheck.ts |
| `request_detail_logs` | No production writer since call-log artifacts; the 500-row ring holds only rows from before artifacts existed, whose call_logs rows are past retention. Dropped by owner decision. | db/detailedLogs.ts, the route api/logs/detail/route.ts (removed with the table), fallback in usage/callLogDetailResolver.ts:43, compliance cleanup, `RESET_TARGETS` |
| `prompt_templates` (runtime) | db/prompts.ts is never imported by non-test code. | db/prompts.ts |
| `model_assessments`, `assessment_runs`, `combo_health`, `heal_actions` (runtime) | `runAssessmentMigration` is never called; no SQL touches them. | src/domain/assessment/migration.ts |
| `api_key_token_limits_new` | Leftover of a table rebuild (migration 196); 0 references. | — |
| `call_logs_v1_legacy` | Legacy inline-body table that `core.ts` drops at the end of its migration. | fallback in usage/callLogDetailResolver.ts:145 |

## Behaviour changes code agents must carry

These change observable results, deliberately. Each fixes a defect or follows from the new types.

- **Timestamp comparisons become correct.** Several cutoffs compared ISO text with `datetime('now')` text and misplaced the boundary day. With timestamptz they compare instants:
  - `mcp_tool_audit`, `compression_cache_stats`, `a2a_task_events` and `a2a_tasks` purge;
  - `getCacheTrend`;
  - `registered_keys` expiry;
  - `api_key_token_counters.window_start` compared as text.
- **`pg` returns parsed values.** jsonb comes back as JS objects and arrays, and timestamptz as `Date`. `rowToCamel`'s `_json` auto-parse no longer applies, because the `_json` columns lost the suffix. Code that did `JSON.parse(row.x)` or `new Date(row.x)` must accept the parsed value. Recommended follow-up: a type parser in `src/lib/db/backends/postgres/pool.ts` (timestamptz → ISO string), so the many `toISOString()`-shaped consumers keep working during the rewrite.
- **Raw-text config values become JSON strings.** These are `feature_flags`, `ccDiscoveryAliases`, `functionalGatewayMirrors` and the `job_state` entries from `arena_elo` and `free_proxies`. Write `to_jsonb($1::text)` and read `value #>> '{}'`.
- **Combo names are unique case-insensitively.** Look up with `lower(name) = lower($1)`. The exact-then-NOCASE two-step lookup goes.
- **`api_keys.key` is no longer unique.** Uniqueness and lookup are on `key_hash` only.
- **Every `api_keys` insert path must write `key_hash`**, which is now NOT NULL. `createApiKey` already does. The legacy import in `db/core.ts:1747` (`INSERT OR REPLACE INTO api_keys (...)` without `key_hash`) and `jsonMigration` must compute it from the raw key.
- **Point updates on partitioned logs pass the partition key.**
  - `publishPendingCallLogDetail` and `failPendingCallLogDetail` add `AND "timestamp" = $ts`, using the value the writer already has.
  - The same applies to `proxy_logs` `updateAttemptTiming` and to the `usage_history` backfill.
  - Without it, each statement probes every partition's PK index (about 45 index probes).
- **Retention for the three partitioned tables drops partitions** (see the design doc). Retention is rounded to whole UTC days: the newest dropped day ends at or before the cutoff.
- **Log export reads with a lag.** It reads `WHERE seq > $cursor AND "timestamp" < now() - interval '1 minute' ORDER BY seq`.
- **The remaining `rowid` uses become keys.**
  - Batch deletes become `DELETE ... WHERE ctid = ANY(ARRAY(SELECT ctid ... LIMIT n))`, or go by PK.
  - `conversation_turn_nodes` pages by `seq`.
- **Unique-violation handling is by SQLSTATE `23505`, not message text.** This covers leases and the server-tool fence. Prefer `INSERT ... ON CONFLICT DO NOTHING RETURNING` so a conflict does not abort the transaction.
- **Removed derived columns.**
  - `free_proxies.in_pool` → `pool_proxy_id IS NOT NULL`.
  - `plugins.enabled` → `status = 'active'`.
  - `quota_pools.connection_id` → `quota_pool_connections` with `position = 0`.
- **The relay auth-failure log writes `token_id = NULL`** instead of `'unknown'`, and it writes no `relay_rate_limits` row.
- **Sync tokens issued for the env key** store `sync_api_key_id = NULL`, never `'env-key'` (the column has an FK).
- **`call_logs.artifact_relpath` is set at INSERT** to `buildArtifactRelativePath(timestamp, id)` (`callLogArtifacts.ts:141`), a pure function of the row.
  - The detail publish only flips `detail_state`, `detail_pending_until`, `artifact_size_bytes` and `artifact_sha256`. None of those is indexed, so the update is HOT (measured 100%).
  - "Has an artifact" means `detail_state = 'ready'`, no longer `artifact_relpath IS NOT NULL`. Update `completedRequestDetails.ts`, `conversationTurnContent.ts`, `responsesContinuationStore.ts`, `callLogsBoundedQueries.ts` and `logExport/exportChild.ts` accordingly.
  - Lookups by path go through the primary key: parse `(timestamp, id)` from `<day>/<timestamp with '-' for ':'>_<id>.json`. That covers `clearArtifactReference` (`callLogRotation.ts:36-44`) and the referenced-path check (`callLogsBoundedQueries.ts:69`).
  - Legacy rows keep their stored path.
  - The pending sweep becomes `UPDATE call_logs SET detail_state='missing', detail_pending_until=NULL WHERE "timestamp" > now() - interval '1 day' AND detail_state='pending' AND detail_pending_until <= $now`. There is no index; the time bound limits it to one or two partitions.
- **Dropping a partition must remove that day's artifact directory.**
  - Artifacts live in `<callLogsDir>/<YYYY-MM-DD>/...` (UTC day). After `omniroute_drop_daily_partitions_before('call_logs', D)`, the leader deletes every day directory before `D`.
  - The orphan-file sweep stays as a safety net.
- **`trimCallLogsToMaxRows` and `selectOverflowArtifactPaths` work on `(id, "timestamp")` pairs**, not ids alone. They select `id, "timestamp"` ordered by `"timestamp"` and delete with `WHERE (id, "timestamp") IN (...)`, so each delete prunes to its partitions.
- **Id-only lookups on partitioned tables:**
  - `getCallLogById(id)` (the detail route has only the id): `SELECT ... WHERE id = $1 ORDER BY "timestamp" DESC LIMIT 1`. This is acceptable for an interactive view; it probes each partition's PK index. Where a caller has the timestamp (export, conversation views), pass it.
  - The `'corrupt'` state update (`callLogs.ts:1018`) runs right after reading the row, so it passes the row's `"timestamp"`.
  - `updateAttemptTiming` (`proxyLogs.ts:338`) needs the attempt's `"timestamp"` passed through from `proxyLogger` (the queued entry has it).
  - The `usage_history` dedup (`duplicateEntry.ts`) already filters `"timestamp" = $ts`, so it prunes to one partition. The backfill `UPDATE` must keep `"timestamp"` in its WHERE.
  - `deleteCallLogRowsByIds` becomes `(id, "timestamp")` pairs, as above.
  - `isCallLogIdCollision`: the PK is `(id, "timestamp")`, so a reused id with a different timestamp no longer conflicts. Rely on UUID generation and treat `23505` on insert as the collision signal (regenerate the id, retry). The pre-check query goes.
- **Bind timestamps as parameters.**
  - Compute cutoffs in JS (`new Date(Date.now() - ms)`) and pass them as parameters, rather than writing `now() - interval ...` in SQL against the partitioned tables.
  - With a bound value, plan-time pruning keeps planning at 1–2 ms at 382 partitions. A `now()`-based bound is pruned only at executor start, after planning every partition (40–50 ms measured).
- **UUID-keyed tables reject bad ids up front.** A non-UUID path or body id would raise `22P02` (invalid_text_representation) and surface as a 500. Repositories return `null`/not-found for a value that fails a UUID regex, before querying. Affected:
  - `registered_keys`, `registered_key_limits` lookups by key id;
  - `codex_wakeup_tasks`, `codex_wakeup_runs`;
  - `auto_candidate_overrides`, `quota_recovery_tickets`;
  - `api_key_billing_team_history`, `api_key_token_limits` (and its counters and reset logs);
  - `command_code_auth_sessions`, `server_tool_executions`, `playground_presets`.
- **Strip U+0000 at the write boundary.** Postgres rejects `\u0000` in `text` and in jsonb strings ("unsupported Unicode escape sequence"), and upstream content can carry it. Before `JSON.stringify` or binding a text parameter, remove `\u0000` from strings. A shared helper in the backend layer is the simplest place. Columns that receive upstream or user content:
  - `call_logs.error_summary`, `request_summary`, `resilience_actions`;
  - `semantic_cache.response`, `reasoning_cache.reasoning`, `ccr_blocks.content`;
  - `context_handoffs.summary`/`task_progress`/`key_decisions`/`active_entities`;
  - `skill_executions.input`/`output`, `server_tool_executions.output`/`error_message`;
  - `a2a_tasks.input`/`output`, `a2a_task_events.data`;
  - `eval_runs.results`/`outputs`, `batch_item_checkpoints.result`/`error`;
  - `inspector_session_requests.payload`, `audit_log.details`/`metadata`;
  - `webhook_deliveries.payload_snapshot`, `cloud_agent_tasks.activities`/`result`;
  - `gemini_thought_signatures.signature`, `proxy_logs.error`.
- **Races that SQLite's single writer hid.**
  - **Settings revision.** `updateSettings` reads `_settingsRevision` and writes the new revision inside one transaction:
    - Seed once: `INSERT INTO config_entries ('settings','_settingsRevision','0') ON CONFLICT DO NOTHING`.
    - Then `SELECT value FROM config_entries WHERE namespace='settings' AND key='_settingsRevision' FOR UPDATE`, compare it to `expectedRevision`, write the keys and bump the revision.
  - **`agentic_conversations` external sessions.** "Select by id, else insert" becomes one statement: `INSERT ... ON CONFLICT (id) DO UPDATE SET turn_count = agentic_conversations.turn_count + 1, last_seen_at = excluded.last_seen_at`. The heuristic path also uses `turn_count = turn_count + 1`, not a JS-computed value.
  - **Whole-document read-modify-write** of `provider_model_catalog.custom_models`/`compat_overrides`/`provider_aliases`, `connection_model_sync.models` and `combos.data`. Read with `SELECT ... FOR UPDATE` inside the same transaction as the write, so two processes cannot lose each other's edit. Where the change is a single key, a jsonb operator in the UPDATE (`jsonb_set`, `||`, `-`) avoids the read altogether.
  - The remaining races are listed in the design doc ([Coordination and runtime state](postgres-schema.md#coordination-and-runtime-state)).
- **Every UPDATE sets `updated_at`.** There is no trigger. Writers that skipped it in SQLite must add `updated_at = now()`: `reorderConnections` (`providers/deletion.ts:266`), the re-encrypt sweeps (`providers/migrations.ts:55`) and the remaining `UPDATE ... SET` statements on tables that have the column. The only exception is the touch writes that deliberately leave it alone (`touchConnectionLastUsed` sets it itself).
- **Round numbers bound to integer columns.** Postgres rejects `12.5` for an `integer` parameter, while SQLite stored it. Writers that compute counts (`usageWriteRetry.ts:206-216` token fields, latency and duration values, `consumed`-style counters going into integer columns) pass `Math.round(x)`.
