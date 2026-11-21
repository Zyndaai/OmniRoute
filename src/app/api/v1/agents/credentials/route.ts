import { z } from "zod";
import {
  listCloudAgentCredentials,
  saveCloudAgentCredential,
  maskApiKey,
} from "@/lib/cloudAgent/credentials";
import { getCloudAgentCorsHeaders, requireCloudAgentManagementAuth } from "@/lib/cloudAgent/api";
import pino from "pino";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const logger = pino({ name: "cloud-agents-credentials-api" });

const SaveCredentialSchema = z.object({
  providerId: z.enum(["jules", "devin", "codex-cloud", "cursor-cloud"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

export async function OPTIONS(request: Request) {
  return new Response(null, { headers: getCloudAgentCorsHeaders(request) });
}

export async function GET(request: Request) {
  try {
    const authError = await requireCloudAgentManagementAuth(request);
    if (authError) return authError;

    const data = await listCloudAgentCredentials();

    return Response.json({ data }, { headers: getCloudAgentCorsHeaders(request) });
  } catch (error) {
    logger.error({ err: error }, "Failed to list cloud agent credentials");
    return Response.json(
      {
        error:
          sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown error") ||
          "Internal server error",
      },
      { status: 500, headers: getCloudAgentCorsHeaders(request) }
    );
  }
}

export async function POST(request: Request) {
  try {
    const authError = await requireCloudAgentManagementAuth(request);
    if (authError) return authError;

    const body = await request.json();
    const validation = SaveCredentialSchema.safeParse(body);
    if (!validation.success) {
      return Response.json(
        { error: "Validation failed", details: validation.error.issues },
        { status: 400, headers: getCloudAgentCorsHeaders(request) }
      );
    }

    const { providerId, apiKey, baseUrl } = validation.data;

    await saveCloudAgentCredential(providerId, apiKey, baseUrl);

    return Response.json(
      {
        data: {
          providerId,
          apiKey: maskApiKey(apiKey),
          baseUrl: baseUrl ?? null,
        },
      },
      { status: 201, headers: getCloudAgentCorsHeaders(request) }
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to save cloud agent credentials");
    return Response.json(
      {
        error:
          sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown error") ||
          "Internal server error",
      },
      { status: 500, headers: getCloudAgentCorsHeaders(request) }
    );
  }
}
