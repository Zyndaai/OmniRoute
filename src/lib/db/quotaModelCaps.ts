/**
 * db/quotaModelCaps.ts — CRUD for quota_allocation_model_caps table.
 *
 * Per-(pool_id, api_key_id, model) budget caps for the Quota Share Engine.
 * Closes the "one key drains the pool on a single model" attack (Fase 3 #7).
 *
 * cap_unit aligns with QuotaUnit: "requests" | "tokens" | "usd" | "percent".
 * cap_value of ≤ Number.EPSILON is treated as a placeholder by the enforce
 * layer (not enforced), consistent with the planRegistry EPSILON convention.
 *
 * All SQL goes through parameterised statements — never raw string interpolation.
 * Caps belong to an allocation: the (pool_id, api_key_id) allocation row must
 * exist (foreign key), and deleting the allocation removes its caps.
 */

import { db } from "./pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QuotaUnit = "percent" | "requests" | "tokens" | "usd";

export interface ModelCap {
  poolId: string;
  apiKeyId: string;
  model: string;
  capValue: number;
  capUnit: QuotaUnit;
}

interface ModelCapRow {
  pool_id: string;
  api_key_id: string;
  model: string;
  cap_value: number;
  cap_unit: string;
}

function rowToModelCap(row: ModelCapRow): ModelCap {
  return {
    poolId: row.pool_id,
    apiKeyId: row.api_key_id,
    model: row.model,
    capValue: row.cap_value,
    capUnit: row.cap_unit as QuotaUnit,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the cap for a specific (pool, key, model) triple.
 * Returns null if no cap is configured.
 */
export async function getModelCap(
  poolId: string,
  apiKeyId: string,
  model: string
): Promise<ModelCap | null> {
  const row = await db().queryOne<ModelCapRow>(
    `SELECT pool_id, api_key_id, model, cap_value, cap_unit
     FROM quota_allocation_model_caps
     WHERE pool_id = $1 AND api_key_id = $2 AND model = $3`,
    [poolId, apiKeyId, model]
  );
  return row ? rowToModelCap(row) : null;
}

export async function setModelCap(cap: ModelCap): Promise<void> {
  await db().execute(
    `INSERT INTO quota_allocation_model_caps
       (pool_id, api_key_id, model, cap_value, cap_unit)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (pool_id, api_key_id, model) DO UPDATE SET
       cap_value = EXCLUDED.cap_value,
       cap_unit  = EXCLUDED.cap_unit`,
    [cap.poolId, cap.apiKeyId, cap.model, cap.capValue, cap.capUnit]
  );
}
