/** Aggregate local trigger for every Radar feed sync. */

import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

import { syncRadarIntel } from "@/lib/radar/intelSync";
import { syncRadarOffers } from "@/lib/radar/offersSync";
import { syncRadarReferrals } from "@/lib/radar/referralsSync";
import { syncRadar } from "@/lib/radar/sync";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import { radarSyncBodyError, validateRadarSyncBody } from "../syncRequest";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: Request) {
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
  const bodyError = radarSyncBodyError(await validateRadarSyncBody(request));
  if (bodyError) {
    return Response.json(buildErrorBody(bodyError.status, bodyError.message), {
      status: bodyError.status,
      headers: CORS_HEADERS,
    });
  }
  try {
    const catalog = await syncRadar();
    const referrals = await syncRadarReferrals();
    const offers = await syncRadarOffers();
    const intel = await syncRadarIntel();
    return Response.json({ catalog, referrals, offers, intel }, { headers: CORS_HEADERS });
  } catch (error: unknown) {
    return Response.json(
      buildErrorBody(500, sanitizeErrorMessage(error) || "Radar aggregate sync failed"),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
