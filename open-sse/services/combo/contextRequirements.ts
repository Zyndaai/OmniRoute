/**
 * Context requirements filtering for combo targets.
 * Applies minContextWindow, preferLargeContext, and contextFilterMode
 * from combo config to filter and sort targets by context window size.
 */

import { getModelContextLimit } from "../../../src/lib/modelCapabilities";
import type { ComboLogger, ResolvedComboTarget } from "./types.ts";

export interface ContextRequirements {
  minContextWindow?: number;
  maxContextWindow?: number;
  preferLargeContext?: boolean;
  contextFilterMode?: "strict" | "lenient";
}

/**
 * Get context window size for a target model.
 * Returns null if unknown.
 */
async function getTargetContextWindow(target: ResolvedComboTarget): Promise<number | null> {
  const limit = await getModelContextLimit(target.provider, target.modelStr);
  return typeof limit === "number" && limit > 0 ? limit : null;
}

/**
 * Apply context requirements filtering and sorting to combo targets.
 *
 * Filtering logic:
 * - If minContextWindow is set, filters out models below that threshold
 * - contextFilterMode determines handling of unknown context limits:
 *   - "strict": excludes models with unknown context limits
 *   - "lenient": includes models with unknown context limits
 * - #8786 fail-open: when "strict" would empty the pool and at least one
 *   unknown-context target exists, restore those unknowns instead of returning
 *   [] (which becomes a false 404 "no executable targets"). Known-too-small
 *   targets are never resurrected.
 *
 * Sorting logic:
 * - If preferLargeContext is true, sorts remaining targets by context size (descending)
 * - Unknown context limits sort to the end
 *
 * @param targets - Array of resolved combo targets
 * @param requirements - Context requirements from combo config
 * @param log - Combo logger for debug output
 * @returns Filtered and sorted targets array
 */
export async function applyContextRequirements(
  targets: ResolvedComboTarget[],
  requirements: ContextRequirements | undefined,
  log: ComboLogger
): Promise<ResolvedComboTarget[]> {
  if (!requirements || targets.length === 0) return targets;

  const {
    minContextWindow,
    maxContextWindow,
    preferLargeContext,
    contextFilterMode = "lenient",
  } = requirements;

  // No requirements specified
  if (!minContextWindow && !maxContextWindow && !preferLargeContext) return targets;

  let filtered = targets;

  // Load every target's window once; the filters and the sort below read this map.
  const windows = new Map<ResolvedComboTarget, number | null>();
  await Promise.all(
    targets.map(async (target) => {
      windows.set(target, await getTargetContextWindow(target));
    })
  );
  const windowOf = (target: ResolvedComboTarget): number | null => windows.get(target) ?? null;

  // Apply minContextWindow filtering
  if (minContextWindow && minContextWindow > 0) {
    const beforeFilterCount = filtered.length;

    const classified = filtered.map((target) => ({
      target,
      contextWindow: windowOf(target),
    }));

    filtered = classified
      .filter(({ contextWindow }) => {
        // Unknown context limit handling
        if (contextWindow === null) {
          return contextFilterMode === "lenient";
        }

        // Known context limit - check threshold
        return contextWindow >= minContextWindow;
      })
      .map(({ target }) => target);

    // #8786: strict must not turn an otherwise-executable combo into an empty
    // pool solely because the capability catalog lacks context metadata. When
    // no known-good target survives, fail open to the unknown-context set
    // (same spirit as the request-compat context fail-open path).
    if (filtered.length === 0 && beforeFilterCount > 0 && contextFilterMode === "strict") {
      const unknowns = classified
        .filter(({ contextWindow }) => contextWindow === null)
        .map(({ target }) => target);
      if (unknowns.length > 0) {
        log.warn(
          "COMBO",
          `Context requirements: strict mode would empty the pool (${beforeFilterCount} targets, none known >= ${minContextWindow}); failing open to ${unknowns.length} unknown-context target(s)`
        );
        filtered = unknowns;
      }
    }

    if (filtered.length < beforeFilterCount) {
      log.info(
        "COMBO",
        `Context requirements: filtered ${beforeFilterCount} → ${filtered.length} targets (minContextWindow: ${minContextWindow}, mode: ${contextFilterMode})`
      );
      log.debug?.(
        "COMBO",
        `Context requirements: kept models ${filtered.map((t) => t.modelStr).join(", ")}`
      );
    }
  }

  // Apply maxContextWindow filtering
  if (maxContextWindow && maxContextWindow > 0) {
    const beforeFilterCount = filtered.length;

    filtered = filtered.filter((target) => {
      const contextWindow = windowOf(target);

      // Unknown context limit handling
      if (contextWindow === null) {
        return contextFilterMode === "lenient";
      }

      // Known context limit - check threshold
      return contextWindow <= maxContextWindow;
    });

    if (filtered.length < beforeFilterCount) {
      log.info(
        "COMBO",
        `Context requirements: filtered ${beforeFilterCount} → ${filtered.length} targets (maxContextWindow: ${maxContextWindow}, mode: ${contextFilterMode})`
      );
      log.debug?.(
        "COMBO",
        `Context requirements: kept models ${filtered.map((t) => t.modelStr).join(", ")}`
      );
    }
  }

  // Apply preferLargeContext sorting
  if (preferLargeContext && filtered.length > 1) {
    filtered = [...filtered].sort((a, b) => {
      const aContext = windowOf(a) ?? 0;
      const bContext = windowOf(b) ?? 0;
      return bContext - aContext; // Descending order
    });

    log.debug?.(
      "COMBO",
      `Context requirements: sorted by context size (descending): ${filtered
        .map((t) => {
          const ctx = windowOf(t);
          return `${t.modelStr}(${ctx === null ? "unknown" : ctx})`;
        })
        .join(", ")}`
    );
  }

  return filtered;
}
