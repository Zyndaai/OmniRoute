import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import ApiManagerPageClient, { type ApiKey } from "./ApiManagerPageClient";

/**
 * The key list and the quota pool -> group names, read for the first paint. Each is optional, as
 * before: a failing key list shows an empty page, failing quota reads leave the group chips out.
 * The per-key usage totals, session counts and device counts stay client-side: they run after
 * the list is known (one request per key for devices) and fill in when they arrive.
 */
export async function loader() {
  const [keysBody, poolsBody, groupsBody] = await Promise.all([
    apiJsonOrNull<{ keys?: ApiKey[]; allowKeyReveal?: boolean }>("/api/keys"),
    apiJsonOrNull<{ pools?: Array<{ id: string; groupId: string }> }>("/api/quota/pools"),
    apiJsonOrNull<{ groups?: Array<{ id: string; name: string }> }>("/api/quota/groups"),
  ]);
  const quotaPoolGroup: Record<string, string> = {};
  if (poolsBody && groupsBody) {
    const groupNameById: Record<string, string> = {};
    for (const g of Array.isArray(groupsBody.groups) ? groupsBody.groups : []) {
      groupNameById[g.id] = g.name;
    }
    for (const p of Array.isArray(poolsBody.pools) ? poolsBody.pools : []) {
      if (groupNameById[p.groupId]) quotaPoolGroup[p.id] = groupNameById[p.groupId];
    }
  }
  return {
    keys: keysBody?.keys || [],
    allowKeyReveal: keysBody?.allowKeyReveal === true,
    quotaPoolGroup,
  };
}

export default function ApiManagerPage() {
  return <ApiManagerPageClient />;
}
