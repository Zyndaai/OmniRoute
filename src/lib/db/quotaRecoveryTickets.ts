/** Durable, opt-in recovery state for unanswered quota-failed requests. */
import { createHash, randomUUID } from "node:crypto";
import { db, ts } from "./pg";
import { decrypt, encrypt, isEncryptionEnabled, looksEncrypted } from "./encryption";

export type QuotaRecoveryState =
  "pending" | "running" | "completed" | "failed" | "needs_confirmation" | "cancelled" | "expired";

export interface QuotaRecoveryTicket {
  id: string;
  apiKeyId: string;
  turnKey: string;
  endpoint: "chat/completions" | "responses";
  state: QuotaRecoveryState;
  attemptCount: number;
  nextAttemptAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

type TicketRow = {
  id: string;
  api_key_id: string;
  turn_key: string;
  request_hash: string;
  endpoint: QuotaRecoveryTicket["endpoint"];
  state: QuotaRecoveryState;
  attempt_count: number;
  next_attempt_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  request_ciphertext: string;
  result_ciphertext: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toTicket(row: TicketRow): QuotaRecoveryTicket {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    turnKey: row.turn_key,
    endpoint: row.endpoint,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encryptRequired(payload: string): string {
  if (!isEncryptionEnabled()) {
    throw new Error("Quota recovery requires STORAGE_ENCRYPTION_KEY");
  }
  const ciphertext = encrypt(payload);
  if (!looksEncrypted(ciphertext)) {
    throw new Error("Quota recovery payload encryption failed");
  }
  return ciphertext as string;
}

async function getRow(id: string): Promise<TicketRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return db().queryOne<TicketRow>("SELECT * FROM quota_recovery_tickets WHERE id = $1", [id]);
}

export async function enqueueQuotaRecoveryTicket(input: {
  apiKeyId: string;
  turnKey: string;
  endpoint: QuotaRecoveryTicket["endpoint"];
  requestPayload: string;
  nextAttemptAt: string;
  expiresAt: string;
}): Promise<QuotaRecoveryTicket> {
  const ciphertext = encryptRequired(input.requestPayload);
  const id = randomUUID();
  const requestHash = createHash("sha256")
    .update(input.endpoint)
    .update("\0")
    .update(input.requestPayload)
    .digest("hex");
  const inserted = await db().queryOne<TicketRow>(
    `INSERT INTO quota_recovery_tickets
      (id, api_key_id, turn_key, request_hash, endpoint, request_ciphertext, next_attempt_at,
       expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (api_key_id, turn_key) DO NOTHING
     RETURNING *`,
    [
      id,
      input.apiKeyId,
      input.turnKey,
      requestHash,
      input.endpoint,
      ciphertext,
      ts(input.nextAttemptAt),
      ts(input.expiresAt),
    ]
  );
  const row =
    inserted ??
    (await db().queryOne<TicketRow>(
      "SELECT * FROM quota_recovery_tickets WHERE api_key_id = $1 AND turn_key = $2",
      [input.apiKeyId, input.turnKey]
    ));
  if (!row) throw new Error("Quota recovery ticket could not be created");
  if (row.request_hash !== requestHash) {
    throw new Error("Recovery turn identity was reused with a different request");
  }
  return toTicket(row);
}

export async function getQuotaRecoveryTicket(
  id: string,
  apiKeyId: string
): Promise<QuotaRecoveryTicket | null> {
  const row = await getRow(id);
  return row?.api_key_id === apiKeyId ? toTicket(row) : null;
}

/** Claim before dispatch. A crash while running is ambiguous and must not auto-replay. */
export async function claimQuotaRecoveryTicket(
  id: string,
  now = new Date()
): Promise<QuotaRecoveryTicket | null> {
  if (!UUID_RE.test(id)) return null;
  const iso = now.toISOString();
  const row = await db().queryOne<TicketRow>(
    `UPDATE quota_recovery_tickets
     SET state = 'running', attempt_count = attempt_count + 1, updated_at = $1
     WHERE id = $2 AND state = 'pending' AND next_attempt_at <= $1 AND expires_at > $1
     RETURNING *`,
    [iso, id]
  );
  return row ? toTicket(row) : null;
}

export async function listDueQuotaRecoveryTickets(
  now = new Date(),
  limit = 25
): Promise<QuotaRecoveryTicket[]> {
  const rows = await db().query<TicketRow>(
    `SELECT * FROM quota_recovery_tickets
     WHERE state = 'pending' AND next_attempt_at <= $1 AND expires_at > $1
     ORDER BY next_attempt_at, created_at LIMIT $2`,
    [now.toISOString(), Math.max(1, Math.min(Math.floor(limit), 100))]
  );
  return rows.map(toTicket);
}

export async function readQuotaRecoveryRequest(id: string): Promise<string | null> {
  const row = await getRow(id);
  if (row?.state !== "running" || !looksEncrypted(row.request_ciphertext)) return null;
  return decrypt(row.request_ciphertext) ?? null;
}

export async function completeQuotaRecoveryTicket(
  id: string,
  resultPayload: string
): Promise<boolean> {
  const ciphertext = encryptRequired(resultPayload);
  if (!UUID_RE.test(id)) return false;
  const changed = await db().execute(
    `UPDATE quota_recovery_tickets
     SET state = 'completed', result_ciphertext = $1, request_ciphertext = '', updated_at = now()
     WHERE id = $2 AND state = 'running'`,
    [ciphertext, id]
  );
  return changed.changes === 1;
}

export async function readQuotaRecoveryResult(
  id: string,
  apiKeyId: string
): Promise<string | null> {
  const row = await getRow(id);
  if (row?.api_key_id !== apiKeyId || row.state !== "completed" || !row.result_ciphertext) {
    return null;
  }
  if (!looksEncrypted(row.result_ciphertext)) return null;
  return decrypt(row.result_ciphertext) ?? null;
}

export async function rescheduleQuotaRecoveryTicket(
  id: string,
  nextAttemptAt: string
): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const changed = await db().execute(
    `UPDATE quota_recovery_tickets SET state = 'pending', next_attempt_at = $1, updated_at = now()
     WHERE id = $2 AND state = 'running'`,
    [ts(nextAttemptAt), id]
  );
  return changed.changes === 1;
}

export async function failQuotaRecoveryTicket(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const changed = await db().execute(
    `UPDATE quota_recovery_tickets
     SET state = 'failed', request_ciphertext = '', updated_at = now()
     WHERE id = $1 AND state = 'running'`,
    [id]
  );
  return changed.changes === 1;
}

export async function markQuotaRecoveryNeedsConfirmation(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const changed = await db().execute(
    `UPDATE quota_recovery_tickets
     SET state = 'needs_confirmation', updated_at = now()
     WHERE id = $1 AND state = 'running'`,
    [id]
  );
  return changed.changes === 1;
}

/**
 * A dispatch may have reached upstream before a process died. Require a client decision.
 * Shared state: only the leader process may run this at startup, or it flips the
 * live tickets of other processes.
 */
export async function reconcileInterruptedQuotaRecoveries(): Promise<number> {
  const changed = await db().execute(
    `UPDATE quota_recovery_tickets SET state = 'needs_confirmation', updated_at = now()
     WHERE state = 'running'`
  );
  return changed.changes;
}

/** A long-dead dispatch is ambiguous; do not replay it after a restart. */
export async function reconcileStaleRunningQuotaRecoveries(
  now = new Date(),
  staleMs = 30 * 60_000
): Promise<number> {
  const changed = await db().execute(
    `UPDATE quota_recovery_tickets SET state = 'needs_confirmation', updated_at = $1
     WHERE state = 'running' AND updated_at < $2`,
    [now.toISOString(), new Date(now.getTime() - staleMs).toISOString()]
  );
  return changed.changes;
}

export async function cancelQuotaRecoveryTicket(id: string, apiKeyId: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const changed = await db().execute(
    `UPDATE quota_recovery_tickets
     SET state = 'cancelled', request_ciphertext = '', result_ciphertext = NULL, updated_at = now()
     WHERE id = $1 AND api_key_id = $2 AND state IN ('pending', 'needs_confirmation')`,
    [id, apiKeyId]
  );
  return changed.changes === 1;
}

export async function expireQuotaRecoveryTickets(now = new Date()): Promise<number> {
  const changed = await db().execute(
    `UPDATE quota_recovery_tickets
     SET state = 'expired', request_ciphertext = '', result_ciphertext = NULL, updated_at = $1
     WHERE expires_at <= $1 AND state IN ('pending', 'completed', 'failed', 'needs_confirmation')`,
    [now.toISOString()]
  );
  return changed.changes;
}
