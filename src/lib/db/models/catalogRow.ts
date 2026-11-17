/**
 * db/models/catalogRow.ts — column-scoped access to `provider_model_catalog`.
 *
 * One row per provider holds three independent documents (`custom_models`,
 * `compat_overrides`, `provider_aliases`). A write touches only its own column; clearing a
 * document sets it to its empty value and never deletes the row, so the other two survive.
 */

import { db, type DbExecutor } from "../pg";
import { jsonValueParam } from "../pgJsonText";
import { invalidateModelMetadataSnapshots, loadModelMetadataSnapshot } from "../readCache";

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

type CatalogRow = Record<CatalogColumn, unknown>;

/**
 * The whole table (one small row per provider), shared until a model-metadata write or the
 * snapshot TTL; see loadModelMetadataSnapshot. Read paths hand out clones of its documents.
 */
function catalogSnapshot(): Promise<Map<string, CatalogRow>> {
  return loadModelMetadataSnapshot("provider_model_catalog", async () => {
    const rows = await db().query<CatalogRow & { provider: string }>(
      "SELECT provider, custom_models, compat_overrides, provider_aliases " +
        "FROM provider_model_catalog ORDER BY provider"
    );
    return new Map(rows.map(({ provider, ...docs }) => [provider, docs]));
  });
}

/**
 * The writes below run through these so a read never serves a pre-write snapshot. Only the
 * snapshot is dropped: the /v1/models catalog version stays with the callers, which already
 * bump it once per write (finishModelCatalogWriteWithoutBackup).
 */
function catalogWritten(): void {
  invalidateModelMetadataSnapshots();
}

/**
 * The parsed document, or `undefined` when the provider has no catalog row. With an explicit
 * executor (a transaction) it reads the row itself; otherwise it answers from the snapshot.
 */
export async function readCatalogColumn(
  column: CatalogColumn,
  provider: string,
  ex?: DbExecutor
): Promise<unknown> {
  assertColumn(column);
  if (ex) {
    const row = await ex.queryOne<{ v: unknown }>(
      `SELECT ${column} AS v FROM provider_model_catalog WHERE provider = $1`,
      [provider]
    );
    return row?.v;
  }
  const row = (await catalogSnapshot()).get(provider);
  return row ? structuredClone(row[column]) : undefined;
}

/** jsonb `<> '[]'` / `<> '{}'` of the old SQL filter: NULL and the empty document are skipped. */
function isEmptyDocument(column: CatalogColumn, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (column === "provider_aliases") {
    return typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  }
  return Array.isArray(value) && value.length === 0;
}

/** Every provider's document for one column, skipping providers where it is empty. */
export async function readAllCatalogColumn(
  column: CatalogColumn
): Promise<Array<{ provider: string; value: unknown }>> {
  assertColumn(column);
  const out: Array<{ provider: string; value: unknown }> = [];
  for (const [provider, row] of await catalogSnapshot()) {
    if (!isEmptyDocument(column, row[column])) {
      out.push({ provider, value: structuredClone(row[column]) });
    }
  }
  return out;
}

export type CatalogMutation<T> =
  { skip: true; result: T } | { skip?: false; value: unknown; result: T };

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
  let wrote = false;
  const result = await db().transaction(async (tx) => {
    let row = await tx.queryOne<{ v: unknown }>(selectSql, [provider]);
    let outcome = mutate(row?.v);
    if (!row) {
      if (outcome.skip) return outcome.result;
      await tx.execute(
        "INSERT INTO provider_model_catalog (provider) VALUES ($1) ON CONFLICT (provider) DO NOTHING",
        [provider]
      );
      wrote = true;
      row = await tx.queryOne<{ v: unknown }>(selectSql, [provider]);
      outcome = mutate(row?.v);
    }
    if ("value" in outcome) {
      await tx.execute(updateSql, [provider, jsonValueParam(outcome.value)]);
      wrote = true;
    }
    return outcome.result;
  });
  // After the commit: invalidating inside the transaction would let a concurrent read cache
  // the pre-commit row under the new version.
  if (wrote) catalogWritten();
  return result;
}

/**
 * Set a document unconditionally (upsert of its own column only). A caller passing its own
 * transaction must call {@link invalidateCatalogSnapshot} after that transaction commits.
 */
export async function writeCatalogColumn(
  column: CatalogColumn,
  provider: string,
  value: unknown,
  ex?: DbExecutor
): Promise<void> {
  assertColumn(column);
  await (ex ?? db()).execute(
    `INSERT INTO provider_model_catalog (provider, ${column}) VALUES ($1, $2::jsonb)
     ON CONFLICT (provider) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()`,
    [provider, jsonValueParam(value)]
  );
  if (!ex) catalogWritten();
}

/** For writers that change `provider_model_catalog` outside this module, after their commit. */
export function invalidateCatalogSnapshot(): void {
  catalogWritten();
}

export function emptyCatalogValue(column: CatalogColumn): unknown {
  return column === "provider_aliases" ? {} : [];
}
