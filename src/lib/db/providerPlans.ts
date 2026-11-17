/**
 * db/providerPlans.ts — CRUD for provider_plans table.
 *
 * Stores per-connection quota dimension plans (manual overrides or auto-
 * detected). `dimensions` is a jsonb QuotaDimension[] array that arrives parsed.
 * A plan belongs to its connection: deleting the connection removes the plan.
 *
 * Part of: Group B — Quota Sharing Engine (plan 22, frente F2).
 */

import { db, jsonb } from "./pg";

// ---------------------------------------------------------------------------
// Local type shapes (aligned with src/lib/quota/dimensions.ts — merged by F7)
// ---------------------------------------------------------------------------

type QuotaUnit = "percent" | "requests" | "tokens" | "usd";
type QuotaWindow = "5h" | "hourly" | "daily" | "weekly" | "monthly";

export interface QuotaDimension {
  unit: QuotaUnit;
  window: QuotaWindow;
  limit: number;
}

export interface ProviderPlan {
  connectionId: string | null;
  provider: string;
  dimensions: QuotaDimension[];
  source: "auto" | "manual";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PlanRow {
  connection_id: string;
  provider: string;
  dimensions: unknown;
  source: string;
  updated_at: string;
}

function rowToPlan(row: PlanRow): ProviderPlan {
  let dimensions: QuotaDimension[] = [];
  if (Array.isArray(row.dimensions)) {
    dimensions = row.dimensions as QuotaDimension[];
  } else if (typeof row.dimensions === "string") {
    // Tolerate a double-encoded legacy value; malformed JSON reads as empty.
    try {
      const parsed = JSON.parse(row.dimensions);
      if (Array.isArray(parsed)) dimensions = parsed as QuotaDimension[];
    } catch {
      dimensions = [];
    }
  }
  return {
    connectionId: row.connection_id,
    provider: row.provider,
    dimensions,
    source: row.source as "auto" | "manual",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the plan for a specific provider connection, or null if not found.
 */
export async function getPlan(connectionId: string): Promise<ProviderPlan | null> {
  const row = await db().queryOne<PlanRow>(
    `SELECT connection_id, provider, dimensions, source, updated_at
     FROM provider_plans WHERE connection_id = $1`,
    [connectionId]
  );
  return row ? rowToPlan(row) : null;
}

/**
 * List all provider plans stored in the DB.
 */
export async function listPlans(): Promise<ProviderPlan[]> {
  const rows = await db().query<PlanRow>(
    `SELECT connection_id, provider, dimensions, source, updated_at
     FROM provider_plans ORDER BY provider ASC, connection_id ASC`
  );
  return rows.map(rowToPlan);
}

/**
 * Upsert a provider plan. If a row for connectionId already exists it is
 * replaced (ON CONFLICT DO UPDATE).
 *
 * @param connectionId Unique provider connection identifier.
 * @param provider     Provider name (e.g. "codex", "kimi").
 * @param dimensions   Array of QuotaDimension objects.
 * @param source       "auto" = detected at runtime; "manual" = operator config.
 */
export async function upsertPlan(
  connectionId: string,
  provider: string,
  dimensions: QuotaDimension[],
  source: "auto" | "manual"
): Promise<void> {
  await db().execute(
    `INSERT INTO provider_plans (connection_id, provider, dimensions, source, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (connection_id)
     DO UPDATE SET
       provider = EXCLUDED.provider,
       dimensions = EXCLUDED.dimensions,
       source = EXCLUDED.source,
       updated_at = now()`,
    [connectionId, provider, jsonb(dimensions), source]
  );
}

/**
 * Delete the plan for a connection (clears override, falls back to auto/catalog).
 * Returns true if a row was deleted, false if not found.
 */
export async function deletePlan(connectionId: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM provider_plans WHERE connection_id = $1", [
    connectionId,
  ]);
  return result.changes > 0;
}
