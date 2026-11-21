import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getWebSessionPoolHealth } from "@omniroute/open-sse/services/webSessionPoolHealth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function GET(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const report = await getWebSessionPoolHealth();
    return Response.json(report);
  } catch (err) {
    return Response.json(
      { error: sanitizeErrorMessage(err) || "Failed to get session pool health" },
      { status: 500 }
    );
  }
}
