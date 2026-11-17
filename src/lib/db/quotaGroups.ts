/**
 * db/quotaGroups.ts — CRUD for the quota_groups table.
 *
 * Quota groups are first-class entities that pool multiple quota pools
 * under a shared namespace. Pools reference groups via quota_pools.group_id.
 *
 * All SQL goes through parameterised statements — never raw string interpolation.
 */

import { db } from "./pg";
import { invalidateModelCatalogCache } from "./readCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuotaGroup {
  id: string;
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GroupRow {
  id: string;
  name: string;
  created_at: string;
}

function rowToGroup(row: GroupRow): QuotaGroup {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
}

function makeId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new quota group with the given name.
 * Returns the newly created QuotaGroup row.
 */
export async function createGroup(name: string): Promise<QuotaGroup> {
  const id = makeId();
  const row = await db().queryOne<GroupRow>(
    "INSERT INTO quota_groups (id, name) VALUES ($1, $2) RETURNING id, name, created_at",
    [id, name]
  );
  return row ? rowToGroup(row) : { id, name, createdAt: new Date().toISOString() };
}

/**
 * Get a single quota group by id.
 * Returns null if not found.
 */
export async function getGroup(id: string): Promise<QuotaGroup | null> {
  const row = await db().queryOne<GroupRow>(
    "SELECT id, name, created_at FROM quota_groups WHERE id = $1",
    [id]
  );
  return row ? rowToGroup(row) : null;
}

/**
 * Convenience helper — returns just the group name, or null if not found.
 */
export async function getGroupName(id: string): Promise<string | null> {
  const row = await db().queryOne<{ name: string }>(
    "SELECT name FROM quota_groups WHERE id = $1",
    [id]
  );
  return row ? row.name : null;
}

/**
 * List all quota groups, ordered by created_at ascending.
 */
export async function listGroups(): Promise<QuotaGroup[]> {
  const rows = await db().query<GroupRow>(
    "SELECT id, name, created_at FROM quota_groups ORDER BY created_at ASC, id ASC"
  );
  return rows.map(rowToGroup);
}

/**
 * Rename an existing group.
 * Returns true if the row was updated, false if the group was not found.
 */
export async function renameGroup(id: string, name: string): Promise<boolean> {
  const result = await db().execute("UPDATE quota_groups SET name = $1 WHERE id = $2", [name, id]);
  if (result.changes > 0) {
    invalidateModelCatalogCache();
    return true;
  }
  return false;
}

/**
 * Delete a quota group by id.
 *
 * Throws if:
 * - The group is the protected seed 'group-demo' — it must always exist.
 * - Any quota_pools row still references this group via group_id — the caller
 *   must reassign or delete those pools first.
 *
 * Returns true if a row was deleted, false if the group was not found.
 */
export async function deleteGroup(id: string): Promise<boolean> {
  // Protect the seed group.
  if (id === "group-demo") {
    throw new Error(
      "Cannot delete the protected seed group 'group-demo'. Reassign its pools to another group first."
    );
  }

  // Guard: refuse deletion when pools still reference this group.
  const refRow = await db().queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM quota_pools WHERE group_id = $1",
    [id]
  );
  if (refRow && refRow.cnt > 0) {
    throw new Error(`Group '${id}' has pools; reassign or delete them first.`);
  }

  const result = await db().execute("DELETE FROM quota_groups WHERE id = $1", [id]);
  return result.changes > 0;
}
