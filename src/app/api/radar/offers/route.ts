/** GET the verified local Radar offers cache. Never proxies the private service. */

import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { getRadarOffers } from "@/lib/radar";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  if (!isFeatureFlagEnabled("RADAR_ENABLED")) {
    return Response.json(buildErrorBody(404, "Not found"), {
      status: 404,
      headers: CORS_HEADERS,
    });
  }
  if (!(await isAuthenticated(request))) {
    return Response.json(buildErrorBody(401, "Unauthorized"), {
      status: 401,
      headers: CORS_HEADERS,
    });
  }

  try {
    return Response.json(await getRadarOffers(), {
      headers: { ...CORS_HEADERS, "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    return Response.json(
      buildErrorBody(500, sanitizeErrorMessage(error) || "Failed to load Radar offers"),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
