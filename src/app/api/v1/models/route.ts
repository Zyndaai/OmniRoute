import { getUnifiedModelsResponse } from "./catalog";
import { getFilteredCatalogResponse } from "./catalogDiscovery";
import { hasCatalogDiscoveryParams } from "./catalogFilters";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * HEAD /v1/models - availability probe (RFC 9110 §9.3.2: HEAD returns headers only)
 *
 * Explicit handler: without it HEAD falls back to GET (src/server/routing/apiResource.ts),
 * which builds the full catalog (200+ providers enumerated on-demand) only to drop the
 * body — a ~6s hang for clients like the OpenAI SDK that use HEAD as a health probe.
 * See: https://github.com/cheaper-inference/OmniRoute/issues/6400
 */
export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list
 *
 * Optional discovery filters: `capability` (repeatable / comma-separated),
 * `min_context`, `kind`, `q`. Without any of them the response is untouched.
 */
export async function GET(request: Request) {
  if (hasCatalogDiscoveryParams(new URL(request.url).searchParams)) {
    return getFilteredCatalogResponse(request, (catalogRequest) =>
      getUnifiedModelsResponse(catalogRequest)
    );
  }
  return getUnifiedModelsResponse(request);
}
