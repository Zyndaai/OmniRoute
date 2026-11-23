// Main-server keepAlive/headers timeouts (#7003) — sibling module of the
// launcher (run-server.mjs). The launcher runs as plain Node before any
// TypeScript loads, so it cannot import the canonical TS implementation; a
// ../../src/... import would also resolve outside an image that ships the
// launcher files in one folder (the #7065 class: ERR_MODULE_NOT_FOUND at boot).
// Parity with src/shared/utils/runtimeTimeouts.ts#getMainServerTimeoutConfig
// is enforced by tests/unit/build/main-server-timeouts-parity.test.ts.

export const DEFAULT_MAIN_SERVER_KEEPALIVE_TIMEOUT_MS = 65_000;
export const DEFAULT_MAIN_SERVER_HEADERS_TIMEOUT_MS = 66_000;
export const DEFAULT_MAIN_SERVER_TCP_KEEPALIVE_MS = 30_000;

function readTimeoutMs(env, name, defaultValue, { allowZero = false, logger } = {}) {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  const parsed = Number(raw);
  const isValid = Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0);
  if (!isValid) {
    logger?.(`Invalid ${name}="${raw}". Using default ${defaultValue}ms.`);
    return defaultValue;
  }
  return Math.floor(parsed);
}

export function getMainServerTimeoutConfig(env = process.env, logger) {
  const keepAliveTimeoutMs = readTimeoutMs(
    env,
    "MAIN_SERVER_KEEPALIVE_TIMEOUT_MS",
    DEFAULT_MAIN_SERVER_KEEPALIVE_TIMEOUT_MS,
    { allowZero: true, logger }
  );
  const headersTimeoutMs = readTimeoutMs(
    env,
    "MAIN_SERVER_HEADERS_TIMEOUT_MS",
    DEFAULT_MAIN_SERVER_HEADERS_TIMEOUT_MS,
    { allowZero: true, logger }
  );
  const tcpKeepAliveInitialDelayMs = readTimeoutMs(
    env,
    "MAIN_SERVER_TCP_KEEPALIVE_MS",
    DEFAULT_MAIN_SERVER_TCP_KEEPALIVE_MS,
    { allowZero: true, logger }
  );
  return {
    keepAliveTimeoutMs,
    // Node requires headersTimeout > keepAliveTimeout; keep both configurable
    // but always coherent (mirrors the canonical TS implementation).
    headersTimeoutMs:
      headersTimeoutMs > 0 && keepAliveTimeoutMs > 0
        ? Math.max(headersTimeoutMs, keepAliveTimeoutMs + 1_000)
        : headersTimeoutMs,
    tcpKeepAliveInitialDelayMs,
  };
}
