/**
 * Endpoints (`route.ts` files) that live outside `/api`. Everything else outside `/api` and the
 * rewritten aliases is a page, whose writes are React Router actions and get the page-write
 * origin check (`../origin/pageActionOrigin.ts`). An endpoint keeps its own rules: `/a2a` takes
 * JSON-RPC from agents that may run in a browser on another origin, and the embedded-service
 * proxy forwards the embedded app's own writes.
 *
 * Keep in sync with the `route.ts` files under `src/app` outside `src/app/api`
 * (`tests/unit/server/page-action-origin.test.ts` fails when one is missing).
 */
import { matchPathPattern } from "./pathPattern";

export const RESOURCE_ROUTE_PATTERNS: readonly string[] = [
  "/a2a",
  "/authorize",
  "/docs/api/search",
  "/healthz",
  "/livez",
  "/readyz",
  "/manifest.webmanifest",
  "/.well-known/agent.json",
  "/.well-known/agent-card.json",
  "/dashboard/providers/services/:name/embed/:path*",
];

/** `pathname`: base path stripped, decoded, no data suffix. */
export function isResourceRoutePath(pathname: string): boolean {
  return RESOURCE_ROUTE_PATTERNS.some((pattern) => matchPathPattern(pattern, pathname) !== null);
}
