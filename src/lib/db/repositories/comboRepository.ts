/**
 * PostgreSQL implementation of the combo repository contract.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  ComboReorderResult,
  ComboRepository,
  ComboUpdateResult,
} from "@/domain/persistence/comboRepositories";
import { normalizeComboRecord } from "@/lib/combos/steps";
import { validateComboInvariant } from "@/lib/combos/invariants";
import { db, jsonb, ts, type DbExecutor } from "../pg";
import { bumpProxyRegistryGeneration } from "../proxies/registryGeneration";
import { revokeComboGrantsByName } from "../apiKeys/comboGrantRevocation";

type JsonRecord = Record<string, unknown>;

/** Deletes a combo's LKGP pins (`<combo>:<model>` keys); LIKE wildcards in the name are escaped. */
async function deleteLKGPPinsByComboName(ex: DbExecutor, comboName: string): Promise<string[]> {
  const pattern = `${`${comboName}:`.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const rows = await ex.query<{ pin_key: string }>(
    "DELETE FROM lkgp_pins WHERE pin_key LIKE $1 ESCAPE '\\' RETURNING pin_key",
    [pattern]
  );
  return rows.map((row) => row.pin_key);
}

interface ComboRow {
  id: string;
  name?: string;
  data: unknown;
  sort_order: number | null;
  context_cache_protection: boolean | null;
}

const COMBO_COLUMNS = "id, name, data, sort_order, context_cache_protection";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** `data` is jsonb (already an object); tolerate a JSON string from legacy callers. */
function parseData(value: unknown): JsonRecord | null {
  if (typeof value === "string") {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonRecord)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonRecord) }
    : null;
}

/**
 * The row's primary key and sort_order are authoritative over any stale id or
 * sortOrder persisted inside the data JSON (e.g. from duplication or import).
 */
function parseComboRow(row: ComboRow | undefined | null): JsonRecord | null {
  if (!row) return null;
  const parsed = parseData(row.data);
  if (!parsed) return null;
  if (typeof row.sort_order === "number") parsed.sortOrder = row.sort_order;
  if (typeof row.id === "string" && row.id.trim().length > 0) parsed.id = row.id;
  // The column is authoritative when enabled; when false keep the JSON value so a
  // pre-column blob is not silently disabled.
  if (row.context_cache_protection === true) parsed.context_cache_protection = true;
  return parsed;
}

async function getComboNameSet(ex: DbExecutor, extraNames: string[] = []): Promise<Set<string>> {
  const rows = await ex.query<{ name: string }>("SELECT name FROM combos");
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string" && row.name.trim().length > 0) names.add(row.name.trim());
  }
  for (const name of extraNames) {
    if (typeof name === "string" && name.trim().length > 0) names.add(name.trim());
  }
  return names;
}

async function normalizeStoredCombo(
  combo: JsonRecord,
  ex: DbExecutor,
  extraNames: string[] = []
): Promise<JsonRecord> {
  return normalizeComboRecord(combo, {
    allCombos: await getComboNameSet(ex, extraNames),
  }) as JsonRecord;
}

async function getNextSortOrder(ex: DbExecutor): Promise<number> {
  const row = await ex.queryOne<{ sort_order: number }>(
    "SELECT COALESCE(MAX(sort_order), 0) AS sort_order FROM combos"
  );
  return (row?.sort_order ?? 0) + 1;
}

export async function getCombos(limit?: number, offset?: number) {
  let sql = `SELECT ${COMBO_COLUMNS} FROM combos ORDER BY sort_order ASC, lower(name) ASC, name ASC`;
  const params: unknown[] = [];
  if (limit !== undefined) {
    sql += " LIMIT $1 OFFSET $2";
    params.push(limit, offset ?? 0);
  }
  const rows = await db().query<ComboRow>(sql, params);
  const rawCombos = rows
    .map((row) => parseComboRow(row))
    .filter((row): row is JsonRecord => row !== null);

  const comboNames = rawCombos
    .map((combo) => (typeof combo.name === "string" ? combo.name.trim() : ""))
    .filter((name): name is string => name.length > 0);

  return rawCombos.map((combo) =>
    normalizeComboRecord(combo, {
      allCombos: comboNames,
    })
  );
}

export async function getCombosCount(): Promise<number> {
  const row = await db().queryOne<{ cnt: number }>("SELECT count(*) AS cnt FROM combos");
  return row?.cnt ?? 0;
}

export async function getComboById(id: string) {
  const row = await db().queryOne<ComboRow>(`SELECT ${COMBO_COLUMNS} FROM combos WHERE id = $1`, [
    id,
  ]);
  const combo = parseComboRow(row);
  if (!combo) return null;
  return normalizeStoredCombo(combo, db(), typeof combo.name === "string" ? [combo.name] : []);
}

// Combo names are unique case-insensitively (unique index on lower(name)), so one
// lookup covers the old exact-then-NOCASE two-step (#4446: the opencode dispatch path
// forwards a lowercased slug for a combo provisioned as "MASTER-LIGHT").
export async function getComboByName(name: string) {
  const row = await db().queryOne<ComboRow>(
    `SELECT ${COMBO_COLUMNS} FROM combos WHERE lower(name) = lower($1)`,
    [name]
  );
  const combo = parseComboRow(row);
  if (!combo) return null;
  return normalizeStoredCombo(combo, db(), [typeof combo.name === "string" ? combo.name : name]);
}

export async function createCombo(data: JsonRecord) {
  const now = new Date().toISOString();
  return db().transaction(async (tx) => {
    const sortOrder =
      typeof data.sortOrder === "number" ? data.sortOrder : await getNextSortOrder(tx);
    const comboId = typeof data.id === "string" && data.id.trim().length > 0 ? data.id : uuidv4();
    const combo = await normalizeStoredCombo(
      {
        ...data,
        id: comboId,
        name: data.name,
        models: data.models || [],
        strategy: data.strategy || "priority",
        config: data.config || {},
        isHidden: Boolean(data.isHidden),
        sortOrder,
        createdAt: now,
        updatedAt: now,
      },
      tx,
      typeof data.name === "string" ? [data.name] : []
    );

    validateComboInvariant(combo);
    await tx.execute(
      `INSERT INTO combos (id, name, data, sort_order, created_at, updated_at, context_cache_protection)
       VALUES ($1, $2, $3::jsonb, $4, $5, $5, $6)`,
      [combo.id, combo.name, jsonb(combo), sortOrder, ts(now), Boolean(data.context_cache_protection)]
    );
    return combo;
  });
}

export async function updateCombo(id: string, data: JsonRecord): Promise<ComboUpdateResult | null> {
  return db().transaction(async (tx) => {
    // Whole-document read-modify-write of combos.data: lock the row for the duration.
    const existing = await tx.queryOne<ComboRow>(
      `SELECT ${COMBO_COLUMNS} FROM combos WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!existing) return null;

    const current = parseComboRow(existing);
    if (!current) return null;
    const sortOrder =
      typeof data.sortOrder === "number"
        ? data.sortOrder
        : typeof current.sortOrder === "number"
          ? current.sortOrder
          : await getNextSortOrder(tx);
    const merged: JsonRecord = {
      ...current,
      ...data,
      sortOrder,
      updatedAt: new Date().toISOString(),
    };
    // Remove fields explicitly set to null (for deletion support)
    for (const key of Object.keys(data)) {
      if (data[key] === null) {
        delete merged[key];
      }
    }
    const currentName = typeof current.name === "string" ? current.name : "";
    const nextName =
      typeof merged["name"] === "string" && merged["name"].trim().length > 0
        ? merged["name"]
        : currentName;
    const normalizedMerged = await normalizeStoredCombo({ ...merged, name: nextName }, tx, [
      nextName,
    ]);
    validateComboInvariant({
      ...normalizedMerged,
      ...data,
      name: nextName,
      models: normalizedMerged.models,
    });

    await tx.execute(
      `UPDATE combos
          SET name = $1, data = $2::jsonb, sort_order = $3, updated_at = $4,
              context_cache_protection = $5
        WHERE id = $6`,
      [
        nextName,
        jsonb(normalizedMerged),
        sortOrder,
        ts(normalizedMerged.updatedAt as string),
        Boolean(normalizedMerged.context_cache_protection),
        id,
      ]
    );

    return {
      combo: normalizedMerged,
      previousName: currentName,
      currentName: nextName,
      modelsFieldProvided: data.models !== undefined,
    };
  });
}

export async function reorderCombos(comboIds: string[]): Promise<ComboReorderResult> {
  const rowsReordered = await db().transaction(async (tx) => {
    const rows = await tx.query<ComboRow>(
      `SELECT ${COMBO_COLUMNS} FROM combos ORDER BY sort_order ASC, lower(name) ASC, name ASC FOR UPDATE`
    );
    if (rows.length === 0) return 0;

    const existingIds = new Set(rows.map((row) => row.id));
    const seen = new Set<string>();
    const requestedIds = comboIds.filter((id) => {
      if (!existingIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const orderedIds = [...requestedIds, ...rows.map((row) => row.id).filter((id) => !seen.has(id))];

    const now = new Date().toISOString();
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const comboNames = rows
      .map((row) => {
        const combo = parseComboRow(row);
        return combo && typeof combo.name === "string" ? combo.name.trim() : "";
      })
      .filter((name): name is string => name.length > 0);

    for (const [index, id] of orderedIds.entries()) {
      const combo = parseComboRow(rowById.get(id));
      if (!combo) continue;
      const sortOrder = index + 1;
      const updatedCombo = normalizeComboRecord(
        { ...combo, sortOrder, updatedAt: now },
        { allCombos: comboNames }
      );
      await tx.execute(
        "UPDATE combos SET data = $1::jsonb, sort_order = $2, updated_at = $3 WHERE id = $4",
        [jsonb(updatedCombo), sortOrder, ts(now), id]
      );
    }
    return orderedIds.length;
  });

  if (rowsReordered === 0) return { combos: [], rowsReordered: 0 };
  return { combos: await getCombos(), rowsReordered };
}

export async function deleteCombo(id: string) {
  const outcome = await db().transaction(async (tx) => {
    const combo = await tx.queryOne<{ name: string }>("SELECT name FROM combos WHERE id = $1", [
      id,
    ]);
    const result = await tx.execute("DELETE FROM combos WHERE id = $1", [id]);
    if (result.changes === 0) {
      return {
        deleted: false,
        purged: 0,
        revokedKeys: 0,
        name: null as string | null,
        lkgpKeys: [] as string[],
      };
    }
    // routing_combo_id holds a combo id or a combo name, so it has no FK: drop both.
    await tx.execute(
      "DELETE FROM compression_combo_assignments WHERE routing_combo_id = $1 OR routing_combo_id = $2",
      [id, combo?.name ?? id]
    );
    // Purge the combo's proxy assignments and rotation cursor with the combo row
    // (#14553): orphaned proxy_assignments rows would keep answering for a scope_id
    // that no longer exists.
    const purged = (
      await tx.execute("DELETE FROM proxy_assignments WHERE scope = 'combo' AND scope_id = $1", [
        id,
      ])
    ).changes;
    await tx.execute("DELETE FROM proxy_scope_rotation WHERE scope = 'combo' AND scope_id = $1", [
      id,
    ]);
    // Grants are stored by name: revoke them with the row, or a combo recreated
    // under the same name would inherit every key's old grant.
    const revokedKeys = combo?.name ? (await revokeComboGrantsByName(tx, combo.name)).length : 0;
    // Pins go with the row (same transaction), or a recreated combo would inherit them.
    const lkgpKeys = combo?.name ? await deleteLKGPPinsByComboName(tx, combo.name) : [];
    return { deleted: true, purged, revokedKeys, name: combo?.name ?? null, lkgpKeys };
  });

  if (!outcome.deleted) return false;

  const lkgpKeys = outcome.lkgpKeys ?? [];

  if (outcome.revokedKeys > 0) {
    const { clearApiKeyCaches } = await import("../apiKeys");
    const { invalidateModelCatalogCache } = await import("../readCache");
    clearApiKeyCaches();
    invalidateModelCatalogCache();
  }

  if (outcome.purged > 0) {
    bumpProxyRegistryGeneration();
  }

  if (lkgpKeys.length > 0) {
    const { invalidateCachedLKGP } = await import("../readCache");
    for (const key of lkgpKeys) {
      invalidateCachedLKGP(key);
    }
  }

  return true;
}

export const comboRepository: ComboRepository = {
  list: getCombos,
  count: getCombosCount,
  findById: getComboById,
  findByName: getComboByName,
  create: createCombo,
  update: updateCombo,
  reorder: reorderCombos,
  deleteById: deleteCombo,
};
