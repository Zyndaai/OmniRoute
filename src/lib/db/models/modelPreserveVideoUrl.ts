/**
 * modelPreserveVideoUrl.ts — preserveVideoUrl resolver for model-compat overrides.
 *
 * Extracted from models.ts to avoid growing the frozen file-size baseline.
 * Follows the same pattern as getModelPreserveOpenAIDeveloperRole.
 */

import { readCompatList, isCompatProtocolKey } from "./compat";

/** The model-compat override key for the preserveVideoUrl flag. */
const KEY = "preserveVideoUrl";

/**
 * Get the explicit preserve-video-url preference for a provider/model.
 * `undefined` = unset → fall back to moonshot/kimi hardcoded behavior (caller decides).
 * `true` = keep video_url content parts in the translated request.
 * Per-protocol overrides live under `compatByProtocol[sourceFormat]`.
 *
 * The retired `provider::model` rows of the old key_value store were never written, so the
 * lookup goes straight to the provider's compat list.
 */
export async function getModelPreserveVideoUrl(
  providerId: string,
  modelId: string,
  sourceFormat?: string | null
): Promise<boolean | undefined> {
  const protocol = sourceFormat && isCompatProtocolKey(sourceFormat) ? sourceFormat : null;
  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  if (protocol && co?.compatByProtocol?.[protocol]) {
    const pc = co.compatByProtocol[protocol]!;
    if (Object.prototype.hasOwnProperty.call(pc, KEY)) {
      return Boolean(pc[KEY]);
    }
  }
  if (co && Object.prototype.hasOwnProperty.call(co, KEY)) {
    return Boolean(co[KEY]);
  }
  return undefined;
}
