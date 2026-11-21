import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getSuite } from "@/lib/evals/evalRunner";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function GET(request: Request, { params }: { params: Promise<{ suiteId: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { suiteId } = await params;
    const suite = await getSuite(suiteId);
    if (!suite) {
      return Response.json({ error: `Suite not found: ${suiteId}` }, { status: 404 });
    }
    return Response.json(suite);
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
