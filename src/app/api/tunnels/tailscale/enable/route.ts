import { enableTailscaleTunnel } from "@/lib/tailscaleTunnel";
import { toPublicSafeTunnelError } from "@/lib/api/publicSafeTunnelError";
import { parseOptionalJsonBody, requireTailscaleAuth, tailscaleEnableSchema } from "../routeUtils";

export async function POST(request: Request) {
  const authError = await requireTailscaleAuth(request);
  if (authError) return authError;

  const parsed = await parseOptionalJsonBody(request, tailscaleEnableSchema);
  if ("response" in parsed) return parsed.response;

  try {
    const result = await enableTailscaleTunnel(parsed.data);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      toPublicSafeTunnelError(
        error,
        "Failed to enable the Tailscale Funnel.",
        "tunnels/tailscale/enable POST"
      ),
      { status: 500 }
    );
  }
}
