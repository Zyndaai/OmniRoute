import { z } from "zod";
import {
  detectCommandType,
  processRtkText,
} from "@omniroute/open-sse/services/compression/engines/rtk";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { rtkConfigSchema } from "@/shared/validation/compressionConfigSchemas";

export const rtkTestSchema = z
  .object({
    text: z.string().min(1),
    command: z.string().optional(),
    config: rtkConfigSchema.optional(),
  })
  .strict();

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(rtkTestSchema, rawBody);
  if (isValidationFailure(validation)) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const detection = detectCommandType(validation.data.text, validation.data.command);
  return Response.json({
    detection,
    ...processRtkText(validation.data.text, {
      command: validation.data.command,
      config: validation.data.config,
    }),
  });
}
