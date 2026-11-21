import { getTailscaleTunnelStatus, startTailscaleDaemon } from "@/lib/tailscaleTunnel";
import { toPublicSafeTunnelError } from "@/lib/api/publicSafeTunnelError";
import { parseOptionalJsonBody, requireTailscaleAuth, tailscaleSudoSchema } from "../routeUtils";

export async function POST(request: Request) {
  const authError = await requireTailscaleAuth(request);
  if (authError) return authError;

  const parsed = await parseOptionalJsonBody(request, tailscaleSudoSchema);
  if ("response" in parsed) return parsed.response;

  try {
    await startTailscaleDaemon(parsed.data);
    return Response.json({
      success: true,
      status: await getTailscaleTunnelStatus(),
    });
  } catch (error) {
    return Response.json(
      toPublicSafeTunnelError(
        error,
        "Failed to start the Tailscale daemon.",
        "tunnels/tailscale/start-daemon POST"
      ),
      { status: 500 }
    );
  }
}
