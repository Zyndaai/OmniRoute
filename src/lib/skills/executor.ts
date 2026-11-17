import {
  sanitizeErrorMessage,
  sanitizeUpstreamDetails,
} from "@omniroute/open-sse/utils/errorSanitization.ts";

import { skillRegistry } from "./registry";
import { SkillExecution, SkillStatus, SkillHandler } from "./types";
import { builtinSkills } from "./builtins";
import { db } from "../db/pg";
import { jsonValueParam } from "../db/pgJsonText";
import { getSettings } from "../db/settings";
import { randomUUID } from "crypto";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("SKILLS_EXECUTOR");

class SkillTimeoutError extends Error {
  constructor() {
    super("Skill execution timed out");
    this.name = "SkillTimeoutError";
  }
}

function toSafeSkillErrorMessage(value: unknown): string {
  try {
    const raw = value instanceof Error ? value.message : value;
    return sanitizeErrorMessage(raw) || "Skill execution failed";
  } catch {
    return "Skill execution failed";
  }
}

const SKILL_FAILURE_DISCRIMINATORS = new Set(["error", "failed", "failure"]);

function isSkillErrorKey(key: string): boolean {
  const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
  return (
    normalizedKey === "error" ||
    normalizedKey === "errors" ||
    normalizedKey === "warning" ||
    normalizedKey === "warnings"
  );
}

function isFailureDiscriminator(value: unknown): boolean {
  return typeof value === "string" && SKILL_FAILURE_DISCRIMINATORS.has(value.trim().toLowerCase());
}

function isSkillFailureOutput(output: Record<string, unknown>): boolean {
  try {
    const status = output.status;
    return (
      output.success === false ||
      (typeof status === "number" && Number.isFinite(status) && status >= 400) ||
      isFailureDiscriminator(status) ||
      isFailureDiscriminator(output.type) ||
      isFailureDiscriminator(output.event) ||
      isFailureDiscriminator(output.kind)
    );
  } catch {
    return true;
  }
}

type SensitiveSkillReferences = {
  objects: WeakSet<object>;
  strings: Set<string>;
};

function markSensitiveSkillReference(value: unknown, sensitive: SensitiveSkillReferences): void {
  if (typeof value === "string") {
    sensitive.strings.add(value);
    return;
  }
  if (!value || typeof value !== "object" || sensitive.objects.has(value)) return;

  sensitive.objects.add(value);
  try {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      markSensitiveSkillReference(entry, sensitive);
    }
  } catch {
    // A revoked proxy or throwing getter is unsafe to expose at the boundary.
  }
}

function collectSensitiveSkillReferences(
  value: unknown,
  sensitive: SensitiveSkillReferences,
  visited: WeakSet<object>
): void {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);

  try {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSkillErrorKey(key)) {
        markSensitiveSkillReference(entry, sensitive);
      } else {
        collectSensitiveSkillReferences(entry, sensitive, visited);
      }
    }
  } catch {
    markSensitiveSkillReference(value, sensitive);
  }
}

type SkillProjectionContext = {
  active: WeakSet<object>;
  projected: WeakMap<object, unknown>;
  sensitive: SensitiveSkillReferences;
};

function projectNestedSkillErrorSubtrees(value: unknown, context: SkillProjectionContext): unknown {
  if (typeof value === "string") {
    return context.sensitive.strings.has(value) ? sanitizeErrorMessage(value) : value;
  }
  if (!value || typeof value !== "object") return value;
  if (context.active.has(value)) return "[circular]";
  if (context.projected.has(value)) return context.projected.get(value);

  if (context.sensitive.objects.has(value)) {
    const safeValue = sanitizeUpstreamDetails(value);
    context.projected.set(value, safeValue);
    return safeValue;
  }

  context.active.add(value);
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    context.projected.set(value, projected);
    for (const entry of value) projected.push(projectNestedSkillErrorSubtrees(entry, context));
    context.active.delete(value);
    return projected;
  }

  const projected: Record<string, unknown> = {};
  context.projected.set(value, projected);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    projected[key] = isSkillErrorKey(key)
      ? sanitizeUpstreamDetails(entry)
      : projectNestedSkillErrorSubtrees(entry, context);
  }
  context.active.delete(value);
  return projected;
}

function skillFailureMessage(output: Record<string, unknown>): string {
  try {
    for (const candidate of [output.message, output.reason, output.statusText, output.error]) {
      if (typeof candidate === "string" || candidate instanceof Error) {
        return toSafeSkillErrorMessage(candidate);
      }
    }
  } catch {
    // Fall through to the stable public message.
  }
  return "Skill execution failed";
}

export function projectSkillOutputForBoundary(
  output: Record<string, unknown>
): Record<string, unknown> {
  try {
    if (isSkillFailureOutput(output)) {
      const projected = sanitizeUpstreamDetails(output);
      return projected && typeof projected === "object" && !Array.isArray(projected)
        ? (projected as Record<string, unknown>)
        : { success: false, error: "Skill execution failed" };
    }

    const sensitive: SensitiveSkillReferences = {
      objects: new WeakSet<object>(),
      strings: new Set<string>(),
    };
    collectSensitiveSkillReferences(output, sensitive, new WeakSet<object>());
    return projectNestedSkillErrorSubtrees(output, {
      active: new WeakSet<object>(),
      projected: new WeakMap<object, unknown>(),
      sensitive,
    }) as Record<string, unknown>;
  } catch {
    return { success: false, error: "Skill execution failed" };
  }
}

class SkillExecutor {
  private static instance: SkillExecutor;
  private handlers: Map<string, SkillHandler> = new Map();
  private timeout: number = 30000;
  private maxRetries: number = 3;

  private constructor() {}

  static getInstance(): SkillExecutor {
    if (!SkillExecutor.instance) {
      SkillExecutor.instance = new SkillExecutor();
    }
    return SkillExecutor.instance;
  }

  registerHandler(name: string, handler: SkillHandler): void {
    this.handlers.set(name, handler);
  }

  setTimeout(ms: number): void {
    this.timeout = ms;
  }

  setMaxRetries(count: number): void {
    this.maxRetries = count;
  }

  async execute(
    skillName: string,
    input: Record<string, unknown>,
    context: { apiKeyId: string; sessionId?: string }
  ): Promise<SkillExecution> {
    const settings = await getSettings();
    if (settings.skillsEnabled === false) {
      throw new Error("Skills execution is disabled. Enable Skills in Settings > AI.");
    }

    const skill = skillRegistry.getSkill(skillName, context.apiKeyId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Check enabled/disabled BEFORE creating a DB row (preserves pre-Task-3
    // behavior: disabled/missing skills never write to skill_executions).
    if (!skill.enabled) {
      throw new Error(`Skill is disabled: ${skillName}`);
    }

    const executionId = randomUUID();
    const startTime = Date.now();

    log.info("skills.executor.start", { skillId: skill.id, skillName, apiKeyId: context.apiKeyId });

    try {
      await db().execute(
        `INSERT INTO skill_executions (id, skill_id, api_key_id, session_id, input, status, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          executionId,
          skill.id,
          context.apiKeyId,
          context.sessionId || null,
          jsonValueParam(input) ?? "{}",
          SkillStatus.RUNNING,
          new Date().toISOString(),
        ]
      );

      const { output, errorMessage, status } = await this.runHandler(skillName, input, {
        apiKeyId: context.apiKeyId,
        sessionId: context.sessionId || "",
      });

      const durationMs = Date.now() - startTime;

      await db().execute(
        `UPDATE skill_executions SET output = $1::jsonb, status = $2, error_message = $3, duration_ms = $4 WHERE id = $5`,
        [output ? jsonValueParam(output) : null, status, errorMessage, durationMs, executionId]
      );

      log.info("skills.executor.complete", {
        skillId: skill.id,
        success: status === SkillStatus.SUCCESS,
        durationMs,
      });

      return {
        id: executionId,
        skillId: skill.id,
        apiKeyId: context.apiKeyId,
        sessionId: context.sessionId || "",
        input,
        output,
        status,
        errorMessage,
        durationMs,
        createdAt: new Date(),
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = toSafeSkillErrorMessage(err);

      await db().execute(
        `UPDATE skill_executions SET status = $1, error_message = $2, duration_ms = $3 WHERE id = $4`,
        [SkillStatus.ERROR, errorMessage, durationMs, executionId]
      );

      throw err;
    }
  }

  private async executeWithTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SkillTimeoutError()), this.timeout);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Shared handler lookup + execute + output projection used by both
   * `execute()` (which writes history) and `executeClaimed()` (which does not).
   */
  private async runHandler(
    skillName: string,
    input: Record<string, unknown>,
    context: { apiKeyId: string; sessionId: string }
  ): Promise<{
    output: Record<string, unknown> | null;
    errorMessage: string | null;
    status: SkillStatus;
  }> {
    const skill = skillRegistry.getSkill(skillName, context.apiKeyId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }
    if (!skill.enabled) {
      throw new Error(`Skill is disabled: ${skillName}`);
    }

    let handler = this.handlers.get(skill.handler);
    if (!handler) {
      const builtin = builtinSkills[skill.handler];
      if (builtin) {
        this.handlers.set(skill.handler, builtin);
        handler = builtin;
      }
    }
    if (!handler) {
      throw new Error(`Handler not found: ${skill.handler}`);
    }

    let output: Record<string, unknown> | null = null;
    let errorMessage: string | null = null;
    let status = SkillStatus.SUCCESS;

    try {
      const result = await this.executeWithTimeout(
        handler(input, { apiKeyId: context.apiKeyId, sessionId: context.sessionId || "" })
      );
      const resultIsFailure = isSkillFailureOutput(result);
      output = projectSkillOutputForBoundary(result);
      if (resultIsFailure) {
        errorMessage = skillFailureMessage(result);
        status = SkillStatus.ERROR;
      }
    } catch (err) {
      errorMessage = toSafeSkillErrorMessage(err);
      status = err instanceof SkillTimeoutError ? SkillStatus.TIMEOUT : SkillStatus.ERROR;
    }

    return { output, errorMessage, status };
  }

  /**
   * Execute a claimed skill call for the server-owned tool loop.
   * Reuses the same handler lookup/timeout/projection as `execute()`
   * but does NOT write to `skill_executions` — the fence table owns
   * persistence for claimed executions.
   */
  async executeClaimed(
    skillName: string,
    input: Record<string, unknown>,
    context: { apiKeyId: string; sessionId: string },
    executionId: string
  ): Promise<SkillExecution> {
    const settings = await getSettings();
    if (settings.skillsEnabled === false) {
      throw new Error("Skills execution is disabled. Enable Skills in Settings > AI.");
    }

    const skill = skillRegistry.getSkill(skillName, context.apiKeyId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    const startTime = Date.now();
    log.info("skills.executor.claimed_start", {
      skillId: skill.id,
      skillName,
      apiKeyId: context.apiKeyId,
      executionId,
    });

    const { output, errorMessage, status } = await this.runHandler(skillName, input, context);
    const durationMs = Date.now() - startTime;

    if (status !== SkillStatus.SUCCESS) {
      throw new Error(`Skill execution failed: ${errorMessage ?? "unknown error"}`);
    }

    log.info("skills.executor.claimed_complete", {
      skillId: skill.id,
      success: status === SkillStatus.SUCCESS,
      durationMs,
      executionId,
    });

    return {
      id: executionId,
      skillId: skill.id,
      apiKeyId: context.apiKeyId,
      sessionId: context.sessionId || "",
      input,
      output,
      status,
      errorMessage,
      durationMs,
      createdAt: new Date(),
    };
  }

  private rowToExecution(row: any): SkillExecution {
    return {
      id: row.id,
      skillId: row.skill_id,
      apiKeyId: row.api_key_id,
      sessionId: row.session_id || "",
      input: typeof row.input === "string" ? JSON.parse(row.input) : row.input,
      output: row.output ?? null,
      status: row.status as SkillStatus,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: new Date(row.created_at),
    };
  }

  async getExecution(executionId: string): Promise<SkillExecution | undefined> {
    const row = await db().queryOne(`SELECT * FROM skill_executions WHERE id = $1`, [executionId]);
    return row ? this.rowToExecution(row) : undefined;
  }

  async listExecutions(
    apiKeyId?: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<SkillExecution[]> {
    const rows = apiKeyId
      ? await db().query(
          `SELECT * FROM skill_executions WHERE api_key_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
          [apiKeyId, limit, offset]
        )
      : await db().query(
          `SELECT * FROM skill_executions ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
    return rows.map((row) => this.rowToExecution(row));
  }

  async countExecutions(apiKeyId?: string): Promise<number> {
    const row = apiKeyId
      ? await db().queryOne<{ count: number }>(
          `SELECT COUNT(*) AS count FROM skill_executions WHERE api_key_id = $1`,
          [apiKeyId]
        )
      : await db().queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM skill_executions`);
    return Number(row?.count ?? 0);
  }
}

export const skillExecutor = SkillExecutor.getInstance();
