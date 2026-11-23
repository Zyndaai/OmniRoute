// Regression guard for #10273: opt-in CSP relaxation so OmniRoute's HTML pages can be
// embedded in the VS Code Simple Browser (the OmniCopilot extension's `dashboardOpen:
// "editor"` mode renders them inside a `vscode-webview:` iframe).
//
// The default posture is UNCHANGED and must stay that way: `frame-ancestors 'none'` +
// `X-Frame-Options: DENY` on every route. Only when the operator explicitly sets
// DASHBOARD_ALLOW_EMBED=vscode do the HTML pages switch to
// `frame-ancestors 'self' vscode-webview:` and drop `X-Frame-Options`.
//
// The API surface (`/api`, `/v1`, `/v1beta`, the root-level rewrite aliases, `/a2a`,
// `/healthz`) must keep the strict headers even in embed mode.
//
// These tests assert the EFFECTIVE headers `securityHeadersFor()` returns per path.

import test from "node:test";
import assert from "node:assert/strict";

import { REWRITES } from "../../../src/server/http/rewrites.ts";
import {
  DASHBOARD_EMBED_ENV,
  EMBED_FRAME_ANCESTORS,
  nonPageRoutePrefixes,
  resolveDashboardEmbedMode,
  securityHeadersFor,
  type DashboardEmbedMode,
} from "../../../src/server/http/securityHeaders.ts";

function effectiveHeaders(
  pathname: string,
  mode: DashboardEmbedMode | null
): Record<string, string> {
  return Object.fromEntries(securityHeadersFor(pathname, mode));
}

// Pages an operator expects to reach inside the VS Code Simple Browser.
const PAGE_PATHS = [
  "/",
  "/dashboard",
  "/dashboard/providers",
  "/dashboard/combos/editor",
  "/login",
  "/forgot-password",
  "/docs/guides/i18n",
  "/landing",
  "/status",
];

// Never framable — the process-spawning / proxy surfaces plus every root-level API alias.
const API_PATHS = [
  "/api",
  "/api/v1/chat/completions",
  "/api/services/ninerouter/start",
  "/v1",
  "/v1/models",
  "/v1beta/models",
  "/chat/completions",
  "/responses",
  "/responses/abc/cancel",
  "/models",
  "/codex/responses",
  "/anthropic/v1/messages",
  "/openai/v1/models",
  "/metrics",
  "/debug",
  "/.env",
  "/a2a",
  "/healthz",
  "/V1/models",
];

test("#10273 embed mode is OFF unless DASHBOARD_ALLOW_EMBED names a known mode", () => {
  for (const raw of [undefined, "", "  ", "0", "1", "true", "yes", "on", "browser", "vscode-web"]) {
    assert.equal(
      resolveDashboardEmbedMode(raw === undefined ? {} : { [DASHBOARD_EMBED_ENV]: raw }),
      null,
      `DASHBOARD_ALLOW_EMBED=${JSON.stringify(raw)} must not enable embedding`
    );
  }
});

test("#10273 DASHBOARD_ALLOW_EMBED=vscode enables the vscode mode, case/space tolerant", () => {
  for (const raw of ["vscode", "VSCode", "  vscode  ", "VSCODE"]) {
    assert.equal(resolveDashboardEmbedMode({ [DASHBOARD_EMBED_ENV]: raw }), "vscode");
  }
  assert.equal(EMBED_FRAME_ANCESTORS.vscode, "'self' vscode-webview:");
});

test("#10273 default keeps frame-ancestors 'none' + X-Frame-Options: DENY everywhere", () => {
  for (const pathname of [...PAGE_PATHS, ...API_PATHS]) {
    const headers = effectiveHeaders(pathname, null);
    assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/, pathname);
    assert.equal(headers["X-Frame-Options"], "DENY", pathname);
  }
});

test("#10273 embed mode lets vscode-webview: frame the HTML pages and drops X-Frame-Options", () => {
  for (const pathname of PAGE_PATHS) {
    const headers = effectiveHeaders(pathname, "vscode");
    assert.match(
      headers["Content-Security-Policy"],
      /frame-ancestors 'self' vscode-webview:/,
      `${pathname} must allow the vscode-webview: ancestor in embed mode`
    );
    assert.equal(headers["X-Frame-Options"], undefined, pathname);
  }
});

test("#10273 embed mode keeps the API surface strictly unframable", () => {
  for (const pathname of API_PATHS) {
    const headers = effectiveHeaders(pathname, "vscode");
    assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/, pathname);
    assert.equal(headers["X-Frame-Options"], "DENY", pathname);
    assert.ok(!headers["Content-Security-Policy"].includes("vscode-webview:"), pathname);
  }
});

test("#10273 embed mode relaxes ONLY frame-ancestors — every other directive/header survives", () => {
  const relaxed = effectiveHeaders("/dashboard", "vscode");
  const strict = effectiveHeaders("/dashboard", null);
  assert.equal(
    relaxed["Content-Security-Policy"],
    strict["Content-Security-Policy"].replace(
      "frame-ancestors 'none'",
      `frame-ancestors ${EMBED_FRAME_ANCESTORS.vscode}`
    )
  );
  for (const key of [
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Strict-Transport-Security",
  ]) {
    assert.equal(relaxed[key], strict[key], `${key} must be identical in embed mode`);
  }
});

test("G-10: the 9Router embed route's CSP is replaced by frame-ancestors 'self' in both modes", () => {
  for (const mode of [null, "vscode"] as const) {
    for (const pathname of [
      "/dashboard/providers/services/ninerouter/embed",
      "/dashboard/providers/services/ninerouter/embed/ui",
    ]) {
      assert.equal(
        effectiveHeaders(pathname, mode)["Content-Security-Policy"],
        "frame-ancestors 'self'",
        `${pathname} (mode ${mode})`
      );
    }
  }
});

test("#10273 every root-level rewrite alias is excluded from the embeddable page surface", () => {
  const prefixes = new Set(nonPageRoutePrefixes(REWRITES));
  for (const { source } of REWRITES) {
    const first = source.replace(/^\//, "").split("/")[0];
    assert.ok(prefixes.has(first), `rewrite alias "${source}" must never be framable`);
  }
  for (const literal of ["api", "a2a", "healthz"]) {
    assert.ok(prefixes.has(literal), `"${literal}" must be excluded from the page surface`);
  }
});
