/**
 * MCP SSE Transport — /api/mcp/sse
 *
 * Endpoints:
 *   GET    — open SSE stream for bidirectional communication
 *   POST   — send JSON-RPC messages to the MCP server
 */

import { getCachedSettings } from "@/lib/db/settings";
import { handleMcpSSE } from "../../../../../open-sse/mcp-server/httpTransport";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

async function guardEnabled(): Promise<Response | null> {
  const settings = await getCachedSettings();
  if (!settings.mcpEnabled) {
    return Response.json(
      { error: "MCP server is disabled. Enable it from the Endpoints page." },
      { status: 503 }
    );
  }
  const transport = settings.mcpTransport as string;
  if (transport !== "sse") {
    return Response.json(
      { error: `MCP transport is set to "${transport}", not "sse". Change it from Settings.` },
      { status: 400 }
    );
  }
  return null;
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { acceptMcpConnectScope: true });
  if (authError) return authError;
  const blocked = await guardEnabled();
  if (blocked) return blocked;
  return handleMcpSSE(request);
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { acceptMcpConnectScope: true });
  if (authError) return authError;
  const blocked = await guardEnabled();
  if (blocked) return blocked;
  return handleMcpSSE(request);
}
