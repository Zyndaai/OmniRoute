import { data } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { CLI_TOOLS } from "@/shared/constants/cliTools";

/**
 * Loader body shared by the cli-code and cli-agents detail pages. The tool id is validated
 * against the catalogue first (404 for an unknown tool or one of the other category). All reads
 * are optional: the old page rendered the card with empty defaults when one of them failed.
 * `/v1/models` (not an `/api` route) stays a client read in ToolDetailClient.
 */
export async function loadToolDetail(id: string, category: "code" | "agent") {
  const tool = CLI_TOOLS[id];
  if (!tool || tool.category !== category) throw data(null, { status: 404 });

  const [providers, keys, settings] = await Promise.all([
    apiJsonOrNull<{ connections?: unknown[] }>("/api/providers"),
    apiJsonOrNull<{ keys?: unknown[] }>("/api/cli-tools/keys"),
    apiJsonOrNull<{ cloudEnabled?: boolean }>("/api/settings"),
  ]);

  return {
    id,
    connections: (providers?.connections ?? []) as any[],
    apiKeys: (keys?.keys ?? []) as any[],
    cloudEnabled: settings?.cloudEnabled || false,
  };
}
