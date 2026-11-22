-- Covering index for the per-request API key quota check and the search spend lookup (upstream
-- migration 226). They filter on (api_key_id, "timestamp") and read success, service_tier and
-- amount_usd; with those carried in the index, the check is an index-only scan instead of one
-- heap fetch per matching ledger row. The old two-column index is a prefix of the new one.
CREATE INDEX request_cost_ledger_api_key_cover_idx
  ON request_cost_ledger (api_key_id, "timestamp") INCLUDE (success, service_tier, amount_usd);
DROP INDEX IF EXISTS request_cost_ledger_api_key_ts_idx;
