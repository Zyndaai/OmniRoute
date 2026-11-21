/**
 * Root-level URL aliases served by routes under `/api`. Applied after the authz pipeline, so
 * authz and route classification see the alias the client sent (`src/server/authz/classify.ts`
 * maps the client-API aliases itself), and React Router sees the target. First match wins;
 * matching is case-insensitive and the query string is kept.
 */
import { fillPathPattern, matchPathPattern } from "./pathPattern";

export interface RewriteRule {
  source: string;
  destination: string;
}

export const REWRITES: readonly RewriteRule[] = [
  { source: "/chat/completions", destination: "/api/v1/chat/completions" },
  { source: "/responses", destination: "/api/v1/responses" },
  { source: "/responses/:path*", destination: "/api/v1/responses/:path*" },
  { source: "/models", destination: "/api/v1/models" },
  { source: "/v1/v1/:path*", destination: "/api/v1/:path*" },
  { source: "/v1/v1", destination: "/api/v1" },
  // Every Codex path goes to the Responses endpoint; the tail is dropped on purpose.
  { source: "/codex/:path*", destination: "/api/v1/responses" },
  { source: "/v1/:path*", destination: "/api/v1/:path*" },
  { source: "/v1", destination: "/api/v1" },
  // CLIProxyAPI management clients. Authz: AUTHZ_PATH_PATTERNS + the classify.ts alias.
  { source: "/v0/management/:path*", destination: "/api/v0/management/:path*" },
  { source: "/v1beta/:path*", destination: "/api/v1beta/:path*" },
  { source: "/v1beta", destination: "/api/v1beta" },
  // Unknown root-level API-looking paths answer the JSON 404 of the `/api` catch-all route
  // instead of an HTML page (#6405, #6424). A real `/api/...` route at the target wins.
  { source: "/anthropic/:path*", destination: "/api/anthropic/:path*" },
  { source: "/openai/:path*", destination: "/api/openai/:path*" },
  { source: "/metrics", destination: "/api/metrics" },
  { source: "/debug", destination: "/api/debug" },
  { source: "/.env", destination: "/api/.env" },
];

/** The path `pathname` (base path stripped) is served from, or `null` when no alias applies. */
export function resolveRewrite(pathname: string): string | null {
  for (const rule of REWRITES) {
    const match = matchPathPattern(rule.source, pathname);
    if (match) return fillPathPattern(rule.destination, match);
  }
  return null;
}
