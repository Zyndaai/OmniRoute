import {
  configureIPFilter,
  getIPFilterConfig,
  addToBlacklist,
  removeFromBlacklist,
  addToWhitelist,
  removeFromWhitelist,
  tempBanIP,
  removeTempBan,
} from "@omniroute/open-sse/services/ipFilter.ts";
import { updateIpFilterSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return Response.json(await getIPFilterConfig());
  } catch (error) {
    console.error("Error getting IP filter config:", error);
    return Response.json({ error: "Failed to get IP filter config" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(updateIpFilterSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const body = validation.data;

    // Configure entire filter
    if (body.enabled !== undefined || body.mode || body.blacklist || body.whitelist) {
      await configureIPFilter(body);
    }

    // Add/remove individual IPs
    if (body.addBlacklist) await addToBlacklist(body.addBlacklist);
    if (body.removeBlacklist) await removeFromBlacklist(body.removeBlacklist);
    if (body.addWhitelist) await addToWhitelist(body.addWhitelist);
    if (body.removeWhitelist) await removeFromWhitelist(body.removeWhitelist);

    // Temp bans
    if (body.tempBan) {
      tempBanIP(
        body.tempBan.ip,
        body.tempBan.durationMs || 3600000,
        body.tempBan.reason || "Manual ban"
      );
    }
    if (body.removeBan) removeTempBan(body.removeBan);

    return Response.json(await getIPFilterConfig());
  } catch (error) {
    console.error("Error updating IP filter config:", error);
    return Response.json({ error: "Failed to update IP filter config" }, { status: 500 });
  }
}
