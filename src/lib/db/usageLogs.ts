/**
 * Read-only auto-routing aggregations over `call_logs`.
 * `requested_model` keeps the client auto/* id after routing resolves a target.
 */

import { db } from "@/lib/db/pg";

// ---------------------------------------------------------------------------
// Auto-routing analytics
// ---------------------------------------------------------------------------

export interface AutoRoutingTotalResult {
  count: number;
}

/**
 * Returns the number of call-log rows requested through auto/ prefix models.
 */
export async function getAutoRoutingTotalCount(): Promise<AutoRoutingTotalResult> {
  const row = await db().queryOne<AutoRoutingTotalResult>(
    `
      SELECT COUNT(*) as count
      FROM call_logs
      WHERE requested_model = 'auto' OR requested_model LIKE 'auto/%'
    `
  );
  return row ? { count: Number(row.count) } : { count: 0 };
}

export interface AutoRoutingVariantRow {
  variant: string;
  count: number;
}

/**
 * Returns per-variant request counts from the client-requested model id.
 */
export async function getAutoRoutingVariantBreakdown(): Promise<AutoRoutingVariantRow[]> {
  return db().query<AutoRoutingVariantRow>(
    `
      SELECT
        CASE
          WHEN requested_model = 'auto' THEN 'default'
          WHEN requested_model LIKE 'auto/%' THEN SUBSTR(requested_model, 6)
          ELSE 'other'
        END as variant,
        COUNT(*) as count
      FROM call_logs
      WHERE requested_model = 'auto' OR requested_model LIKE 'auto/%'
      GROUP BY variant
      ORDER BY count DESC
    `
  );
}

export interface AutoRoutingTopProviderRow {
  provider: string;
  count: number;
}

/**
 * Returns the top 10 providers used for auto/ prefix requests.
 */
export async function getAutoRoutingTopProviders(): Promise<AutoRoutingTopProviderRow[]> {
  return db().query<AutoRoutingTopProviderRow>(
    `
      SELECT provider, COUNT(*) as count
      FROM call_logs
      WHERE (requested_model = 'auto' OR requested_model LIKE 'auto/%')
        AND provider IS NOT NULL
        AND BTRIM(provider) != ''
      GROUP BY provider
      ORDER BY count DESC
      LIMIT 10
      `
  );
}
