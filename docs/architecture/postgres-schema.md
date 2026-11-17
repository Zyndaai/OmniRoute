---
title: "PostgreSQL schema design"
status: proposed
lastUpdated: 2026-11-16
---

# PostgreSQL schema design

OmniRoute's PostgreSQL 18 schema is one init migration, `src/lib/db/backends/postgres/migrations/0001_init.sql`, designed fresh rather than translated from the 219 SQLite migrations. It has 125 tables, down from 156 SQLite source tables. Of those 156, 143 are in the schema snapshot, 11 are created at runtime and 2 are leftovers.
- **Removed:** 35 dead or retired tables.
- **Split:** the generic `key_value` store becomes one bounded `config_entries` table plus 10 typed tables, so per-request and unbounded state gets keys, foreign keys and expiry.
- **Merged:** duplicate tables (counters, key-issuance limits, radar caches) become one each.

The schema uses native types throughout: timestamptz, boolean, jsonb, numeric money and uuid leaf ids. Foreign keys tie configuration together, while logs and caches stay free of FKs. The three per-request log tables are partitioned by day, so retention drops whole partitions. Every column change and the transfer rule for existing data are in [`postgres-schema-mapping.md`](postgres-schema-mapping.md). Process roles, Redis and the backend contract are in [`persistence-shared-state.md`](persistence-shared-state.md) and [`persistence-backend-boundary.md`](persistence-backend-boundary.md).

## Contents

- [Design principles](#design-principles)
- [Control plane](#control-plane)
- [Model catalog and what key_value became](#model-catalog-and-what-key_value-became)
- [Coordination and runtime state](#coordination-and-runtime-state)
- [Records and logs](#records-and-logs)
- [Caches](#caches)
- [Skills, plugins, agents, evals, batches, files](#skills-plugins-agents-evals-batches-files)
- [Partitioning and retention](#partitioning-and-retention)
- [Indexing strategy](#indexing-strategy)
- [Removed tables](#removed-tables)
- [Conventions and operability](#conventions-and-operability)
- [Open questions for the owner](#open-questions-for-the-owner)
- [Sources](#sources)
- [Appendix: query plans](#appendix-query-plans)

## Design principles

1. **Integrity where the app relies on it.**
   - Real primary keys everywhere: surrogate SQLite ids are dropped where a natural key existed (`upstream_proxy_config`, `version_manager`, `semantic_cache`, `daily_usage_summary`).
   - CHECK constraints for every enum the code defines (TS unions, zod enums). Open-ended sets, such as `test_status` or `last_error_type`, stay unchecked.
   - Case-insensitive uniqueness the app assumes: team names, combo names, provider node prefixes.
   - SQLite enforced foreign keys only on some drivers. The code comments disagree on whether FKs were on (`a2aTasks.ts` vs migrations 072/073/126), so the transfer tool treats every relationship as possibly dirty and applies an orphan rule per FK.
2. **Foreign keys connect configuration, not history.**
   - Config children reference their parents with `ON DELETE CASCADE`. That replaces the manual cascades in `providers/deletion.ts` and `apiKeys.ts`, and closes the orphan leaks the code did not clean (`auto_candidate_overrides`, `provider_quota_state`, `provider_plans`, quota pools, token limits).
   - Logs, ledgers and caches have no FK to `api_keys` or `provider_connections`. History must outlive its parent, which is why `call_logs` keeps the `api_key_name` and `account` snapshots.
   - Several writers use synthetic owner ids: `system`, `skillsmp`, `env-key`, `self-loop`, `__anon__`, `omniroute:glm-reset-card-operation`.
   - The request path also uses the synthetic connection `noauth` (`SYNTHETIC_NOAUTH_CONNECTION_ID` in `src/sse/services/auth.ts`).
   - `sync_tokens` is the one table that keeps its FK even though its writer used a synthetic id. Tokens issued for the env key store `sync_api_key_id = NULL`, which the code reads as "no linked key", instead of `'env-key'`; the transfer maps it the same way.
   - So even some config-like tables get **no** FK, because they can hold these ids. Code keeps deleting their rows when the real parent goes:
     - `domain_budgets` and `quota_recovery_tickets` (env-key traffic);
     - `auto_candidate_overrides`;
     - `session_affinities`, `lkgp_pins` and `provider_quota_state` (the noauth connection).
3. **Native types.** Each rule's transfer conversion is in the mapping doc.
   - **Timestamps:** `timestamptz`. The SQLite data mixes ISO text, `datetime('now')` text, epoch ms and epoch seconds, sometimes within one column.
   - **Days:** `date`.
   - **Booleans:** `boolean`.
   - **JSON:** `jsonb`. The exceptions stay `text`: payloads whose bytes matter (the signed radar documents, the semantic-cache response, truncated webhook snapshots) and opaque values (`muse_session_ownership`).
   - **Money:** `numeric(20,10)` USD, which gives sub-cent precision to 1e-10 with 10 integer digits.
   - **Credentials:** remain `enc:v1:` envelopes in `text`, as decided.
4. **Ids.** Entity ids that other tables, or JSON documents like `combos.data` and `api_keys.allowed_connections`, reference as text stay `text`. This covers api keys, connections, combos, nodes, pools and teams. Making them `uuid` would force casts on every log join (`call_logs.api_key_id` must stay text for synthetic ids), and some are caller-supplied: combo imports, provider node suffixes, `tok_`/`rl_`/`task_` prefixes. Leaf tables whose ids were always `crypto.randomUUID()` get `uuid` with a `gen_random_uuid()` default, which is core PostgreSQL since 13 and needs no extension. Surrogates are `bigint GENERATED BY DEFAULT AS IDENTITY`; BY DEFAULT lets the transfer insert the old ids.
5. **Schema instead of single-writer luck.** SQLite serialized every write, which hid check-then-act races. Where a constraint can make the race harmless, the schema has one:
   - a partial unique index for one running Codex wake-up run per task;
   - unique `(limit_id, window_start)` on token-limit reset logs and `(api_key_id, period_start)` on budget reset logs, so four writers log a rollover once;
   - the lease mutual-exclusion indexes, which stay as they were.
   The remaining races are application logic and are listed under [Coordination and runtime state](#coordination-and-runtime-state).
6. **Fewer, purposeful indexes.** The SQLite schema had 244 explicit indexes (0001 has 127); many duplicated each other (five identical `(provider, model, date)` indexes on `daily_usage_summary`) or served no query. Every index in 0001 maps to a query shape below, and columns that hot paths update are kept out of B-tree indexes so updates stay HOT.

## Control plane

**Tables:**
- `provider_nodes`, `provider_connections`
- `api_keys`, `api_key_context_sources`
- `teams`, `api_key_billing_team_history`
- `key_groups`, `key_group_members`, `group_model_permissions`
- `sso_identities`
- `combos`, `model_combo_mappings`, `reasoning_routing_rules`, `auto_candidate_overrides`
- `registered_keys`, `registered_key_limits`
- `sync_tokens`, `cli_access_tokens`
- the proxy tables (`proxy_registry`, `proxy_assignments`, `proxy_scope_rotation`, `proxy_subscriptions`, `free_proxies`, `free_proxy_sync_errors`, `proxy_operator_egress`)
- `upstream_proxy_config`, `version_manager`
- `cloud_agent_credentials`, `cloud_agent_tasks`
- `webhooks`, `log_export_destinations`, `middleware_hooks`
- `compression_combos`, `compression_combo_assignments`
- `config_entries`, `jobs`

Key decisions:

- **API key auth looks up `key_hash` only.** It is `NOT NULL UNIQUE` with a hex CHECK.
  - Today `key_hash` is added at runtime (`apiKeyColumnFallbacks.ts`), has no index, and is nullable, with a backfill-on-miss.
  - `key` keeps the app-encrypted secret for reveal and export and loses its UNIQUE, because randomized ciphertext makes that uniqueness meaningless.
- **`provider_connections`** is read per request through a 5 s cache: `WHERE provider=? AND is_active ORDER BY priority, updated_at DESC`.
  - It is touched per request by `touchConnectionLastUsed`. The single routing index `(provider, priority)` deliberately leaves out `updated_at`, `last_used_at` and `consecutive_use_count`, and `fillfactor=80` keeps those touches HOT. Measured: 100% HOT updates, see the appendix.
  - The six SQLite indexes on this 10–1,000-row table become one.
  - `"group"` is renamed `group_name` to drop the reserved-word quoting.
  - `rate_limited_until` was written as epoch-ms numbers and as ISO strings into one text column; it is now `timestamptz`.
- **Combos** keep the full normalized record in `data jsonb`.
  - No SQL reads inside it, and steps reference connections and nested combos by id or name inside the document, so normalizing steps would rewrite every combo code path for no query benefit.
  - `name` is unique on `lower(name)`, matching the app's case-insensitive handling (the NOCASE fallback lookup and the grant revocation).
  - The only database CHECK on the name is its length (1–300 after trimming). The charset rule stays in zod, because system-built names such as quota combos `qtSd/<slug>/<provider>/<model>` contain `:`, `@` and `+` and exceed 100 characters.
  - The never-used `system_message` and `tool_filter_regex` columns are gone.
- **Duplicates merged.**
  - `provider_key_limits` and `account_key_limits` were identical, so they become `registered_key_limits(scope, scope_id)`.
  - `free_proxies.in_pool` is derived from `pool_proxy_id`. Dropping it, plus an FK with `SET NULL`, replaces the trigger `trg_free_proxies_clear_pool_proxy_id`.
- **Proxy scopes.** `proxy_assignments` and `proxy_scope_rotation` both use the `'__global__'` sentinel with `scope_id NOT NULL`. That removes the NULL-in-unique-key ambiguity and the `scope_id IS ?` comparisons.
- **Retired-provider triggers** (20, for cgpt-web, felo-web, qwen-web and microsoft-designer-web) and the reasoning-rule cascade triggers are not ported. The FKs replace the cascades, and the retired providers' rows are copied already deactivated.

## Model catalog and what key_value became

`key_value(namespace, key, value text)` held 47 namespaces. They ranged from 1-row config to per-request, unbounded session state, with mixed JSON and raw values. Plain `text` meant no types, no expiry index and no FK cleanup: `lkgp` was cleaned by scanning the namespace and parsing JSON. It also meant the critical-state preservation silently skipped the whole table past 10,000 rows. Each namespace now has one of four outcomes.

| Outcome | Namespaces | Why |
|---|---|---|
| `config_entries(namespace, key, value jsonb, updated_at)`, with a CHECK on the allowed namespaces | `settings`, `proxyConfig`, `secrets`, `ipFilter`, `feature_flags`, `pii_settings`, `provider_param_filters`, `interception_rules`, `compression`, `databaseSettings`, `ccDiscoveryAliases`, `functionalGatewayMirrors`, `obsidian`, `notion`, `sync`, `conductor`, `local_corpus`, `cliToolLastConfig`, `cliToolInitialConfig`, `serviceModels`, `antigravityCreditBalance`, plus `tier` (was the `tier_config` table) and `job_state` (sync and job status, and job keys moved out of `settings`) | Bounded configuration: tens to hundreds of rows, read whole-namespace and cached. One table keeps the 60+ call sites simple. jsonb gives typed values, and the namespace CHECK stops it becoming a dumping ground again. |
| Dedicated typed table | `session_account_affinity` → `session_affinities`; `gemini_thought_signatures` → same; `muse_session_ownership` → same; `ccDiscoveryMetrics` → `cc_discovery_metrics`; `lkgp` → `lkgp_pins`; `modelAliases` + `managedModelAliasNames` → `model_aliases`; `pricing`/`pricing_synced`/`models_dev_pricing` → `model_pricing(source, provider)`; `customModels` + `modelCompatOverrides` + `providerAliases` → `provider_model_catalog` (one row per provider); `syncedAvailableModels` + `discoveryState` → `connection_model_sync` (one row per connection); `providerLimitsCache` → `connection_limits_cache` | Read or written per request, unbounded or TTL-bound, or owned by a connection, so it needs an FK. Catalog documents stay one jsonb row per provider or connection rather than one row per model, which keeps the code rewrite to a key change. |
| Column on the owning row | `budgetUnpricedUsage` → `domain_budgets.unpriced_usage_since`; `keyQuotaUnpricedUsage` → `api_key_quota_limits.unpriced_usage_since`; `mitmAlias` → rows of `agent_bridge_mappings` (the namespace was a mirror of that table for the MITM process) | The value is an attribute of an existing row or a copy of one. |
| Dropped | `scheduler`, `walMaintenance`, `dbBackup`, `apiKeySelfService`; SQLite-only `databaseSettings` keys (`optimization.*`, `mmapSize`, `integrity.lastCheck`, `backup.*`); `settings` keys for the memory engine, `qdrant*` and the dead `chatAdmissionSettings` | SQLite VACUUM, WAL and file-backup state, a run-once marker, and removed features. |

Job-state keys move out of `settings` (`model_sync_last_run`, `provider_limits_auto_sync_last_run`, `codex_catalog_revalidated_version`, `maxaiSigningConstants`, `learnedRateLimits`). Background jobs used to bump `_settingsRevision`, which could make a dashboard save fail its optimistic-concurrency check.

`config_entries` values for formerly raw namespaces become JSON strings (`feature_flags`, `ccDiscoveryAliases`, `functionalGatewayMirrors`); readers use `value #>> '{}'`. `lkgp_pins.pin_key` keeps the app's key format. Prefix scans such as `pin_key LIKE 'combo:%'` use the primary key directly, because the database collation is `C`, where B-tree indexes serve `LIKE 'prefix%'`.

The other catalog tables keep their shape with native types: `model_capabilities` (tri-state booleans, jsonb modalities), `model_capability_overrides` (jsonb value), `model_context_overrides` and `model_intelligence`.

## Coordination and runtime state

**Tables:**
- `connection_runtime_state`, `provider_quota_state`
- `quota_counters`, `api_key_quota_limits`
- `api_key_token_limits`, `api_key_token_counters`, `api_key_token_limit_reset_logs`
- quota pools: `quota_groups`, `quota_pools`, `quota_pool_connections`, `quota_allocations`, `quota_allocation_model_caps`, `quota_schedules`
- `quota_recovery_tickets`, `provider_plans`
- the `domain_*` budget, breaker, fallback and lockout tables
- `exclusive_connection_leases`
- `session_affinities`, `gemini_thought_signatures`, `muse_session_ownership`, `cc_discovery_metrics`
- `context_handoffs`, `session_model_pins`, `codex_wakeup_tasks`, `codex_wakeup_runs`
- `command_code_auth_sessions`, `server_tool_executions`
- `relay_tokens`, `relay_rate_limits`

These are small rows that all 2–4 processes read and write. They split into three groups.

**Hot counters.**
- `quota_consumption` and `api_key_quota_counters` had the same shape and the same upsert, so they merge into `quota_counters(api_key_id, dimension_key, bucket_index)`. The `key-quota:` prefix keeps their dimension keys apart. The per-request write is `INSERT ... ON CONFLICT DO UPDATE SET consumed = consumed + excluded.consumed`, which is atomic across processes.
- The SQLite `updated_at` B-tree indexes on both tables served only `gcOlderThan`, which nothing calls. They would make every upsert non-HOT, so they are replaced by a BRIN index. Since PostgreSQL 16, BRIN-only column changes still qualify for HOT. Measured: 100% HOT.
- The counter rows are many: one per key, dimension and bucket. Contention exists only when the same key hits the same bucket at once, and the row lock is held for microseconds. At tens of requests per second that is fine.
- Redis already has a quota store (`QUOTA_STORE_DRIVER=redis`) if contention ever shows up.
- `cache_metrics` (3 rows updated on every semantic-cache lookup) is the one true hot row. It gets `fillfactor=50`. The Prometheus exporter is the better long-term home.

**Snapshots written through.** All of these have `fillfactor` 70–80 and no index on the changed columns.
- `domain_circuit_breakers` is written after every request through a breaker.
- `proxy_scope_rotation` is written on every round-robin advance.
- `connection_runtime_state` is written per warmup.
- `session_model_pins` replaces SQLite `session_model_history`, which my first pass wrongly marked dead. It is live: `executeTargetAttempt.ts` records and reads it through `contextHandoffs.ts`, and `comboAttemptLoop.ts` clears it. The code only ever reads the newest row per `(combo, session)`, so the table keeps one upserted row per pair under a PK. It has no `used_at` index, and the leader sweeps it by sequential scan like `session_affinities`.
- `muse_session_ownership` is touched per Muse request. Its `touched_at` has no index; a periodic scan sweeps it.

**Races a constraint cannot fix.** These are listed for the code-rewrite agents. The schema provides the keys the fixes need.
- `provider_quota_state` and the token-limit "seed on first write": do the window roll in one upsert, `ON CONFLICT DO UPDATE SET tokens_used = CASE WHEN excluded.window_start > provider_quota_state.window_start THEN excluded.tokens_used ELSE provider_quota_state.tokens_used + excluded.tokens_used END`. Seed counters with `INSERT ... ON CONFLICT DO NOTHING` before incrementing.
- `domain_budgets` (an in-process Map with whole-row `INSERT OR REPLACE`), `domain_lockout_state` (attempts array read-modify-write) and `domain_circuit_breakers` (a per-process state machine): update single columns in SQL, append attempts with `array_append`, and broadcast breaker transitions on the Redis bus.
- `claimCodexWakeupRun`: the partial unique index now rejects a second running run; catch `23505`.
- Leases and `server_tool_executions` detect conflicts by SQLite error text. Use `ON CONFLICT DO NOTHING RETURNING`, because a failed INSERT aborts a Postgres transaction.
- Per-process timers must run only on the leader: the warmup and Codex schedulers, the session-affinity sweep, semantic and reasoning cache pruning, quota recovery polling and the `reconcileInterruptedQuotaRecoveries` startup reset. The startup reset in particular flips other processes' live tickets.

**FK ownership** closes leaks the code never cleaned.
- Deleting a connection now removes its plans, reset events, quota snapshots, pool memberships, leases, runtime state and catalog rows (`connection_model_sync`, `connection_limits_cache`).
- Deleting an API key removes its quota limits and allocations, token limits and sync tokens.
- Deleting a pool removes its schedules and model caps. `deletePool` used to leave them, and `updatePool` deleted schedules by accident.
- Tables that may hold synthetic ids keep code-side cleanup (design principle 2): `session_affinities`, `lkgp_pins`, `provider_quota_state`, `auto_candidate_overrides`, `domain_budgets`, `quota_recovery_tickets`. The rewrite should add the missing deletes to the connection and API-key delete paths.

## Records and logs

**Tables:**
- the partitioned logs: `call_logs`, `usage_history`, `proxy_logs`
- rollups: `daily_usage_summary`, `daily_team_usage_summary`
- cost: `request_cost_ledger`, `domain_cost_history`
- quota history: `quota_snapshots`, `provider_quota_reset_events`
- compression: `compression_analytics`, `compression_engine_breakdown`, `compression_cache_stats`, `compression_run_telemetry`
- audit and delivery: `mcp_tool_audit`, `audit_log`, `webhook_deliveries`, `job_runs`, `relay_logs`
- conversations: `agentic_conversations`, `conversation_turn_nodes`

Query patterns served:
- **Dashboard call-log list:** time window plus filters, newest first, LIMIT/OFFSET 200. Served by `call_logs_timestamp_idx` per partition with Merge Append; partition pruning drops days outside the window.
- **Usage analytics:** time window grouped by day, provider, model or key. Pruning plus `usage_history_timestamp_idx` or `(api_key_id, "timestamp")`.
- **Provider health matrix and provider stats:** `(provider, "timestamp") INCLUDE (connection_id, model, requested_model, status, duration)` replaces the 9-column SQLite covering index.
- **Point lookups:** correlation id, response id (Responses-API continuation), session tag and artifact path, each a partial index on non-NULL values.
- **Detail publishing:** the per-request `UPDATE ... WHERE id=? AND "timestamp"=? AND detail_state='pending'` touches one partition, and it is **HOT** (measured 2000/2000). To get there:
  - `artifact_relpath` is a pure function of `("timestamp", id)` (`buildArtifactRelativePath`), so it is written at INSERT and the update no longer changes an indexed column.
  - Neither `artifact_relpath` nor `detail_state`/`detail_pending_until` is indexed. Path lookups resolve to the primary key by parsing the file name.
  - `call_logs` and `proxy_logs` partitions are created with `fillfactor=85`, so the one post-insert update finds room on its page.
  - The pending sweep runs `WHERE "timestamp" > now() - interval '1 day' AND detail_state = 'pending'`, which touches one or two partitions.
- **Artifact files follow the partitions.** Artifact files sit in per-UTC-day directories (`<callLogsDir>/<YYYY-MM-DD>/`). After dropping day D, the leader removes that day's directory; the orphan-file sweep stays as a safety net. `trimCallLogsToMaxRows` and `selectOverflowArtifactPaths` select and delete by `(id, "timestamp")`.
- **Log export:** `seq` replaces the SQLite `rowid` cursor; the transfer loads `seq` from the old rowid so stored cursors stay valid.
  - Identity values are handed out at INSERT but become visible at COMMIT, so with 2–4 processes a smaller `seq` can commit after a larger one.
  - The exporter must therefore read `WHERE seq > $cursor AND "timestamp" < now() - interval '1 minute'`.
- **Team budgets:** `usage_history (billing_team_id, "timestamp")` plus a partial index on rows awaiting team rollup.

Cost is still priced at read time from token columns and `provider_cost_usd`, which is now numeric. `call_logs` has no cost column, unchanged. There are four spend sources today: `domain_cost_history`, `request_cost_ledger`, usage plus pricing, and team rollups. Both cost tables are written from `recordCost`; merging them is a follow-up, not done here, because their semantics differ (batching, cost > 0 filter, search tier).

Dead columns dropped:
- `agentic_conversations.last_message_count` and `last_messages_hash`;
- `provider_quota_reset_events.raw_data`;
- `eval_runs.pass_rate`/`total`/`passed`/`failed` (duplicates of `summary`).

Write-only debug columns on `call_logs` (`added_wait_*`, `reasoning_duration_ms`, `reasoning_effort_upstream`) are kept, because the log exporter ships whole rows.

## Caches

Tables: `semantic_cache` (PK `signature`), `cache_metrics`, `reasoning_cache`, `ccr_blocks`, `radar_cache`, `radar_settings`, `radar_local_model_state`. The session and signature caches are covered under coordination above.
- Each expiring cache has `expires_at timestamptz` with a B-tree index for its sweep.
- `reasoning_cache` used a `typeof`/`GLOB`/`unixepoch` expression in every read, because old rows mixed epoch seconds and ISO text. That defeated its index; the transfer now normalizes once.
- The four identical singleton radar caches become `radar_cache(kind)`, and `payload` stays byte-exact `text` because it is a signed document.

## Skills, plugins, agents, evals, batches, files

Tables: `skills`, `skill_executions`, `plugins`, `a2a_tasks`, `a2a_task_events`, `eval_suites`, `eval_cases`, `eval_runs`, `files`, `batches`, `batch_item_checkpoints`, `inspector_sessions`, `inspector_session_requests`, `inspector_custom_hosts`, `agent_bridge_state`, `agent_bridge_mappings`, `agent_bridge_bypass`, `playground_presets`, `discovery_results`.

- **`_json` columns lose the suffix** (`input_json` → `input`, and so on). `rowToCamel` already exposed them without the suffix, so camel-cased output is unchanged.
- **Redundant derived columns go:** `plugins.enabled` (= `status='active'`) and `batches.expires_at` (never written).
- **Never-written columns go** in `a2a_tasks` and `inspector_custom_hosts`.
- **`agent_bridge_state` keeps all its columns.** `upsertAgentBridgeState` writes whatever fields a caller passes, and the UI reads `cert_trusted`, so `cert_trusted`, `last_started_at` and `last_error` are live API surface.
- **Batches** get indexes on the three `*_file_id` columns. The batch processor runs an OR-scan over them for every terminal batch every 10 s.
- **`files.content` stays `bytea` in the database** (owner decision; the live database is 8 MB in total).
- **`discovery_results`** uses `UNIQUE NULLS NOT DISTINCT`, so a rescan with a NULL endpoint updates instead of duplicating.

## Partitioning and retention

**Decision:** partition `call_logs`, `usage_history` and `proxy_logs` by UTC day; leave everything else unpartitioned.

| Factor | Today (tens of calls/day) | Designed capacity (tens of streaming req/s) |
|---|---|---|
| `call_logs` rows/day | ~50 | ~1M (at an average of 12 req/s) |
| Bytes/row incl. indexes (measured, see appendix) | ~730 B | ~730 B |
| Size at 30-day retention | < 2 MB | ~22 GB, plus about as much for `usage_history` and `proxy_logs` |
| Retention by `DELETE` | trivial | ~1M row deletes/day/table: index bloat, vacuum load, WAL equal to the data size |
| Retention by `DROP` of a partition | trivial | one catalog operation per day per table |

At capacity, `DELETE`-based retention is the dominant maintenance cost. Dropping partitions removes it.

The cost of partitioning, and how it is contained:
- **Primary key.** The PK must include the partition key, so it becomes `(id, "timestamp")`. Global uniqueness of `id` alone is no longer enforced. Ids are UUIDs or caller ids that are unique in practice.
- **Point updates** should pass `"timestamp"`.
- **Partition management.** The leader calls `omniroute_ensure_log_partitions(1, 14)` at startup and on every cleanup pass. The function is in 0001, so no external tool such as pg_partman is needed (it is not in the alpine image anyway).
  - It keeps 14 days of partitions ahead.
  - It uses `ATTACH PARTITION`, which takes only `SHARE UPDATE EXCLUSIVE` on the parent, so inserts into existing days continue.
  - A transaction-scoped advisory lock serializes concurrent callers. The drop function takes the same lock. Tested: two ensures for the same 11 days, one creates 11 and the other 0.
  - Before moving rows out of the default partition, the function locks it in `SHARE ROW EXCLUSIVE` mode, so an insert into the default that is still in flight commits first. Tested: the in-flight row ends up in the new partition. If the insert holds its lock past `lock_timeout`, the call fails and the next pass succeeds.
  - ATTACH briefly takes `ACCESS EXCLUSIVE` on the DEFAULT partition and scans it. Dashboard queries without a tight time bound also read the default (see Q4b and Q5a), so they can queue behind it for that moment. The function's `lock_timeout = 5s` bounds the wait, and the default partition is normally empty, so the scan is instant.
- **Default partition.** Each table has a DEFAULT partition as a safety net, because callers may supply back-dated timestamps.
  - When the ensure function later creates that day's partition, it moves the rows out first. That avoids the classic failure where a new partition conflicts with rows already in the default.
  - A non-empty default partition should raise a warning in the cleanup log.
- **Drops.** `omniroute_drop_daily_partitions_before(table, cutoff_date)` drops whole days with `lock_timeout = 2s`, so a long dashboard query cannot queue gateway inserts behind the drop's lock. On timeout the job retries next pass.
- **Rollup first.** `usage_history` is rolled up into `daily_usage_summary` and `daily_team_usage_summary` before its partitions are dropped. The existing rule (abort the delete if the rollup fails) carries over.
- **Day granularity.** Retention rounds to whole UTC days.
- **Planning.** A table holds its retention in days, plus 14 ahead, plus the default partition. At 365-day retention that is about 380 partitions.
  - Measured at 382 `usage_history` partitions with 350k rows, on the per-request per-key aggregate over 7 days:
    - with the cutoff **bound as a parameter** (what node-postgres sends), plan-time pruning leaves 8 partitions: planning 1.0–1.6 ms warm, about 25 ms on a cold connection, execution 0.4 ms;
    - with `now() - interval '7 days'` written in SQL, pruning happens only at executor start, after the planner has handled all 382 partitions: 39–51 ms warm, 266 ms cold.
  - At 47 partitions (30-day retention), the Q5a call-log list plans in 3 ms warm and 45–80 ms cold.
  - **Decision: daily partitions for all three tables, including `usage_history` at 365 days.** Weekly partitions would cut the partition count by 7 but round retention to weeks and add a second naming scheme to the helpers. With bound parameters, planning is already about 1–2 ms. The rewrite rule that makes this hold is in the mapping doc: compute cutoffs in JS and bind them, and never write `now() - interval` against the partitioned tables.

Every other append table stays unpartitioned. Their volume is per event rather than per request, or bounded:
- quota snapshots, compression analytics, audit tables, cost ledgers, relay logs, a2a events, skill executions, conversation nodes.

They keep batched `DELETE` with a BRIN or B-tree time index. Insert-only tables get BRIN, which is tiny and perfectly correlated with insert order.

Retention jobs, all run by the leader's cleanup pass:

| Table(s) | Mechanism | Status |
|---|---|---|
| `call_logs`, `proxy_logs` | partition drop by `retention.callLogs`; then delete the dropped days' artifact directories | existing setting, new mechanism |
| `call_logs_default`, `usage_history_default`, `proxy_logs_default` | DELETE `WHERE "timestamp" < cutoff` (rows older than the oldest dated partition land here and no drop reaches them; usage rows are rolled up first) | **new**; also log a warning when non-empty |
| `usage_history` | rollup, then partition drop by `retention.usageHistory` | existing setting, new mechanism |
| `quota_snapshots`, `compression_*`, `mcp_tool_audit`, `audit_log`, `a2a_task_events`, `conversation_turn_nodes` (+ orphan `agentic_conversations`), `domain_cost_history` | batched DELETE by time | existing |
| `semantic_cache`, `reasoning_cache`, `ccr_blocks`, `context_handoffs`, `session_affinities`, `gemini_thought_signatures`, `muse_session_ownership` | DELETE `WHERE expires_at <= now()` (or touched-at TTL) | existing sweeps; run on the leader only |
| `session_model_pins` | DELETE `WHERE used_at < now() - <session TTL>` (sequential scan) | **new**; SQLite never pruned session history |
| `webhook_deliveries` (100 per webhook), `job_runs`, `codex_wakeup_runs` (newest 100) | row caps in the writer | existing |
| `quota_counters` | DELETE `WHERE updated_at < now() - 35 days` (longer than the monthly window plus the previous bucket) | **new**; nothing deleted these before |
| `api_key_token_counters` | DELETE windows older than 62 days | **new** |
| `relay_rate_limits` | DELETE `window_start < now() - 2 days` | **new** |
| `exclusive_connection_leases` | DELETE terminal rows `ended_at < now() - 30 days` | **new** |
| `server_tool_executions`, `command_code_auth_sessions`, `quota_recovery_tickets` | DELETE terminal/expired rows older than 7 / 1 / 30 days | **new** |
| `request_cost_ledger`, `skill_executions`, `eval_runs` | batched DELETE older than 400 / 90 / 90 days | **new** (owner decision) |

## Indexing strategy

- **Every index answers a named query shape** from this document or the appendix.
  - The SQLite schema had 244 explicit `CREATE INDEX` statements. 0001 has 127, counting each partitioned-table index once; primary keys and UNIQUE constraints come on top in both.
  - Removed indexes were duplicates (five on `daily_usage_summary`; `idx_ak_key`, `idx_sc_sig` and `idx_cli_access_tokens_hash` duplicating UNIQUE constraints), single-column indexes on low-cardinality flags (`is_active`, `enabled`, `status` on tiny tables), or indexes no query used (`idx_crs_warmup_until`, `idx_mi_source`, the `usage_history` single-column set).
- **Hot-updated columns get no B-tree index.** These are:
  - `provider_connections.last_used_at`/`consecutive_use_count`/`updated_at`;
  - `quota_counters.updated_at` (BRIN only);
  - `session_affinities.last_used_at`/`expires_at`;
  - `session_model_pins.used_at`;
  - `muse_session_ownership.touched_at`;
  - `agentic_conversations.last_seen_at` (BRIN only);
  - the `call_logs` detail-publish columns.
  The TTL sweeps are sequential scans of bounded tables.
- **Covering index for the per-request spend check.** `usage_history (api_key_id, "timestamp") INCLUDE (provider, model, service_tier, success, provider_cost_usd, tokens_*)` makes `getApiKeyUsdSpendSince` an index-only scan (measured: Heap Fetches 0 after VACUUM; insert-only partitions are vacuumed by the insert-triggered autovacuum).
  - I chose it over a per-key running aggregate table. The aggregate would add a second write per request and a consistency problem, to save a scan that is already sub-millisecond.
- **Time columns.**
  - Insert-only tables use BRIN (`request_cost_ledger`, `domain_cost_history`, `quota_snapshots`, `server_tool_executions`, `relay_logs`, `a2a_task_events`, `skill_executions`, `conversation_turn_nodes`).
  - Tables that need ordered top-N reads use B-tree (`call_logs`, `audit_log`, `compression_analytics`). The `agentic_conversations` dashboard list sorts a small result in memory.
- **Partial indexes** cover the sparse lookups:
  - pending details;
  - correlation, response and session ids;
  - open billing intervals;
  - active leases;
  - due recovery tickets;
  - running tool claims;
  - live files.
- **Foreign keys.** Child columns of growing tables are indexed so parent deletes do not scan. On tiny config tables they are deliberately not indexed.
- **Expression indexes** on `lower(name)` and `lower(prefix)` give case-insensitive uniqueness. The database collation stays `C`, so `LIKE 'prefix%'` uses ordinary B-tree indexes.

## Removed tables

Thirty-five source tables have no successor. The full list with the readers to delete is in the mapping doc, [Domain G](postgres-schema-mapping.md#domain-g-dropped-tables). Summary:
- **Memory engine (8):** `memories`, the `memory_fts*` tables, `memory_vec_meta`, `vec_memories`. Owner decision.
- **Gamification (9):** `badge_definitions`, `community_servers`, `invite_tokens`, `leaderboard`, `token_ledger`, `user_badges`, `user_levels`, `xp_action_counts`, `xp_audit_log`. Their code was removed in df35513d, and `rg` finds only migrations and tests.
- **Never read or written (11):** `combo_adaptation_state`, `routing_decisions`, `tier_assignments`, `session_account_affinity` (the table; its namespace lives on), `plugin_metrics`, `middleware_logs`, `prompt_templates`, and the four assessment tables, whose migration function is never called.
- **Written but never read, or the reverse (4):**
  - `hourly_usage_summary`: written only by a manual backfill script, never read.
  - `plugin_analytics`: its writer has no caller.
  - `config_audit_log`: its writer has no caller; `audit_log` is the live audit table.
  - `db_meta`: a constant.
- **Rebuild and legacy leftovers:** `api_key_token_limits_new`, `call_logs_v1_legacy`.
- **`request_detail_logs`:** no writer since call-log artifacts. See open question 2.

## Conventions and operability

- **Names.**
  - snake_case tables and columns.
  - SQLite names are kept unless a rename removes a real problem: `"group"` → `group_name`, `*_json` suffixes on jsonb columns, `cursor_row_id` → `cursor_seq`, `registered_keys.key` → `key_hash`.
  - Constraints are `<table>_<column>_fk`; indexes are `<table>_<purpose>_idx`, `_uq` (unique) or `_brin`.
- **Every table has a `COMMENT ON TABLE`.** A few columns whose meaning is not obvious have column comments.
- **`updated_at` is set by the application, not by a trigger.** A generic trigger would add work to every write, including the per-request touch updates that must stay HOT. Not every SQLite-era writer set it (`providers/deletion.ts:266`, `providers/migrations.ts:55`). "Every UPDATE sets `updated_at`" is therefore a rewrite rule in the mapping doc's behaviour changes.
- **Collation C is required.** 0001 aborts unless the database collation is `C` (or `POSIX`).
  - The test template builder (`scripts/db/test-db.mjs`) already creates C databases.
  - The production compose must create the database the same way: `POSTGRES_INITDB_ARGS="--locale=C --encoding=UTF8"`, or `CREATE DATABASE ... TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`.
- **Autovacuum.** Defaults suit this workload.
  - Insert-only log partitions are frozen by the insert-triggered autovacuum (PG13+) and are dropped whole.
  - The small hot tables are tiny, so the default thresholds (50 rows + 20%) trigger often. fillfactor plus HOT keeps their bloat in-page.
  - Revisit `autovacuum_vacuum_scale_factor = 0.02` on `quota_counters` and `agentic_conversations` only if `n_dead_tup` stays high under load.
- **Backups.** `pg_dump -Fc` replaces the SQLite file copies and the `dbBackup`/`backup.*` settings. Partitions dump as normal tables under their parent.
- **Statement timeout.** The pool's 5 s `statement_timeout` applies to the partition functions too. The leader calls them in a transaction that sets `SET LOCAL statement_timeout = '60s'`. The transfer tool's bulk creation uses `'600s'`: 365 days of partitions take about 7 s. The runner already lifts the timeout for migrations.

## Open questions for the owner

All answered by the owner on 2026-11-16:

1. **Storage key and plaintext secrets.** The transfer tool runs with `STORAGE_ENCRYPTION_KEY`, so it can backfill `api_keys.key_hash`. The secrets stored in plaintext today get the same `enc:v1:` envelope as provider credentials, from the rewritten writers and from the transfer (mapping rule 12):
   - `settings.skillsmpApiKey` and `settings.cliproxyapi_api_key`;
   - `proxy_registry.password`, `version_manager.api_key`/`management_key`;
   - `webhooks.secret`, `notion.integration_token`, `sync.omniroute_sync_token`, `api_key_context_sources.token`.
2. **`request_detail_logs`.** Dropped, together with the `/api/logs/detail` route and the resolver fallback.
3. **Out-of-process SQLite readers.** The CLI commands that read SQLite (`bin/cli/settings-store.mjs`, `sqlite.mjs`, `provider-store.mjs`) and `scripts/dev/webdav-handler.mjs` are deleted. If the MITM proxy (`standaloneRouting.cjs`) is ever used, it reads `agent_bridge_mappings` from the server over HTTP.
4. **Retention.** `request_cost_ledger` 400 days, `skill_executions` 90 days, `eval_runs` 90 days.
5. **Combo name collisions.** The transfer renames case-only duplicates to `<name>-dup-<n>` and reports them. Accepted.
6. **`files.content`.** Stays `bytea` in Postgres (the live database is 8 MB in total).

## Sources

- PostgreSQL 18 docs, [Table Partitioning](https://www.postgresql.org/docs/18/ddl-partitioning.html): unique constraints must include the partition key, default partition behaviour, and ATTACH vs CREATE ... PARTITION OF.
- PostgreSQL 18 docs, [ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html): ATTACH PARTITION takes SHARE UPDATE EXCLUSIVE on the parent.
- PostgreSQL 18 docs, [CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html): fillfactor, `UNIQUE NULLS NOT DISTINCT`, identity columns.
- PostgreSQL 18 docs, [Heap-Only Tuples](https://www.postgresql.org/docs/18/storage-hot.html), and the [PostgreSQL 16 release notes](https://www.postgresql.org/docs/release/16.0/): HOT is allowed when only BRIN-indexed (summarizing) columns change. Confirmed by measurement in the appendix.
- [PostgreSQL 17 release notes](https://www.postgresql.org/docs/release/17.0/): identity columns on partitioned tables. Confirmed by measurement: `seq` is assigned in the parent's sequence across partitions and survives ATTACH.
- PostgreSQL 18 docs, [BRIN Indexes](https://www.postgresql.org/docs/18/brin.html), [UUID Functions](https://www.postgresql.org/docs/18/functions-uuid.html) (`gen_random_uuid()` in core), and [Routine Vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html) (insert-triggered autovacuum).
- PostgreSQL 18 docs, [Operator Classes and Collations](https://www.postgresql.org/docs/18/indexes-opclass.html): in the C locale, ordinary B-tree indexes support `LIKE 'prefix%'`.
- Repository evidence: `_artifacts/inventory.md` (file to table map), `src/lib/db/backends/postgres/sqlite-schema-snapshot.sql`, and the per-domain code reads summarized in the mapping doc.

## Appendix: query plans

**Environment:**
- Postgres 18.7 (`postgres:18-alpine`), database collation C.
- Schema applied through `runPostgresMigrations` + `createPostgresBackend(createPgPool(url, { instanceId: "architect" }))`.

**Synthetic data:**
- 400 connections, 5,000 API keys, 300 combos.
- 210,000 `call_logs` and 210,000 `usage_history` rows spread over 30 daily partitions (7,200 rows/day).
- 60,000 `quota_counters`, 20,000 `session_affinities`, 60,000 `quota_snapshots`, 370 `config_entries`.
- `ANALYZE` was run after loading.

Scripts: `_artifacts/pg-init/apply-init.mts`, `explain.sql`, `hot.sql` (gitignored). The scratch database was dropped afterwards.

| # | Pattern | SQL shape | Plan | Index used |
|---|---|---|---|---|
| 1 | API key lookup by hash | `WHERE key_hash = $1` | Index Scan `api_keys_key_hash_key`, 3 buffers | yes |
| 2 | Connections for routing | `WHERE provider=$1 AND is_active ORDER BY priority, updated_at DESC` | Seq Scan + sort on 400 rows (10 buffers). With `enable_seqscan=off`: Bitmap Index Scan `provider_connections_routing_idx`. The planner rightly prefers the seq scan at this size. | available; chosen as the table grows |
| 3 | Combo by name | `WHERE lower(name) = lower($1)` | Index Scan `combos_name_ci_uq` | yes |
| 4a | Usage analytics, 7-day window grouped by day/provider/model | `WHERE "timestamp" BETWEEN ... GROUP BY 1,2,3` | Append over 8 partitions, **39 pruned**; full-day partitions seq-scanned (each is 100% in range), the boundary day by `usage_history_*_timestamp_idx`; HashAggregate | partition pruning + index on the boundary partition |
| 4b | Usage for one API key over 30 days | `WHERE api_key_id=$1 AND "timestamp" >= ...` | Index Scan `(api_key_id, "timestamp")` in each in-range partition; future empty partitions show as zero-cost scans. Add `AND "timestamp" <= now()` to prune them. | yes |
| 5a | Call-log list: provider filter, last 24 h, page 1 | `... LEFT JOIN provider_nodes, provider_connections ... ORDER BY "timestamp" DESC LIMIT 200` | Merge Append, **30 partitions pruned**, `call_logs_*_timestamp_idx` per partition; Memoize + PK lookups for the connection join. Planning 3 ms warm (45–80 ms on a cold connection), execution 1.2–1.7 ms. | yes |
| 5b | Call-log keyset page | `WHERE "timestamp" < $cursor ORDER BY "timestamp" DESC LIMIT 200` | Merge Append of per-partition index scans, 17 pruned, stops after 200 rows | yes |
| 5c | Detail publish (per request) | `UPDATE call_logs ... WHERE id=$1 AND "timestamp"=$2 AND detail_state='pending'` | **46 of 47 partitions pruned**; single-partition index scan. After the review fixes the planner uses the `"timestamp"` index plus an `id` filter, which is equally selective. The update is HOT (see below). | yes |
| 6a | Quota counter upsert (per request) | `INSERT ... ON CONFLICT (api_key_id, dimension_key, bucket_index) DO UPDATE SET consumed = consumed + excluded.consumed` | Conflict arbiter `quota_counters_pkey` | yes |
| 6b | Pool dimension sum (per request) | `SUM(consumed) WHERE dimension_key=$1 AND bucket_index=$2` | Bitmap Index Scan `quota_counters_dimension_idx`, 25 buffers | yes |
| 7 | Session affinity lookup (per request) | `WHERE provider=$1 AND session_hash=$2` | Index Scan `session_affinities_pkey`, 4 buffers | yes |
| 8 | Cooldown update | `UPDATE provider_connections SET rate_limited_until=..., backoff_level=backoff_level+1, ... WHERE id=$1` | Index Scan `provider_connections_pkey` | yes |
| 9 | Settings read | `WHERE namespace='settings'` | Seq Scan of 370 rows (4 buffers). With `enable_seqscan=off`: Bitmap Index Scan `config_entries_pkey`. | available; seq scan is cheaper at this size |
| 10a | Retention on an unpartitioned log | `DELETE FROM quota_snapshots WHERE created_at < now() - '30 days'` | Bitmap Index Scan `quota_snapshots_created_brin` | yes (BRIN) |
| 10b | Retention on partitioned logs | `SELECT omniroute_drop_daily_partitions_before('call_logs', current_date - 20)` | 47 → 36 partitions; 11 dropped as catalog operations, no row deletes | n/a |

**HOT verification.** 2,000 autocommit touch updates each were made, the way requests arrive:
- `provider_connections` (`last_used_at`, `consecutive_use_count`, `updated_at`);
- `quota_counters` (`consumed` and the BRIN-indexed `updated_at`);
- `session_affinities` (`last_used_at`, `expires_at`).

The result was `n_tup_hot_upd = n_tup_upd = 2000` on all three, **100% HOT**.

The same loop run inside a single `DO` block got only 22–56% HOT. Within one transaction the dead versions cannot be pruned, so free page space runs out. Production writes are separate transactions.

**Review re-measurements** (fresh scratch database, final `0001_init.sql`):
- **Detail-publish HOT on `call_logs`.** 2,000 pending rows were published with 2,000 autocommit `UPDATE ... SET detail_state='ready', detail_pending_until=NULL, artifact_size_bytes, artifact_sha256 WHERE id AND "timestamp"`. Result: `n_tup_hot_upd = n_tup_upd = 2000` (100%) on the day partition (fillfactor 85, `artifact_relpath` written at insert).
- **Per-request spend aggregate** (`getApiKeyUsdSpendSince` shape, 7-day window, bound parameters, after `VACUUM`): Index Only Scan on `usage_history_*_api_key_id_timestamp_...` with **Heap Fetches: 0**; planning 7 ms on a cold connection, execution 0.4 ms.
- **Planning at 382 daily partitions:** covered under Planning in [Partitioning and retention](#partitioning-and-retention).
- **Partition helper races:**
  - two concurrent ensures for the same 11 days: 11 created and 0 created, no error;
  - an open insert into the default for a new day: the ensure waits, then the row lands in the new partition;
  - an insert held past `lock_timeout`: the ensure fails with "lock timeout", and the retry succeeds and moves the row.
- **Collation guard:** applying 0001 to an `en_US.utf8` database aborts with "OmniRoute requires a database with LC_COLLATE 'C'"; on a C database it applies through `runPostgresMigrations`.

**Storage.** One day of `call_logs` with 7,200 rows takes 5.3 MB including its indexes, about 730 bytes per row. These figures predate the review; it dropped two indexes and added fillfactor 85. That is the basis for the capacity estimate in [Partitioning and retention](#partitioning-and-retention).
