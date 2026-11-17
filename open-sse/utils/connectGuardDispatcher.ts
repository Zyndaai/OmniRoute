import dns from "node:dns";
import { Agent, type Dispatcher } from "undici";
import * as undici from "undici";
import {
  isCloudMetadataHost,
  isPrivateHost,
  type OutboundUrlGuardMode,
} from "@/shared/network/outboundUrlGuard";
import { getDispatcherOptions } from "./proxyDispatcher.ts";

/**
 * Connect-time outbound guard (DNS-rebinding, GHSA-cmhj-wh2f-9cgx).
 *
 * The string-level URL guard judges a host NAME; the socket then resolves that name again, so an
 * attacker-controlled record can be public for the check and private/metadata for the connect.
 * The dispatcher built here validates the addresses of the very lookup the connection is made
 * with — there is no second lookup to race, and no address is remembered or pinned.
 */

export type ConnectGuardMode = Exclude<OutboundUrlGuardMode, "none">;

export const CONNECT_GUARD_BLOCKED_CODE = "ERR_OUTBOUND_HOST_BLOCKED";

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number
) => void;
type LookupImpl = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

function blockedAddress(guard: ConnectGuardMode, address: string): boolean {
  return guard === "public-only" ? isPrivateHost(address) : isCloudMetadataHost(address);
}

/**
 * `net.connect` `lookup` that refuses to connect when ANY resolved address is blocked by `guard`.
 * Node calls it in one of two shapes (`options.all` set with Happy Eyeballs, or the single-address
 * form); both are honored. `resolve` is injectable so tests need no real DNS.
 */
export function createGuardedLookup(
  guard: ConnectGuardMode,
  // Late-bound so a test that replaces `dns.lookup` after the shared dispatcher exists still wins.
  resolve: LookupImpl = (hostname, options, callback) => dns.lookup(hostname, options, callback)
) {
  return (hostname: string, options: dns.LookupOptions | undefined, callback: LookupCallback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const blocked = addresses.find(({ address }) => blockedAddress(guard, address));
      if (blocked || addresses.length === 0) {
        const reason = blocked
          ? `resolves to a blocked ${guard === "public-only" ? "private" : "cloud-metadata"} address (DNS rebinding)`
          : "could not be resolved";
        return callback(
          Object.assign(new Error(`Outbound host ${reason}: ${hostname}`), {
            code: CONNECT_GUARD_BLOCKED_CODE,
          })
        );
      }
      if (options?.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function compatibleGuardedDispatcher(agent: Dispatcher): Dispatcher {
  if (typeof agent.dispatch !== "function") {
    throw new Error("This runtime does not support guarded outbound dispatchers");
  }
  const Bridge = undici.Dispatcher1Wrapper;
  if (typeof Bridge !== "function") return agent;
  return new (class extends Bridge {
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      return typeof handler?.onRequestStart === "function"
        ? agent.dispatch(options, handler)
        : super.dispatch(options, handler);
    }
  })(agent);
}

const guardedDispatchers = new Map<string, Dispatcher>();

function buildGuardedDispatcher(guard: ConnectGuardMode, reuseSockets: boolean): Dispatcher {
  const options = getDispatcherOptions();
  const agent = new Agent({
    ...options,
    ...(reuseSockets ? {} : { keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }),
    pipelining: 0,
    connect: {
      ...(options.connect as object),
      lookup: createGuardedLookup(guard),
    } as never,
  });
  return compatibleGuardedDispatcher(agent);
}

/**
 * Shared direct-egress dispatcher whose connections are validated by {@link createGuardedLookup}.
 * One instance per guard mode (the validation is per connect, so hosts can share it). Sockets are
 * kept alive like the ordinary direct dispatcher: a reused socket is to an address that was
 * validated when it connected, and undici pools per origin, so no other host can reuse it. Without
 * reuse every request paid DNS + TCP + TLS. A stale pooled socket is handled by
 * {@link getGuardedRetryDispatcher}.
 */
export function getGuardedDispatcher(guard: ConnectGuardMode): Dispatcher {
  let dispatcher = guardedDispatchers.get(guard);
  if (!dispatcher) {
    dispatcher = buildGuardedDispatcher(guard, true);
    guardedDispatchers.set(guard, dispatcher);
  }
  return dispatcher;
}

/**
 * Same guard, but every socket is fresh: used once to retry a request whose pooled socket had
 * been closed by the upstream (the direct path's #4252 policy).
 */
export function getGuardedRetryDispatcher(guard: ConnectGuardMode): Dispatcher {
  const key = `${guard}:retry`;
  let dispatcher = guardedDispatchers.get(key);
  if (!dispatcher) {
    dispatcher = buildGuardedDispatcher(guard, false);
    guardedDispatchers.set(key, dispatcher);
  }
  return dispatcher;
}

const STALE_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

/**
 * True for the errors a reused keep-alive socket produces when the upstream closed it while it sat
 * idle. Never true for a guard refusal, which must not be retried.
 */
export function isStaleSocketError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 3; depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (code === CONNECT_GUARD_BLOCKED_CODE) return false;
    if (typeof code === "string" && STALE_SOCKET_CODES.has(code)) return true;
    if (typeof message === "string" && message.includes("other side closed")) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** A body fetch can send twice: absent, a string, bytes, form params or a Blob — not a stream. */
export function isReplayableBody(body: unknown): boolean {
  return (
    body == null ||
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams ||
    (typeof Blob !== "undefined" && body instanceof Blob)
  );
}
