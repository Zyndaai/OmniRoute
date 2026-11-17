/**
 * db/modelPricing.ts — the `model_pricing` table: one row per (source, provider) holding
 * that provider's `{modelId: {input, output, ...}}` price table. Sources are the three
 * price layers: operator overrides (`user`), the LiteLLM sync (`litellm`) and the
 * models.dev sync (`models_dev`).
 */

import { db, jsonb, type DbExecutor } from "./pg";

export type PricingSourceName = "user" | "litellm" | "models_dev";
export type PricingRows = Record<string, Record<string, Record<string, unknown>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every provider's price table of one source. Rows that are not objects are skipped. */
export async function readPricingSource(
  source: PricingSourceName,
  ex: DbExecutor = db()
): Promise<PricingRows> {
  const rows = await ex.query<{ provider: string; models: unknown }>(
    "SELECT provider, models FROM model_pricing WHERE source = $1",
    [source]
  );
  const result: PricingRows = {};
  for (const row of rows) {
    if (isRecord(row.models)) result[row.provider] = row.models as PricingRows[string];
  }
  return result;
}

/** One provider's price table of one source, or `undefined` when it has no row. */
export async function readPricingProvider(
  source: PricingSourceName,
  provider: string,
  ex: DbExecutor = db()
): Promise<Record<string, Record<string, unknown>> | undefined> {
  const row = await ex.queryOne<{ models: unknown }>(
    "SELECT models FROM model_pricing WHERE source = $1 AND provider = $2",
    [source, provider]
  );
  return row && isRecord(row.models)
    ? (row.models as Record<string, Record<string, unknown>>)
    : undefined;
}

export async function writePricingProvider(
  source: PricingSourceName,
  provider: string,
  models: unknown,
  ex: DbExecutor = db()
): Promise<void> {
  await ex.execute(
    `INSERT INTO model_pricing (source, provider, models) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (source, provider) DO UPDATE SET models = EXCLUDED.models, updated_at = now()`,
    [source, provider, jsonb(models)]
  );
}

/** Replace the whole source with `data` in one transaction. */
export async function replacePricingSource(
  source: PricingSourceName,
  data: PricingRows
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.execute("DELETE FROM model_pricing WHERE source = $1", [source]);
    const providers = Object.keys(data);
    if (providers.length === 0) return;
    await tx.execute(
      `INSERT INTO model_pricing (source, provider, models)
       SELECT $1, p, m::jsonb FROM unnest($2::text[], $3::text[]) AS t(p, m)`,
      [source, providers, providers.map((provider) => JSON.stringify(data[provider]))]
    );
  });
}

export async function deletePricingProvider(
  source: PricingSourceName,
  provider: string,
  ex: DbExecutor = db()
): Promise<void> {
  await ex.execute("DELETE FROM model_pricing WHERE source = $1 AND provider = $2", [
    source,
    provider,
  ]);
}

export async function clearPricingSource(source: PricingSourceName): Promise<number> {
  const { changes } = await db().execute("DELETE FROM model_pricing WHERE source = $1", [source]);
  return changes;
}
