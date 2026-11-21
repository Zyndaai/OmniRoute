import { saveCustomEvalSuite } from "@/lib/db/evals";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { evalSuiteSaveSchema } from "@/shared/validation/schemas";

export async function POST(request: Request) {
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

  const validation = validateBody(evalSuiteSaveSchema, rawBody);
  if (isValidationFailure(validation)) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  try {
    const suite = await saveCustomEvalSuite(validation.data);
    return Response.json({ suite }, { status: 201 });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Failed to create eval suite" },
      { status: 500 }
    );
  }
}
