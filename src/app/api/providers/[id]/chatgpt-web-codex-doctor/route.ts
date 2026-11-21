import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnectionById } from "@/lib/db/providers";
import { getChatGptWebCodexDoctorStatus } from "@omniroute/open-sse/services/chatgptWebCodexAdmin.ts";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection || connection.provider !== "chatgpt-web-codex") {
    return Response.json({ error: "ChatGPT Web (Codex) connection not found" }, { status: 404 });
  }
  return Response.json({ status: await getChatGptWebCodexDoctorStatus(connection) });
}
