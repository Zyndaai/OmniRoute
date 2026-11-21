import { getAllFallbackChains, registerFallback, removeFallback } from "@/domain/fallbackPolicy";
import { registerFallbackSchema, removeFallbackSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export async function GET() {
  try {
    const chains = await getAllFallbackChains();
    return Response.json(chains);
  } catch (error) {
    console.error("Error fetching fallback chains:", error);
    return Response.json({ error: "Failed to fetch fallback chains" }, { status: 500 });
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
    const validation = validateBody(registerFallbackSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const { model, chain } = validation.data;

    await registerFallback(model, chain);
    return Response.json({ success: true, model });
  } catch (error) {
    console.error("Error registering fallback chain:", error);
    return Response.json({ error: "Failed to register fallback chain" }, { status: 500 });
  }
}

export async function DELETE(request) {
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
    const validation = validateBody(removeFallbackSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const { model } = validation.data;
    const removed = await removeFallback(model);
    return Response.json({ success: true, removed });
  } catch (error) {
    console.error("Error removing fallback chain:", error);
    return Response.json({ error: "Failed to remove fallback chain" }, { status: 500 });
  }
}
