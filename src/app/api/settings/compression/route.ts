import { getCompressionSettings, updateCompressionSettings } from "@/lib/db/compression";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { compressionSettingsUpdateSchema } from "@/shared/validation/compressionConfigSchemas";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const settings = await getCompressionSettings();
    return Response.json(settings);
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = validateBody(compressionSettingsUpdateSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }

    const settings = await updateCompressionSettings(
      validation.data as Parameters<typeof updateCompressionSettings>[0]
    );
    return Response.json(settings);
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
