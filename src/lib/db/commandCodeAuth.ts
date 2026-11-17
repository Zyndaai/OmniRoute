import { createHash, randomUUID } from "crypto";

import { db } from "./pg";
import { decrypt, encrypt } from "./encryption";

export type CommandCodeAuthStatus = "pending" | "received" | "applied" | "expired";

export interface CommandCodeAuthMetadata {
  userId?: string;
  userName?: string;
  keyName?: string;
  receivedAt?: string;
}

export interface CommandCodeAuthSafeStatus {
  id: string;
  stateHash: string;
  status: CommandCodeAuthStatus;
  metadata: CommandCodeAuthMetadata | null;
  createdAt: string;
  expiresAt: string;
  receivedAt: string | null;
  appliedAt: string | null;
  updatedAt: string;
}

export interface ConsumedCommandCodeAuthSecret extends CommandCodeAuthSafeStatus {
  apiKey: string;
}

type AuthSessionRow = {
  id: string;
  state_hash: string;
  status: CommandCodeAuthStatus;
  encrypted_api_key?: string | null;
  metadata?: unknown;
  created_at: string;
  expires_at: string;
  received_at?: string | null;
  applied_at?: string | null;
  updated_at: string;
};

export function hashCommandCodeAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseMetadata(value: unknown): CommandCodeAuthMetadata | null {
  if (!value) return null;
  // jsonb arrives parsed; a raw JSON string is still accepted.
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as CommandCodeAuthMetadata;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as CommandCodeAuthMetadata;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function toSafeStatus(row: AuthSessionRow): CommandCodeAuthSafeStatus {
  return {
    id: String(row.id),
    stateHash: String(row.state_hash),
    status: row.status,
    metadata: parseMetadata(row.metadata),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    receivedAt: row.received_at ?? null,
    appliedAt: row.applied_at ?? null,
    updatedAt: String(row.updated_at),
  };
}

async function markExpiredForState(stateHash: string, now = nowIso()): Promise<void> {
  await db().execute(
    `UPDATE command_code_auth_sessions
     SET status = 'expired', updated_at = $1
     WHERE state_hash = $2 AND status IN ('pending', 'received') AND expires_at <= $1`,
    [now, stateHash]
  );
}

export async function createPendingCommandCodeAuthSession(input: {
  stateHash: string;
  expiresAt: string;
}): Promise<CommandCodeAuthSafeStatus> {
  const row = await db().queryOne<AuthSessionRow>(
    `INSERT INTO command_code_auth_sessions (id, state_hash, status, expires_at)
     VALUES ($1, $2, 'pending', $3)
     RETURNING *`,
    [randomUUID(), input.stateHash, input.expiresAt]
  );
  if (!row) throw new Error("Failed to create Command Code auth session");
  return toSafeStatus(row);
}

export async function markCommandCodeAuthSessionReceived(input: {
  stateHash: string;
  apiKey: string;
  metadata?: CommandCodeAuthMetadata;
}): Promise<CommandCodeAuthSafeStatus | null> {
  const now = nowIso();
  await markExpiredForState(input.stateHash, now);
  const metadata: CommandCodeAuthMetadata = {
    ...(input.metadata || {}),
    receivedAt: now,
  };
  const encryptedApiKey = encrypt(input.apiKey);
  await db().execute(
    `UPDATE command_code_auth_sessions
     SET status = 'received', encrypted_api_key = $1, metadata = $2::jsonb, received_at = $3, updated_at = $3
     WHERE state_hash = $4 AND status IN ('pending', 'received') AND expires_at > $3`,
    [encryptedApiKey, JSON.stringify(metadata), now, input.stateHash]
  );

  return getCommandCodeAuthSessionSafeStatus(input.stateHash);
}

export async function getCommandCodeAuthSessionSafeStatus(
  stateHash: string
): Promise<CommandCodeAuthSafeStatus | null> {
  await markExpiredForState(stateHash);
  const row = await db().queryOne<AuthSessionRow>(
    "SELECT * FROM command_code_auth_sessions WHERE state_hash = $1",
    [stateHash]
  );
  return row ? toSafeStatus(row) : null;
}

export async function consumeCommandCodeAuthSecret(
  stateHash: string
): Promise<ConsumedCommandCodeAuthSecret | null> {
  return db().transaction(async (tx): Promise<ConsumedCommandCodeAuthSecret | null> => {
    const now = nowIso();
    await tx.execute(
      `UPDATE command_code_auth_sessions
       SET status = 'expired', updated_at = $1
       WHERE state_hash = $2 AND status IN ('pending', 'received') AND expires_at <= $1`,
      [now, stateHash]
    );

    // FOR UPDATE: two processes redeeming the same state cannot both read the secret.
    const row = await tx.queryOne<AuthSessionRow>(
      `SELECT * FROM command_code_auth_sessions
       WHERE state_hash = $1 AND status = 'received' AND expires_at > $2
         AND encrypted_api_key IS NOT NULL
       FOR UPDATE`,
      [stateHash, now]
    );
    if (!row?.encrypted_api_key) return null;

    const apiKey = decrypt(row.encrypted_api_key);
    if (!apiKey) return null;

    const result = await tx.execute(
      `UPDATE command_code_auth_sessions
       SET status = 'applied', encrypted_api_key = NULL, applied_at = $1, updated_at = $1
       WHERE id = $2 AND status = 'received'`,
      [now, row.id]
    );
    if (!result.changes) return null;

    return {
      ...toSafeStatus({
        ...row,
        status: "applied",
        encrypted_api_key: null,
        applied_at: now,
        updated_at: now,
      }),
      apiKey,
    };
  });
}
