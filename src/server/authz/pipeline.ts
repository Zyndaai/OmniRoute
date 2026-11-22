import { stringifySetCookie } from "cookie";

import { rebuildRequest } from "../http/rebuildRequest";
import { requestCookie } from "../requestContext";
import { getCachedSettings } from "../../lib/db/readCache";
import { isDraining } from "../../lib/gracefulShutdown";
import { checkBodySize, getBodySizeLimit } from "../../shared/middleware/bodySizeGuard";
import {
  verifyDashboardSessionToken,
  mintDashboardSessionToken,
  DASHBOARD_SESSION_COOKIE,
  getDashboardJwtSecret,
} from "@/shared/utils/dashboardSessionToken";
import { generateRequestId } from "../../shared/utils/requestId";
import { applyCorsHeaders } from "../cors/origins";
import {
  buildMcpInvalidOriginBody,
  isMcpOriginGuardedPath,
  validateMcpRequestOrigin,
} from "../origin/mcpOrigin";
import { validateBrowserMutationOrigin } from "../origin/publicOrigin";
import { classifyRoute } from "./classify";
import { validateDashboardCsrfToken } from "./csrf";
import {
  classifyStampedPeerLocality,
  resolveStampedPeer,
  resolveStampedViaProxy,
} from "./peerStamp";
import { checkRequestIP } from "@omniroute/open-sse/services/ipFilter.ts";
import { clientApiPolicy } from "./policies/clientApi";
import { managementPolicy } from "./policies/management";
import { publicPolicy } from "./policies/public";
import {
  AUTHZ_HEADER_AUTH_ID,
  AUTHZ_HEADER_AUTH_KIND,
  AUTHZ_HEADER_AUTH_LABEL,
  AUTHZ_HEADER_AUTH_SCOPES,
  AUTHZ_HEADER_PEER_LOCALITY,
  AUTHZ_HEADER_REQUEST_ID,
  AUTHZ_HEADER_ROUTE_CLASS,
  AUTHZ_HEADER_TRUSTED_PEER_IP,
  AUTHZ_TRUSTED_HEADERS,
  CLI_TOKEN_HEADER,
  PEER_IP_HEADER,
  VIA_PROXY_HEADER,
  CLIENT_IP_HEADER,
  AUTHZ_HEADER_TRUSTED_CLIENT_IP,
} from "./headers";
import type { AuthSubject, RouteClass, RouteClassification } from "./types";
import type { AuthOutcome, RoutePolicy } from "./context";

/** The rest of the request pipeline: called with the request the route must receive. */
export type AuthzNext = (request: Request) => Response | Promise<Response>;

export interface AuthzPipelineOptions {
  enforce?: boolean;
  /**
   * Path to classify: base path stripped, percent-decoded, without a data suffix. Defaults to
   * the request URL's path.
   */
  pathname?: string;
  /** Base path the redirects it answers with are prefixed with (`""` at the root). */
  basePath?: string;
  /**
   * Continues an allowed request. It receives the request with the trusted headers stripped
   * and re-stamped; the headers the pipeline adds to its response are merged into the result,
   * a header the route set itself winning. Defaults to an empty 200 response.
   */
  next?: AuthzNext;
}

const emptyNext: AuthzNext = () => new Response(null, { status: 200 });

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/**
 * Same-origin redirects carry a path, not an absolute URL: `request.url` holds the address the
 * server is bound to, which a client behind a proxy or on the LAN cannot reach.
 */
function redirectResponse(location: string): Response {
  return new Response(null, { status: 307, headers: { Location: location } });
}

/**
 * Headers the pipeline set on `stamped` are added to `response` unless the route set the same
 * header; `Set-Cookie` values are appended. The response is copied because some have
 * immutable headers (`fetch()`, `Response.redirect()`); the body keeps streaming.
 */
function mergeResponseHeaders(response: Response, stamped: Headers): Response {
  const nullBody = [101, 103, 204, 205, 304].includes(response.status);
  const target = new Response(nullBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
  for (const [name, value] of stamped) {
    if (name === "set-cookie") continue;
    if (!target.headers.has(name)) target.headers.set(name, value);
  }
  for (const cookie of stamped.getSetCookie()) target.headers.append("Set-Cookie", cookie);
  return target;
}

function deleteCookieHeader(name: string): string {
  return stringifySetCookie({ name, value: "", path: "/", expires: new Date(0) });
}

const POLICIES: Record<RouteClass, RoutePolicy> = {
  PUBLIC: publicPolicy,
  CLIENT_API: clientApiPolicy,
  MANAGEMENT: managementPolicy,
};

function stampSubject(headers: Headers, subject: AuthSubject): void {
  headers.set(AUTHZ_HEADER_AUTH_KIND, subject.kind);
  headers.set(AUTHZ_HEADER_AUTH_ID, subject.id);
  if (subject.label) headers.set(AUTHZ_HEADER_AUTH_LABEL, subject.label);
  if (subject.scopes && subject.scopes.length > 0) {
    headers.set(AUTHZ_HEADER_AUTH_SCOPES, subject.scopes.join(","));
  }
}

function rejectionResponse(
  outcome: Extract<AuthOutcome, { allow: false }>,
  classification: RouteClassification,
  requestId: string
): Response {
  const response = jsonResponse(
    {
      error: {
        code: outcome.code,
        message: outcome.message,
        correlation_id: requestId,
      },
    },
    outcome.status
  );
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
  return response;
}

function isDashboardPath(pathname: string): boolean {
  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/home" ||
    pathname.startsWith("/home/")
  );
}

function isManagementDashboardRoute(
  classification: RouteClassification,
  pathname: string
): boolean {
  return classification.routeClass === "MANAGEMENT" && isDashboardPath(pathname);
}

function shouldUseSecureCookie(request: Request): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https" || new URL(request.url).protocol === "https:";
}

// Module-level (not per-call): throttles the stale-cookie warning below to once per
// process instead of once per request, avoiding log-flooding from a background dashboard
// tab or foreign token riding along on every request (see #13684 LEDGER-12).
let staleDashboardJwtWarningEmitted = false;

async function refreshDashboardSessionIfNeeded(
  response: Response,
  request: Request
): Promise<void> {
  const secret = getDashboardJwtSecret();
  if (!secret) return;

  const token = requestCookie(DASHBOARD_SESSION_COOKIE, request);
  if (!token) return;

  try {
    const payload = await verifyDashboardSessionToken(token, secret);
    if (!payload) {
      // Not a dashboard session (foreign/expired/claim-less token): drop it so a
      // Cursor CLI token can never ride along as the cookie (#13298).
      response.headers.append("Set-Cookie", deleteCookieHeader(DASHBOARD_SESSION_COOKIE));
      if (!staleDashboardJwtWarningEmitted) {
        staleDashboardJwtWarningEmitted = true;
        console.warn("[Authz] Dropped stale dashboard session cookie during auto-refresh");
      }
      return;
    }
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    if (!exp) return;

    const now = Math.floor(Date.now() / 1000);
    const refreshWindowSeconds = 7 * 24 * 60 * 60;
    if (exp - now >= refreshWindowSeconds) return;

    const freshToken = await mintDashboardSessionToken(secret);

    response.headers.append(
      "Set-Cookie",
      stringifySetCookie({
        name: DASHBOARD_SESSION_COOKIE,
        value: freshToken,
        httpOnly: true,
        secure: shouldUseSecureCookie(request),
        sameSite: "lax",
        path: "/",
      })
    );
  } catch (error) {
    console.error("[Authz] JWT auto-refresh failed:", error);
  }
}

/**
 * A React Router data request (`/x.data`, sent by `fetch()` for loaders and actions) must not
 * get a plain redirect: `fetch()` would follow it and hand the router the login page's HTML.
 * React Router's client reads a 204 carrying `X-Remix-Redirect` as a redirect instead, and
 * `X-Remix-Reload-Document` makes it a full page load.
 */
function isRouterDataRequest(request: Request): boolean {
  return new URL(request.url).pathname.endsWith(".data");
}

function dashboardLoginRedirect(request: Request, basePath: string, requestId: string): Response {
  const location = `${basePath}/login`;
  const response = isRouterDataRequest(request)
    ? new Response(null, {
        status: 204,
        headers: {
          "X-Remix-Redirect": location,
          "X-Remix-Status": "302",
          "X-Remix-Reload-Document": "true",
        },
      })
    : redirectResponse(location);
  response.headers.append("Set-Cookie", deleteCookieHeader(DASHBOARD_SESSION_COOKIE));
  stampRouteResponse(response, requestId, "MANAGEMENT");
  applyCorsHeaders(response, request);
  return response;
}

function drainingResponse(requestId: string): Response {
  const response = jsonResponse(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Server is shutting down",
        correlation_id: requestId,
      },
    },
    503
  );
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  response.headers.set("Retry-After", "5");
  return response;
}

function invalidOriginResponse(requestId: string): Response {
  const response = jsonResponse(
    {
      error: {
        code: "INVALID_ORIGIN",
        message:
          "Invalid request origin. Same-origin dashboard writes must include a valid dashboard CSRF token. " +
          "Refresh the dashboard and retry, or set OMNIROUTE_PUBLIC_BASE_URL for non-dashboard browser integrations.",
        correlation_id: requestId,
      },
    },
    403
  );
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  return response;
}

function mcpInvalidOriginResponse(requestId: string): Response {
  const response = jsonResponse(buildMcpInvalidOriginBody(requestId), 403);
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  return response;
}

function isUnsafeMutationMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function stampRouteResponse(
  response: Response,
  requestId: string,
  routeClass: RouteClass
): Response {
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, routeClass);
  return response;
}

async function getBodySizeSettings(): Promise<Record<string, unknown> | undefined> {
  try {
    return await getCachedSettings();
  } catch (error) {
    console.warn(
      "[Authz] Failed to load request body limit settings:",
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}

export async function runAuthzPipeline(
  request: Request,
  options: AuthzPipelineOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = options.pathname ?? url.pathname;
  const basePath = options.basePath ?? "";
  const next = options.next ?? emptyNext;
  const method = request.method;

  const requestId = generateRequestId();

  if (pathname === "/") {
    // Zed's native-app sign-in redirects the browser to the loopback ROOT
    // (http://127.0.0.1:<port>/?user_id=...&access_token=...), ignoring any
    // path. When the dashboard's own loopback port is reused as native_app_port
    // (see src/lib/oauth/providers/zed-hosted.ts), that redirect lands HERE. The
    // root page (src/app/page.tsx) is meant to forward the payload to the
    // /callback relay, but this pipeline runs first and the redirect below
    // only built `basePath + "/dashboard"` — dropping the query string and
    // silently losing the zed-hosted / native_app_signin result. Detect the
    // native callback and forward it straight to /callback preserving the
    // params, mirroring page.tsx.
    const { searchParams, search } = url;
    const hasNativeCallback = searchParams.get("user_id") && searchParams.get("access_token");
    const response = redirectResponse(
      hasNativeCallback ? `${basePath}/callback${search}` : `${basePath}/dashboard`
    );
    return stampRouteResponse(response, requestId, "MANAGEMENT");
  }

  const classification = classifyRoute(pathname, method);
  const guardedPathname = classification.normalizedPath;
  const managementDashboardRoute = isManagementDashboardRoute(classification, pathname);

  // Relax the CORS origin fallback ONLY for the token-authenticated API
  // surface (CLIENT_API: /v1/*, /v1beta/*, codex/responses aliases) and
  // read-only PUBLIC endpoints. These authenticate via Authorization /
  // x-api-key headers that browsers never auto-attach, so echoing the caller's
  // Origin (or `*`) there carries no credentialed-session / CSRF risk — it just
  // lets browser/Electron clients (issue #5242) read responses they are already
  // entitled to. MANAGEMENT (cookie-authed dashboard) and non-read-only PUBLIC
  // routes (e.g. /api/cloud/, which sets Allow-Credentials in its own handler)
  // stay exactly fail-closed.
  const corsRelaxOrigin =
    classification.routeClass === "CLIENT_API" ||
    (classification.routeClass === "PUBLIC" && classification.reason === "public_readonly_prefix");

  if (guardedPathname.startsWith("/api/") && isDraining()) {
    const response = drainingResponse(requestId);
    stampRouteResponse(response, requestId, classification.routeClass);
    applyCorsHeaders(response, request, corsRelaxOrigin);
    return response;
  }

  if (guardedPathname.startsWith("/api/") && method !== "GET" && method !== "OPTIONS") {
    const bodySizeSettings = await getBodySizeSettings();
    const bodySizeRejection = checkBodySize(
      request,
      getBodySizeLimit(guardedPathname, bodySizeSettings)
    );
    if (bodySizeRejection) {
      stampRouteResponse(bodySizeRejection, requestId, classification.routeClass);
      applyCorsHeaders(bodySizeRejection, request, corsRelaxOrigin);
      return bodySizeRejection;
    }
  }

  const requestHeaders = new Headers(request.headers);
  for (const trusted of AUTHZ_TRUSTED_HEADERS) {
    requestHeaders.delete(trusted);
  }
  // The trusted peer-IP + via-proxy stamps are read by the policy from the
  // ORIGINAL request (above); strip them from the forwarded headers so the
  // per-process token never reaches route handlers or upstream providers.
  requestHeaders.delete(PEER_IP_HEADER);
  requestHeaders.delete(VIA_PROXY_HEADER);
  requestHeaders.delete(CLIENT_IP_HEADER);

  requestHeaders.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
  requestHeaders.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  // Stamp a trusted, non-secret locality verdict derived from the real stamped
  // peer IP AND the via-proxy marker. Route handlers (e.g. cliTokenAuth) read
  // this instead of re-deriving locality from the spoofable Host header. The
  // client-supplied values (if any) were already removed by the
  // AUTHZ_TRUSTED_HEADERS strip above. When the via-proxy marker is set, a
  // loopback socket is the proxy hop, not the end-user — verdict is downgraded
  // to "remote" so the LOCAL_ONLY gate is not bypassed by a request arriving
  // through an external reverse proxy (nginx / Caddy / Cloudflare Tunnel).
  // See peerStamp.ts and the upstream da667836 reference for the full rationale.
  const peerLocality = classifyStampedPeerLocality(
    request.headers.get(PEER_IP_HEADER),
    request.headers.get(VIA_PROXY_HEADER),
    process.env.OMNIROUTE_PEER_STAMP_TOKEN
  );
  requestHeaders.set(AUTHZ_HEADER_PEER_LOCALITY, peerLocality);
  // Stamp the resolved, non-spoofable peer IP for route handlers that need
  // the real client IP (e.g. login rate-limit key). Only set when the stamp
  // token is configured and the HMAC signature validates; absent otherwise.
  const trustedPeerIp = resolveStampedPeer(
    request.headers.get(PEER_IP_HEADER),
    process.env.OMNIROUTE_PEER_STAMP_TOKEN
  );
  if (trustedPeerIp) {
    requestHeaders.set(AUTHZ_HEADER_TRUSTED_PEER_IP, trustedPeerIp);
  }
  // The server stamps the client address to judge (the peer, or what a trusted proxy
  // reported for it). Forward it too, so route handlers that key a per-client control on
  // "who is calling" (e.g. the relay throttle) read the same resolution as the IP filter
  // below — a direct caller cannot move it with X-Forwarded-For, and clients behind one
  // reverse proxy are still told apart. Requests without that stamp get no header.
  const stampedClientIp = resolveStampedPeer(
    request.headers.get(CLIENT_IP_HEADER),
    process.env.OMNIROUTE_PEER_STAMP_TOKEN
  );
  if (stampedClientIp) {
    requestHeaders.set(AUTHZ_HEADER_TRUSTED_CLIENT_IP, stampedClientIp);
  }
  // Local CLI-token auth is decided centrally above. Preserve that trusted
  // decision for route-level requireManagementAuth without forwarding the
  // machine token itself: custom client auth headers are stripped before the
  // route runs, so the route consumes only the stamped auth subject.
  requestHeaders.delete(CLI_TOKEN_HEADER);

  if (method === "OPTIONS") {
    const preflight = new Response(null, { status: 204 });
    preflight.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
    preflight.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
    applyCorsHeaders(preflight, request, corsRelaxOrigin);
    return preflight;
  }

  if (!options.enforce) {
    const response = new Response(null);
    response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
    response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
    applyCorsHeaders(response, request, corsRelaxOrigin);
    return mergeResponseHeaders(
      await next(rebuildRequest(request, { headers: requestHeaders })),
      response.headers
    );
  }

  // IP filter (#6131): enforce the operator's IP blacklist/whitelist on the
  // external surface. Loopback is exempt so the local operator can never lock
  // themselves out of the dashboard (they can always fix the list from
  // localhost). checkIP is a no-op when the filter is disabled.
  //
  // D1 (#9033): a fetch `Request` carries no socket, so checkRequestIP alone
  // reads only forwarding headers and falls to "unknown", never blocking the
  // blacklisted client on a direct connection. Resolve the
  // trusted peer IP from the authenticated stamp and pass it to checkRequestIP,
  // but only when NOT behind a reverse proxy (the via-proxy marker means the
  // peer IP is the proxy hop, e.g. 127.0.0.1, and the real client is in XFF).
  if (peerLocality !== "loopback") {
    const trustedPeerIp = resolveStampedPeer(
      request.headers.get(PEER_IP_HEADER),
      process.env.OMNIROUTE_PEER_STAMP_TOKEN
    );
    const viaProxy = resolveStampedViaProxy(
      request.headers.get(VIA_PROXY_HEADER),
      process.env.OMNIROUTE_PEER_STAMP_TOKEN
    );
    // The stamped client address (resolved above) is judged; requests without that stamp
    // keep the earlier rule.
    const ipVerdict = await checkRequestIP(
      request,
      stampedClientIp ?? (viaProxy ? null : trustedPeerIp)
    );
    if (!ipVerdict.allowed) {
      const blocked = jsonResponse({ error: ipVerdict.reason || "Access denied" }, 403);
      stampRouteResponse(blocked, requestId, classification.routeClass);
      applyCorsHeaders(blocked, request, corsRelaxOrigin);
      return blocked;
    }
  }

  const policy = POLICIES[classification.routeClass];
  const outcome = await policy.evaluate({ request, classification, requestId });

  if (outcome.allow === false) {
    if (managementDashboardRoute) {
      return dashboardLoginRedirect(request, basePath, requestId);
    }

    const rejection = rejectionResponse(outcome, classification, requestId);
    // Rejections keep the presence-based relax: their bodies are fixed error
    // envelopes (no data), and browser/Electron clients with a revoked or
    // mistyped key must still be able to read the 401 instead of an opaque
    // CORS failure (#5242).
    applyCorsHeaders(rejection, request, corsRelaxOrigin);
    return rejection;
  }

  // MCP Streamable HTTP spec: Origin MUST be validated on every connection, for
  // every caller — API key, CLI token, dashboard session or anonymous loopback
  // (requireLogin=false). Runs here, not in the route handlers, because only the
  // original request still carries the token-stamped peer headers the trusted
  // proxy / direct-LAN origin candidates are derived from. A dashboard session
  // that proves same-origin with its CSRF token keeps the fallback it already has
  // for mutations below (tunnel-served dashboards without a configured base URL).
  if (isMcpOriginGuardedPath(guardedPathname)) {
    const mcpOriginVerdict = validateMcpRequestOrigin(request);
    const csrfOriginFallback =
      !mcpOriginVerdict.ok &&
      outcome.subject.kind === "dashboard_session" &&
      validateDashboardCsrfToken(request);
    if (!mcpOriginVerdict.ok && !csrfOriginFallback) {
      const rejection = mcpInvalidOriginResponse(requestId);
      rejection.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
      applyCorsHeaders(rejection, request);
      return rejection;
    }
  }

  if (
    classification.routeClass === "MANAGEMENT" &&
    outcome.subject.kind === "dashboard_session" &&
    isUnsafeMutationMethod(method)
  ) {
    const originVerdict = validateBrowserMutationOrigin(request);
    const csrfOriginFallback =
      originVerdict.reason === "invalid-origin" && validateDashboardCsrfToken(request);
    if (!originVerdict.ok && !csrfOriginFallback) {
      const rejection = invalidOriginResponse(requestId);
      rejection.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
      applyCorsHeaders(rejection, request);
      return rejection;
    }
  }

  stampSubject(requestHeaders, outcome.subject);

  const response = new Response(null);
  response.headers.set(AUTHZ_HEADER_REQUEST_ID, requestId);
  response.headers.set(AUTHZ_HEADER_ROUTE_CLASS, classification.routeClass);
  // Only relax CORS for a CLIENT_API request whose credential actually
  // validated. requestCarriesTokenOrPreflight() looks at header presence, and on
  // a keyless install (REQUIRE_API_KEY=false) clientApiPolicy serves an
  // unvalidated credential as anonymous; an anonymous response keeps the
  // fail-closed origin policy.
  const relaxForValidatedCredential =
    corsRelaxOrigin &&
    (classification.routeClass !== "CLIENT_API" || outcome.subject.kind !== "anonymous");
  applyCorsHeaders(response, request, relaxForValidatedCredential);
  if (corsRelaxOrigin && !relaxForValidatedCredential) {
    // The anonymous response still negotiates content-encoding: keep the
    // `Vary: Accept-Encoding` that applyCorsHeaders() stamps on this surface (#6737).
    response.headers.append("Vary", "Accept-Encoding");
  }
  if (managementDashboardRoute) {
    await refreshDashboardSessionIfNeeded(response, request);
  }
  return mergeResponseHeaders(
    await next(rebuildRequest(request, { headers: requestHeaders })),
    response.headers
  );
}
