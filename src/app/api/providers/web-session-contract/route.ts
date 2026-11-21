import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildWebSessionContract } from "@/lib/providers/webSessionContract";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  return Response.json(buildWebSessionContract());
}
