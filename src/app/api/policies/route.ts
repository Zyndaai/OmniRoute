import { getLockedIdentifiers, forceUnlock } from "@/domain/lockoutPolicy";
import { policyActionSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export async function GET() {
  try {
    const lockedIdentifiers = await getLockedIdentifiers();
    return Response.json({ lockedIdentifiers });
  } catch (error) {
    console.error("Error loading policies:", error);
    return Response.json({ error: "Failed to load policies" }, { status: 500 });
  }
}

export async function POST(request) {
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
    const validation = validateBody(policyActionSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const { action, identifier } = validation.data;

    if (action === "unlock" && identifier) {
      await forceUnlock(identifier);
      return Response.json({ success: true, action: "unlocked", identifier });
    }

    return Response.json({ error: "Unknown action. Supported: unlock" }, { status: 400 });
  } catch (error) {
    console.error("Error updating policies:", error);
    return Response.json({ error: "Failed to update policies" }, { status: 500 });
  }
}
