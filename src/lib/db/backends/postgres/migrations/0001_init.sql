-- OmniRoute PostgreSQL 18 schema (migration pg-0001, "init").
--
-- Designed fresh for PostgreSQL; it is NOT a translation of the SQLite migrations.
-- Design notes:      docs/architecture/postgres-schema.md
-- Table/column map:  docs/architecture/postgres-schema-mapping.md (SQLite -> Postgres, transfer rules)
--
-- Conventions (details in the design doc):
--   * snake_case names; tables keep their SQLite names unless the mapping doc lists a rename.
--   * Timestamps are timestamptz (UTC instants). Calendar days are `date`. Durations and window
--     ordinals stay integer/bigint.
--   * Booleans are boolean. JSON is jsonb, except verbatim payloads whose bytes matter
--     (signed radar payloads, cached HTTP responses, truncated snapshots), which stay text.
--   * Credentials stay app-encrypted text (`enc:v1:` envelopes from src/lib/db/encryption.ts).
--   * Money is numeric(20,10) USD. Scores and percentages are double precision.
--   * Ids keep their app-generated text form when other tables or JSON documents reference them
--     as text (api keys, connections, combos, nodes, pools, teams). Leaf tables whose ids are
--     always crypto.randomUUID() use uuid. Surrogate keys are bigint identities.
--   * Foreign keys connect configuration to configuration. Logs, ledgers and caches carry
--     no FK to api_keys / provider_connections: history must outlive its parents and several
--     writers use synthetic owner ids ('system', 'env-key', '__anon__', ...).
--   * updated_at is maintained by the application (no triggers): hot "touch" writes must stay
--     HOT-eligible. Every UPDATE must set it explicitly (a rewrite rule; a few SQLite-era writers
--     did not, e.g. providers/deletion.ts reorderConnections, providers/migrations.ts).
--   * call_logs, usage_history and proxy_logs are range-partitioned by day on "timestamp".
--     The leader creates partitions ahead and drops expired ones with the two functions below.
--
-- Order: collation guard, functions, tables, constraints (foreign keys), indexes, comments,
-- seed rows, initial partitions. No triggers. Not idempotent: the runner applies it exactly once.

-- ============================================================================================
-- 0. Guard: the schema relies on the C collation (byte-order text comparison, B-tree indexes
--    serving LIKE 'prefix%', locale-independent ORDER BY). Create the database with
--    LC_COLLATE 'C' LC_CTYPE 'C' (TEMPLATE template0).
-- ============================================================================================

DO $$
BEGIN
  IF (SELECT datcollate FROM pg_database WHERE datname = current_database()) NOT IN ('C', 'POSIX') THEN
    RAISE EXCEPTION 'OmniRoute requires a database with LC_COLLATE ''C''; current database % uses %',
      current_database(), (SELECT datcollate FROM pg_database WHERE datname = current_database());
  END IF;
END
$$;

-- ============================================================================================
-- 1. Functions
-- ============================================================================================

-- Creates the missing daily partitions [p_from, p_to] of one log table. Rows that already sit
-- in the table's DEFAULT partition for a day being created are moved into the new partition,
-- so a late or back-dated insert never blocks partition creation. Uses ATTACH (SHARE UPDATE
-- EXCLUSIVE on the parent) instead of CREATE ... PARTITION OF (ACCESS EXCLUSIVE), so gateway
-- inserts into existing days keep flowing. Returns the number of partitions created.
-- Concurrency: a transaction-scoped advisory lock serializes concurrent callers (two leaders
-- during failover, startup + cleanup pass), and the DEFAULT partition is locked in SHARE ROW
-- EXCLUSIVE mode before rows move out of it, so an in-flight insert into the default for the
-- day being created commits first (or the call hits lock_timeout and is retried later).
-- call_logs/proxy_logs partitions get fillfactor 85: every row is updated once shortly after
-- insert (detail publish, attempt timing) and the update must find room for a HOT tuple.
CREATE FUNCTION omniroute_ensure_daily_partitions(p_parent text, p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_day date;
  v_part text;
  v_default text := p_parent || '_default';
  v_fillfactor integer := CASE WHEN p_parent = 'usage_history' THEN 100 ELSE 85 END;
  v_default_locked boolean := false;
  v_lo timestamptz;
  v_hi timestamptz;
  v_created integer := 0;
BEGIN
  IF p_parent NOT IN ('call_logs', 'usage_history', 'proxy_logs') THEN
    RAISE EXCEPTION 'omniroute_ensure_daily_partitions: % is not a partitioned log table', p_parent;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('omniroute_ensure_partitions'));
  PERFORM set_config('lock_timeout', '5s', true);
  FOR v_day IN SELECT generate_series(p_from, p_to, interval '1 day')::date LOOP
    v_part := format('%s_p%s', p_parent, to_char(v_day, 'YYYYMMDD'));
    CONTINUE WHEN to_regclass(v_part) IS NOT NULL;
    v_lo := v_day::timestamp AT TIME ZONE 'UTC';
    v_hi := (v_day + 1)::timestamp AT TIME ZONE 'UTC';
    IF NOT v_default_locked THEN
      EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE', v_default);
      v_default_locked := true;
    END IF;
    EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE) WITH (fillfactor = %s)',
                   v_part, p_parent, v_fillfactor);
    EXECUTE format(
      'WITH moved AS (DELETE FROM %I WHERE "timestamp" >= $1 AND "timestamp" < $2 RETURNING *) '
      'INSERT INTO %I SELECT * FROM moved', v_default, v_part)
      USING v_lo, v_hi;
    EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
                   p_parent, v_part, v_lo, v_hi);
    v_created := v_created + 1;
  END LOOP;
  RETURN v_created;
END;
$$;

-- Drops every daily partition of one log table whose whole day lies before p_before
-- (upper bound <= p_before). Dropping a partition needs a brief ACCESS EXCLUSIVE lock on the
-- parent: lock_timeout keeps a long dashboard query from queueing gateway inserts behind it;
-- on timeout the caller (leader cleanup job) logs and retries on its next pass.
-- Returns the number of partitions dropped.
CREATE FUNCTION omniroute_drop_daily_partitions_before(p_parent text, p_before date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_part record;
  v_dropped integer := 0;
BEGIN
  IF p_parent NOT IN ('call_logs', 'usage_history', 'proxy_logs') THEN
    RAISE EXCEPTION 'omniroute_drop_daily_partitions_before: % is not a partitioned log table', p_parent;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('omniroute_ensure_partitions'));
  PERFORM set_config('lock_timeout', '2s', true);
  FOR v_part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = p_parent::regclass
      AND c.relname ~ ('^' || p_parent || '_p[0-9]{8}$')
      AND to_date(right(c.relname, 8), 'YYYYMMDD') + 1 <= p_before
    ORDER BY c.relname
  LOOP
    EXECUTE format('DROP TABLE %I', v_part.relname);
    v_dropped := v_dropped + 1;
  END LOOP;
  RETURN v_dropped;
END;
$$;

-- Convenience wrapper for the leader: makes sure all three log tables have partitions from
-- p_days_back days ago to p_days_ahead days ahead (UTC). Called at leader startup and by the
-- cleanup job; cheap when nothing is missing.
CREATE FUNCTION omniroute_ensure_log_partitions(p_days_back integer DEFAULT 1, p_days_ahead integer DEFAULT 14)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_total integer := 0;
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['call_logs', 'usage_history', 'proxy_logs'] LOOP
    v_total := v_total + omniroute_ensure_daily_partitions(v_table, v_today - p_days_back, v_today + p_days_ahead);
  END LOOP;
  RETURN v_total;
END;
$$;

-- ============================================================================================
-- 2. Tables
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- 2.1 Control plane: providers, connections, API keys, teams, combos, routing rules
-- --------------------------------------------------------------------------------------------

CREATE TABLE provider_nodes (
  id                          text PRIMARY KEY,
  type                        text NOT NULL CHECK (type IN ('openai-compatible', 'anthropic-compatible')),
  name                        text NOT NULL,
  prefix                      text CHECK (prefix IS NULL OR btrim(prefix) <> ''),
  api_type                    text CHECK (api_type IN ('chat', 'responses', 'embeddings', 'audio-transcriptions',
                                                       'audio-speech', 'images-generations')),
  base_url                    text,
  chat_path                   text,
  models_path                 text,
  icon_url                    text,
  custom_headers              jsonb,
  daily_quota_reset_timezone  text,
  daily_quota_reset_hour      smallint CHECK (daily_quota_reset_hour BETWEEN 0 AND 23),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Hot-updated on every request by touchConnectionLastUsed (last_used_at, consecutive_use_count,
-- updated_at): none of those columns is indexed, and fillfactor leaves room for HOT updates.
CREATE TABLE provider_connections (
  id                            text PRIMARY KEY,
  provider                      text NOT NULL,
  auth_type                     text,
  name                          text,
  email                         text,
  display_name                  text,
  group_name                    text,
  priority                      integer NOT NULL DEFAULT 0,
  global_priority               integer,
  is_active                     boolean NOT NULL DEFAULT true,
  -- credentials: enc:v1 envelopes (plaintext only when STORAGE_ENCRYPTION_KEY is unset)
  api_key                       text,
  access_token                  text,
  refresh_token                 text,
  id_token                      text,
  expires_at                    timestamptz,
  token_expires_at              timestamptz,
  expires_in                    integer,
  token_type                    text,
  scope                         text,
  project_id                    text,
  provider_specific_data        jsonb,
  default_model                 text,
  -- health / error state
  test_status                   text,
  error_code                    text,
  last_error                    text,
  last_error_at                 timestamptz,
  last_error_type               text,
  last_error_source             text,
  backoff_level                 integer NOT NULL DEFAULT 0,
  rate_limited_until            timestamptz,
  health_check_interval         integer,
  last_health_check_at          timestamptz,
  last_tested                   timestamptz,
  last_ping_at                  timestamptz,
  last_pinged_reset_key         text,
  -- selection statistics (hot)
  last_used_at                  timestamptz,
  consecutive_use_count         integer NOT NULL DEFAULT 0,
  -- limits and routing options
  max_concurrent                integer CHECK (max_concurrent IS NULL OR max_concurrent >= 0),
  rate_limit_protection         boolean NOT NULL DEFAULT false,
  rate_limit_overrides          jsonb,
  quota_window_thresholds       jsonb,
  proxy_enabled                 boolean NOT NULL DEFAULT true,
  per_key_proxy_enabled         boolean NOT NULL DEFAULT false,
  quota_visible                 boolean NOT NULL DEFAULT true,
  synced_models_at              timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);

CREATE TABLE api_keys (
  id                          text PRIMARY KEY,
  name                        text NOT NULL,
  -- the raw secret, app-encrypted (enc:v1, randomized): never compared, never unique
  key                         text NOT NULL,
  -- sha256 hex of the raw secret: the only auth lookup column
  key_hash                    text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix                  text,
  machine_id                  text,
  source                      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sso')),
  is_active                   boolean NOT NULL DEFAULT true,
  is_banned                   boolean NOT NULL DEFAULT false,
  revoked_at                  timestamptz,
  expires_at                  timestamptz,
  last_used_at                timestamptz,
  -- access policy (JSON arrays of strings unless noted)
  model_access_mode           text NOT NULL DEFAULT 'all' CHECK (model_access_mode IN ('all', 'restricted')),
  allowed_models              jsonb,
  blocked_models              jsonb,
  allowed_combos              jsonb,           -- NULL = allow all, [] = deny all (combo names)
  allowed_connections         jsonb,
  preferred_connections       jsonb,
  allowed_quotas              jsonb NOT NULL DEFAULT '[]',
  allowed_endpoints           jsonb,
  scopes                      jsonb,
  ip_allowlist                jsonb,
  access_schedule             jsonb,           -- {enabled, from, until, days[], tz}
  rate_limits                 jsonb,           -- [{limit, window}]
  catalog_scope               text NOT NULL DEFAULT 'all' CHECK (catalog_scope IN ('all', 'combos', 'models')),
  forced_model                text,
  proxy_id                    text,
  disable_non_public_models   boolean NOT NULL DEFAULT false,
  allow_usage_command         boolean NOT NULL DEFAULT false,
  allow_auto_combos           boolean NOT NULL DEFAULT true,
  allow_cc_discovery_aliases  boolean NOT NULL DEFAULT true,
  auto_resolve                boolean NOT NULL DEFAULT false,
  -- behaviour
  no_log                      boolean NOT NULL DEFAULT false,
  compression_enabled         boolean NOT NULL DEFAULT true,
  chaos_mode_enabled          boolean NOT NULL DEFAULT false,
  stream_default_mode         text NOT NULL DEFAULT 'legacy' CHECK (stream_default_mode IN ('legacy', 'json')),
  cache_default_mode          text NOT NULL DEFAULT 'legacy' CHECK (cache_default_mode IN ('legacy', 'bypass')),
  codex_service_mode          text NOT NULL DEFAULT 'inherit'
                              CHECK (codex_service_mode IN ('inherit', 'default', 'priority', 'flex')),
  -- limits (NULL = unlimited)
  throttle_delay_ms           integer CHECK (throttle_delay_ms IS NULL OR throttle_delay_ms >= 0),
  max_requests_per_day        integer CHECK (max_requests_per_day IS NULL OR max_requests_per_day >= 0),
  max_requests_per_minute     integer CHECK (max_requests_per_minute IS NULL OR max_requests_per_minute >= 0),
  max_sessions                integer NOT NULL DEFAULT 0 CHECK (max_sessions >= 0),   -- 0 = unlimited
  usage_limit_enabled         boolean NOT NULL DEFAULT false,
  daily_usage_limit_usd       numeric(20,10) CHECK (daily_usage_limit_usd IS NULL OR daily_usage_limit_usd > 0),
  weekly_usage_limit_usd      numeric(20,10) CHECK (weekly_usage_limit_usd IS NULL OR weekly_usage_limit_usd > 0),
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_key_context_sources (
  api_key_id   text NOT NULL,
  source_type  text NOT NULL,
  token        text,
  base_url     text,
  vault_path   text,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, source_type)
);

CREATE TABLE teams (
  id               text PRIMARY KEY,
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  max_budget_usd   numeric(20,10) CHECK (max_budget_usd IS NULL OR max_budget_usd > 0),
  budget_duration  text CHECK (budget_duration IS NULL OR budget_duration IN ('1d', '7d', '30d')),
  budget_reset_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  CHECK (
    (max_budget_usd IS NULL AND budget_duration IS NULL AND budget_reset_at IS NULL)
    OR (max_budget_usd IS NOT NULL AND budget_duration IS NOT NULL AND budget_reset_at IS NOT NULL)
  )
);

CREATE TABLE api_key_billing_team_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id  text NOT NULL,
  team_id     text NOT NULL,
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE key_groups (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE key_group_members (
  key_id      text NOT NULL,
  group_id    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, group_id)
);

CREATE TABLE group_model_permissions (
  id             text PRIMARY KEY,
  group_id       text NOT NULL,
  model_pattern  text NOT NULL,                 -- exact id or glob with '*'
  provider       text,                          -- NULL = any provider
  access_type    text NOT NULL DEFAULT 'allow' CHECK (access_type IN ('allow', 'deny')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sso_identities (
  oid           text PRIMARY KEY,               -- Entra object id
  tenant_id     text NOT NULL,
  upn           text,
  display_name  text,
  api_key_id    text NOT NULL,
  last_groups   jsonb NOT NULL DEFAULT '[]',    -- key_groups ids resolved on the last auth
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE combos (
  id                        text PRIMARY KEY,
  name                      text NOT NULL,
  data                      jsonb NOT NULL,     -- full normalized combo record (steps, strategy, config)
  sort_order                integer NOT NULL DEFAULT 0,
  context_cache_protection  boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- the charset is validated in zod; system-built names (quota combos 'qtSd/<slug>/<provider>/<model>')
  -- contain ':', '@', '+' and can exceed 100 chars
  CHECK (length(btrim(name)) BETWEEN 1 AND 300)
);

CREATE TABLE model_combo_mappings (
  id           text PRIMARY KEY,
  pattern      text NOT NULL,                   -- glob, e.g. 'claude-*-opus*'
  combo_id     text NOT NULL,
  priority     integer NOT NULL DEFAULT 0,      -- higher is checked first
  enabled      boolean NOT NULL DEFAULT true,
  description  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reasoning_routing_rules (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  scope            text NOT NULL CHECK (scope IN ('global', 'apiKey', 'combo', 'model', 'connection')),
  api_key_id       text,
  combo_id         text,
  connection_id    text,
  model_pattern    text,
  source_effort    text NOT NULL DEFAULT 'any'
                   CHECK (source_effort IN ('any', 'missing', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')),
  request_tags     jsonb NOT NULL DEFAULT '[]',
  tag_match_mode   text NOT NULL DEFAULT 'any' CHECK (tag_match_mode IN ('any', 'all')),
  effort_mode      text NOT NULL DEFAULT 'inherit' CHECK (effort_mode IN ('inherit', 'default', 'force')),
  target_effort    text CHECK (target_effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')),
  target_kind      text NOT NULL DEFAULT 'keep' CHECK (target_kind IN ('keep', 'model', 'combo')),
  target_model     text,
  target_combo_id  text,
  budget_action    text NOT NULL DEFAULT 'preserve' CHECK (budget_action IN ('preserve', 'remove', 'set')),
  budget_tokens    integer,
  priority         integer NOT NULL DEFAULT 0,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (scope <> 'apiKey' OR api_key_id IS NOT NULL),
  CHECK (scope <> 'combo' OR combo_id IS NOT NULL),
  CHECK (scope <> 'model' OR model_pattern IS NOT NULL),
  CHECK (scope <> 'connection' OR connection_id IS NOT NULL),
  CHECK (target_kind <> 'model' OR target_model IS NOT NULL),
  CHECK (target_kind <> 'combo' OR target_combo_id IS NOT NULL),
  CHECK (effort_mode = 'inherit' OR target_effort IS NOT NULL),
  CHECK (budget_action <> 'set' OR budget_tokens > 0),
  CHECK (NOT (target_effort = 'none' AND budget_action = 'set'))
);

CREATE TABLE auto_candidate_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id     text NOT NULL,
  auto_channel   text NOT NULL,                 -- request model string: 'auto', 'auto/<variant>'
  connection_id  text NOT NULL,
  excluded       boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, auto_channel, connection_id)
);

-- Externally issued "ork_" keys (admin API). Not on the gateway path.
CREATE TABLE registered_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash         text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix       text NOT NULL,
  name             text NOT NULL,
  provider         text,                        -- NULL = not bound to a provider
  account_id       text,                        -- NULL = not bound to an account
  is_active        boolean NOT NULL DEFAULT true,
  revoked_at       timestamptz,
  expires_at       timestamptz,
  idempotency_key  text UNIQUE,
  daily_budget     integer CHECK (daily_budget IS NULL OR daily_budget >= 0),
  hourly_budget    integer CHECK (hourly_budget IS NULL OR hourly_budget >= 0),
  daily_used       integer NOT NULL DEFAULT 0,
  hourly_used      integer NOT NULL DEFAULT 0,
  last_reset_day   date,
  last_reset_hour  timestamptz,                 -- start of the UTC hour of the last reset
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Issuance limits for registered_keys, per provider and per account (one table, two scopes).
CREATE TABLE registered_key_limits (
  scope               text NOT NULL CHECK (scope IN ('provider', 'account')),
  scope_id            text NOT NULL,
  max_active_keys     integer CHECK (max_active_keys IS NULL OR max_active_keys >= 0),
  daily_issue_limit   integer CHECK (daily_issue_limit IS NULL OR daily_issue_limit >= 0),
  hourly_issue_limit  integer CHECK (hourly_issue_limit IS NULL OR hourly_issue_limit >= 0),
  daily_issued        integer NOT NULL DEFAULT 0,
  hourly_issued       integer NOT NULL DEFAULT 0,
  last_reset_day      date,
  last_reset_hour     timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_id)
);

CREATE TABLE sync_tokens (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  sync_api_key_id  text,
  issued_by        text,
  revoked_at       timestamptz,
  expires_at       timestamptz,
  last_used_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cli_access_tokens (
  id            text PRIMARY KEY,               -- 'tok_<uuid>'
  token_hash    text NOT NULL UNIQUE,
  token_prefix  text NOT NULL,
  name          text NOT NULL,
  scope         text NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'write', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);

-- --------------------------------------------------------------------------------------------
-- 2.2 Control plane: proxies, upstream tools, integrations
-- --------------------------------------------------------------------------------------------

CREATE TABLE proxy_subscriptions (
  id                                text PRIMARY KEY,
  name                              text NOT NULL,
  url                               text NOT NULL,
  mirror_urls                       text,         -- encodeMirrorUrls() output
  enabled                           boolean NOT NULL DEFAULT false,
  mode                              text NOT NULL DEFAULT 'global' CHECK (mode IN ('global', 'rule')),
  rule_providers                    jsonb,
  local_core_endpoint               text,
  core_config_path                  text,
  core_binary_path                  text,
  control_url                       text,
  control_secret_enc                text,         -- enc:v1
  update_interval_minutes           integer NOT NULL DEFAULT 60 CHECK (update_interval_minutes > 0),
  status                            text NOT NULL DEFAULT 'empty' CHECK (status IN ('ok', 'error', 'empty')),
  error                             text,
  last_nodes                        jsonb,
  last_fetched_at                   timestamptz,
  last_error_at                     timestamptz,
  consecutive_failures              integer NOT NULL DEFAULT 0,
  selector_min_gap_seconds          integer NOT NULL DEFAULT 60,
  selector_last_switch_at           timestamptz,
  selector_last_switch_result       text,
  selector_last_switch_member       text,
  selector_last_switch_kind         text,
  selector_last_switch_by_selector  jsonb,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE proxy_registry (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('http', 'https', 'socks4', 'socks5', 'vercel', 'deno', 'cloudflare')),
  host             text NOT NULL,
  port             integer NOT NULL CHECK (port BETWEEN 0 AND 65535),
  username         text,
  password         text,
  region           text,
  notes            text,           -- relay types hold JSON {relayAuth?, relayAuthEnc?}; free text otherwise
  status           text NOT NULL DEFAULT 'active',
  source           text NOT NULL DEFAULT 'manual',
  family           text NOT NULL DEFAULT 'auto' CHECK (family IN ('auto', 'ipv4', 'ipv6')),
  subscription_id  text,
  quality_score    integer,
  latency_ms       integer,
  anonymity        text,
  google_access    boolean NOT NULL DEFAULT false,
  country_code     text,
  last_validated   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- scope_id meaning per scope: global -> '__global__', provider -> provider id,
-- account -> provider_connections.id, combo -> combos.id.
CREATE TABLE proxy_assignments (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  proxy_id    text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('global', 'provider', 'account', 'combo')),
  scope_id    text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, scope_id, proxy_id),
  CHECK ((scope = 'global') = (scope_id = '__global__'))
);

-- Rotation cursor per scope: written on every round-robin advance (hot, HOT-eligible).
CREATE TABLE proxy_scope_rotation (
  scope                  text NOT NULL CHECK (scope IN ('global', 'provider', 'account', 'combo')),
  scope_id               text NOT NULL,
  strategy               text NOT NULL DEFAULT 'round-robin'
                         CHECK (strategy IN ('round-robin', 'random', 'sticky', 'latency')),
  cursor                 integer NOT NULL DEFAULT 0,
  sticky_window_minutes  integer NOT NULL DEFAULT 30,
  rotated_at             timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_id)
) WITH (fillfactor = 70);

CREATE TABLE free_proxies (
  id              text PRIMARY KEY,
  source          text NOT NULL,                -- '1proxy' | 'proxifly' | 'iplocate'
  host            text NOT NULL,
  port            integer NOT NULL CHECK (port BETWEEN 0 AND 65535),
  type            text NOT NULL DEFAULT 'http',
  country_code    text,
  quality_score   integer,
  latency_ms      integer,
  anonymity       text,
  last_validated  timestamptz,
  pool_proxy_id   text,                         -- set when promoted to proxy_registry ("in pool")
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, host, port)
);

CREATE TABLE free_proxy_sync_errors (
  source      text PRIMARY KEY,
  errors      jsonb NOT NULL,                   -- string[]
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE proxy_operator_egress (
  host         text NOT NULL,                   -- normalized: trimmed, unbracketed, lowercase
  port         integer NOT NULL,
  address      text NOT NULL,
  observed_at  timestamptz NOT NULL,
  PRIMARY KEY (host, port, address)
);

CREATE TABLE upstream_proxy_config (
  provider_id                text PRIMARY KEY,
  mode                       text NOT NULL DEFAULT 'native' CHECK (mode IN ('native', 'cliproxyapi', 'dario', 'fallback')),
  cliproxyapi_model_mapping  jsonb,
  native_priority            integer NOT NULL DEFAULT 1,
  cliproxyapi_priority       integer NOT NULL DEFAULT 2,
  enabled                    boolean NOT NULL DEFAULT true,
  family                     text NOT NULL DEFAULT 'auto' CHECK (family IN ('auto', 'ipv4', 'ipv6')),
  fallback_backend           text NOT NULL DEFAULT 'cliproxyapi' CHECK (fallback_backend IN ('cliproxyapi', 'dario')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE version_manager (
  tool                  text PRIMARY KEY,       -- 'cliproxyapi' | 'omniroute' | ...
  current_version       text,
  installed_version     text,
  pinned_version        text,
  binary_path           text,
  logs_buffer_path      text,
  status                text NOT NULL DEFAULT 'not_installed'
                        CHECK (status IN ('not_installed', 'installed', 'running', 'stopped', 'error')),
  pid                   integer,
  port                  integer DEFAULT 8317,
  api_key               text,
  management_key        text,
  auto_update           boolean NOT NULL DEFAULT true,
  auto_start            boolean NOT NULL DEFAULT false,
  auto_restart_adopted  boolean NOT NULL DEFAULT false,
  provider_expose       boolean NOT NULL DEFAULT false,
  health_status         text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'unhealthy', 'timeout')),
  last_health_check     timestamptz,
  last_update_check     timestamptz,
  last_sync_at          timestamptz,
  config_overrides      jsonb,
  error_message         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cloud_agent_credentials (
  provider_id        text PRIMARY KEY CHECK (provider_id IN ('jules', 'devin', 'codex-cloud', 'cursor-cloud')),
  api_key_encrypted  text NOT NULL,
  base_url           text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cloud_agent_tasks (
  id            text PRIMARY KEY,               -- 'task_<ms>_<hex>'
  provider_id   text NOT NULL CHECK (provider_id IN ('jules', 'devin', 'codex-cloud', 'cursor-cloud')),
  external_id   text,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  prompt        text NOT NULL,
  source        jsonb NOT NULL,                 -- {repoName, repoUrl, branch?}
  options       jsonb NOT NULL DEFAULT '{}',
  result        jsonb,
  activities    jsonb NOT NULL DEFAULT '[]',
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE TABLE webhooks (
  id                  text PRIMARY KEY,
  url                 text NOT NULL,
  kind                text NOT NULL DEFAULT 'custom' CHECK (kind IN ('slack', 'telegram', 'discord', 'custom')),
  events              jsonb NOT NULL DEFAULT '["*"]',
  secret              text,
  metadata_encrypted  text,                     -- caller-supplied envelope
  enabled             boolean NOT NULL DEFAULT true,
  description         text NOT NULL DEFAULT '',
  last_triggered_at   timestamptz,
  last_status         integer,
  failure_count       integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE log_export_destinations (
  id                text PRIMARY KEY,
  name              text NOT NULL,
  type              text NOT NULL,
  enabled           boolean NOT NULL DEFAULT false,
  config            jsonb NOT NULL DEFAULT '{}',
  batch_size        integer NOT NULL DEFAULT 500 CHECK (batch_size > 0),
  include_bodies    boolean NOT NULL DEFAULT false,
  max_body_bytes    integer NOT NULL DEFAULT 262144,
  max_rows_per_run  integer NOT NULL DEFAULT 10000,
  cursor_seq        bigint NOT NULL DEFAULT 0,  -- last exported call_logs.seq
  exported_total    bigint NOT NULL DEFAULT 0,
  last_run_at       timestamptz,
  last_status       text CHECK (last_status IS NULL OR last_status IN ('success', 'failure')),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE middleware_hooks (
  name         text PRIMARY KEY,
  description  text NOT NULL DEFAULT '',
  priority     integer NOT NULL DEFAULT 200,
  scope_type   text NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'combo')),
  combo_id     text,
  enabled      boolean NOT NULL DEFAULT true,
  code         text NOT NULL DEFAULT '',
  run_count    bigint NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compression_combos (
  id                     text PRIMARY KEY,
  name                   text NOT NULL,
  description            text NOT NULL DEFAULT '',
  pipeline               jsonb NOT NULL DEFAULT '[]',
  language_packs         jsonb NOT NULL DEFAULT '["en"]',
  output_mode            boolean NOT NULL DEFAULT false,
  output_mode_intensity  text NOT NULL DEFAULT 'full',
  output_styles          jsonb NOT NULL DEFAULT '[]',
  is_default             boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- routing_combo_id holds either a combos.id or a combo name (the lookup tries both), so it
-- has no FK; combo deletion must delete the assignment in code.
CREATE TABLE compression_combo_assignments (
  routing_combo_id      text PRIMARY KEY,
  compression_combo_id  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Generic, bounded configuration store (replaces most of SQLite key_value). Only the namespaces
-- listed in the CHECK may exist; unbounded or per-request state has dedicated tables.
CREATE TABLE config_entries (
  namespace   text NOT NULL CHECK (namespace IN (
                'settings', 'proxyConfig', 'secrets', 'ipFilter', 'feature_flags', 'pii_settings',
                'provider_param_filters', 'interception_rules', 'compression', 'databaseSettings',
                'ccDiscoveryAliases', 'functionalGatewayMirrors', 'obsidian', 'notion', 'sync',
                'conductor', 'local_corpus', 'cliToolLastConfig', 'cliToolInitialConfig',
                'serviceModels', 'antigravityCreditBalance', 'tier', 'job_state')),
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, key)
);

CREATE TABLE jobs (
  id           text PRIMARY KEY,                -- job name
  type         text NOT NULL DEFAULT 'interval' CHECK (type IN ('interval', 'cron')),
  cron         text,
  interval_ms  integer CHECK (interval_ms IS NULL OR interval_ms > 0),
  enabled      boolean NOT NULL DEFAULT true,
  env_flag     text,
  config       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------------------------
-- 2.3 Model catalog state (from key_value namespaces customModels, modelCompatOverrides,
--     providerAliases, syncedAvailableModels, discoveryState, providerLimitsCache, pricing*,
--     modelAliases, managedModelAliasNames, lkgp)
-- --------------------------------------------------------------------------------------------

-- One row per provider id (built-in key or provider_nodes.id). Read per request, uncached.
CREATE TABLE provider_model_catalog (
  provider          text PRIMARY KEY,
  custom_models     jsonb NOT NULL DEFAULT '[]',   -- [{id, name, source, apiFormat, ...}]
  compat_overrides  jsonb NOT NULL DEFAULT '[]',   -- [{id, normalizeToolCallId, isHidden, ...}]
  provider_aliases  jsonb NOT NULL DEFAULT '{}',   -- {alias: upstreamModelId}
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per connection: the models its last sync returned plus the discovery verdict.
CREATE TABLE connection_model_sync (
  connection_id      text PRIMARY KEY,
  provider           text NOT NULL,
  models             jsonb NOT NULL DEFAULT '[]',
  discovery_status   text CHECK (discovery_status IN ('healthy', 'degraded')),
  discovery_cause    text,
  discovery_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Last fetched provider limits/quota payload per connection (written by the quota refresh job).
CREATE TABLE connection_limits_cache (
  connection_id  text PRIMARY KEY,
  data           jsonb NOT NULL,                -- {quotas, plan, fetchedAt, source, limitReached, ...}
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Price tables per provider and source layer: user overrides, LiteLLM sync, models.dev sync.
CREATE TABLE model_pricing (
  source      text NOT NULL CHECK (source IN ('user', 'litellm', 'models_dev')),
  provider    text NOT NULL,
  models      jsonb NOT NULL,                   -- {modelId: {input, output, cached, ...}}
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, provider)
);

CREATE TABLE model_aliases (
  alias       text PRIMARY KEY,
  target      jsonb NOT NULL,                   -- "provider/model" | [...] | {provider, model}
  managed     boolean NOT NULL DEFAULT false,   -- created by provider model sync (was managedModelAliasNames)
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Last-known-good provider pin per combo target. pin_key keeps the app's key format
-- ('<comboName>:<modelId>' or '<comboId>'); prefix scans use the PK (database collation C).
CREATE TABLE lkgp_pins (
  pin_key        text PRIMARY KEY,
  provider       text NOT NULL,
  connection_id  text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_capabilities (
  provider           text NOT NULL,
  model_id           text NOT NULL,
  tool_call          boolean,
  reasoning          boolean,
  attachment         boolean,
  structured_output  boolean,
  temperature        boolean,
  open_weights       boolean,
  modalities_input   jsonb NOT NULL DEFAULT '[]',
  modalities_output  jsonb NOT NULL DEFAULT '[]',
  reasoning_efforts  jsonb,
  knowledge_cutoff   text,                      -- models.dev strings ('2025-03', '2025-03-01'), not normalized
  release_date       text,
  last_updated       text,
  status             text,
  family             text,
  limit_context      integer,
  limit_input        integer,
  limit_output       integer,
  interleaved_field  text,
  last_synced        timestamptz,
  PRIMARY KEY (provider, model_id)
);

CREATE TABLE model_capability_overrides (
  provider        text NOT NULL,
  model_id        text NOT NULL,
  override_key    text NOT NULL CHECK (override_key IN ('max_input_tokens', 'max_output_tokens', 'max_token', 'reasoning_efforts')),
  override_value  jsonb NOT NULL,               -- positive integer or string[]
  refreshed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model_id, override_key)
);

CREATE TABLE model_context_overrides (
  provider      text NOT NULL,
  model_id      text NOT NULL,
  real_context  integer NOT NULL CHECK (real_context > 0),
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto:discovery')),
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model_id)
);

CREATE TABLE model_intelligence (
  model       text NOT NULL,
  source      text NOT NULL CHECK (source IN ('arena_elo', 'models_dev_tier', 'user_override')),
  category    text NOT NULL,
  score       double precision NOT NULL CHECK (score BETWEEN 0 AND 1),
  elo_raw     integer,
  confidence  text,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  PRIMARY KEY (model, source, category)
);

-- --------------------------------------------------------------------------------------------
-- 2.4 Coordination and runtime state (shared by all processes; small, hot-updated rows)
-- --------------------------------------------------------------------------------------------

CREATE TABLE connection_runtime_state (
  connection_id          text PRIMARY KEY,
  warmup_circuit_streak  integer NOT NULL DEFAULT 0,
  warmup_circuit_until   timestamptz,
  warmup_last_fail_at    timestamptz,
  last_warmup_at         timestamptz,
  last_warmup_result     text,
  warmup_tokens_used     integer NOT NULL DEFAULT 0,
  updated_at             timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);

-- Per (connection, model) token window for round-robin combos. window_start/window_reset are
-- the fixed window bounds; the upsert must roll the window in SQL (see design doc).
CREATE TABLE provider_quota_state (
  connection_id  text NOT NULL,
  model          text NOT NULL,
  tokens_used    bigint NOT NULL DEFAULT 0,
  token_limit    bigint NOT NULL DEFAULT 0,
  window_start   timestamptz NOT NULL,
  window_reset   timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, model)
) WITH (fillfactor = 80);

-- Sliding-window usage counters for quota pools AND per-key TPM/RPM quotas (merged from
-- quota_consumption and api_key_quota_counters). dimension_key: '<poolId>:<unit>:<window>',
-- '<poolId>:model:<model>:<unit>:hourly', '<poolId>:sched:<id>:<unit>:<window>',
-- 'key-quota:tpm', 'key-quota:rpm'. bucket_index = floor(epoch_ms / window_ms).
-- Only BRIN indexes the hot-updated updated_at, so the per-request upsert stays HOT (PG16+).
CREATE TABLE quota_counters (
  api_key_id     text NOT NULL,
  dimension_key  text NOT NULL,
  bucket_index   bigint NOT NULL,
  consumed       numeric(24,10) NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, dimension_key, bucket_index)
) WITH (fillfactor = 80);

CREATE TABLE api_key_quota_limits (
  api_key_id            text PRIMARY KEY,
  tpm_limit             integer CHECK (tpm_limit IS NULL OR tpm_limit > 0),
  rpm_limit             integer CHECK (rpm_limit IS NULL OR rpm_limit > 0),
  monthly_amount_usd    numeric(20,10) CHECK (monthly_amount_usd IS NULL OR monthly_amount_usd > 0),
  unpriced_usage_since  timestamptz,           -- was key_value keyQuotaUnpricedUsage
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_key_token_limits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id      text NOT NULL,
  scope_type      text NOT NULL CHECK (scope_type IN ('model', 'provider', 'global')),
  scope_value     text NOT NULL DEFAULT '',     -- '' for global
  token_limit     bigint NOT NULL CHECK (token_limit > 0),
  reset_interval  text NOT NULL DEFAULT 'monthly' CHECK (reset_interval IN ('daily', 'weekly', 'monthly')),
  reset_time      time,                         -- UTC time of day the window starts
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, scope_type, scope_value, reset_interval)
);

CREATE TABLE api_key_token_counters (
  limit_id      uuid NOT NULL,
  window_start  timestamptz NOT NULL,
  tokens_used   bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (limit_id, window_start)
) WITH (fillfactor = 80);

CREATE TABLE api_key_token_limit_reset_logs (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  limit_id      uuid NOT NULL,
  reset_at      timestamptz NOT NULL DEFAULT now(),
  prev_tokens   bigint NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL,
  UNIQUE (limit_id, window_start)              -- one reset row per rolled window, even with 4 writers
);

CREATE TABLE quota_groups (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quota_pools (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  group_id    text NOT NULL DEFAULT 'group-demo',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Authoritative pool membership; position 0 is the pool's primary connection
-- (was quota_pools.connection_id).
CREATE TABLE quota_pool_connections (
  pool_id        text NOT NULL,
  connection_id  text NOT NULL,
  position       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool_id, connection_id),
  -- deferred so membership rewrites (delete + re-insert, or position swaps) only need to be
  -- consistent at commit
  UNIQUE (pool_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE quota_allocations (
  pool_id     text NOT NULL,
  api_key_id  text NOT NULL,
  weight      double precision NOT NULL CHECK (weight >= 0 AND weight <= 100),
  cap_value   double precision,
  cap_unit    text CHECK (cap_unit IN ('percent', 'requests', 'tokens', 'usd')),
  policy      text NOT NULL DEFAULT 'hard' CHECK (policy IN ('hard', 'soft', 'burst')),
  PRIMARY KEY (pool_id, api_key_id)
);

CREATE TABLE quota_allocation_model_caps (
  pool_id     text NOT NULL,
  api_key_id  text NOT NULL,
  model       text NOT NULL,
  cap_value   double precision NOT NULL CHECK (cap_value > 0),
  cap_unit    text NOT NULL CHECK (cap_unit IN ('percent', 'requests', 'tokens', 'usd')),
  PRIMARY KEY (pool_id, api_key_id, model)
);

CREATE TABLE quota_schedules (
  id             text PRIMARY KEY,             -- 'sched-<base36>-<rand>'
  pool_id        text NOT NULL,
  label          text,
  days           smallint[] NOT NULL CHECK (days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),  -- JS getDay()
  start_minute   smallint NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
  end_minute     smallint NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
  timezone       text,                          -- IANA zone; NULL = server local
  mode           text NOT NULL DEFAULT 'allow' CHECK (mode IN ('allow', 'block')),
  reserves       jsonb,                         -- [{window, percent}]
  budget_value   double precision CHECK (budget_value IS NULL OR budget_value > 0),
  budget_unit    text CHECK (budget_unit IS NULL OR budget_unit IN ('requests', 'tokens', 'usd')),
  budget_window  text NOT NULL DEFAULT 'daily' CHECK (budget_window IN ('hourly', '5h', 'daily', 'weekly', 'monthly')),
  priority       integer NOT NULL DEFAULT 0,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((budget_value IS NULL) = (budget_unit IS NULL))
);

CREATE TABLE quota_recovery_tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id          text NOT NULL,
  turn_key            text NOT NULL,            -- 'sessionId:turnId'
  request_hash        text NOT NULL,
  endpoint            text NOT NULL CHECK (endpoint IN ('chat/completions', 'responses')),
  request_ciphertext  text NOT NULL,            -- enc:v1 ('' once terminal)
  result_ciphertext   text,                     -- enc:v1
  state               text NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'running', 'completed', 'failed', 'needs_confirmation', 'cancelled', 'expired')),
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, turn_key)
);

CREATE TABLE provider_plans (
  connection_id  text PRIMARY KEY,
  provider       text NOT NULL,
  dimensions     jsonb NOT NULL,                -- [{unit, window, limit}]
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domain_budgets (
  api_key_id            text PRIMARY KEY,
  daily_limit_usd       numeric(20,10) NOT NULL,
  weekly_limit_usd      numeric(20,10) NOT NULL DEFAULT 0,
  monthly_limit_usd     numeric(20,10) NOT NULL DEFAULT 0,
  warning_threshold     double precision NOT NULL DEFAULT 0.8,
  reset_interval        text NOT NULL DEFAULT 'daily' CHECK (reset_interval IN ('daily', 'weekly', 'monthly')),
  reset_time            time NOT NULL DEFAULT '00:00',
  budget_reset_at       timestamptz,
  last_budget_reset_at  timestamptz,
  warning_emitted_at    timestamptz,
  warning_period_start  timestamptz,
  unpriced_usage_since  timestamptz           -- was key_value budgetUnpricedUsage
);

CREATE TABLE domain_budget_reset_logs (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  api_key_id      text NOT NULL,
  reset_interval  text NOT NULL,
  previous_spend  numeric(20,10) NOT NULL DEFAULT 0,
  reset_at        timestamptz NOT NULL,
  next_reset_at   timestamptz NOT NULL,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  UNIQUE (api_key_id, period_start)            -- a rollover is logged once even with several writers
);

-- Circuit breaker snapshot per breaker name: written after every request through a breaker.
CREATE TABLE domain_circuit_breakers (
  name               text PRIMARY KEY,          -- provider id or '<provider>::conn::<connectionId>'
  state              text NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED', 'DEGRADED', 'OPEN', 'HALF_OPEN')),
  failure_count      integer NOT NULL DEFAULT 0,
  last_failure_time  timestamptz,
  options            jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 70);

CREATE TABLE domain_fallback_chains (
  model  text PRIMARY KEY,
  chain  jsonb NOT NULL                         -- [{provider, priority, enabled}]
);

CREATE TABLE domain_lockout_state (
  identifier    text PRIMARY KEY,               -- IP, username or API key
  attempts      timestamptz[] NOT NULL DEFAULT '{}',
  locked_until  timestamptz
);

CREATE TABLE exclusive_connection_leases (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lease_owner_hash  text NOT NULL CHECK (lease_owner_hash ~ '^[0-9a-f]{64}$'),
  api_key_id        text NOT NULL,              -- may be synthetic ('omniroute:glm-reset-card-operation')
  provider          text NOT NULL,
  connection_id     text NOT NULL,
  generation        integer NOT NULL CHECK (generation > 0),
  state             text NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'INVALIDATED')),
  acquired_at       timestamptz NOT NULL,
  renewed_at        timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  end_reason        text CHECK (end_reason IN ('AUTHORIZATION_CHANGED', 'CLIENT_CANCELLED', 'CONNECTION_INELIGIBLE',
                                               'HEALTH_OR_COOLDOWN', 'MANAGED_KEY_REVOKED', 'MODEL_INELIGIBLE',
                                               'OWNER_EXIT', 'QUOTA_UNAVAILABLE', 'TTL_EXPIRED'))
);

-- Sticky session -> connection binding (was key_value namespace session_account_affinity).
-- Read and touched on every request; no index on the touched columns so touches stay HOT.
CREATE TABLE session_affinities (
  provider          text NOT NULL,
  session_hash      text NOT NULL,              -- sha256(provider:sessionKey)
  connection_id     text NOT NULL,
  account_identity  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (provider, session_hash)
) WITH (fillfactor = 80);

-- Gemini thought signatures by tool call (was key_value namespace gemini_thought_signatures).
CREATE TABLE gemini_thought_signatures (
  signature_key  text PRIMARY KEY,              -- toolCallId or '<connectionId[:family]>:<toolCallId>'
  signature      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);

-- Muse session ownership records (was key_value namespace muse_session_ownership). Keys keep the
-- app format ('session:<scope>', 'served:<scope>', 'opaque:<scope>:<hash>', 'touched:<scope>', ...);
-- values are opaque text. touched_at replaces the epoch-ms text in 'touched:' rows.
CREATE TABLE muse_session_ownership (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  touched_at  timestamptz,                    -- swept by a periodic scan, deliberately unindexed (HOT touches)
  updated_at  timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);

CREATE TABLE cc_discovery_metrics (
  metric_key  text PRIMARY KEY,                 -- 'req:total', 'discovery:hits', 'req:model:<id>'
  count       bigint NOT NULL DEFAULT 0
) WITH (fillfactor = 70);

CREATE TABLE context_handoffs (
  id                     text PRIMARY KEY DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 16),
  session_id             text NOT NULL,
  combo_name             text NOT NULL,
  from_account           text NOT NULL,
  summary                text NOT NULL,
  key_decisions          jsonb NOT NULL DEFAULT '[]',
  task_progress          text NOT NULL DEFAULT '',
  active_entities        jsonb NOT NULL DEFAULT '[]',
  message_count          integer NOT NULL DEFAULT 0,
  model                  text NOT NULL DEFAULT '',
  last_model             text,
  warning_threshold_pct  double precision NOT NULL DEFAULT 0.85,
  generated_at           timestamptz NOT NULL,
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, combo_name)
);

-- Last model/provider used by a session within a combo (replaces SQLite session_model_history:
-- the code only ever reads the newest row per (combo, session), so one row is kept and upserted).
-- No index on used_at so the per-attempt upsert stays HOT; swept by the leader like
-- session_affinities (DELETE WHERE used_at < now() - TTL, sequential scan).
CREATE TABLE session_model_pins (
  combo_name     text NOT NULL,
  session_id     text NOT NULL,
  model_str      text NOT NULL,
  provider       text NOT NULL,
  connection_id  text,
  used_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (combo_name, session_id)
) WITH (fillfactor = 80);

CREATE TABLE codex_wakeup_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  connection_ids  jsonb NOT NULL,               -- string[] (1..20)
  schedule        jsonb NOT NULL,               -- {kind:'interval',minutes} | {kind:'daily',time,timezone,days}
  enabled         boolean NOT NULL DEFAULT false,
  next_run_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE codex_wakeup_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid NOT NULL,
  task_name         text NOT NULL,
  trigger_kind      text NOT NULL CHECK (trigger_kind IN ('scheduled', 'manual')),
  status            text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'partial', 'interrupted')),
  results           jsonb NOT NULL DEFAULT '[]',
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  lease_expires_at  timestamptz NOT NULL
);

CREATE TABLE command_code_auth_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash         text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'applied', 'expired')),
  encrypted_api_key  text,
  metadata           jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  received_at        timestamptz,
  applied_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE server_tool_executions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id        text NOT NULL,
  request_identity  text NOT NULL,
  tool_call_id      text NOT NULL,
  tool_name         text NOT NULL,
  input_digest      text NOT NULL,
  output            text,                       -- sanitized JSON string, may be a truncation envelope
  status            text NOT NULL CHECK (status IN ('running', 'success', 'error', 'timeout')),
  error_message     text,
  duration_ms       integer,
  claim_expires_at  timestamptz NOT NULL,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, request_identity, tool_call_id)
);

CREATE TABLE relay_tokens (
  id                       text PRIMARY KEY,     -- 'rl_<hex>'
  name                     text NOT NULL,
  token_hash               text NOT NULL UNIQUE,
  token_prefix             text NOT NULL,
  description              text NOT NULL DEFAULT '',
  combo_id                 text,
  allowed_models           jsonb NOT NULL DEFAULT '["*"]',
  max_tokens_per_request   integer DEFAULT 128000,
  max_requests_per_minute  integer DEFAULT 60,
  max_requests_per_day     integer DEFAULT 10000,
  max_cost_per_day         numeric(20,10) NOT NULL DEFAULT 0,   -- 0 = unlimited
  enabled                  boolean NOT NULL DEFAULT true,
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz,
  last_used_at             timestamptz
) WITH (fillfactor = 80);

CREATE TABLE relay_rate_limits (
  token_id       text NOT NULL,
  window_start   timestamptz NOT NULL,          -- start of the UTC minute
  request_count  integer NOT NULL DEFAULT 0,
  cost           numeric(20,10) NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, window_start)
);

-- --------------------------------------------------------------------------------------------
-- 2.5 Caches with their own expiry
-- --------------------------------------------------------------------------------------------

CREATE TABLE semantic_cache (
  signature     text PRIMARY KEY,               -- '<apiKeyId>.<sha256>' or bare sha256
  model         text NOT NULL,
  prompt_hash   text NOT NULL,
  response      text NOT NULL,                  -- cached completion, returned verbatim
  tokens_saved  integer NOT NULL DEFAULT 0,
  hit_count     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE TABLE cache_metrics (
  key         text PRIMARY KEY CHECK (key IN ('hits', 'misses', 'tokens_saved')),
  value       bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 50);

CREATE TABLE reasoning_cache (
  tool_call_id  text PRIMARY KEY,
  provider      text NOT NULL,
  model         text NOT NULL,
  reasoning     text NOT NULL,
  char_count    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE TABLE ccr_blocks (
  principal_id      text NOT NULL,              -- api key id or anonymous sentinel
  hash              text NOT NULL,
  content           text NOT NULL,
  bytes             integer NOT NULL,
  chars             integer NOT NULL,
  lines             integer NOT NULL,
  content_type      text NOT NULL DEFAULT 'text/plain',
  source            text NOT NULL DEFAULT 'compression',
  created_at        timestamptz NOT NULL,
  last_accessed_at  timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (principal_id, hash)
);

-- Radar caches: one row per feed kind (merged from radar_feed_cache, radar_referrals_cache,
-- radar_offers_cache, radar_intel_cache). payload is the signed document, kept byte-exact.
CREATE TABLE radar_cache (
  kind                text PRIMARY KEY CHECK (kind IN ('feed', 'referrals', 'offers', 'intel')),
  version             text,
  generated_at        text,                     -- as published by the feed
  tier                text CHECK (tier IN ('community', 'live')),
  payload             text NOT NULL,
  signature           text NOT NULL,
  supporter_identity  text,                     -- intel only (one-way hash)
  fetched_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radar_settings (
  id                       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  opt_in                   boolean NOT NULL DEFAULT false,
  supporter_key_encrypted  text,
  updated_at               timestamptz
);

CREATE TABLE radar_local_model_state (
  provider      text NOT NULL,
  model_id      text NOT NULL,
  display_name  text,
  enabled       boolean,                        -- NULL = no override
  tombstoned    boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model_id)
);

-- --------------------------------------------------------------------------------------------
-- 2.6 Records and logs. call_logs, usage_history and proxy_logs are partitioned by UTC day;
--     the PK includes "timestamp" (a partitioned table's unique keys must contain the
--     partition key). Point updates should pass "timestamp" so the planner prunes.
-- --------------------------------------------------------------------------------------------

CREATE TABLE call_logs (
  id                          text NOT NULL,
  seq                         bigint GENERATED BY DEFAULT AS IDENTITY,  -- monotonic export cursor (was SQLite rowid)
  "timestamp"                 timestamptz NOT NULL,
  method                      text,
  path                        text,
  status                      integer,
  model                       text,
  requested_model             text,
  provider                    text,
  account                     text,                -- display snapshot of the connection name
  connection_id               text,
  duration                    integer NOT NULL DEFAULT 0,
  ttft_ms                     integer,
  tokens_in                   integer NOT NULL DEFAULT 0,
  tokens_out                  integer NOT NULL DEFAULT 0,
  tokens_cache_read           integer,
  tokens_cache_creation       integer,
  tokens_reasoning            integer,
  tokens_compressed           integer,
  cache_source                text DEFAULT 'upstream',
  request_type                text,
  source_format               text,
  target_format               text,
  api_key_id                  text,
  api_key_name                text,                -- snapshot; survives key deletion
  combo_name                  text,
  combo_step_id               text,
  combo_execution_key         text,
  error_summary               text,
  error_type                  text,
  request_summary             jsonb,
  resilience_actions          jsonb,
  detail_state                text NOT NULL DEFAULT 'none'
                              CHECK (detail_state IN ('none', 'pending', 'ready', 'missing', 'corrupt')),
  detail_pending_until        timestamptz,
  artifact_relpath            text,
  artifact_size_bytes         bigint,
  artifact_sha256             text,
  has_request_body            boolean NOT NULL DEFAULT false,
  has_response_body           boolean NOT NULL DEFAULT false,
  has_pipeline_details        boolean NOT NULL DEFAULT false,
  has_content                 boolean,
  correlation_id              text,
  response_id                 text,
  session_tag                 text,
  client_session_id           text,
  model_pinned                boolean NOT NULL DEFAULT false,
  video_content_removed       boolean NOT NULL DEFAULT false,
  added_wait_ms               integer,
  added_wait_cause            text,
  usage_provenance            text,
  reasoning_source            text,
  reasoning_chars             integer,
  reasoning_duration_ms       integer,
  reasoning_effort_requested  text,
  reasoning_effort_upstream   text,
  reasoning_encrypted         boolean,
  PRIMARY KEY (id, "timestamp")
) PARTITION BY RANGE ("timestamp");

CREATE TABLE call_logs_default PARTITION OF call_logs DEFAULT WITH (fillfactor = 85);

CREATE TABLE usage_history (
  id                        bigint GENERATED BY DEFAULT AS IDENTITY,
  "timestamp"               timestamptz NOT NULL,
  provider                  text,
  model                     text,
  connection_id             text,
  account_key               text,
  account_label             text,
  account_label_priority    integer NOT NULL DEFAULT 0,
  api_key_id                text,
  api_key_name              text,
  billing_team_id           text,
  team_rollup_processed_at  timestamptz,
  tokens_input              integer NOT NULL DEFAULT 0,
  tokens_output             integer NOT NULL DEFAULT 0,
  tokens_cache_read         integer NOT NULL DEFAULT 0,
  tokens_cache_creation     integer NOT NULL DEFAULT 0,
  tokens_reasoning          integer NOT NULL DEFAULT 0,
  service_tier              text NOT NULL DEFAULT 'standard',
  status                    text,
  success                   boolean NOT NULL DEFAULT true,
  latency_ms                integer NOT NULL DEFAULT 0,
  ttft_ms                   integer NOT NULL DEFAULT 0,
  error_code                text,
  combo_strategy            text DEFAULT 'direct',
  endpoint                  text,
  cpa_auth_index            text,
  provider_credits          numeric(20,10) CHECK (provider_credits >= 0),
  provider_cost_usd         numeric(20,10) CHECK (provider_cost_usd >= 0),
  PRIMARY KEY (id, "timestamp")
) PARTITION BY RANGE ("timestamp");

CREATE TABLE usage_history_default PARTITION OF usage_history DEFAULT;

CREATE TABLE proxy_logs (
  id                text NOT NULL,
  "timestamp"       timestamptz NOT NULL,
  status            text,
  proxy_type        text,
  proxy_name        text,
  proxy_host        text,
  proxy_port        integer,
  level             text,
  level_id          text,
  provider          text,
  target_url        text,
  public_ip         text,
  egress_ip         text,
  latency_ms        integer NOT NULL DEFAULT 0,
  headers_ms        integer,
  first_chunk_ms    integer,
  upstream_status   integer,
  error             text,
  connection_id     text,
  combo_id          text,
  account           text,
  rotation_account  text,
  correlation_id    text,
  attempt_number    integer,
  attempt_issue     text,
  tls_fingerprint   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, "timestamp")
) PARTITION BY RANGE ("timestamp");

CREATE TABLE proxy_logs_default PARTITION OF proxy_logs DEFAULT WITH (fillfactor = 85);

CREATE TABLE daily_usage_summary (
  provider             text NOT NULL,
  model                text NOT NULL,
  date                 date NOT NULL,           -- UTC day
  total_requests       bigint NOT NULL DEFAULT 0,
  total_input_tokens   bigint NOT NULL DEFAULT 0,
  total_output_tokens  bigint NOT NULL DEFAULT 0,
  total_cost           numeric(20,10) NOT NULL DEFAULT 0,   -- priced at rollup time (API-equivalent USD)
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, date)
);

CREATE TABLE daily_team_usage_summary (
  team_id                           text NOT NULL,
  api_key_id                        text NOT NULL,   -- 'unknown' when the usage row had none
  api_key_name                      text,
  provider                          text NOT NULL,
  model                             text NOT NULL,
  service_tier                      text NOT NULL DEFAULT 'standard',
  date                              date NOT NULL,
  total_requests                    bigint NOT NULL DEFAULT 0,
  successful_requests               bigint NOT NULL DEFAULT 0,
  total_input_tokens                bigint NOT NULL DEFAULT 0,
  total_output_tokens               bigint NOT NULL DEFAULT 0,
  total_cache_read_tokens           bigint NOT NULL DEFAULT 0,
  total_cache_creation_tokens       bigint NOT NULL DEFAULT 0,
  total_reasoning_tokens            bigint NOT NULL DEFAULT 0,
  successful_input_tokens           bigint NOT NULL DEFAULT 0,
  successful_output_tokens          bigint NOT NULL DEFAULT 0,
  successful_cache_read_tokens      bigint NOT NULL DEFAULT 0,
  successful_cache_creation_tokens  bigint NOT NULL DEFAULT 0,
  successful_reasoning_tokens       bigint NOT NULL DEFAULT 0,
  token_shapes                      jsonb,     -- {"[in,out,cacheRead,cacheCreate,reasoning]": count}
  successful_token_shapes           jsonb,
  PRIMARY KEY (team_id, api_key_id, provider, model, service_tier, date)
);

CREATE TABLE request_cost_ledger (
  id                     bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "timestamp"            timestamptz NOT NULL,
  api_key_id             text NOT NULL,
  provider               text NOT NULL,
  model                  text NOT NULL,
  request_id             text,                  -- = call_logs.correlation_id
  service_tier           text NOT NULL DEFAULT 'standard',
  success                boolean NOT NULL DEFAULT true,
  tokens_input           integer NOT NULL DEFAULT 0,
  tokens_output          integer NOT NULL DEFAULT 0,
  tokens_cache_read      integer NOT NULL DEFAULT 0,
  tokens_cache_creation  integer NOT NULL DEFAULT 0,
  tokens_reasoning       integer NOT NULL DEFAULT 0,
  unit_price_input       numeric(20,10) NOT NULL DEFAULT 0,
  unit_price_output      numeric(20,10) NOT NULL DEFAULT 0,
  amount_usd             numeric(20,10) NOT NULL DEFAULT 0
);

CREATE TABLE domain_cost_history (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  api_key_id   text NOT NULL,
  cost         numeric(20,10) NOT NULL,
  "timestamp"  timestamptz NOT NULL
);

CREATE TABLE quota_snapshots (
  id                    bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  provider              text NOT NULL,
  connection_id         text NOT NULL,
  window_key            text NOT NULL,
  remaining_percentage  double precision,
  is_exhausted          boolean NOT NULL DEFAULT false,
  next_reset_at         timestamptz,
  window_duration_ms    bigint,
  raw_data              jsonb,                  -- NULL or {"fractionReported": false}
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_quota_reset_events (
  id                             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  provider                       text NOT NULL,
  connection_id                  text NOT NULL,
  window_key                     text NOT NULL,
  window_started_at              timestamptz NOT NULL,
  window_resets_at               timestamptz NOT NULL,
  observed_at                    timestamptz NOT NULL,
  previous_remaining_percentage  double precision,
  new_remaining_percentage       double precision,
  previous_used_percentage       double precision,
  new_used_percentage            double precision,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, window_key, window_started_at, window_resets_at)
);

CREATE TABLE compression_analytics (
  id                            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "timestamp"                   timestamptz NOT NULL,
  request_id                    text,
  combo_id                      text,
  compression_combo_id          text,
  provider                      text,
  mode                          text NOT NULL,
  engine                        text,
  output_mode                   text,
  original_tokens               integer NOT NULL,
  compressed_tokens             integer NOT NULL,
  tokens_saved                  integer NOT NULL,
  duration_ms                   integer,
  estimated_usd_saved           numeric(20,10),
  mcp_description_tokens_saved  integer NOT NULL DEFAULT 0,
  multimodal_skip_count         integer NOT NULL DEFAULT 0,
  validation_fallback           boolean NOT NULL DEFAULT false,
  skip_reason                   text,
  receipt_source                text,
  actual_prompt_tokens          integer,
  actual_completion_tokens      integer,
  actual_total_tokens           integer,
  actual_cache_read_tokens      integer,
  actual_cache_write_tokens     integer,
  rtk_raw_output_pointer        text,
  rtk_raw_output_bytes          integer,
  rtk_raw_output_pointers       jsonb,
  rtk_raw_output_total_bytes    bigint
);

CREATE TABLE compression_engine_breakdown (
  id                 bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "timestamp"        timestamptz NOT NULL,
  request_id         text,
  engine             text NOT NULL,
  original_tokens    integer NOT NULL DEFAULT 0,
  compressed_tokens  integer NOT NULL DEFAULT 0,
  tokens_saved       integer NOT NULL DEFAULT 0,
  duration_ms        integer
);

CREATE TABLE compression_cache_stats (
  id                        bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  provider                  text NOT NULL,
  model                     text NOT NULL DEFAULT '',
  compression_mode          text NOT NULL,
  cache_control_present     boolean NOT NULL DEFAULT false,
  estimated_cache_hit       boolean NOT NULL DEFAULT false,
  tokens_saved_compression  integer NOT NULL DEFAULT 0,
  tokens_saved_caching      integer NOT NULL DEFAULT 0,
  net_savings               integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compression_run_telemetry (
  id                   bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "timestamp"          timestamptz NOT NULL,
  request_id           text,
  model                text,
  provider             text,
  source               text,
  tokens_before        integer NOT NULL,
  tokens_after         integer NOT NULL,
  ratio                double precision,
  cost_delta           numeric(20,10),
  output_styles        jsonb,
  output_style_bypass  text,
  output_tokens        integer
);

CREATE TABLE mcp_tool_audit (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tool_name       text NOT NULL,
  input_hash      text,
  output_summary  text,
  duration_ms     integer,
  api_key_id      text,
  success         boolean NOT NULL DEFAULT true,
  error_code      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "timestamp"    timestamptz NOT NULL DEFAULT now(),
  action         text NOT NULL,
  actor          text NOT NULL DEFAULT 'system',
  target         text,
  resource_type  text,
  status         text,
  request_id     text,
  ip_address     text,
  details        jsonb,                         -- redacted by serializeAuditValue
  metadata       jsonb
);

CREATE TABLE webhook_deliveries (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  webhook_id        text NOT NULL,
  event_type        text NOT NULL,
  status            text NOT NULL,
  http_status       integer,
  latency_ms        integer,
  error             text,
  payload_snapshot  text,                       -- first 2000 chars of the JSON; may be cut mid-document
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_runs (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  job_id            text NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failure')),
  error_message     text,
  records_affected  integer NOT NULL DEFAULT 0,
  duration_ms       integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE relay_logs (
  id                 bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  token_id           text,                      -- NULL when authentication failed (was 'unknown')
  request_id         text,
  model              text,
  prompt_tokens      integer NOT NULL DEFAULT 0,
  completion_tokens  integer NOT NULL DEFAULT 0,
  cost               numeric(20,10) NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'rate_limited', 'auth_failed', 'error')),
  status_code        integer NOT NULL DEFAULT 200,
  latency_ms         integer NOT NULL DEFAULT 0,
  client_ip          text,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Conversation identity tracking: updated on every chat request that continues a conversation.
CREATE TABLE agentic_conversations (
  id                text PRIMARY KEY,           -- 'conv_<uuid>' or the client's X-Omniroute-Session-Id
  api_key_id        text,
  fingerprint_hash  text NOT NULL,
  turn_count        integer NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL
) WITH (fillfactor = 80);

CREATE TABLE conversation_turn_nodes (
  id                   text PRIMARY KEY,        -- chain hash
  seq                  bigint GENERATED BY DEFAULT AS IDENTITY,  -- page cursor (was SQLite rowid)
  conversation_id      text NOT NULL,
  parent_id            text,                    -- no FK: retention deletes old ancestors first
  role                 text NOT NULL,
  content_hash         text NOT NULL DEFAULT '',
  last_correlation_id  text,                    -- = call_logs.correlation_id
  first_seen_at        timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL
);

-- --------------------------------------------------------------------------------------------
-- 2.7 Skills, plugins, agents, evals, batches, files, inspector, misc
-- --------------------------------------------------------------------------------------------

CREATE TABLE skills (
  id               text PRIMARY KEY,
  api_key_id       text NOT NULL,               -- owner: api key id or 'system' | 'skillsmp' | 'skillssh'
  name             text NOT NULL,
  version          text NOT NULL DEFAULT '1.0.0',
  description      text,
  schema           jsonb NOT NULL,
  handler          text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  mode             text NOT NULL DEFAULT 'auto' CHECK (mode IN ('on', 'off', 'auto')),
  source_provider  text CHECK (source_provider IN ('skillsmp', 'skillssh', 'local')),
  tags             jsonb,
  install_count    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skill_executions (
  id             text PRIMARY KEY,
  skill_id       text NOT NULL,
  api_key_id     text NOT NULL,
  session_id     text,
  input          jsonb NOT NULL,
  output         jsonb,
  status         text NOT NULL CHECK (status IN ('pending', 'running', 'success', 'error', 'timeout')),
  error_message  text,
  duration_ms    integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugins (
  id             text PRIMARY KEY,
  name           text NOT NULL UNIQUE,
  version        text NOT NULL DEFAULT '1.0.0',
  description    text,
  author         text,
  license        text DEFAULT 'MIT',
  main           text NOT NULL DEFAULT 'index.js',
  source         text NOT NULL DEFAULT 'local',
  tags           jsonb NOT NULL DEFAULT '[]',
  status         text NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'active', 'inactive', 'error')),
  manifest       jsonb NOT NULL,
  config         jsonb NOT NULL DEFAULT '{}',
  config_schema  jsonb NOT NULL DEFAULT '{}',
  hooks          jsonb NOT NULL DEFAULT '[]',
  permissions    jsonb NOT NULL DEFAULT '[]',
  plugin_dir     text NOT NULL,
  error_message  text,
  installed_at   timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  activated_at   timestamptz
);

CREATE TABLE a2a_tasks (
  id            text PRIMARY KEY,
  state         text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'working', 'completed', 'failed', 'cancelled')),
  skill_id      text,
  api_key_id    text,                           -- owner (hashed key) or NULL for keyless tasks
  input         jsonb,
  output        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE TABLE a2a_task_events (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  task_id     text NOT NULL,
  event_type  text NOT NULL,                    -- 'state:<state>' | 'memory_hits'
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_suites (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_cases (
  id                 text PRIMARY KEY,
  suite_id           text NOT NULL,
  sort_order         integer NOT NULL DEFAULT 0,
  name               text NOT NULL,
  model              text,
  input              jsonb NOT NULL,
  expected_strategy  text NOT NULL CHECK (expected_strategy IN ('contains', 'exact', 'regex', 'custom')),
  expected_value     text,
  tags               jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- suite_id may name a built-in (code-defined) suite, so it has no FK.
CREATE TABLE eval_runs (
  id              text PRIMARY KEY,
  run_group_id    text,
  suite_id        text NOT NULL,
  suite_name      text NOT NULL,
  target_type     text NOT NULL CHECK (target_type IN ('suite-default', 'model', 'combo')),
  target_id       text,
  target_label    text NOT NULL,
  api_key_id      text,
  avg_latency_ms  integer NOT NULL DEFAULT 0,
  summary         jsonb NOT NULL,               -- {total, passed, failed, passRate}
  results         jsonb NOT NULL,
  outputs         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id          text PRIMARY KEY,
  filename    text NOT NULL,
  purpose     text NOT NULL,
  mime_type   text,
  bytes       bigint NOT NULL CHECK (bytes >= 0),
  content     bytea,                            -- NULL after soft delete / expiry
  api_key_id  text,                             -- owner; may be 'env-key'
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  deleted_at  timestamptz
);

CREATE TABLE batches (
  id                            text PRIMARY KEY,
  endpoint                      text NOT NULL,
  completion_window             text NOT NULL,
  status                        text NOT NULL CHECK (status IN ('validating', 'failed', 'in_progress', 'finalizing',
                                                                 'completed', 'expired', 'cancelling', 'cancelled')),
  input_file_id                 text NOT NULL,
  output_file_id                text,
  error_file_id                 text,
  api_key_id                    text,
  model                         text,
  request_counts_total          integer NOT NULL DEFAULT 0,
  request_counts_completed      integer NOT NULL DEFAULT 0,
  request_counts_failed         integer NOT NULL DEFAULT 0,
  metadata                      jsonb,
  errors                        jsonb,
  usage                         jsonb,
  output_expires_after_seconds  integer,
  output_expires_after_anchor   text CHECK (output_expires_after_anchor IS NULL OR output_expires_after_anchor = 'created_at'),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  in_progress_at                timestamptz,
  finalizing_at                 timestamptz,
  completed_at                  timestamptz,
  failed_at                     timestamptz,
  expired_at                    timestamptz,
  cancelling_at                 timestamptz,
  cancelled_at                  timestamptz
);

CREATE TABLE batch_item_checkpoints (
  batch_id     text NOT NULL,
  line_number  integer NOT NULL,
  custom_id    text,
  status       text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'errored')),
  result       jsonb,
  error        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, line_number)
);

CREATE TABLE inspector_sessions (
  id             text PRIMARY KEY,
  name           text,
  profile        text CHECK (profile IN ('llm', 'custom', 'all')),
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  request_count  integer NOT NULL DEFAULT 0
);

CREATE TABLE inspector_session_requests (
  session_id  text NOT NULL,
  seq         integer NOT NULL,
  payload     jsonb NOT NULL,                   -- InterceptedRequest (secrets masked), <= 1 MiB
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE inspector_custom_hosts (
  host      text PRIMARY KEY,
  enabled   boolean NOT NULL DEFAULT true,
  label     text,
  kind      text NOT NULL DEFAULT 'custom' CHECK (kind IN ('llm', 'app', 'custom')),
  added_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_bridge_state (
  agent_id         text PRIMARY KEY,
  dns_enabled      boolean NOT NULL DEFAULT false,
  cert_trusted     boolean NOT NULL DEFAULT false,
  setup_completed  boolean NOT NULL DEFAULT false,
  last_started_at  timestamptz,
  last_error       text
);

-- Model rewrites per intercepted agent. Also the source the MITM proxy reads
-- (replaces the key_value mitmAlias mirror). source_model '*' is the catch-all.
CREATE TABLE agent_bridge_mappings (
  agent_id      text NOT NULL,
  source_model  text NOT NULL,
  target_model  text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, source_model)
);

CREATE TABLE agent_bridge_bypass (
  pattern     text PRIMARY KEY,
  source      text NOT NULL CHECK (source IN ('default', 'user')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE playground_presets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  endpoint    text NOT NULL,
  model       text NOT NULL,
  system      text,
  params      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery_results (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  provider_id    text NOT NULL,
  method         text NOT NULL CHECK (method IN ('free_tier', 'web_cookie', 'auto_register', 'trial', 'public_api')),
  endpoint       text,
  auth_type      text CHECK (auth_type IN ('none', 'cookie', 'api_key', 'oauth')),
  models         jsonb,
  rate_limit     text,
  feasibility    smallint CHECK (feasibility BETWEEN 1 AND 5),
  risk_level     text CHECK (risk_level IN ('none', 'low', 'medium', 'high', 'critical')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'testing', 'verified', 'rejected')),
  notes          text,
  discovered_at  timestamptz NOT NULL DEFAULT now(),
  verified_at    timestamptz,
  UNIQUE NULLS NOT DISTINCT (provider_id, method, endpoint)
);

-- ============================================================================================
-- 3. Constraints: foreign keys (DEFERRABLE INITIALLY IMMEDIATE so the one-way transfer tool may
--    defer them inside its load transaction; normal statements check immediately).
--    Deliberately NO FK where the request path writes synthetic ids: api_key_id 'env-key' /
--    'self-loop' (domain_budgets, quota_recovery_tickets, auto_candidate_overrides) and the
--    synthetic connection 'noauth' (session_affinities, lkgp_pins, provider_quota_state,
--    auto_candidate_overrides). Code keeps deleting those rows when the parent is deleted.
--    sync_tokens keeps its FK: a token issued for the env key stores sync_api_key_id = NULL
--    ("no linked key"), never 'env-key'.
-- ============================================================================================

ALTER TABLE api_key_context_sources       ADD CONSTRAINT api_key_context_sources_api_key_fk       FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE api_key_billing_team_history  ADD CONSTRAINT api_key_billing_team_history_api_key_fk  FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE api_key_billing_team_history  ADD CONSTRAINT api_key_billing_team_history_team_fk     FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE RESTRICT DEFERRABLE;
ALTER TABLE key_group_members             ADD CONSTRAINT key_group_members_key_fk                 FOREIGN KEY (key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE key_group_members             ADD CONSTRAINT key_group_members_group_fk               FOREIGN KEY (group_id) REFERENCES key_groups (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE group_model_permissions       ADD CONSTRAINT group_model_permissions_group_fk         FOREIGN KEY (group_id) REFERENCES key_groups (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE sso_identities                ADD CONSTRAINT sso_identities_api_key_fk                FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE model_combo_mappings          ADD CONSTRAINT model_combo_mappings_combo_fk            FOREIGN KEY (combo_id) REFERENCES combos (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE reasoning_routing_rules       ADD CONSTRAINT reasoning_routing_rules_api_key_fk       FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE reasoning_routing_rules       ADD CONSTRAINT reasoning_routing_rules_combo_fk         FOREIGN KEY (combo_id) REFERENCES combos (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE reasoning_routing_rules       ADD CONSTRAINT reasoning_routing_rules_target_combo_fk  FOREIGN KEY (target_combo_id) REFERENCES combos (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE reasoning_routing_rules       ADD CONSTRAINT reasoning_routing_rules_connection_fk    FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE sync_tokens                   ADD CONSTRAINT sync_tokens_api_key_fk                   FOREIGN KEY (sync_api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE proxy_registry                ADD CONSTRAINT proxy_registry_subscription_fk           FOREIGN KEY (subscription_id) REFERENCES proxy_subscriptions (id) ON DELETE SET NULL DEFERRABLE;
ALTER TABLE proxy_assignments             ADD CONSTRAINT proxy_assignments_proxy_fk               FOREIGN KEY (proxy_id) REFERENCES proxy_registry (id) ON DELETE RESTRICT DEFERRABLE;
ALTER TABLE free_proxies                  ADD CONSTRAINT free_proxies_pool_proxy_fk               FOREIGN KEY (pool_proxy_id) REFERENCES proxy_registry (id) ON DELETE SET NULL DEFERRABLE;
ALTER TABLE compression_combo_assignments ADD CONSTRAINT compression_combo_assignments_combo_fk   FOREIGN KEY (compression_combo_id) REFERENCES compression_combos (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE connection_model_sync         ADD CONSTRAINT connection_model_sync_connection_fk      FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE connection_limits_cache       ADD CONSTRAINT connection_limits_cache_connection_fk    FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE connection_runtime_state      ADD CONSTRAINT connection_runtime_state_connection_fk   FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE api_key_quota_limits          ADD CONSTRAINT api_key_quota_limits_api_key_fk          FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE api_key_token_limits          ADD CONSTRAINT api_key_token_limits_api_key_fk          FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE api_key_token_counters        ADD CONSTRAINT api_key_token_counters_limit_fk          FOREIGN KEY (limit_id) REFERENCES api_key_token_limits (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE api_key_token_limit_reset_logs ADD CONSTRAINT api_key_token_limit_reset_logs_limit_fk FOREIGN KEY (limit_id) REFERENCES api_key_token_limits (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE quota_pools                   ADD CONSTRAINT quota_pools_group_fk                     FOREIGN KEY (group_id) REFERENCES quota_groups (id) ON DELETE RESTRICT DEFERRABLE;
ALTER TABLE quota_pool_connections        ADD CONSTRAINT quota_pool_connections_pool_fk           FOREIGN KEY (pool_id) REFERENCES quota_pools (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE quota_pool_connections        ADD CONSTRAINT quota_pool_connections_connection_fk     FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE quota_allocations             ADD CONSTRAINT quota_allocations_pool_fk                FOREIGN KEY (pool_id) REFERENCES quota_pools (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE quota_allocations             ADD CONSTRAINT quota_allocations_api_key_fk             FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE quota_allocation_model_caps   ADD CONSTRAINT quota_allocation_model_caps_allocation_fk FOREIGN KEY (pool_id, api_key_id) REFERENCES quota_allocations (pool_id, api_key_id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE quota_schedules               ADD CONSTRAINT quota_schedules_pool_fk                  FOREIGN KEY (pool_id) REFERENCES quota_pools (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE provider_plans                ADD CONSTRAINT provider_plans_connection_fk             FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE domain_budget_reset_logs      ADD CONSTRAINT domain_budget_reset_logs_budget_fk       FOREIGN KEY (api_key_id) REFERENCES domain_budgets (api_key_id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE exclusive_connection_leases   ADD CONSTRAINT exclusive_connection_leases_connection_fk FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE codex_wakeup_runs             ADD CONSTRAINT codex_wakeup_runs_task_fk                FOREIGN KEY (task_id) REFERENCES codex_wakeup_tasks (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE relay_rate_limits             ADD CONSTRAINT relay_rate_limits_token_fk               FOREIGN KEY (token_id) REFERENCES relay_tokens (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE relay_logs                    ADD CONSTRAINT relay_logs_token_fk                      FOREIGN KEY (token_id) REFERENCES relay_tokens (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE quota_snapshots               ADD CONSTRAINT quota_snapshots_connection_fk            FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE provider_quota_reset_events   ADD CONSTRAINT provider_quota_reset_events_connection_fk FOREIGN KEY (connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE webhook_deliveries            ADD CONSTRAINT webhook_deliveries_webhook_fk            FOREIGN KEY (webhook_id) REFERENCES webhooks (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE job_runs                      ADD CONSTRAINT job_runs_job_fk                          FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE daily_team_usage_summary      ADD CONSTRAINT daily_team_usage_summary_team_fk         FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE RESTRICT DEFERRABLE;
ALTER TABLE conversation_turn_nodes       ADD CONSTRAINT conversation_turn_nodes_conversation_fk  FOREIGN KEY (conversation_id) REFERENCES agentic_conversations (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE skill_executions              ADD CONSTRAINT skill_executions_skill_fk                FOREIGN KEY (skill_id) REFERENCES skills (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE a2a_task_events               ADD CONSTRAINT a2a_task_events_task_fk                  FOREIGN KEY (task_id) REFERENCES a2a_tasks (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE eval_cases                    ADD CONSTRAINT eval_cases_suite_fk                      FOREIGN KEY (suite_id) REFERENCES eval_suites (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE batches                       ADD CONSTRAINT batches_input_file_fk                    FOREIGN KEY (input_file_id) REFERENCES files (id) DEFERRABLE;
ALTER TABLE batches                       ADD CONSTRAINT batches_output_file_fk                   FOREIGN KEY (output_file_id) REFERENCES files (id) DEFERRABLE;
ALTER TABLE batches                       ADD CONSTRAINT batches_error_file_fk                    FOREIGN KEY (error_file_id) REFERENCES files (id) DEFERRABLE;
ALTER TABLE batch_item_checkpoints        ADD CONSTRAINT batch_item_checkpoints_batch_fk          FOREIGN KEY (batch_id) REFERENCES batches (id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE inspector_session_requests    ADD CONSTRAINT inspector_session_requests_session_fk    FOREIGN KEY (session_id) REFERENCES inspector_sessions (id) ON DELETE CASCADE DEFERRABLE;

-- ============================================================================================
-- 4. Indexes (each serves a query named in the design doc; FK child columns are indexed where
--    the child table can grow)
-- ============================================================================================

-- control plane
CREATE UNIQUE INDEX provider_nodes_prefix_uq ON provider_nodes (lower(btrim(prefix))) WHERE prefix IS NOT NULL;
CREATE INDEX provider_connections_routing_idx ON provider_connections (provider, priority);
CREATE UNIQUE INDEX teams_name_ci_uq ON teams (lower(name));
CREATE UNIQUE INDEX combos_name_ci_uq ON combos (lower(name));
CREATE INDEX api_key_billing_team_history_lookup_idx ON api_key_billing_team_history (api_key_id, valid_from);
CREATE UNIQUE INDEX api_key_billing_team_history_one_open_uq ON api_key_billing_team_history (api_key_id) WHERE valid_to IS NULL;
CREATE INDEX api_key_billing_team_history_team_open_idx ON api_key_billing_team_history (team_id, api_key_id) WHERE valid_to IS NULL;
CREATE INDEX key_group_members_group_idx ON key_group_members (group_id);
CREATE INDEX group_model_permissions_group_idx ON group_model_permissions (group_id);
CREATE INDEX sso_identities_api_key_idx ON sso_identities (api_key_id);
CREATE INDEX model_combo_mappings_combo_idx ON model_combo_mappings (combo_id);
CREATE INDEX registered_keys_provider_idx ON registered_keys (provider) WHERE is_active;
CREATE INDEX registered_keys_account_idx ON registered_keys (account_id) WHERE is_active;
CREATE INDEX proxy_registry_host_port_idx ON proxy_registry (host, port);
CREATE INDEX proxy_registry_subscription_idx ON proxy_registry (subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX proxy_assignments_proxy_idx ON proxy_assignments (proxy_id);
CREATE INDEX free_proxies_pool_proxy_idx ON free_proxies (pool_proxy_id) WHERE pool_proxy_id IS NOT NULL;
CREATE INDEX proxy_operator_egress_member_idx ON proxy_operator_egress (host, port, observed_at DESC);
CREATE INDEX compression_combo_assignments_combo_idx ON compression_combo_assignments (compression_combo_id);
CREATE UNIQUE INDEX compression_combos_one_default_uq ON compression_combos ((true)) WHERE is_default;
CREATE INDEX cloud_agent_tasks_provider_idx ON cloud_agent_tasks (provider_id, created_at DESC);
CREATE INDEX cloud_agent_tasks_status_idx ON cloud_agent_tasks (status, created_at DESC);
CREATE INDEX cloud_agent_tasks_created_idx ON cloud_agent_tasks (created_at DESC);

-- model catalog state
CREATE INDEX connection_model_sync_provider_idx ON connection_model_sync (provider);
CREATE INDEX lkgp_pins_connection_idx ON lkgp_pins (connection_id) WHERE connection_id IS NOT NULL;
CREATE INDEX model_intelligence_expires_idx ON model_intelligence (expires_at) WHERE expires_at IS NOT NULL;

-- coordination / runtime state
CREATE INDEX quota_counters_dimension_idx ON quota_counters (dimension_key, bucket_index);
CREATE INDEX quota_counters_updated_brin ON quota_counters USING brin (updated_at);
CREATE INDEX quota_pool_connections_connection_idx ON quota_pool_connections (connection_id);
CREATE INDEX quota_allocations_api_key_idx ON quota_allocations (api_key_id);
CREATE INDEX quota_schedules_pool_idx ON quota_schedules (pool_id);
CREATE INDEX quota_recovery_tickets_due_idx ON quota_recovery_tickets (next_attempt_at) WHERE state = 'pending';
CREATE INDEX domain_budget_reset_logs_key_idx ON domain_budget_reset_logs (api_key_id, reset_at DESC);
CREATE UNIQUE INDEX exclusive_connection_leases_active_connection_uq ON exclusive_connection_leases (connection_id) WHERE state = 'ACTIVE';
CREATE UNIQUE INDEX exclusive_connection_leases_active_owner_uq ON exclusive_connection_leases (lease_owner_hash) WHERE state = 'ACTIVE';
CREATE INDEX exclusive_connection_leases_owner_generation_idx ON exclusive_connection_leases (lease_owner_hash, generation);
CREATE INDEX exclusive_connection_leases_active_expiry_idx ON exclusive_connection_leases (expires_at) WHERE state = 'ACTIVE';
CREATE INDEX exclusive_connection_leases_connection_idx ON exclusive_connection_leases (connection_id);
CREATE INDEX exclusive_connection_leases_ended_brin ON exclusive_connection_leases USING brin (ended_at);
CREATE INDEX session_affinities_connection_idx ON session_affinities (connection_id);
CREATE INDEX gemini_thought_signatures_expires_idx ON gemini_thought_signatures (expires_at);
CREATE INDEX context_handoffs_expires_idx ON context_handoffs (expires_at);
CREATE UNIQUE INDEX codex_wakeup_runs_one_running_uq ON codex_wakeup_runs (task_id) WHERE status = 'running';
CREATE INDEX codex_wakeup_runs_task_idx ON codex_wakeup_runs (task_id, started_at DESC);
CREATE INDEX codex_wakeup_runs_started_idx ON codex_wakeup_runs (started_at DESC);
CREATE INDEX server_tool_executions_running_idx ON server_tool_executions (claim_expires_at) WHERE status = 'running';
CREATE INDEX server_tool_executions_created_brin ON server_tool_executions USING brin (created_at);
CREATE INDEX command_code_auth_sessions_expires_idx ON command_code_auth_sessions (expires_at);
CREATE INDEX relay_rate_limits_window_brin ON relay_rate_limits USING brin (window_start);

-- caches
CREATE INDEX semantic_cache_expires_idx ON semantic_cache (expires_at);
CREATE INDEX reasoning_cache_expires_idx ON reasoning_cache (expires_at);
CREATE INDEX ccr_blocks_expires_idx ON ccr_blocks (expires_at);

-- partitioned logs (created on every partition, current and future)
CREATE INDEX call_logs_timestamp_idx ON call_logs ("timestamp" DESC);
CREATE INDEX call_logs_seq_idx ON call_logs (seq);
CREATE INDEX call_logs_provider_ts_idx ON call_logs (provider, "timestamp")
  INCLUDE (connection_id, model, requested_model, status, duration);
CREATE INDEX call_logs_api_key_ts_idx ON call_logs (api_key_id, "timestamp");
CREATE INDEX call_logs_combo_ts_idx ON call_logs (combo_name, "timestamp") WHERE combo_name IS NOT NULL;
CREATE INDEX call_logs_correlation_idx ON call_logs (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX call_logs_response_idx ON call_logs (response_id) WHERE response_id IS NOT NULL;
CREATE INDEX call_logs_session_tag_idx ON call_logs (session_tag, "timestamp") WHERE session_tag IS NOT NULL;
-- No index on artifact_relpath / detail_state / detail_pending_until: the per-request detail publish
-- updates exactly those columns and must stay HOT. artifact_relpath is a pure function of
-- ("timestamp", id), so path lookups resolve to the primary key; the pending sweep scans only
-- the last day ("timestamp" > now() - 1 day AND detail_state = 'pending').

CREATE INDEX usage_history_timestamp_idx ON usage_history ("timestamp");
-- INCLUDE makes the per-request USD-limit aggregate (apiKeyUsageLimits.getApiKeyUsdSpendSince)
-- an index-only scan once the insert-only partition is vacuumed (visibility map set).
CREATE INDEX usage_history_api_key_ts_idx ON usage_history (api_key_id, "timestamp")
  INCLUDE (provider, model, service_tier, success, provider_cost_usd, tokens_input, tokens_output,
           tokens_cache_read, tokens_cache_creation, tokens_reasoning);
CREATE INDEX usage_history_provider_model_ts_idx ON usage_history (provider, model, "timestamp");
CREATE INDEX usage_history_connection_ts_idx ON usage_history (connection_id, "timestamp");
CREATE INDEX usage_history_team_ts_idx ON usage_history (billing_team_id, "timestamp") WHERE billing_team_id IS NOT NULL;
CREATE INDEX usage_history_rollup_pending_idx ON usage_history ("timestamp")
  WHERE billing_team_id IS NOT NULL AND team_rollup_processed_at IS NULL;

CREATE INDEX proxy_logs_timestamp_idx ON proxy_logs ("timestamp" DESC);
CREATE INDEX proxy_logs_connection_egress_idx ON proxy_logs (connection_id, "timestamp") WHERE egress_ip IS NOT NULL;
CREATE INDEX proxy_logs_proxy_ts_idx ON proxy_logs (proxy_host, proxy_port, "timestamp");
CREATE INDEX proxy_logs_correlation_idx ON proxy_logs (correlation_id) WHERE correlation_id IS NOT NULL;

-- other records
CREATE INDEX daily_usage_summary_date_idx ON daily_usage_summary (date);
CREATE INDEX daily_team_usage_summary_team_date_idx ON daily_team_usage_summary (team_id, date);
CREATE INDEX request_cost_ledger_api_key_ts_idx ON request_cost_ledger (api_key_id, "timestamp");
CREATE INDEX request_cost_ledger_request_idx ON request_cost_ledger (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX request_cost_ledger_ts_brin ON request_cost_ledger USING brin ("timestamp");
CREATE INDEX domain_cost_history_api_key_ts_idx ON domain_cost_history (api_key_id, "timestamp");
CREATE INDEX domain_cost_history_ts_brin ON domain_cost_history USING brin ("timestamp");
CREATE INDEX quota_snapshots_connection_ts_idx ON quota_snapshots (connection_id, created_at);
CREATE INDEX quota_snapshots_provider_ts_idx ON quota_snapshots (provider, created_at);
CREATE INDEX quota_snapshots_created_brin ON quota_snapshots USING brin (created_at);
CREATE INDEX provider_quota_reset_events_observed_idx ON provider_quota_reset_events (connection_id, observed_at DESC);
CREATE INDEX provider_quota_reset_events_provider_idx ON provider_quota_reset_events (provider, observed_at);
CREATE INDEX compression_analytics_ts_idx ON compression_analytics ("timestamp");
CREATE INDEX compression_analytics_request_idx ON compression_analytics (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX compression_engine_breakdown_engine_ts_idx ON compression_engine_breakdown (engine, "timestamp");
CREATE INDEX compression_engine_breakdown_request_idx ON compression_engine_breakdown (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX compression_cache_stats_created_idx ON compression_cache_stats (created_at);
CREATE INDEX compression_run_telemetry_ts_idx ON compression_run_telemetry ("timestamp");
CREATE INDEX mcp_tool_audit_created_idx ON mcp_tool_audit (created_at);
CREATE INDEX mcp_tool_audit_tool_idx ON mcp_tool_audit (tool_name, created_at);
CREATE INDEX audit_log_ts_idx ON audit_log ("timestamp");
CREATE INDEX audit_log_action_ts_idx ON audit_log (action, "timestamp");
CREATE INDEX audit_log_request_idx ON audit_log (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX job_runs_job_idx ON job_runs (job_id, started_at DESC);
CREATE INDEX relay_logs_token_idx ON relay_logs (token_id, created_at);
CREATE INDEX relay_logs_created_brin ON relay_logs USING brin (created_at);
CREATE INDEX agentic_conversations_fingerprint_idx ON agentic_conversations (fingerprint_hash);
CREATE INDEX agentic_conversations_api_key_idx ON agentic_conversations (api_key_id);
-- BRIN only: last_seen_at is rewritten on every continued request and must not block HOT.
CREATE INDEX agentic_conversations_last_seen_brin ON agentic_conversations USING brin (last_seen_at);
CREATE INDEX conversation_turn_nodes_conversation_idx ON conversation_turn_nodes (conversation_id, seq);
CREATE INDEX conversation_turn_nodes_content_idx ON conversation_turn_nodes (conversation_id, content_hash);
CREATE INDEX conversation_turn_nodes_last_seen_brin ON conversation_turn_nodes USING brin (last_seen_at);

-- skills, plugins, agents, evals, batches, files, inspector
CREATE INDEX skills_api_key_idx ON skills (api_key_id);
CREATE INDEX skill_executions_skill_idx ON skill_executions (skill_id);
CREATE INDEX skill_executions_api_key_idx ON skill_executions (api_key_id, created_at DESC);
CREATE INDEX skill_executions_created_brin ON skill_executions USING brin (created_at);
CREATE INDEX a2a_tasks_created_idx ON a2a_tasks (created_at DESC);
CREATE INDEX a2a_task_events_task_idx ON a2a_task_events (task_id, id);
CREATE INDEX a2a_task_events_created_brin ON a2a_task_events USING brin (created_at);
CREATE INDEX eval_cases_suite_idx ON eval_cases (suite_id, sort_order, created_at);
CREATE INDEX eval_runs_suite_idx ON eval_runs (suite_id, created_at DESC);
CREATE INDEX eval_runs_group_idx ON eval_runs (run_group_id) WHERE run_group_id IS NOT NULL;
CREATE INDEX eval_runs_target_idx ON eval_runs (target_type, target_id, created_at DESC);
CREATE INDEX eval_runs_created_idx ON eval_runs (created_at DESC);
CREATE INDEX files_owner_list_idx ON files (api_key_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX files_list_idx ON files (created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX files_expiry_idx ON files (expires_at) WHERE deleted_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX batches_owner_idx ON batches (api_key_id, created_at DESC, id DESC);
CREATE INDEX batches_status_idx ON batches (status, created_at);
CREATE INDEX batches_input_file_idx ON batches (input_file_id);
CREATE INDEX batches_output_file_idx ON batches (output_file_id) WHERE output_file_id IS NOT NULL;
CREATE INDEX batches_error_file_idx ON batches (error_file_id) WHERE error_file_id IS NOT NULL;
CREATE INDEX batch_item_checkpoints_status_idx ON batch_item_checkpoints (batch_id, status);
CREATE INDEX inspector_sessions_started_idx ON inspector_sessions (started_at DESC);
CREATE INDEX playground_presets_created_idx ON playground_presets (created_at DESC);
CREATE INDEX discovery_results_provider_idx ON discovery_results (provider_id);

-- ============================================================================================
-- 5. Comments
-- ============================================================================================

COMMENT ON TABLE provider_nodes IS 'Operator-defined OpenAI/Anthropic-compatible providers; id is the provider key used by provider_connections.provider and call_logs.provider.';
COMMENT ON TABLE provider_connections IS 'Upstream accounts/credentials per provider. Routing reads by (provider, priority); every request touches last_used_at/consecutive_use_count (HOT).';
COMMENT ON TABLE api_keys IS 'Client API keys and their access policy. Auth looks up key_hash only; key holds the app-encrypted secret for reveal/export.';
COMMENT ON TABLE api_key_context_sources IS 'Per-key external context source (Obsidian) settings.';
COMMENT ON TABLE teams IS 'Billing teams; never deleted (archived). Name is unique case-insensitively.';
COMMENT ON TABLE api_key_billing_team_history IS 'Validity intervals of api key -> billing team; at most one open interval per key.';
COMMENT ON TABLE key_groups IS 'Groups of API keys that grant/deny model access.';
COMMENT ON TABLE key_group_members IS 'API key membership in key_groups.';
COMMENT ON TABLE group_model_permissions IS 'Allow/deny model patterns per key group; deny wins.';
COMMENT ON TABLE sso_identities IS 'Entra SSO identities and their shadow API key.';
COMMENT ON TABLE combos IS 'Routing combos; data holds the full normalized combo record. Name unique case-insensitively.';
COMMENT ON TABLE model_combo_mappings IS 'Glob pattern -> combo routing for plain model requests.';
COMMENT ON TABLE reasoning_routing_rules IS 'Reasoning-effort routing rules scoped to global/key/combo/model/connection.';
COMMENT ON TABLE auto_candidate_overrides IS 'Per key and auto channel, connections excluded from auto-combo candidates.';
COMMENT ON TABLE registered_keys IS 'Externally issued ork_ keys (admin API); key_hash is sha256 of the raw key.';
COMMENT ON TABLE registered_key_limits IS 'Issuance limits for registered_keys per provider or account (merged provider_key_limits + account_key_limits).';
COMMENT ON TABLE sync_tokens IS 'Config-sync bearer tokens (hashed).';
COMMENT ON TABLE cli_access_tokens IS 'CLI / remote-management access tokens (hashed).';
COMMENT ON TABLE proxy_subscriptions IS 'Proxy subscription sources refreshed by the leader job.';
COMMENT ON TABLE proxy_registry IS 'Known outbound proxies (manual, subscription, free-proxy promotion, oneproxy).';
COMMENT ON TABLE proxy_assignments IS 'Proxy pools per scope (global/provider/account/combo), ordered by position.';
COMMENT ON TABLE proxy_scope_rotation IS 'Rotation cursor and strategy per proxy scope; updated on every round-robin advance.';
COMMENT ON TABLE free_proxies IS 'Free proxies scraped by the sync job; pool_proxy_id set when promoted into proxy_registry.';
COMMENT ON TABLE free_proxy_sync_errors IS 'Last sync errors per free-proxy source.';
COMMENT ON TABLE proxy_operator_egress IS 'Egress addresses observed by proxy operators per (host, port); bounded by the push handler.';
COMMENT ON TABLE upstream_proxy_config IS 'Per provider: native vs CLIProxyAPI routing mode.';
COMMENT ON TABLE version_manager IS 'Managed sidecar tools (CLIProxyAPI, ...) and their process state.';
COMMENT ON TABLE cloud_agent_credentials IS 'Cloud coding-agent provider credentials (app-encrypted).';
COMMENT ON TABLE cloud_agent_tasks IS 'Cloud coding-agent tasks and their activity log.';
COMMENT ON TABLE webhooks IS 'Outgoing webhook subscriptions.';
COMMENT ON TABLE log_export_destinations IS 'Call-log export destinations; cursor_seq is the last exported call_logs.seq.';
COMMENT ON TABLE middleware_hooks IS 'User-defined request middleware hooks (admin).';
COMMENT ON TABLE compression_combos IS 'Prompt-compression pipelines; at most one is_default.';
COMMENT ON TABLE compression_combo_assignments IS 'Routing combo (id or name) -> compression combo.';
COMMENT ON TABLE config_entries IS 'Bounded configuration by namespace (former key_value minus per-request/unbounded state). value is jsonb; raw strings are JSON strings.';
COMMENT ON TABLE jobs IS 'Registered background jobs (run by the leader).';
COMMENT ON TABLE provider_model_catalog IS 'Per provider: custom models, compat overrides and provider model aliases (former key_value customModels/modelCompatOverrides/providerAliases).';
COMMENT ON TABLE connection_model_sync IS 'Per connection: last synced model list and discovery verdict (former key_value syncedAvailableModels/discoveryState).';
COMMENT ON TABLE connection_limits_cache IS 'Per connection: last fetched provider limits payload (former key_value providerLimitsCache).';
COMMENT ON TABLE model_pricing IS 'Model price tables per source layer (user overrides, LiteLLM, models.dev) and provider.';
COMMENT ON TABLE model_aliases IS 'Global model aliases; managed rows are maintained by provider model sync.';
COMMENT ON TABLE lkgp_pins IS 'Last-known-good provider/connection per combo target.';
COMMENT ON TABLE model_capabilities IS 'models.dev / OpenRouter capability catalog (replaced wholesale by the daily sync).';
COMMENT ON TABLE model_capability_overrides IS 'Operator capability overrides per model.';
COMMENT ON TABLE model_context_overrides IS 'Corrected context windows per model (manual or discovered).';
COMMENT ON TABLE model_intelligence IS 'Task-fitness scores per model/source/category (Arena ELO sync).';
COMMENT ON TABLE connection_runtime_state IS 'Warmup circuit state per connection (warmup job).';
COMMENT ON TABLE provider_quota_state IS 'Fixed-window token usage per (connection, model) for round-robin combos.';
COMMENT ON TABLE quota_counters IS 'Bucketed usage counters for quota pools and per-key TPM/RPM (merged quota_consumption + api_key_quota_counters). Hot upsert.';
COMMENT ON TABLE api_key_quota_limits IS 'Per-key TPM/RPM/monthly USD quota limits.';
COMMENT ON TABLE api_key_token_limits IS 'Per-key token limits by scope and reset interval.';
COMMENT ON TABLE api_key_token_counters IS 'Tokens used per token limit and window.';
COMMENT ON TABLE api_key_token_limit_reset_logs IS 'One row per rolled token-limit window.';
COMMENT ON TABLE quota_groups IS 'Groups of quota pools.';
COMMENT ON TABLE quota_pools IS 'Quota-share pools.';
COMMENT ON TABLE quota_pool_connections IS 'Pool membership; position 0 is the primary connection.';
COMMENT ON TABLE quota_allocations IS 'Share of a pool allocated to an API key.';
COMMENT ON TABLE quota_allocation_model_caps IS 'Per-model caps inside an allocation.';
COMMENT ON TABLE quota_schedules IS 'Time-of-day allow/block windows and budgets per pool.';
COMMENT ON TABLE quota_recovery_tickets IS 'Deferred replays of quota-failed turns (encrypted request/result).';
COMMENT ON TABLE provider_plans IS 'Quota plan dimensions per connection.';
COMMENT ON TABLE domain_budgets IS 'USD budget per API key and its window/warning state.';
COMMENT ON TABLE domain_budget_reset_logs IS 'One row per rolled budget window.';
COMMENT ON TABLE domain_circuit_breakers IS 'Circuit-breaker snapshot per provider or connection; written after each request through a breaker.';
COMMENT ON TABLE domain_fallback_chains IS 'Provider fallback chain per model.';
COMMENT ON TABLE domain_lockout_state IS 'Failed-login attempts and lockouts per identifier.';
COMMENT ON TABLE exclusive_connection_leases IS 'Exclusive connection leases; partial unique indexes give mutual exclusion across processes.';
COMMENT ON TABLE session_affinities IS 'Sticky session -> connection binding with TTL (former key_value session_account_affinity).';
COMMENT ON TABLE gemini_thought_signatures IS 'Gemini thought signatures by tool call, with TTL.';
COMMENT ON TABLE muse_session_ownership IS 'Muse session ownership records (opaque key/value).';
COMMENT ON TABLE cc_discovery_metrics IS 'Claude Code discovery counters.';
COMMENT ON TABLE session_model_pins IS 'Last model/provider/connection a session used within a combo (one upserted row per combo and session).';
COMMENT ON COLUMN call_logs.artifact_relpath IS 'Set at INSERT to buildArtifactRelativePath("timestamp", id); detail_state = ''ready'' says the file exists.';
COMMENT ON TABLE context_handoffs IS 'Context-relay handoff summaries per (session, combo), with expiry.';
COMMENT ON TABLE codex_wakeup_tasks IS 'Scheduled Codex wake-up tasks.';
COMMENT ON TABLE codex_wakeup_runs IS 'Codex wake-up runs; at most one running run per task (partial unique index).';
COMMENT ON TABLE command_code_auth_sessions IS 'Command Code login handshakes.';
COMMENT ON TABLE server_tool_executions IS 'Idempotency fence for server-owned tool calls.';
COMMENT ON TABLE relay_tokens IS 'Relay endpoint tokens (hashed).';
COMMENT ON TABLE relay_rate_limits IS 'Per-token per-minute relay request counters.';
COMMENT ON TABLE semantic_cache IS 'Cached temperature-0 completions by signature, with expiry.';
COMMENT ON TABLE cache_metrics IS 'Semantic cache hit/miss/tokens-saved counters (3 rows).';
COMMENT ON TABLE reasoning_cache IS 'Reasoning text replay cache by tool call id, with expiry.';
COMMENT ON TABLE ccr_blocks IS 'Compressed-context retrieval blocks per principal, with expiry.';
COMMENT ON TABLE radar_cache IS 'Signed radar documents, one row per feed kind (merged four singleton caches).';
COMMENT ON TABLE radar_settings IS 'Radar opt-in and supporter key (singleton id = 1).';
COMMENT ON TABLE radar_local_model_state IS 'Local display/enable overrides for radar models.';
COMMENT ON TABLE call_logs IS 'One row per gateway attempt. Partitioned by UTC day on "timestamp"; retention drops partitions. Bodies live in artifact files.';
COMMENT ON TABLE usage_history IS 'Token usage per attempt. Partitioned by UTC day; rolled up into daily summaries before partitions are dropped.';
COMMENT ON TABLE proxy_logs IS 'Outbound proxy attempts. Partitioned by UTC day; same retention as call_logs.';
COMMENT ON TABLE daily_usage_summary IS 'Daily usage rollup per (provider, model), kept after raw usage_history expires.';
COMMENT ON TABLE daily_team_usage_summary IS 'Daily team usage rollup per key/provider/model/tier.';
COMMENT ON TABLE request_cost_ledger IS 'Priced cost per request with the unit prices used at the time.';
COMMENT ON TABLE domain_cost_history IS 'Budget spend entries per API key (batched by the spend writer).';
COMMENT ON TABLE quota_snapshots IS 'Provider quota window observations per connection (written on change).';
COMMENT ON TABLE provider_quota_reset_events IS 'Observed provider quota window resets.';
COMMENT ON TABLE compression_analytics IS 'Per-request prompt-compression outcome and usage receipt.';
COMMENT ON TABLE compression_engine_breakdown IS 'Per-engine breakdown of stacked compression runs.';
COMMENT ON TABLE compression_cache_stats IS 'Per-request compression vs prompt-cache interaction stats.';
COMMENT ON TABLE compression_run_telemetry IS 'Per-request output-style compression telemetry.';
COMMENT ON TABLE mcp_tool_audit IS 'MCP tool call audit trail.';
COMMENT ON TABLE audit_log IS 'Compliance audit events (admin actions and selected gateway events).';
COMMENT ON TABLE webhook_deliveries IS 'Webhook delivery attempts; the writer keeps the newest 100 per webhook.';
COMMENT ON TABLE job_runs IS 'Background job run history.';
COMMENT ON TABLE relay_logs IS 'Relay endpoint request log.';
COMMENT ON TABLE agentic_conversations IS 'Conversation identities resolved from request fingerprints or client session ids.';
COMMENT ON TABLE conversation_turn_nodes IS 'Turn chain nodes per conversation; display content comes from call_logs artifacts.';
COMMENT ON TABLE skills IS 'Installed skills per owner.';
COMMENT ON TABLE skill_executions IS 'Skill execution history.';
COMMENT ON TABLE plugins IS 'Installed plugins and lifecycle status.';
COMMENT ON TABLE a2a_tasks IS 'A2A protocol tasks.';
COMMENT ON TABLE a2a_task_events IS 'A2A task state transitions and events.';
COMMENT ON TABLE eval_suites IS 'Custom eval suites.';
COMMENT ON TABLE eval_cases IS 'Cases of custom eval suites.';
COMMENT ON TABLE eval_runs IS 'Eval run results (built-in or custom suites).';
COMMENT ON TABLE files IS 'Uploaded and batch files; content is cleared on soft delete/expiry.';
COMMENT ON TABLE batches IS 'OpenAI-compatible batch jobs.';
COMMENT ON TABLE batch_item_checkpoints IS 'Per-line batch progress and results.';
COMMENT ON TABLE inspector_sessions IS 'Traffic inspector recording sessions.';
COMMENT ON TABLE inspector_session_requests IS 'Captured requests of an inspector session.';
COMMENT ON TABLE inspector_custom_hosts IS 'Extra hosts intercepted by the traffic inspector.';
COMMENT ON TABLE agent_bridge_state IS 'Agent bridge setup state per agent.';
COMMENT ON TABLE agent_bridge_mappings IS 'Agent bridge model rewrites; also read by the MITM proxy.';
COMMENT ON TABLE agent_bridge_bypass IS 'Hosts/patterns the agent bridge does not intercept.';
COMMENT ON TABLE playground_presets IS 'Saved playground request presets.';
COMMENT ON TABLE discovery_results IS 'Provider discovery scan results.';
COMMENT ON COLUMN call_logs.seq IS 'Assigned at insert; not commit-ordered across processes. Exporters must only read rows older than a lag (see design doc).';
COMMENT ON COLUMN api_keys.key_hash IS 'sha256 hex of the raw key (opaqueTokenFingerprint).';
COMMENT ON COLUMN quota_counters.bucket_index IS 'floor(epoch_ms / window_ms) of the dimension window; an ordinal, not a timestamp.';

-- ============================================================================================
-- 6. Seed rows the application assumes exist
-- ============================================================================================

INSERT INTO quota_groups (id, name) VALUES ('group-demo', 'GroupDemo');
INSERT INTO radar_settings (id, opt_in) VALUES (1, false);
INSERT INTO cache_metrics (key, value) VALUES ('hits', 0), ('misses', 0), ('tokens_saved', 0);

-- ============================================================================================
-- 7. Initial partitions: yesterday through 14 days ahead (UTC). The leader keeps the window
--    rolling with omniroute_ensure_log_partitions() at startup and on every cleanup pass.
-- ============================================================================================

SELECT omniroute_ensure_log_partitions(1, 14);
