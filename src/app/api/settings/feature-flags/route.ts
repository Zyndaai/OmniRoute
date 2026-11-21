import { z } from "zod";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isProtectedFeatureFlag } from "@/shared/constants/protectedFeatureFlags";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  FEATURE_FLAG_DEFINITIONS,
  type FeatureFlagDefinition,
} from "@/shared/constants/featureFlagDefinitions";
import {
  ADAPTIVE_VIRTUAL_LANES_FLAG_KEY,
  resolveAdaptiveVirtualLanesFlag,
} from "@/lib/admissionVirtualLanes";
import {
  getFeatureFlagOverrides,
  setFeatureFlagOverride,
  removeFeatureFlagOverride,
  clearAllFeatureFlagOverrides,
} from "@/lib/db/featureFlags";
import { resolveAllFeatureFlags } from "@/shared/utils/featureFlags";
import { getCcAliasGlobalState } from "@/lib/db/ccDiscoveryAliases";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const ACTIVE_VALUES = new Set(["true", "1", "yes"]);
const CC_DISCOVERY_ALIASES_FLAG_KEY = "EXPOSE_CC_DISCOVERY_ALIASES";

function isActive(value: string): boolean {
  return ACTIVE_VALUES.has(value);
}

/**
 * Standard feature-flag payload shape for GET /api/settings/feature-flags.
 * Flags whose gate resolves differently from the generic db-wins-over-env
 * order pass their own effectiveValue/source (see the special cases below).
 */
function flagPayload(
  definition: FeatureFlagDefinition,
  effectiveValue: string,
  source: "db" | "env" | "default"
) {
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    category: definition.category,
    type: definition.type,
    enumValues: definition.enumValues ?? null,
    defaultValue: definition.defaultValue,
    effectiveValue,
    source,
    requiresRestart: definition.requiresRestart,
    warningLevel: definition.warningLevel,
  };
}

/**
 * GET /api/settings/feature-flags
 * Returns all feature flags with their effective values and a summary.
 */
export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const resolved = await resolveAllFeatureFlags();

    const flags = await Promise.all(
      resolved.map(async ({ key, effectiveValue, source, definition, ...provenance }) => {
        // Flags whose gate resolves with env-wins-over-db precedence (the
        // opposite of resolveAllFeatureFlags' generic db-wins-over-env order)
        // report the gate's own resolution so the dashboard never shows a source
        // that doesn't match actual gate behavior.
        if (key === CC_DISCOVERY_ALIASES_FLAG_KEY) {
          const gateState = await getCcAliasGlobalState();
          return flagPayload(definition, gateState.enabled ? "true" : "false", gateState.source);
        }
        // #9654 U7: the adaptive virtual-lanes gate reads env at runtime
        // construction — env wins over any DB override, and a DB override gates
        // at next boot (see lib/admissionVirtualLanes.ts).
        if (key === ADAPTIVE_VIRTUAL_LANES_FLAG_KEY) {
          const state = await resolveAdaptiveVirtualLanesFlag();
          return flagPayload(definition, state.enabled ? "true" : "false", state.source);
        }
        return { ...flagPayload(definition, effectiveValue, source), ...provenance };
      })
    );

    const total = flags.length;
    const active = flags.filter((f) => isActive(f.effectiveValue)).length;
    const inactive = total - active;
    // Count this flag's configuration, not a dependency's inherited DB/env source twice.
    const overriddenByDb = resolved.filter(
      (f, i) => (f.configuredSource ?? flags[i].source) === "db"
    ).length;
    const overriddenByEnv = resolved.filter(
      (f, i) => (f.configuredSource ?? flags[i].source) === "env"
    ).length;

    return Response.json({
      flags,
      summary: { total, active, inactive, overriddenByDb, overriddenByEnv },
    });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

const putFeatureFlagSchema = z.object({
  key: z.string().min(1),
  value: z.string().optional(),
});

/**
 * PUT /api/settings/feature-flags
 * Set or remove a feature flag override.
 * Body: { key: string; value?: string }
 * If value is omitted, the override is removed.
 */
/**
 * Protected flags keep needing a credential when login is disabled: isAuthenticated is true
 * for everyone then, and a DB override beats the env value immediately. Returns the refusal
 * response, or null when the caller may write.
 */
async function authorizeProtectedFeatureFlagWrite(
  request: Request,
  keys: readonly string[]
): Promise<Response | null> {
  if (!keys.some((key) => isProtectedFeatureFlag(key))) return null;
  return requireManagementAuth(request, { alwaysRequireAuth: true });
}

export async function PUT(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(putFeatureFlagSchema, rawBody);
  if (isValidationFailure(validation)) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const { key, value } = validation.data;

  // Validate key against known definitions
  const definition = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
  if (!definition) {
    return Response.json({ error: `Unknown feature flag key: ${key}` }, { status: 400 });
  }

  const authError = await authorizeProtectedFeatureFlagWrite(request, [key]);
  if (authError) return authError;

  // Validate enum values
  if (value !== undefined && definition.type === "enum" && definition.enumValues) {
    if (!definition.enumValues.includes(value)) {
      return Response.json(
        {
          error: `Invalid value "${value}" for enum flag ${key}. Allowed: ${definition.enumValues.join(", ")}`,
        },
        { status: 400 }
      );
    }
  }

  try {
    // Capture previous state before modifying
    const allFlagsBefore = await resolveAllFeatureFlags();
    const prevFlag = allFlagsBefore.find((f) => f.key === key);
    const previousValue = prevFlag?.effectiveValue ?? definition.defaultValue;
    const previousSource = prevFlag?.source ?? "default";

    if (value === undefined) {
      await removeFeatureFlagOverride(key);
    } else {
      await setFeatureFlagOverride(key, value);
    }

    // After write — get new effective value
    const allFlagsAfter = await resolveAllFeatureFlags();
    const updatedFlag = allFlagsAfter.find((f) => f.key === key);
    const newEffectiveValue = updatedFlag?.effectiveValue ?? definition.defaultValue;
    const newSource = updatedFlag?.source ?? "default";

    // Env-wins gates resolve with env > DB > default (the opposite of the
    // generic db-wins helper above), so report their true resolution here too —
    // the response must never tell an operator they enabled a gate that the env
    // var still overrides (#9654 U7).
    let reportedEffectiveValue = newEffectiveValue;
    let reportedSource = newSource;
    if (key === ADAPTIVE_VIRTUAL_LANES_FLAG_KEY) {
      const state = await resolveAdaptiveVirtualLanesFlag();
      reportedEffectiveValue = state.enabled ? "true" : "false";
      reportedSource = state.source;
    }

    return Response.json({
      key,
      effectiveValue: reportedEffectiveValue,
      source: reportedSource,
      previousValue,
      previousSource,
      ...(key === "UNPRICED_USAGE_BUDGET_POLICY"
        ? {
            configuredSource: updatedFlag.configuredSource,
            sourceKey: updatedFlag.sourceKey,
            previousConfiguredSource: prevFlag.configuredSource,
            previousSourceKey: prevFlag.sourceKey,
          }
        : {}),
      requiresRestart: definition.requiresRestart,
    });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

/**
 * DELETE /api/settings/feature-flags
 * Clear all feature flag overrides.
 */
export async function DELETE(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const overrides = await getFeatureFlagOverrides();
    const count = Object.keys(overrides).length;

    // Clearing all overrides also drops any security flag the operator set here.
    const authError = await authorizeProtectedFeatureFlagWrite(request, Object.keys(overrides));
    if (authError) return authError;

    await clearAllFeatureFlagOverrides();

    return Response.json({
      cleared: count,
      message: `Cleared ${count} feature flag override${count !== 1 ? "s" : ""}`,
    });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
