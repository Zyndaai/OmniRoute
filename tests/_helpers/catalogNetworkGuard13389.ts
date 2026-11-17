import { MockAgent, setGlobalDispatcher } from "undici";
import { Socket } from "node:net";

// Test-only network guard: no application imports, credentials, sockets or DNS.
// The global fetch seam catches catalog refreshes; MockAgent also blocks the
// native fetch captured by other modules before they install their wrappers.
const networkGuard = new MockAgent();
networkGuard.disableNetConnect();
setGlobalDispatcher(networkGuard);

export const unexpectedCatalogNetworkRequests: string[] = [];

// The database is PostgreSQL: connections to its host and port must pass, everything else
// stays blocked.
function postgresTarget(): { host: string; port: number } | null {
  const raw = process.env.OMNIROUTE_POSTGRES_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 5432) };
  } catch {
    return null;
  }
}

const realSocketConnect = Socket.prototype.connect;
const allowedPostgres = postgresTarget();

// These handler-level regressions need no other sockets, including loopback. This also
// catches transports with an explicit dispatcher that bypass MockAgent.
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  const first = args[0] as { port?: number | string; host?: string } | number | string | undefined;
  const options = typeof first === "object" && first !== null ? first : null;
  const port = options ? options.port : first;
  const host = options ? options.host : typeof args[1] === "string" ? args[1] : undefined;
  if (
    allowedPostgres &&
    Number(port) === allowedPostgres.port &&
    (host === undefined || host === allowedPostgres.host || host === "localhost")
  ) {
    return Reflect.apply(realSocketConnect, this, args);
  }
  unexpectedCatalogNetworkRequests.push("node:net socket connection");
  throw new Error("#13389 regression forbids socket connections");
} as typeof Socket.prototype.connect;

globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  unexpectedCatalogNetworkRequests.push(`${url.origin}${url.pathname}`);
  throw new Error("#13389 regression forbids external network requests");
};
