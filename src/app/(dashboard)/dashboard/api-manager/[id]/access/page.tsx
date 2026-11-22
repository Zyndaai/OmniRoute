import { useLoaderData } from "react-router";
import { apiJson, apiJsonOrNull, apiRequest } from "@/server/routing/dashboardApi.server";
import { skipSearchOnlyRevalidation } from "@/shared/utils/routeRevalidation";
import type { ProviderConnection } from "../../components/ProviderConnectionPermissionList";
import ApiKeyAccessEditorClient from "./ApiKeyAccessEditorClient";
import type { ApiKeyAccessData } from "./useApiKeyAccessForm";
import type { ComboOption } from "./tabs/CombosTab";

/**
 * Required: the key (a 404 shows the "key not found" card, any other failure the load-error
 * card). Optional, falling back to empty lists as before: combos and provider connections.
 * The model list stays client-side (`/v1/models`, not an `/api` route).
 */
export async function loader({ params }: { params: { id?: string } }) {
  const id = params.id ?? "";
  const keyPath = `/api/keys/${encodeURIComponent(id)}`;
  const keyResponse = await apiRequest(keyPath);
  // apiJson() turns a 401 into the login redirect; the replay is the same request, so it throws.
  if (keyResponse.status === 401) await apiJson(keyPath);
  const [apiKey, combosBody, providersBody] = await Promise.all([
    keyResponse.ok ? (keyResponse.json() as Promise<ApiKeyAccessData>) : Promise.resolve(null),
    apiJsonOrNull<{ combos?: ComboOption[] }>("/api/combos"),
    apiJsonOrNull<{ connections?: ProviderConnection[] }>("/api/providers"),
  ]);
  const combos = Array.isArray(combosBody?.combos) ? combosBody.combos : [];
  return {
    id,
    apiKey,
    keyStatus: keyResponse.status,
    combos: combos.filter((c) => typeof c?.name === "string" && c.name.trim()),
    connections: providersBody?.connections || [],
  };
}

/**
 * The tab lives in the query string (`?tab=`); switching it must not re-read the key, which
 * would reset the form's unsaved edits. Same-URL revalidation still re-runs the loader.
 */
export const shouldRevalidate = skipSearchOnlyRevalidation;

export default function ApiKeyAccessPage() {
  const { id } = useLoaderData<typeof loader>();
  return <ApiKeyAccessEditorClient apiKeyId={id} />;
}
