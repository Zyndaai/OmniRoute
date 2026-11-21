import { requestCookie } from "@/server/requestContext";
import {
  getDashboardJwtSecret,
  verifyDashboardSessionToken,
  DASHBOARD_SESSION_COOKIE,
} from "@/shared/utils/dashboardSessionToken";

export async function GET(request?: Request) {
  try {
    const token = requestCookie(DASHBOARD_SESSION_COOKIE, request);
    const secret = getDashboardJwtSecret();

    if (!token || !secret) {
      return Response.json({ authenticated: false });
    }

    const payload = await verifyDashboardSessionToken(token, secret);
    return Response.json({ authenticated: payload !== null });
  } catch {
    return Response.json({ authenticated: false });
  }
}
