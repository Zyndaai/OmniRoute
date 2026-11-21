import { deleteCustomEvalSuite, getCustomEvalSuite, saveCustomEvalSuite } from "@/lib/db/evals";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { evalSuiteSaveSchema } from "@/shared/validation/schemas";

export async function GET(request: Request, { params }: { params: Promise<{ suiteId: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { suiteId } = await params;
    const suite = await getCustomEvalSuite(suiteId);
    if (!suite) {
      return Response.json({ error: "Eval suite not found" }, { status: 404 });
    }
    return Response.json({ suite });
  } catch (error: any) {
    return Response.json({ error: error?.message || "Failed to load eval suite" }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ suiteId: string }> }) {
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
    const { suiteId } = await params;
    const existing = await getCustomEvalSuite(suiteId);
    if (!existing) {
      return Response.json({ error: "Eval suite not found" }, { status: 404 });
    }

    const suite = await saveCustomEvalSuite({ ...validation.data, id: suiteId });
    return Response.json({ suite });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Failed to update eval suite" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ suiteId: string }> }
) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { suiteId } = await params;
    const deleted = await deleteCustomEvalSuite(suiteId);
    if (!deleted) {
      return Response.json({ error: "Eval suite not found" }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Failed to delete eval suite" },
      { status: 500 }
    );
  }
}
