/**
 * Database module: Discovery Results
 *
 * CRUD for the automated provider-discovery tool (opt-in, default off). Rows
 * live in the `discovery_results` table. The Discovery service
 * (`src/lib/discovery/`) writes findings here via {@link upsertDiscoveryResult};
 * the `/api/discovery/*` routes read/verify/delete them.
 */

import { db, jsonb } from "./pg";

export type DiscoveryMethod =
  | "free_tier"
  | "web_cookie"
  | "auto_register"
  | "trial"
  | "public_api";
export type DiscoveryAuthType = "none" | "cookie" | "api_key" | "oauth";
export type DiscoveryRiskLevel = "none" | "low" | "medium" | "high" | "critical";
export type DiscoveryStatus = "pending" | "testing" | "verified" | "rejected";

export interface DiscoveryResult {
  id?: number;
  providerId: string;
  method: DiscoveryMethod;
  endpoint?: string | null;
  authType: DiscoveryAuthType;
  models?: string[];
  rateLimit?: string | null;
  feasibility: number;
  riskLevel: DiscoveryRiskLevel;
  status: DiscoveryStatus;
  notes?: string | null;
  discoveredAt?: string;
  verifiedAt?: string | null;
}

interface DiscoveryRow {
  id: number;
  provider_id: string;
  method: string;
  endpoint: string | null;
  auth_type: string | null;
  models: unknown;
  rate_limit: string | null;
  feasibility: number | null;
  risk_level: string | null;
  status: string;
  notes: string | null;
  discovered_at: string;
  verified_at: string | null;
}

function rowToResult(row: DiscoveryRow): DiscoveryResult {
  let models: string[] | undefined;
  let parsed: unknown = row.models;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = undefined;
    }
  }
  if (Array.isArray(parsed)) models = parsed.map(String);
  return {
    id: Number(row.id),
    providerId: row.provider_id,
    method: row.method as DiscoveryMethod,
    endpoint: row.endpoint,
    authType: (row.auth_type as DiscoveryAuthType) ?? "none",
    models,
    rateLimit: row.rate_limit,
    feasibility: row.feasibility ?? 0,
    riskLevel: (row.risk_level as DiscoveryRiskLevel) ?? "none",
    status: row.status as DiscoveryStatus,
    notes: row.notes,
    discoveredAt: row.discovered_at,
    verifiedAt: row.verified_at,
  };
}

/**
 * Insert or update a discovery finding. Uniqueness is keyed on
 * `(provider_id, method, endpoint)` (NULLS NOT DISTINCT), so re-discovering the same
 * endpoint updates the existing row rather than duplicating it. Returns the persisted
 * row (with its id).
 */
export async function upsertDiscoveryResult(result: DiscoveryResult): Promise<DiscoveryResult> {
  const feasibility =
    Number.isFinite(result.feasibility) && result.feasibility >= 1 && result.feasibility <= 5
      ? Math.round(result.feasibility)
      : null;
  const row = await db().queryOne<DiscoveryRow>(
    `INSERT INTO discovery_results
       (provider_id, method, endpoint, auth_type, models, rate_limit, feasibility, risk_level, status, notes)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (provider_id, method, endpoint) DO UPDATE SET
       auth_type = EXCLUDED.auth_type,
       models = EXCLUDED.models,
       rate_limit = EXCLUDED.rate_limit,
       feasibility = EXCLUDED.feasibility,
       risk_level = EXCLUDED.risk_level,
       status = EXCLUDED.status,
       notes = EXCLUDED.notes
     RETURNING *`,
    [
      result.providerId,
      result.method,
      result.endpoint ?? null,
      result.authType,
      result.models ? jsonb(result.models) : null,
      result.rateLimit ?? null,
      feasibility,
      result.riskLevel,
      result.status,
      result.notes ?? null,
    ]
  );
  return rowToResult(row!);
}

/**
 * List discovery results, optionally filtered to a single provider. Newest
 * findings first.
 */
export async function getDiscoveryResults(providerId?: string): Promise<DiscoveryResult[]> {
  const rows = providerId
    ? await db().query<DiscoveryRow>(
        `SELECT * FROM discovery_results WHERE provider_id = $1 ORDER BY discovered_at DESC, id DESC`,
        [providerId]
      )
    : await db().query<DiscoveryRow>(
        `SELECT * FROM discovery_results ORDER BY discovered_at DESC, id DESC`
      );
  return rows.map(rowToResult);
}

export async function getDiscoveryResultById(id: number): Promise<DiscoveryResult | null> {
  if (!Number.isSafeInteger(id)) return null;
  const row = await db().queryOne<DiscoveryRow>(`SELECT * FROM discovery_results WHERE id = $1`, [
    id,
  ]);
  return row ? rowToResult(row) : null;
}

/**
 * Mark a finding as verified, stamping `verified_at`. Returns the updated row,
 * or null if no row with that id exists.
 */
export async function markVerified(id: number): Promise<DiscoveryResult | null> {
  if (!Number.isSafeInteger(id)) return null;
  const row = await db().queryOne<DiscoveryRow>(
    `UPDATE discovery_results SET status = 'verified', verified_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return row ? rowToResult(row) : null;
}

/**
 * Delete a finding. Returns true if a row was removed, false if the id was not
 * found.
 */
export async function deleteDiscoveryResult(id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id)) return false;
  const info = await db().execute(`DELETE FROM discovery_results WHERE id = $1`, [id]);
  return info.changes > 0;
}
