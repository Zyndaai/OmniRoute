/**
 * Security headers sent with every response: pages, endpoints, static files and 404s. A route
 * that sets one of these headers itself keeps its own value.
 *
 * Embedding (#10273): OmniRoute ships `frame-ancestors 'none'` + `X-Frame-Options: DENY`,
 * the right default for a proxy that holds provider credentials. The OmniCopilot VS Code
 * extension renders the dashboard inside the Simple Browser, an iframe whose ancestor is a
 * `vscode-webview:` document, so `DASHBOARD_ALLOW_EMBED=vscode` (a build-time setting) gives
 * the HTML pages `frame-ancestors 'self' vscode-webview:` and drops `X-Frame-Options`, which
 * has no syntax for a custom scheme and would still block the frame. The API surface keeps the
 * strict headers in every mode.
 */
import { matchPathPattern } from "./pathPattern";
import { REWRITES } from "./rewrites";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  // `ws:` is allowed scheme-wide (like `wss:`) so the dashboard can reach its own Live WS
  // server at `ws://<lan-or-tailscale-host>:*` when opened from a non-loopback host (#5083).
  "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https: ws: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

export type HeaderList = ReadonlyArray<readonly [name: string, value: string]>;

export const SECURITY_HEADERS: HeaderList = [
  ["Content-Security-Policy", CONTENT_SECURITY_POLICY],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()"],
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
];

/**
 * G-10: OmniRoute's dashboard frames the 9Router UI through this LOCAL_ONLY route, so its CSP
 * is replaced (not merged) by a same-origin `frame-ancestors`.
 */
export const SERVICE_EMBED_PATTERN = "/dashboard/providers/services/:name/embed/:path*";
export const SERVICE_EMBED_CSP = "frame-ancestors 'self'";

export const DASHBOARD_EMBED_ENV = "DASHBOARD_ALLOW_EMBED";

/** Ancestor allow-list per supported embed mode. Adding a mode here is the only extension point. */
export const EMBED_FRAME_ANCESTORS = Object.freeze({ vscode: "'self' vscode-webview:" });
export type DashboardEmbedMode = keyof typeof EMBED_FRAME_ANCESTORS;

export const STRICT_FRAME_ANCESTORS = "frame-ancestors 'none'";

/** Non-page surfaces without a rewrite alias; the rest are the first segments of `REWRITES`. */
export const STATIC_NON_PAGE_PREFIXES = Object.freeze(["api", "a2a", "healthz"]);

/**
 * The opt-in embed mode. Unknown or truthy-looking values (`1`, `true`, `on`) do NOT enable
 * embedding: the operator must name the ancestor family being opened up.
 */
export function resolveDashboardEmbedMode(
  env: Readonly<Record<string, string | undefined>>
): DashboardEmbedMode | null {
  const raw = env[DASHBOARD_EMBED_ENV];
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return Object.hasOwn(EMBED_FRAME_ANCESTORS, normalized)
    ? (normalized as DashboardEmbedMode)
    : null;
}

/** First path segments that are never framable: the rewrite aliases plus the static list. */
export function nonPageRoutePrefixes(rewrites: ReadonlyArray<{ source: string }>): string[] {
  const prefixes = new Set<string>(STATIC_NON_PAGE_PREFIXES);
  for (const { source } of rewrites) {
    const first = source.replace(/^\//, "").split("/")[0];
    if (first && !first.startsWith(":")) prefixes.add(first.toLowerCase());
  }
  return [...prefixes].sort();
}

const NON_PAGE_PREFIXES = new Set(nonPageRoutePrefixes(REWRITES));

/** Swaps only the `frame-ancestors` directive, leaving every other directive byte-identical. */
export function relaxFrameAncestors(policy: string, mode: DashboardEmbedMode): string {
  return policy.replace(STRICT_FRAME_ANCESTORS, `frame-ancestors ${EMBED_FRAME_ANCESTORS[mode]}`);
}

function isNonPagePath(pathname: string): boolean {
  const first = pathname.replace(/^\//, "").split("/")[0].toLowerCase();
  return NON_PAGE_PREFIXES.has(first);
}

/**
 * The build's embed mode. `process.env.DASHBOARD_ALLOW_EMBED` is written out literally so the
 * bundler can replace it with the value it had at build time.
 */
const BUILD_EMBED_MODE = resolveDashboardEmbedMode({
  [DASHBOARD_EMBED_ENV]: process.env.DASHBOARD_ALLOW_EMBED,
});

/** Security headers for `pathname` (base path stripped). */
export function securityHeadersFor(
  pathname: string,
  mode: DashboardEmbedMode | null = BUILD_EMBED_MODE
): HeaderList {
  let headers: HeaderList = SECURITY_HEADERS;
  if (mode && !isNonPagePath(pathname)) {
    headers = headers
      .filter(([name]) => name !== "X-Frame-Options")
      .map(([name, value]) =>
        name === "Content-Security-Policy"
          ? ([name, relaxFrameAncestors(value, mode)] as const)
          : ([name, value] as const)
      );
  }
  if (matchPathPattern(SERVICE_EMBED_PATTERN, pathname)) {
    headers = headers.map(([name, value]) =>
      name === "Content-Security-Policy" ? ([name, SERVICE_EMBED_CSP] as const) : [name, value]
    );
  }
  return headers;
}
