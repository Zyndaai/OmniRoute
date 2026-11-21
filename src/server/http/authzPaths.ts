/**
 * Paths the authz pipeline runs on (before rewrites). Everything else (`/healthz`, `/livez`,
 * `/readyz`, `/a2a`, `/login`, `/docs`, `/callback`, `/connect`, `/status`, static files, the
 * JSON-404 aliases `/anthropic`, `/openai`, `/metrics`, `/debug`, `/.env`) reaches its route
 * without it. Matching is case-insensitive (GHSA-jvqc-mp9f-q936): an alias in any casing is
 * routed to the same handler, so it must be authorised the same way. Keep in sync with
 * `./rewrites.ts` and `src/server/authz/classify.ts`.
 */
import { matchPathPattern } from "./pathPattern";

export const AUTHZ_PATH_PATTERNS: readonly string[] = [
  "/",
  "/dashboard/:path*",
  "/home/:path*",
  "/api/:path*",
  "/v1/:path*",
  "/v1beta/:path*",
  "/chat/:path*",
  "/responses/:path*",
  "/codex/:path*",
  "/models",
  // CLIProxyAPI management compatibility (/v0/management/* -> /api/v0/management/*). Without
  // it the alias would reach the handler without the trusted x-omniroute-auth-* headers
  // being stripped.
  "/v0/:path*",
];

/** `pathname`: base path stripped, decoded, no data suffix or trailing slash. */
export function isAuthzPath(pathname: string): boolean {
  return AUTHZ_PATH_PATTERNS.some((pattern) => matchPathPattern(pattern, pathname) !== null);
}
