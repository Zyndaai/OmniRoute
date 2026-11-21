/**
 * Permanent (308) redirects for renamed pages. Matched case-insensitively on the path without
 * the base path; the query string is kept. A path with a trailing slash is first redirected
 * to the same path without it.
 */
import { fillPathPattern, matchPathPattern } from "./pathPattern";

export interface RedirectRule {
  source: string;
  destination: string;
}

/** Docs pages that moved into a section folder: `/docs/<name>` -> `/docs/<section>/<name>`. */
const DOCS_SECTIONS: Record<string, readonly string[]> = {
  architecture: [
    "architecture",
    "authz-guide",
    "codebase-documentation",
    "repository-map",
    "resilience-guide",
  ],
  guides: [
    "docker-guide",
    "features",
    "i18n",
    "kiro-setup",
    "pwa-guide",
    "setup-guide",
    "termux-guide",
    "troubleshooting",
    "uninstall",
    "user-guide",
  ],
  reference: ["api-reference", "cli-tools", "environment", "free-tiers", "provider-reference"],
  frameworks: [
    "a2a-server",
    "agent-protocols-guide",
    "cloud-agent",
    "evals",
    "mcp-server",
    "memory",
    "opencode",
    "skills",
    "webhooks",
  ],
  routing: ["auto-combo", "reasoning-replay"],
  security: [
    "cli-token",
    "cli-token-auth",
    "compliance",
    "error-sanitization",
    "guardrails",
    "public-creds",
    "route-guard-tiers",
    "stealth-guide",
  ],
  compression: [
    "compression-engines",
    "compression-guide",
    "compression-language-packs",
    "compression-rules-format",
    "rtk-compression",
  ],
  ops: [
    "coverage-plan",
    "e2e-dashboard-shakedown-v3.8.0",
    "fly-io-deployment-guide",
    "proxy-guide",
    "release-checklist",
    "sqlite-runtime",
    "tunnels-guide",
    "vm-deployment-guide",
  ],
};

export const REDIRECTS: readonly RedirectRule[] = [
  { source: "/dashboard/skills", destination: "/dashboard/omni-skills" },
  { source: "/dashboard/providers/freepik", destination: "/dashboard/providers/magnific" },
  ...Object.entries(DOCS_SECTIONS).flatMap(([section, names]) =>
    names.map((name) => ({ source: `/docs/${name}`, destination: `/docs/${section}/${name}` }))
  ),
  { source: "/dashboard/cli-tools", destination: "/dashboard/cli-code" },
  { source: "/dashboard/cli-tools/:path*", destination: "/dashboard/cli-code/:path*" },
  { source: "/dashboard/agents", destination: "/dashboard/acp-agents" },
  { source: "/dashboard/agents/:path*", destination: "/dashboard/acp-agents/:path*" },
];

export const REDIRECT_STATUS = 308;

/**
 * Where `pathname` (base path stripped) redirects to, without base path or query, or `null`.
 */
export function resolveRedirect(pathname: string): string | null {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "") || "/";
  }
  for (const rule of REDIRECTS) {
    const match = matchPathPattern(rule.source, pathname);
    if (match) return fillPathPattern(rule.destination, match);
  }
  return null;
}
