import { resolveComboTargets } from "@omniroute/open-sse/services/combo.ts";
import type { ComboLike } from "@omniroute/open-sse/services/combo/types.ts";
import { resolveComboConfig } from "@omniroute/open-sse/services/comboConfig.ts";

/** Whether a combo (or any nested combo-ref) uses a route managed leases cannot honour. */
export async function isManagedComboUnsupported(
  combo: ComboLike,
  settings: Record<string, unknown>,
  allCombos: ComboLike[],
  visited = new Set<string>()
): Promise<boolean> {
  if (visited.has(combo.name)) return false;
  visited.add(combo.name);
  const strategy = combo.strategy ?? "priority";
  const config = resolveComboConfig(combo, settings) as Record<string, unknown>;
  const resolvedTargets = await resolveComboTargets(combo, allCombos);
  const pipeline =
    strategy === "pipeline" ||
    (strategy === "auto" && (config.pipeline_enabled === true || combo.name === "auto/smart"));
  // Sequential on purpose: `visited` is shared, so the first unsafe branch short-circuits
  // exactly as the former synchronous `.some()` did.
  let nestedUnsafe = false;
  for (const step of combo.models as Array<{ kind?: string; comboName?: string }>) {
    if (step?.kind !== "combo-ref" || !step.comboName) continue;
    const nested = allCombos.find((candidate) => candidate.name === step.comboName);
    if (nested && (await isManagedComboUnsupported(nested, settings, allCombos, visited))) {
      nestedUnsafe = true;
      break;
    }
  }
  return (
    strategy === "fusion" ||
    strategy === "context-relay" ||
    (config.chaos as { enabled?: boolean } | undefined)?.enabled === true ||
    (config.shadowRouting as { enabled?: boolean } | undefined)?.enabled === true ||
    (config.zeroLatencyOptimizationsEnabled === true && config.hedging === true) ||
    (resolvedTargets.length > 1 &&
      (pipeline || resolvedTargets.some((target) => Boolean(target.connectionId?.trim())))) ||
    nestedUnsafe
  );
}
