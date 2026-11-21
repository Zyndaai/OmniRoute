import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { explainRouteByRequestId } from "@/lib/usage/routeExplain";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;

    const { requestId } = await params;
    const explanation = await explainRouteByRequestId(requestId);

    if (!explanation) {
      return Response.json({ error: "Routing decision not found" }, { status: 404 });
    }

    return Response.json(explanation);
  } catch (error) {
    console.error("[API ERROR] /api/routing/decisions/[requestId] failed:", error);
    return Response.json({ error: "Failed to explain routing decision" }, { status: 500 });
  }
}
