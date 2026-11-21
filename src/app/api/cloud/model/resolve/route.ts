import { validateApiKey, getModelAliases } from "@/models";
import { cloudResolveAliasSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

// Resolve model alias to provider/model
export async function POST(request: Request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      { error: { message: "Invalid request", details: [{ field: "body", message: "Invalid JSON body" }] } },
      { status: 400 }
    );
  }

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return Response.json({ error: "Missing API key" }, { status: 401 });
    }

    const apiKey = authHeader.slice(7);
    const validation = validateBody(cloudResolveAliasSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const { alias } = validation.data;

    // Validate API key
    const isValid = await validateApiKey(apiKey);
    if (!isValid) {
      return Response.json({ error: "Invalid API key" }, { status: 401 });
    }

    // Get model aliases
    const modelAliases = await getModelAliases();
    const resolvedValue = modelAliases[alias];
    const resolved = typeof resolvedValue === "string" ? resolvedValue : null;

    if (resolved) {
      // Parse provider/model
      const firstSlash = resolved.indexOf("/");
      if (firstSlash > 0) {
        return Response.json({
          alias,
          provider: resolved.slice(0, firstSlash),
          model: resolved.slice(firstSlash + 1),
        });
      }
    }

    // Not found
    return Response.json({ error: "Alias not found" }, { status: 404 });
  } catch (error) {
    console.log("Model resolve error:", error);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
