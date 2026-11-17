/**
 * Middleware Hooks DB — CRUD operations for middleware_hooks table
 *
 * Module: src/lib/db/middleware.ts
 * Table: middleware_hooks
 *
 * Hook execution logs are not persisted (the `middleware_logs` table is gone); the live
 * registry keeps them in memory (see `getHookLogs` in src/lib/middleware/registry.ts).
 */

import { db } from "./pg";
import type { HookConfig } from "@/lib/middleware/types";

interface HookRow {
  name: string;
  description: string;
  priority: number;
  scope_type: "global" | "combo";
  combo_id: string | null;
  enabled: boolean;
  code: string;
  created_at: string;
  updated_at: string;
  run_count: number;
  last_error: string | null;
}

function rowToHookConfig(row: HookRow): HookConfig {
  return {
    name: row.name,
    description: row.description,
    priority: row.priority,
    scope:
      row.scope_type === "combo" && row.combo_id
        ? { type: "combo", comboId: row.combo_id }
        : { type: "global" },
    enabled: row.enabled === true,
    code: row.code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runCount: row.run_count,
    lastError: row.last_error || undefined,
  };
}

// ── CRUD Operations ───────────────────────────────────────────────────────

/**
 * Get all hooks from DB.
 */
export async function getAllMiddlewareHooks(): Promise<HookConfig[]> {
  const rows = await db().query<HookRow>(
    "SELECT * FROM middleware_hooks ORDER BY priority ASC, name ASC"
  );
  return rows.map(rowToHookConfig);
}

/**
 * Get enabled hooks from DB (for runtime loading).
 */
export async function getEnabledMiddlewareHooks(): Promise<HookConfig[]> {
  const rows = await db().query<HookRow>(
    "SELECT * FROM middleware_hooks WHERE enabled ORDER BY priority ASC, name ASC"
  );
  return rows.map(rowToHookConfig);
}

/**
 * Get a single hook by name.
 */
export async function getMiddlewareHook(name: string): Promise<HookConfig | undefined> {
  const row = await db().queryOne<HookRow>("SELECT * FROM middleware_hooks WHERE name = $1", [
    name,
  ]);
  return row ? rowToHookConfig(row) : undefined;
}

/**
 * Create a new middleware hook.
 */
export async function createMiddlewareHook(config: HookConfig): Promise<HookConfig> {
  const row = await db().queryOne<HookRow>(
    `INSERT INTO middleware_hooks
       (name, description, priority, scope_type, combo_id, enabled, code, run_count, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      config.name,
      config.description ?? "",
      Math.round(config.priority),
      config.scope.type,
      config.scope.type === "combo" ? config.scope.comboId : null,
      Boolean(config.enabled),
      config.code ?? "",
      Math.round(config.runCount || 0),
      config.lastError ?? null,
    ]
  );
  return rowToHookConfig(row!);
}

/**
 * Update an existing middleware hook.
 */
export async function updateMiddlewareHook(
  name: string,
  updates: Partial<HookConfig>
): Promise<HookConfig | undefined> {
  // Row lock so the merge sees a concurrent recordHookExecution; run_count/last_error are
  // written only when the caller passes them.
  return db().transaction(async (tx) => {
    const current = await tx.queryOne<HookRow>(
      "SELECT * FROM middleware_hooks WHERE name = $1 FOR UPDATE",
      [name]
    );
    if (!current) return undefined;
    const updated = { ...rowToHookConfig(current), ...updates };
    const params: unknown[] = [
      name,
      updated.description ?? "",
      Math.round(updated.priority),
      updated.scope.type,
      updated.scope.type === "combo" ? updated.scope.comboId : null,
      Boolean(updated.enabled),
      updated.code ?? "",
    ];
    const extra: string[] = [];
    if ("runCount" in updates) {
      params.push(Math.round(updates.runCount || 0));
      extra.push(`run_count = $${params.length}`);
    }
    if ("lastError" in updates) {
      params.push(updates.lastError ?? null);
      extra.push(`last_error = $${params.length}`);
    }
    const row = await tx.queryOne<HookRow>(
      `UPDATE middleware_hooks SET
         description = $2, priority = $3, scope_type = $4, combo_id = $5,
         enabled = $6, code = $7, updated_at = now()${extra.map((e) => `, ${e}`).join("")}
       WHERE name = $1
       RETURNING *`,
      params
    );
    return row ? rowToHookConfig(row) : undefined;
  });
}

/**
 * Delete a middleware hook.
 */
export async function deleteMiddlewareHook(name: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM middleware_hooks WHERE name = $1", [name]);
  return result.changes > 0;
}

/**
 * Increment run count and optionally update last error.
 */
export async function recordHookExecution(name: string, error?: string): Promise<void> {
  await db().execute(
    `UPDATE middleware_hooks
        SET run_count = run_count + 1, last_error = $2, updated_at = now()
      WHERE name = $1`,
    [name, error || null]
  );
}
