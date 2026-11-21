/**
 * Scheme and host:port every incoming `Request` URL is built with: the address the server is
 * bound to, never the client's Host header. `request.url` is one of the Origin candidates of
 * the MCP and browser-mutation origin checks (`src/server/origin`), so a URL taken from the
 * Host header would let a DNS-rebinding page (`Host: evil.test` + `Origin: http://evil.test`)
 * match itself. Forwarded headers from a trusted reverse proxy are handled there, not here.
 *
 * The launcher publishes `OMNIROUTE_BOUND_HOST` and `OMNIROUTE_INTERNAL_SCHEME` before it
 * loads the server bundle; the fallbacks mirror how it resolves them.
 */
type EnvLike = Readonly<Record<string, string | undefined>>;

export function boundRequestOrigin(env: EnvLike = process.env): { protocol: string; host: string } {
  const scheme = env.OMNIROUTE_INTERNAL_SCHEME === "https" ? "https" : "http";
  const hostname = env.OMNIROUTE_BOUND_HOST || env.HOST || env.HOSTNAME || "0.0.0.0";
  const parsedPort = Number.parseInt(env.DASHBOARD_PORT || env.PORT || "20128", 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 20128;
  const bracketed =
    hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return { protocol: `${scheme}:`, host: `${bracketed}:${port}` };
}
