/**
 * Origin check for page writes: a React Router action (a POST to a page or its `.data` URL).
 *
 * React Router's built-in check compares `Origin` with `request.url`, but this server builds
 * `request.url` from the address it is bound to (`../http/requestOrigin.ts`), never from the
 * client's Host, so a same-origin dashboard behind a proxy or on `localhost` would fail it and a
 * check against it says nothing. `react-router.config.ts` therefore lets every origin through,
 * and this check runs instead, for every caller, against the server's trusted public origins
 * (configured base URL, trusted forwarded headers, direct loopback/LAN host).
 *
 * A dashboard session that proves itself with the CSRF token keeps the fallback the authz
 * pipeline gives it (a tunnel-served dashboard without a configured base URL).
 */
import { validateDashboardCsrfToken } from "../authz/csrf";
import { validateBrowserMutationOrigin } from "./publicOrigin";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isPageWrite(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** A 403 when `request` is a page write from an untrusted origin, else `null`. */
export function pageActionOriginRejection(request: Request): Response | null {
  const verdict = validateBrowserMutationOrigin(request);
  if (verdict.ok) return null;
  if (verdict.reason === "invalid-origin" && validateDashboardCsrfToken(request)) return null;
  return Response.json(
    {
      error: {
        code: "INVALID_ORIGIN",
        message:
          "Invalid request origin. Refresh the dashboard and retry, or set OMNIROUTE_PUBLIC_BASE_URL " +
          "to the address the dashboard is served from.",
      },
    },
    { status: 403 }
  );
}
