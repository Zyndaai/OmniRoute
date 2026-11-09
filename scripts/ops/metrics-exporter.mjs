#!/usr/bin/env node
/**
 * Prometheus exporter for OmniRoute's own numbers: subscription quota per
 * connection and request/success counters per provider. It reads three GET
 * management routes with a `read`-scope access token (`oma_...`) and serves
 * them as Prometheus text on /metrics. No dependencies, so it runs from the
 * stock node image with this file mounted:
 *
 *   docker run -d --name omniroute-metrics-exporter --network omniroute_default \
 *     -v /opt/omni-monitoring/exporter/metrics-exporter.mjs:/app/exporter.mjs:ro \
 *     -v /opt/omni-monitoring/secrets/omniroute-metrics-token:/run/secrets/token:ro \
 *     -e OMNIROUTE_METRICS_TOKEN_FILE=/run/secrets/token \
 *     node:26-alpine node /app/exporter.mjs
 *
 * Env: OMNIROUTE_URL (default http://omniroute:20128), OMNIROUTE_METRICS_TOKEN_FILE
 * (required), EXPORTER_PORT (default 9464), EXPORTER_EXCLUDE (regex on the
 * connection name, default "stressmock": test connections stay out of the numbers).
 *
 * `/api/usage/provider-limits` (GET) only reads OmniRoute's cache, which it syncs
 * on its own timer, so scraping never calls the providers. Never POST to it: that
 * forces a live quota refresh on every subscription login.
 *
 * Connection names are often account emails, so no name reaches a label; the
 * connection id and the provider id identify a series.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";

const CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

/** weekly / session / other, so one alert rule covers every provider's window names. */
export function quotaPeriod(window) {
  if (/week|7d/i.test(window)) return "weekly";
  if (/session|5h/i.test(window)) return "session";
  return "other";
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function sample(name, labels, value) {
  const pairs = Object.entries(labels)
    .map(([key, v]) => `${key}="${escapeLabel(v)}"`)
    .join(",");
  return `${name}{${pairs}} ${value}`;
}

function usedRatio(quota) {
  if (quota?.unlimited === true) return null;
  if (typeof quota?.total === "number" && quota.total > 0 && typeof quota.used === "number") {
    return quota.used / quota.total;
  }
  if (typeof quota?.remainingPercentage === "number") return (100 - quota.remainingPercentage) / 100;
  return null;
}

/**
 * Prometheus text for one scrape. `limits`, `providerMetrics` and `connections`
 * are the parsed bodies of the three routes, undefined when a fetch failed.
 */
export function renderMetrics({ limits, providerMetrics, connections, now = Date.now(), exclude = /stressmock/i }) {
  const providerOf = new Map();
  const excludedConnections = new Set();
  const excludedProviders = new Set();
  for (const connection of connections?.connections ?? []) {
    if (typeof connection?.id !== "string") continue;
    providerOf.set(connection.id, connection.provider ?? "unknown");
    if (typeof connection.name === "string" && exclude.test(connection.name)) {
      excludedConnections.add(connection.id);
      if (connection.provider) excludedProviders.add(connection.provider);
    }
  }

  const lines = [];
  const metric = (name, type, help, samples) => {
    if (samples.length === 0) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
  };

  const used = [];
  const reset = [];
  const limitReached = [];
  const lastSync = [];
  for (const [connectionId, cache] of Object.entries(limits?.caches ?? {})) {
    if (excludedConnections.has(connectionId)) continue;
    const base = { connection: connectionId, provider: providerOf.get(connectionId) ?? "unknown" };
    for (const [scope, windows] of [
      ["account", cache?.quotas],
      ["model", cache?.modelQuotas],
    ]) {
      for (const [window, quota] of Object.entries(windows ?? {})) {
        const labels = { ...base, plan: cache?.plan ?? "", scope, window, period: quotaPeriod(window) };
        const ratio = usedRatio(quota);
        if (ratio !== null) used.push(sample("omniroute_quota_used_ratio", labels, ratio));
        const resetAt = Date.parse(quota?.resetAt ?? "");
        if (Number.isFinite(resetAt)) {
          reset.push(sample("omniroute_quota_reset_seconds", labels, Math.max(0, Math.round((resetAt - now) / 1000))));
        }
      }
    }
    if (typeof cache?.limitReached === "boolean") {
      limitReached.push(sample("omniroute_quota_limit_reached", base, cache.limitReached ? 1 : 0));
    }
    const fetchedAt = Date.parse(cache?.fetchedAt ?? "");
    if (Number.isFinite(fetchedAt)) {
      lastSync.push(sample("omniroute_quota_last_sync_timestamp_seconds", base, Math.round(fetchedAt / 1000)));
    }
  }
  metric("omniroute_quota_used_ratio", "gauge", "Share of a quota window used (0-1).", used);
  metric("omniroute_quota_reset_seconds", "gauge", "Seconds until a quota window resets.", reset);
  metric("omniroute_quota_limit_reached", "gauge", "1 when the connection reports its limit reached.", limitReached);
  metric("omniroute_quota_last_sync_timestamp_seconds", "gauge", "When OmniRoute last synced this connection's quota.", lastSync);

  const requests = [];
  const successes = [];
  for (const [provider, row] of Object.entries(providerMetrics?.metrics ?? {})) {
    if (excludedProviders.has(provider)) continue;
    if (typeof row?.totalRequests === "number") requests.push(sample("omniroute_provider_requests_total", { provider }, row.totalRequests));
    if (typeof row?.totalSuccesses === "number") successes.push(sample("omniroute_provider_successes_total", { provider }, row.totalSuccesses));
  }
  metric("omniroute_provider_requests_total", "counter", "Requests OmniRoute sent to a provider (call log, all time).", requests);
  metric("omniroute_provider_successes_total", "counter", "Successful requests to a provider (call log, all time).", successes);

  metric(
    "omniroute_exporter_source_up",
    "gauge",
    "1 when the exporter could read the OmniRoute route.",
    [
      ["provider-limits", limits],
      ["provider-metrics", providerMetrics],
      ["providers", connections],
    ].map(([endpoint, body]) => sample("omniroute_exporter_source_up", { endpoint }, body ? 1 : 0))
  );

  return `${lines.join("\n")}\n`;
}

async function fetchJson(baseUrl, token, path) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[metrics-exporter] GET ${path} answered ${response.status}`);
      return undefined;
    }
    return await response.json();
  } catch (error) {
    console.error(`[metrics-exporter] GET ${path} failed: ${error?.message ?? error}`);
    return undefined;
  }
}

function startServer() {
  const baseUrl = (process.env.OMNIROUTE_URL || "http://omniroute:20128").replace(/\/+$/, "");
  const tokenFile = process.env.OMNIROUTE_METRICS_TOKEN_FILE;
  if (!tokenFile) throw new Error("OMNIROUTE_METRICS_TOKEN_FILE is required");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error(`${tokenFile} is empty`);
  const exclude = new RegExp(process.env.EXPORTER_EXCLUDE || "stressmock", "i");
  const port = Number(process.env.EXPORTER_PORT || 9464);

  let cached = { at: 0, body: "" };
  const scrape = async () => {
    if (Date.now() - cached.at < CACHE_MS) return cached.body;
    const [limits, providerMetrics, connections] = await Promise.all([
      fetchJson(baseUrl, token, "/api/usage/provider-limits"),
      fetchJson(baseUrl, token, "/api/provider-metrics"),
      fetchJson(baseUrl, token, "/api/providers"),
    ]);
    cached = { at: Date.now(), body: renderMetrics({ limits, providerMetrics, connections, exclude }) };
    return cached.body;
  };

  http
    .createServer(async (request, response) => {
      if (request.method !== "GET" || request.url !== "/metrics") {
        response.writeHead(404).end();
        return;
      }
      const body = await scrape();
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(body);
    })
    .listen(port, () => console.log(`[metrics-exporter] serving :${port}/metrics from ${baseUrl}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
