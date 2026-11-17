/**
 * Resolves the stored PII settings into what the sanitizers run: the set of
 * enabled built-in types and the compiled, gate-checked custom rules.
 *
 * Fail-safe default: if the settings cannot be read, every built-in type stays
 * enabled and no custom rule runs — exactly the behaviour before per-type
 * selection existed.
 *
 * The sanitizers are synchronous and run per string leaf, so `getPiiRuleConfig`
 * reads the settings cache without awaiting and refreshes it in the background;
 * `loadPiiRuleConfig` is the awaitable form for callers that can wait.
 */

import { getPiiSettings, peekPiiSettings, type PiiSettings } from "@/lib/db/piiSettings";
import { compilePiiCustomRules, type CompiledPiiRule } from "@/shared/utils/piiCustomPatterns";

export interface PiiRuleConfig {
  /** null = all built-in types. */
  enabledTypes: ReadonlySet<string> | null;
  customRules: CompiledPiiRule[];
}

const DEFAULT_CONFIG: PiiRuleConfig = { enabledTypes: null, customRules: [] };

let compiled: { source: object; signature: string; value: PiiRuleConfig } | null = null;

function compileSettings(settings: PiiSettings): PiiRuleConfig {
  // getPiiSettings hands back the same object until its short cache refreshes;
  // after a refresh the regexes are only recompiled when the content changed.
  if (compiled && compiled.source === settings) return compiled.value;
  const signature = JSON.stringify(settings);
  if (compiled && compiled.signature === signature) {
    compiled.source = settings;
    return compiled.value;
  }
  const value: PiiRuleConfig = {
    enabledTypes: settings.enabledTypes ? new Set(settings.enabledTypes) : null,
    customRules: compilePiiCustomRules(settings.customPatterns),
  };
  compiled = { source: settings, signature, value };
  return value;
}

export async function loadPiiRuleConfig(): Promise<PiiRuleConfig> {
  try {
    return compileSettings(await getPiiSettings());
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getPiiRuleConfig(): PiiRuleConfig {
  // Keeps the cache warm; the sync path below uses whatever was loaded last.
  void getPiiSettings().catch(() => undefined);
  const settings = peekPiiSettings();
  return settings ? compileSettings(settings) : DEFAULT_CONFIG;
}
