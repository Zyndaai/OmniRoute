import { apiRead } from "@/server/routing/dashboardApi.server";
import type { CliKeysLoaded, EndpointApiKeySummary } from "./VscodeTokenAliasCard";

/**
 * The CLI keys for the VS Code token alias card (`/api/cli-tools/keys`). An optional read: a
 * failure gives no keys and `failed: true`, so the card shows placeholder URLs.
 */
export async function readCliKeys(): Promise<CliKeysLoaded> {
  const result = await apiRead<{ keys?: EndpointApiKeySummary[] }>("/api/cli-tools/keys");
  if (!result.ok) return { keys: [], failed: true };
  return { keys: result.data?.keys || [], failed: false };
}
