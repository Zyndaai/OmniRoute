/**
 * db/models/catalogRow.ts — column-scoped access to `provider_model_catalog`.
 *
 * One row per provider holds three independent documents (`custom_models`,
 * `compat_overrides`, `provider_aliases`). A write touches only its own column; clearing a
 * document sets it to its empty value and never deletes the row, so the other two survive.
 */

import { db, type DbExecutor } from "../pg";
import { jsonValueParam } from "../pgJsonText";

export type CatalogColumn = "custom_models" | "compat_overrides" | "provider_aliases";

/** Column name is interpolated into SQL: it must come from this closed set. */
const COLUMNS: ReadonlySet<string> = new Set<CatalogColumn>([
  "custom_models",
  "compat_overrides",
  "provider_aliases",
]);

function assertColumn(column: CatalogColumn): void {
  if (!COLUMNS.has(column)) throw new Error(`Invalid provider_model_catalog column: ${column}`);
}

/** The parsed document, or `undefined` when the provider has no catalog row. */
export async function readCatalogColumn(
  column: CatalogColumn,
  provider: string,
  ex: DbExecutor = db()
): Promise<unknown> {
  assertColumn(column);
  const row = await ex.queryOne<{ v: unknown }>(
    `SELECT ${column} AS v FROM provider_model_catalog WHERE provider = $1`,
    [provider]
  );
  return row?.v;
}

/** Every provider's document for one column, skipping providers where it is empty. */
export async function readAllCatalogColumn(
  column: CatalogColumn
): Promise<Array<{ provider: string; value: unknown }>> {
  assertColumn(column);
  const nonEmpty = `${column} <> '${column === "provider_aliases" ? "{}" : "[]"}'::jsonb`;
  const rows = await db().query<{ provider: string; v: unknown }>(
    `SELECT provider, ${column} AS v FROM provider_model_catalog WHERE ${nonEmpty}`
  );
  return rows.map((row) => ({ provider: row.provider, value: row.v }));
}

export type CatalogMutation<T> = { skip: true; result: T } | { skip?: false; value: unknown; result: T };

/**
 * Read-modify-write of one document under a row lock. `mutate` receives the current
 * document (`undefined` when there is no row) and must be pure: when the row does not exist
 * yet and a write is needed, the row is created and `mutate` runs again on the locked row,
 * so two concurrent first writes cannot lose each other's edit.
 */
export async function updateCatalogColumn<T>(
  column: CatalogColumn,
  provider: string,
  mutate: (current: unknown) => CatalogMutation<T>
): Promise<T> {
  assertColumn(column);
  const selectSql = `SELECT ${column} AS v FROM provider_model_catalog WHERE provider = $1 FOR UPDATE`;
  const updateSql = `UPDATE provider_model_catalog SET ${column} = $2::jsonb, updated_at = now() WHERE provider = $1`;
  return db().transaction(async (tx) => {
    let row = await tx.queryOne<{ v: unknown }>(selectSql, [provider]);
    let outcome = mutate(row?.v);
    if (!row) {
      if (outcome.skip) return outcome.result;
      await tx.execute(
        "INSERT INTO provider_model_catalog (provider) VALUES ($1) ON CONFLICT (provider) DO NOTHING",
        [provider]
      );
      row = await tx.queryOne<{ v: unknown }>(selectSql, [provider]);
      outcome = mutate(row?.v);
    }
    if ("value" in outcome) await tx.execute(updateSql, [provider, jsonValueParam(outcome.value)]);
    return outcome.result;
  });
}

/** Set a document unconditionally (upsert of its own column only). */
export async function writeCatalogColumn(
  column: CatalogColumn,
  provider: string,
  value: unknown,
  ex: DbExecutor = db()
): Promise<void> {
  assertColumn(column);
  await ex.execute(
    `INSERT INTO provider_model_catalog (provider, ${column}) VALUES ($1, $2::jsonb)
     ON CONFLICT (provider) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()`,
    [provider, jsonValueParam(value)]
  );
}

export function emptyCatalogValue(column: CatalogColumn): unknown {
  return column === "provider_aliases" ? {} : [];
}
