import { z } from "zod";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";
import { getNgrokTunnelStatus, startNgrokTunnel, stopNgrokTunnel } from "@/lib/ngrokTunnel";
import { toPublicSafeTunnelError } from "@/lib/api/publicSafeTunnelError";

const actionSchema = z.object({
  action: z.enum(["enable", "disable"]),
  authToken: z.string().optional(),
});

function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return unauthorized();
  }

  try {
    const status = await getNgrokTunnelStatus();
    return Response.json(status);
  } catch (error) {
    return Response.json(
      toPublicSafeTunnelError(
        error,
        "Failed to load the ngrok tunnel status.",
        "tunnels/ngrok GET"
      ),
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) {
    return unauthorized();
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(actionSchema, rawBody);
  if (isValidationFailure(validation)) {
    // validateBody() returns { success, error } — it has no `response` field, so
    // the previous `return validation.response` returned undefined and Next
    // answered with a framework 500 instead of this 400.
    return Response.json({ error: formatValidationMessage(validation.error) }, { status: 400 });
  }

  const parsed = validation.data;

  try {
    const status =
      parsed.action === "enable"
        ? await startNgrokTunnel(parsed.authToken)
        : await stopNgrokTunnel();

    return Response.json({
      success: true,
      action: parsed.action,
      status,
    });
  } catch (error) {
    return Response.json(
      toPublicSafeTunnelError(error, "Failed to update the ngrok tunnel.", "tunnels/ngrok POST"),
      { status: 500 }
    );
  }
}
