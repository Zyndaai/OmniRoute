import { db, ts } from "./pg";

export interface ConnectionRuntimeState {
  connectionId: string;
  /** The refresh circuit columns were dead and are gone: always 0 / null. */
  refreshCircuitStreak: number;
  refreshCircuitUntil: string | null;
  refreshLastFailAt: string | null;
  warmupCircuitStreak: number;
  warmupCircuitUntil: string | null;
  warmupLastFailAt: string | null;
  lastWarmupAt: string | null;
  lastWarmupResult: string | null;
  warmupTokensUsed: number;
  updatedAt: string;
}

function mapRow(row: any): ConnectionRuntimeState {
  return {
    connectionId: row.connection_id,
    refreshCircuitStreak: 0,
    refreshCircuitUntil: null,
    refreshLastFailAt: null,
    warmupCircuitStreak: row.warmup_circuit_streak ?? 0,
    warmupCircuitUntil: row.warmup_circuit_until,
    warmupLastFailAt: row.warmup_last_fail_at,
    lastWarmupAt: row.last_warmup_at,
    lastWarmupResult: row.last_warmup_result,
    warmupTokensUsed: row.warmup_tokens_used ?? 0,
    updatedAt: row.updated_at,
  };
}

export async function getConnectionRuntimeState(
  connectionId: string
): Promise<ConnectionRuntimeState | null> {
  const row = await db().queryOne(
    "SELECT * FROM connection_runtime_state WHERE connection_id = $1",
    [connectionId]
  );
  return row ? mapRow(row) : null;
}

export async function upsertWarmupState(
  connectionId: string,
  state: { lastWarmupAt: string; lastResult: string; tokensUsed: number }
): Promise<void> {
  await db().execute(
    `INSERT INTO connection_runtime_state (connection_id, last_warmup_at, last_warmup_result, warmup_tokens_used, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (connection_id) DO UPDATE SET
       last_warmup_at = EXCLUDED.last_warmup_at,
       last_warmup_result = EXCLUDED.last_warmup_result,
       warmup_tokens_used = EXCLUDED.warmup_tokens_used,
       updated_at = now()`,
    [connectionId, ts(state.lastWarmupAt), state.lastResult, Math.round(state.tokensUsed)]
  );
}

export async function upsertWarmupCircuit(
  connectionId: string,
  circuit: { streak: number; until: string; lastFailAt: string }
): Promise<void> {
  await db().execute(
    `INSERT INTO connection_runtime_state (connection_id, warmup_circuit_streak, warmup_circuit_until, warmup_last_fail_at, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (connection_id) DO UPDATE SET
       warmup_circuit_streak = EXCLUDED.warmup_circuit_streak,
       warmup_circuit_until = EXCLUDED.warmup_circuit_until,
       warmup_last_fail_at = EXCLUDED.warmup_last_fail_at,
       updated_at = now()`,
    [connectionId, Math.round(circuit.streak), ts(circuit.until), ts(circuit.lastFailAt)]
  );
}

export async function clearWarmupCircuit(connectionId: string): Promise<void> {
  await db().execute(
    `UPDATE connection_runtime_state
     SET warmup_circuit_streak = 0, warmup_circuit_until = NULL, warmup_last_fail_at = NULL, updated_at = now()
     WHERE connection_id = $1`,
    [connectionId]
  );
}

export async function markForbidden(connectionId: string, at: string): Promise<void> {
  await db().execute(
    `INSERT INTO connection_runtime_state (connection_id, last_warmup_result, last_warmup_at, updated_at)
     VALUES ($1, 'forbidden', $2, now())
     ON CONFLICT (connection_id) DO UPDATE SET
       last_warmup_result = 'forbidden',
       last_warmup_at = EXCLUDED.last_warmup_at,
       updated_at = now()`,
    [connectionId, ts(at)]
  );
}
