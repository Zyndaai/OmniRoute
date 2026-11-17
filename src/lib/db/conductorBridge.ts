/**
 * Conductor bridge persistence — SSE cursor (`last_event_id`) for the hub mirror.
 *
 * Stored in `config_entries` under a dedicated namespace. The cursor lets the bridge
 * resume the hub SSE from where it stopped; the hub replay covers the gap.
 */

import { getConfigValue, setConfigValue } from "./configEntries";

const NAMESPACE = "conductor";
const CURSOR_KEY = "last_event_id";

export async function getConductorCursor(): Promise<string | null> {
  const value = await getConfigValue(NAMESPACE, CURSOR_KEY);
  return typeof value === "string" ? value : null;
}

export async function setConductorCursor(value: string): Promise<void> {
  await setConfigValue(NAMESPACE, CURSOR_KEY, value);
}
