import { useLoaderData } from "react-router";
import { apiJson, apiRead, apiRequest } from "@/server/routing/dashboardApi.server";
import ApiEndpointsTab, {
  type ApiEndpointsCatalog,
  type ApiEndpointsLoaded,
} from "../endpoint/ApiEndpointsTab";
import { readCliKeys } from "../endpoint/cliKeys.server";

type ApiKeyRow = { id?: unknown; key?: unknown; isActive?: boolean; isBanned?: boolean };

/** The OpenAPI catalog, or the failing status plus the route's own `error` message. */
async function readCatalog(): Promise<
  | { catalog: ApiEndpointsCatalog; status: null; message: null }
  | { catalog: null; status: number; message: string | null }
> {
  const response = await apiRequest("/api/openapi/spec");
  // A 401 redirects to the login page (apiJson throws the redirect).
  if (response.status === 401) await apiJson("/api/openapi/spec");
  const body = (await response.json().catch(() => null)) as
    (ApiEndpointsCatalog & { error?: unknown }) | null;
  if (response.ok && body) return { catalog: body, status: null, message: null };
  return {
    catalog: null,
    status: response.status,
    message: body && typeof body.error === "string" ? body.error : null,
  };
}

/**
 * The OpenAPI catalog and the (masked) API keys for the "Try It" panel. Both reads are optional:
 * a failure keeps its HTTP status so the page shows the old "could not load" messages.
 */
export async function loader(): Promise<ApiEndpointsLoaded> {
  const [spec, keys, cliKeys] = await Promise.all([
    readCatalog(),
    apiRead<{ keys?: ApiKeyRow[] } | ApiKeyRow[]>("/api/keys", { query: { limit: 100 } }),
    readCliKeys(),
  ]);
  const rows: ApiKeyRow[] =
    keys.ok && keys.data
      ? Array.isArray(keys.data)
        ? keys.data
        : Array.isArray(keys.data.keys)
          ? keys.data.keys
          : []
      : [];
  return {
    catalog: spec.catalog,
    catalogStatus: spec.status,
    catalogMessage: spec.message,
    apiKeys: rows
      .filter((k) => k?.id && k.isActive !== false && k.isBanned !== true)
      .map((k) => ({ id: String(k.id), key: String(k.key || k.id) })),
    apiKeysStatus: keys.ok ? null : keys.status,
    cliKeys,
  };
}

export default function ApiEndpointsPage() {
  const loaded = useLoaderData<typeof loader>();
  return <ApiEndpointsTab loaded={loaded as ApiEndpointsLoaded} />;
}
