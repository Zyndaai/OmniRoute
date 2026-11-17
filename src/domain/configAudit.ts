/**
 * Configuration Audit Trail — pure helpers
 *
 * Types and diff computation for configuration changes (provider connections,
 * combos, routing policies) with before/after snapshots. The persisted
 * `config_audit_log` table is gone with the move to PostgreSQL: `recordChange`
 * had no caller outside this module, so the table was never written. The live
 * audit table is `audit_log` (see `logAuditEvent` in `src/lib/compliance`).
 */

/** Types of configuration entities that can be audited */
export type AuditTarget = "provider" | "combo" | "policy" | "connection" | "settings";

/** How the change was triggered */
export type AuditSource = "dashboard" | "api" | "sync" | "auto-healing" | "cli" | "mcp";

/** Type of change */
export type AuditAction = "create" | "update" | "delete" | "enable" | "disable";

/** A single audit log entry */
export interface ConfigAuditEntry {
  /** Unique entry ID */
  id: string;
  /** ISO timestamp of the change */
  timestamp: string;
  /** Type of change */
  action: AuditAction;
  /** What type of entity was changed */
  target: AuditTarget;
  /** ID of the changed entity */
  targetId: string;
  /** Human-readable name of the entity */
  targetName: string;
  /** State before the change (null for creates) */
  before: Record<string, unknown> | null;
  /** State after the change (null for deletes) */
  after: Record<string, unknown> | null;
  /** How the change was triggered */
  source: AuditSource;
  /** Computed diff summary */
  diff: ConfigDiff;
  /** Optional human note */
  note: string | null;
}

/** Computed diff between two states */
export interface ConfigDiff {
  /** Keys that were added */
  added: string[];
  /** Keys that were removed */
  removed: string[];
  /** Keys whose values changed */
  changed: Array<{ key: string; from: unknown; to: unknown }>;
  /** True if the states are identical */
  isEmpty: boolean;
}

/** Configuration snapshot for export/import */
export interface ConfigSnapshot {
  /** ISO timestamp when snapshot was taken */
  timestamp: string;
  /** Semantic version tag */
  version: string;
  /** Description of the snapshot */
  description: string;
  /** Full configuration data */
  data: Record<string, unknown>;
}

/**
 * Compute a structured diff between two configuration states.
 */
export function computeDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): ConfigDiff {
  const beforeKeys = new Set(before ? Object.keys(before) : []);
  const afterKeys = new Set(after ? Object.keys(after) : []);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ key: string; from: unknown; to: unknown }> = [];

  // Keys in after but not in before → added
  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) {
      added.push(key);
    }
  }

  // Keys in before but not in after → removed
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) {
      removed.push(key);
    }
  }

  // Keys in both → check for changes
  for (const key of beforeKeys) {
    if (afterKeys.has(key)) {
      const beforeVal = before![key];
      const afterVal = after![key];
      if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
        changed.push({ key, from: beforeVal, to: afterVal });
      }
    }
  }

  return {
    added,
    removed,
    changed,
    isEmpty: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

/**
 * Create a full configuration snapshot for export.
 */
export function createSnapshot(
  version: string,
  description: string,
  configData: Record<string, unknown>
): ConfigSnapshot {
  return {
    timestamp: new Date().toISOString(),
    version,
    description,
    data: JSON.parse(JSON.stringify(configData)), // deep clone
  };
}
