import { injectSkillsWithMetadata } from "@/lib/skills/injection";
import { skillRegistry } from "@/lib/skills/registry";
import { FORMATS } from "../../translator/formats.ts";

type SkillsLogger = { debug?: (...args: unknown[]) => void } | null | undefined;

export interface SkillsInjectionResult {
  body: Record<string, unknown>;
  builtinToolNames: string[];
  injectedCustomSkillNames: string[];
}

function getToolName(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const r = tool as Record<string, unknown>;
  if (typeof r.name === "string") return r.name;
  if (r.function && typeof r.function === "object") {
    const fn = r.function as Record<string, unknown>;
    if (typeof fn.name === "string") return fn.name;
  }
  return "";
}

export function sortToolsByName<T>(tools: T[]): T[] {
  if (!Array.isArray(tools) || tools.length <= 1) return tools;
  return [...tools].sort((a, b) => getToolName(a).localeCompare(getToolName(b)));
}

// #12234: injected tools (skills) are sorted by name so the prompt-cache prefix
// is deterministic; they follow the client's tools, which keep the client's own order.
function orderToolsForCaching<T>(tools: T[], clientToolNames: Set<string>): T[] {
  const fromClient = tools.filter((tool) => clientToolNames.has(getToolName(tool)));
  const injected = tools.filter((tool) => !clientToolNames.has(getToolName(tool)));
  return [...fromClient, ...sortToolsByName(injected)];
}

export function getSkillsProviderForFormat(
  format: string
): "openai" | "anthropic" | "google" | "other" {
  switch (format) {
    case FORMATS.CLAUDE:
      return "anthropic";
    case FORMATS.GEMINI:
      return "google";
    default:
      return "openai";
  }
}

export async function injectSkills({
  body,
  skillsOwnerId,
  skillsEnabled,
  effectiveModel,
  sourceFormat,
  targetFormat,
  backgroundReason,
  log,
}: {
  body: Record<string, unknown>;
  /** API key that owns the skills for this request; null disables injection. */
  skillsOwnerId: string | null;
  skillsEnabled: boolean;
  effectiveModel: string;
  sourceFormat: string;
  targetFormat: string;
  backgroundReason: string | null;
  log: SkillsLogger;
}): Promise<SkillsInjectionResult> {
  // Tools the client sent keep their order: a later cap (upstreamBody) keeps the head of
  // the list, so sorting client tools alphabetically made it drop the built-ins (#18120).
  const clientToolNames = new Set(
    Array.isArray(body.tools) ? body.tools.map((tool) => getToolName(tool)) : []
  );
  const injectedCustomSkillNames: string[] = [];

  if (skillsOwnerId && skillsEnabled && body.stream !== true) {
    // Ensure the registry cache is warm before listing: on a cold/fresh
    // process skills that exist only in the DB would be missed (false
    // negative -> silent skip). loadFromDatabase() is a no-op when the cache
    // is already warm (TTL = 60 s), so repeated calls are cheap. Mirrors the
    // pattern in src/lib/skills/interception.ts (#2815).
    // Registered Skills are only executed by the non-streaming server-owned
    // tool loop; stream clients execute tools client-side, so we skip
    // injection for stream requests.
    await skillRegistry.loadFromDatabase(skillsOwnerId);
    const existingTools = Array.isArray(body.tools) ? body.tools : [];
    const { tools: mergedTools, injectedNames } = injectSkillsWithMetadata({
      provider: getSkillsProviderForFormat(sourceFormat),
      existingTools,
      apiKeyId: skillsOwnerId,
      model: typeof effectiveModel === "string" ? effectiveModel : undefined,
      sourceFormat,
      targetFormat,
      backgroundReason,
      messages: Array.isArray(body.messages)
        ? body.messages
        : Array.isArray(body.input)
          ? body.input
          : undefined,
    });

    if (mergedTools.length > existingTools.length) {
      body = {
        ...body,
        tools: mergedTools,
      };
      injectedCustomSkillNames.push(...injectedNames);
      log?.debug?.("SKILLS", `Injected ${mergedTools.length - existingTools.length} skills`);
    }
  }

  if (Array.isArray(body.tools) && body.tools.length > 1) {
    body = {
      ...body,
      tools: orderToolsForCaching(body.tools, clientToolNames),
    };
  }

  return { body, builtinToolNames: [], injectedCustomSkillNames };
}

interface FallbackPlan {
  enabled: boolean;
  toolName: string | null;
  convertedToolCount: number;
}

/**
 * Pure helper: merge web-search/web-fetch fallback tool names into the
 * builtin owner set. Adds a name only when plan.enabled===true,
 * plan.convertedToolCount>0, plan.toolName is non-null, and that name
 * did not already exist in the pre-conversion client tools (builtinToolNames)
 * OR in the original client tool names captured before fallback injection.
 * Does not mutate its input; returns a new result.
 */
export function mergeInjectedFallbackOwnerNames(
  injectionResult: { builtinToolNames: string[] },
  plans: FallbackPlan[],
  preConversionClientToolNames?: string[]
): { builtinToolNames: string[] } {
  const existing = new Set(injectionResult.builtinToolNames);
  if (preConversionClientToolNames) {
    for (const name of preConversionClientToolNames) {
      existing.add(name);
    }
  }
  const extraNames: string[] = [];
  for (const plan of plans) {
    if (
      plan.enabled &&
      plan.convertedToolCount > 0 &&
      plan.toolName &&
      !existing.has(plan.toolName)
    ) {
      extraNames.push(plan.toolName);
      existing.add(plan.toolName);
    }
  }
  return { builtinToolNames: [...injectionResult.builtinToolNames, ...extraNames] };
}
