import { toValidationErrorResult, validationRead } from "./transport";

// Cloudflare error codes for invalid request headers, invalid tokens and authentication failure.
const AUTH_ERROR_CODES = new Set([6003, 9106, 10000]);

export const CLOUDFLARE_ACCOUNT_ID_REQUIRED =
  "Cloudflare Workers AI requires an Account ID. " +
  "Add it in provider settings under 'Account ID'. " +
  "Find it at: https://dash.cloudflare.com (right sidebar).";

type CloudflareAiValidationResult = {
  valid: boolean;
  error: string | null;
  statusCode?: number;
  unsupported?: boolean;
};

/** Interpret only recognized metadata/auth envelopes; ambiguous probes must not poison key health. */
export function cloudflareAiValidationResult(
  status: number,
  body: unknown
): CloudflareAiValidationResult {
  const envelope = body as { success?: unknown; result?: unknown; errors?: unknown } | null;
  if (status === 200) {
    if (envelope?.success === true && Array.isArray(envelope.result)) {
      return { valid: true, error: null };
    }
    return {
      valid: false,
      unsupported: true,
      error: "Cloudflare credential probe returned an unrecognized envelope",
      statusCode: status,
    };
  }
  const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
  const authRejected =
    status === 401 ||
    ((status === 400 || status === 403) &&
      errors.some((entry: unknown) => {
        const code = (entry as { code?: unknown } | null)?.code;
        return typeof code === "number" && AUTH_ERROR_CODES.has(code);
      }));
  if (authRejected) return { valid: false, error: "Invalid API key", statusCode: status };
  if (status === 403 || status === 429) {
    return {
      valid: false,
      unsupported: true,
      error: `Cloudflare credential probe inconclusive (${status})`,
      statusCode: status,
    };
  }
  return { valid: false, error: `Validation failed: ${status}`, statusCode: status };
}

/**
 * GET the authenticated account's model metadata, without running inference. The account id
 * comes from the connection form (providerSpecificData.accountId) and falls back to
 * CLOUDFLARE_ACCOUNT_ID, the same selection the executor uses.
 * https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/
 */
export async function validateCloudflareAiProvider({
  apiKey,
  providerSpecificData = {},
}: {
  apiKey?: string;
  providerSpecificData?: Record<string, unknown> | null;
}): Promise<CloudflareAiValidationResult> {
  const formAccountId = providerSpecificData?.accountId;
  const accountId =
    (typeof formAccountId === "string" ? formAccountId.trim() : "") ||
    process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) return { valid: false, error: CLOUDFLARE_ACCOUNT_ID_REQUIRED };
  try {
    const response = await validationRead(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?per_page=1`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } }
    );
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON WAF/transport responses are classified as unrecognized, never accepted as success.
    }
    return cloudflareAiValidationResult(response.status, body);
  } catch (error: unknown) {
    return toValidationErrorResult(error);
  }
}
