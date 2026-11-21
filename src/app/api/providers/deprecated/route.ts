import { z } from "zod";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getRawProviderConnections } from "@/lib/db/providers";
import { deleteProviderConnectionsByProvider } from "@/lib/db/providers/deletion";
import { listDeprecatedProviderLeftovers } from "@/lib/providers/deprecatedProviderCleanup";
import { isDeprecatedProvider } from "@omniroute/open-sse/services/tokenRefresh.ts";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const purgeSchema = z.object({
  provider: z.string().min(1),
});

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const rows = await getRawProviderConnections({}, undefined, undefined, [
    "id",
    "provider",
    "name",
  ]);
  const connections = rows.flatMap((row) => {
    if (typeof row.id !== "string") return [];
    return [
      {
        id: row.id,
        provider: typeof row.provider === "string" ? row.provider : null,
        name: typeof row.name === "string" ? row.name : null,
      },
    ];
  });
  return Response.json({ leftovers: listDeprecatedProviderLeftovers(connections) });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const auditContext = getAuditRequestContext(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(purgeSchema, body);
  if (isValidationFailure(validation)) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const { provider } = validation.data;
  if (!isDeprecatedProvider(provider)) {
    return Response.json({ error: "Provider is not deprecated" }, { status: 400 });
  }

  const deleted = Number(await deleteProviderConnectionsByProvider(provider) || 0);

  await logAuditEvent({
    action: "provider.credentials.revoked",
    actor: "admin",
    target: provider,
    resourceType: "provider_credentials",
    status: "success",
    ipAddress: auditContext.ipAddress || undefined,
    requestId: auditContext.requestId,
    metadata: {
      provider,
      reason: "deprecated_provider_purge",
      deleted,
    },
  });

  return Response.json({ deleted });
}
