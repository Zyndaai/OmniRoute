import { mergeModelCompatOverride } from "@/lib/db/models";

/** Clearing the operator override must not expose an older manual compat value. */
export async function clearLegacyVisionOverride(
  provider: string,
  modelId: string,
  updates: Record<string, unknown>
): Promise<void> {
  if (updates.supportsVision !== null) return;
  await mergeModelCompatOverride(provider, modelId, { supportsVision: null });
}
