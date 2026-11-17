/**
 * API Key Groups DB — CRUD operations for team/enterprise key grouping
 *
 * Tables: key_groups, group_model_permissions, key_group_members
 *
 * Enables team-level API key management with model-level access control.
 */

import { db } from "@/lib/db/pg";
import { randomUUID } from "crypto";
import { invalidateModelCatalogCache } from "./readCache";

// ── Types ────────────────────────────────────────────────────────────────

export interface KeyGroup {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupModelPermission {
  id: string;
  groupId: string;
  modelPattern: string;
  provider: string | null;
  accessType: "allow" | "deny";
  createdAt: string;
}

export interface KeyGroupMember {
  keyId: string;
  groupId: string;
  createdAt: string;
}

export interface KeyGroupWithPermissions extends KeyGroup {
  permissions: GroupModelPermission[];
  memberCount: number;
}

// ── Key Groups CRUD ──────────────────────────────────────────────────────

export async function getAllKeyGroups(): Promise<KeyGroup[]> {
  const rows = await db().query<any>("SELECT * FROM key_groups ORDER BY name ASC");
  return rows.map(rowToGroup);
}

export async function getKeyGroup(id: string): Promise<KeyGroup | undefined> {
  const row = await db().queryOne<any>("SELECT * FROM key_groups WHERE id = $1", [id]);
  return row ? rowToGroup(row) : undefined;
}

/**
 * Narrow a list of key-group ids to the ones that exist AND are active.
 *
 * Callers that grant access by group membership must use this before trusting
 * ids from configuration: `addKeyToGroup` swallows a bad id, and a key that
 * ends up in zero groups is treated as UNRESTRICTED by `checkKeyModelAccess`.
 * A typo'd or deleted group would therefore widen access instead of denying it.
 */
export async function filterExistingActiveKeyGroupIds(ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return [];

  const rows = await db().query<{ id?: unknown }>(
    "SELECT id FROM key_groups WHERE is_active = true AND id = ANY($1::text[])",
    [unique]
  );

  const live = new Set(
    rows.map((row) => (typeof row.id === "string" ? row.id : "")).filter((id) => id.length > 0)
  );
  return unique.filter((id) => live.has(id));
}

export async function getKeyGroupWithPermissions(
  id: string
): Promise<KeyGroupWithPermissions | undefined> {
  const group = await getKeyGroup(id);
  if (!group) return undefined;

  const permissions = await getGroupPermissions(id);
  const memberCount = await getGroupMemberCount(id);

  return { ...group, permissions, memberCount };
}

export async function createKeyGroup(name: string, description = ""): Promise<KeyGroup> {
  const id = randomUUID();

  const row = await db().queryOne<any>(
    `INSERT INTO key_groups (id, name, description, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     RETURNING *`,
    [id, name, description]
  );

  return rowToGroup(row);
}

export async function updateKeyGroup(
  id: string,
  updates: { name?: string; description?: string; isActive?: boolean }
): Promise<KeyGroup | undefined> {
  const existing = await getKeyGroup(id);
  if (!existing) return undefined;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    params.push(updates.name);
    sets.push(`name = $${params.length}`);
  }
  if (updates.description !== undefined) {
    params.push(updates.description);
    sets.push(`description = $${params.length}`);
  }
  if (updates.isActive !== undefined) {
    params.push(updates.isActive);
    sets.push(`is_active = $${params.length}`);
  }

  if (sets.length === 0) return existing;
  const catalogInvalidationNeeded =
    updates.isActive !== undefined && updates.isActive !== existing.isActive;

  sets.push("updated_at = now()");
  params.push(id);

  const result = await db().execute(
    `UPDATE key_groups SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  );
  if (catalogInvalidationNeeded && result.changes > 0) {
    invalidateModelCatalogCache();
  }
  return result.changes > 0 ? getKeyGroup(id) : existing;
}

export async function deleteKeyGroup(id: string): Promise<boolean> {
  // CASCADE deletes permissions and members
  const result = await db().execute("DELETE FROM key_groups WHERE id = $1", [id]);
  if (result.changes > 0) {
    invalidateModelCatalogCache();
    return true;
  }
  return false;
}

// ── Group Permissions ────────────────────────────────────────────────────

export async function getGroupPermissions(groupId: string): Promise<GroupModelPermission[]> {
  const rows = await db().query<any>(
    "SELECT * FROM group_model_permissions WHERE group_id = $1 ORDER BY access_type ASC, model_pattern ASC",
    [groupId]
  );
  return rows.map(rowToPermission);
}

export async function addGroupPermission(
  groupId: string,
  modelPattern: string,
  accessType: "allow" | "deny",
  provider?: string
): Promise<GroupModelPermission> {
  const id = randomUUID();

  const row = await db().queryOne<any>(
    `INSERT INTO group_model_permissions (id, group_id, model_pattern, provider, access_type, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING *`,
    [id, groupId, modelPattern, provider || null, accessType]
  );

  invalidateModelCatalogCache();

  return rowToPermission(row);
}

export async function removeGroupPermission(permissionId: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM group_model_permissions WHERE id = $1", [
    permissionId,
  ]);
  if (result.changes > 0) {
    invalidateModelCatalogCache();
  }
  return result.changes > 0;
}

export async function getGroupMembers(groupId: string): Promise<KeyGroupMember[]> {
  const rows = await db().query<any>(
    "SELECT * FROM key_group_members WHERE group_id = $1 ORDER BY created_at ASC",
    [groupId]
  );
  return rows.map(rowToMember);
}

export async function getKeyGroupsForApiKey(
  keyId: string,
  includeInactive = false
): Promise<KeyGroup[]> {
  const rows = await db().query<any>(
    `SELECT g.* FROM key_groups g
     INNER JOIN key_group_members m ON g.id = m.group_id
     WHERE m.key_id = $1 AND ($2::boolean OR g.is_active = true)
     ORDER BY g.name ASC`,
    [keyId, includeInactive]
  );
  return rows.map(rowToGroup);
}

export async function addKeyToGroup(keyId: string, groupId: string): Promise<boolean> {
  try {
    const result = await db().execute(
      "INSERT INTO key_group_members (key_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [keyId, groupId]
    );
    if (result.changes > 0) {
      invalidateModelCatalogCache();
    }
    return true;
  } catch {
    // A missing key or group violates a foreign key; the caller treats that as "not added".
    return false;
  }
}

export async function removeKeyFromGroup(keyId: string, groupId: string): Promise<boolean> {
  const result = await db().execute(
    "DELETE FROM key_group_members WHERE key_id = $1 AND group_id = $2",
    [keyId, groupId]
  );
  if (result.changes > 0) {
    invalidateModelCatalogCache();
  }
  return result.changes > 0;
}

async function getGroupMemberCount(groupId: string): Promise<number> {
  const row = await db().queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM key_group_members WHERE group_id = $1",
    [groupId]
  );
  return row?.count || 0;
}

// ── Authorization Helper ────────────────────────────────────────────────

export interface ModelAccessCheck {
  allowed: boolean;
  matchedRules: GroupModelPermission[];
  deniedBy: GroupModelPermission | null;
}

/**
 * Check if an API key has access to a specific model.
 * All member groups retain deny rules, but only active groups grant access.
 * Membership requires an explicit allow; keys without groups remain unrestricted.
 */
export async function checkKeyModelAccess(
  keyId: string,
  model: string,
  provider?: string
): Promise<ModelAccessCheck> {
  const groups = await getKeyGroupsForApiKey(keyId, true);
  if (groups.length === 0) {
    // No groups = no restrictions
    return { allowed: true, matchedRules: [], deniedBy: null };
  }

  const groupIds = groups.map((g) => g.id);

  const rules = await db().query<any>(
    `SELECT * FROM group_model_permissions
     WHERE group_id = ANY($1::text[])
     ORDER BY access_type ASC`,
    [groupIds]
  );

  const permissions = rules.map(rowToPermission);

  // Check deny rules first (they take precedence)
  const denyRules = permissions.filter(
    (p) =>
      p.accessType === "deny" &&
      matchesModelPattern(p.modelPattern, model) &&
      (!p.provider || p.provider === provider)
  );

  if (denyRules.length > 0) {
    return { allowed: false, matchedRules: permissions, deniedBy: denyRules[0] };
  }

  // Deactivation pauses grants without removing membership restrictions or denies.
  const activeGroupIds = new Set(groups.filter((group) => group.isActive).map((group) => group.id));
  const allowRules = permissions.filter(
    (p) =>
      p.accessType === "allow" &&
      activeGroupIds.has(p.groupId) &&
      matchesModelPattern(p.modelPattern, model) &&
      (!p.provider || p.provider === provider)
  );

  if (allowRules.length > 0) {
    return { allowed: true, matchedRules: permissions, deniedBy: null };
  }

  // No matching rules = restricted by group membership but no explicit allow
  return { allowed: false, matchedRules: permissions, deniedBy: null };
}

/**
 * Compile a group model pattern.
 *
 * `*` is the only wildcard this syntax has, so every other regex
 * metacharacter must be escaped before the pattern is compiled. Interpolating
 * it raw made an operator's pattern behave as a regex in two ways:
 *
 *   - `gpt-4.1*` matched `gpt-4o1-preview`, because `.` is "any character".
 *     On a deny rule that blocks unrelated models; on an allow rule it grants
 *     models the pattern was never meant to cover.
 *   - `gpt-4(*`, `claude-3[*` and `*+*` threw `SyntaxError` (unterminated
 *     group / unterminated character class / nothing to repeat) out of
 *     `checkKeyModelAccess()`, which runs on the completion and /v1/models
 *     paths — one malformed pattern broke every request for keys in that
 *     group.
 *
 * Escaping keeps the semantics this function already had (case-sensitive,
 * `*`-only) and matches how the rest of the repo compiles operator patterns
 * (`globToRegex`, `matchesWildcardPattern`).
 */
function modelPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesModelPattern(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  if (pattern.includes("*")) {
    return modelPatternToRegex(pattern).test(model);
  }
  return pattern === model;
}

// ── Row Mappers ──────────────────────────────────────────────────────────

function rowToGroup(row: any): KeyGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    isActive: row.is_active === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPermission(row: any): GroupModelPermission {
  return {
    id: row.id,
    groupId: row.group_id,
    modelPattern: row.model_pattern,
    provider: row.provider || null,
    accessType: row.access_type,
    createdAt: row.created_at,
  };
}

function rowToMember(row: any): KeyGroupMember {
  return {
    keyId: row.key_id,
    groupId: row.group_id,
    createdAt: row.created_at,
  };
}
