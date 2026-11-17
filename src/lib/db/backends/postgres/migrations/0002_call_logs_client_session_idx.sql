-- Per-session lookups on call_logs.client_session_id (the client's own session id).
-- Replaces SQLite migration 214's idx_cl_client_session_id, which 0001_init.sql did not carry over.
CREATE INDEX IF NOT EXISTS call_logs_client_session_idx
  ON call_logs (client_session_id) WHERE client_session_id IS NOT NULL;
