/**
 * Static CORS headers for open-sse handlers.
 *
 * `Access-Control-Allow-Origin` is set by the authz pipeline
 * (`src/server/authz/pipeline.ts`, allowlist in `src/server/cors/origins.ts`).
 * Handlers in this package only need the methods/headers list; the pipeline
 * overlays the allowed origin per the central allowlist on the way out.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, anthropic-version, x-omniroute-connection, x-omniroute-allow-cross-version-fallback, x-internal-test, accept",
};
