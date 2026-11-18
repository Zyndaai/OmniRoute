/**
 * Passive token refresh: processes that must not POST a refresh themselves adopt the
 * tokens another process stored instead.
 *
 * A rotating (single-use) refresh token presented twice revokes the whole token family
 * (Claude Max, Codex/Auth0, ...; see ROTATION_LOCK_GROUP in ../refreshSerializer.ts),
 * and the per-process refresh lanes cannot see each other. So in cluster mode only the
 * leader refreshes rotating providers; a worker:
 *   1. re-reads the connection row (uncached) and adopts a newer, unexpired token;
 *   2. otherwise asks the leader over the cluster bus and polls the row for up to
 *      `PASSIVE_WAIT_MS`;
 *   3. otherwise reports `refresh_disabled` (never `unrecoverable_refresh_error`, so the
 *      connection is not marked expired by a process that was not allowed to try).
 *
 * The older env switch OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS=codex (a single
 * process that never refreshes Codex) keeps working through `isPassiveCodex`.
 * Non-rotating providers (Google/Antigravity, ...) refresh anywhere.
 */

import { isWorker } from "@/lib/cluster/role";
import { publishRefreshRequest } from "@/lib/cluster/bus";
import { opaqueTokenFingerprint } from "../../utils/opaqueTokenFingerprint.ts";
import { parseTokenExpiryMs } from "../../utils/tokenExpiry.ts";
import { rotationGroupFor } from "../refreshSerializer.ts";
import { getRejectedTokenFingerprints, isPassiveCodex } from "./passiveCodex.ts";

export const PASSIVE_WAIT_MS = 10_000;
const PASSIVE_POLL_MS = 500;

export const PASSIVE_CLUSTER_MESSAGE =
  "This worker does not refresh rotating OAuth tokens; the leader refreshes them. Retry shortly.";

function normalize(provider: unknown): string {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

/** True when this process must not refresh `provider`'s token itself. */
export function isPassiveRefresh(provider: unknown): boolean {
  if (isPassiveCodex(provider)) return true;
  const id = normalize(provider);
  return id !== "" && rotationGroupFor(id) !== null && isWorker();
}

type Snapshot = {
  connectionId?: string;
  id?: string;
  accessToken?: string;
  expiresAt?: unknown;
  tokenExpiresAt?: unknown;
};

/**
 * Only a token that is expired or was just rejected upstream is worth waiting for.
 * A proactive refresh (token still valid, inside the refresh-ahead window) must not
 * stall the request: the leader's health sweep refreshes it ahead of expiry.
 */
function needsNewToken(creds: Snapshot, now: number): boolean {
  if (getRejectedTokenFingerprints(creds).length > 0) return true;
  return !(parseTokenExpiryMs(creds.tokenExpiresAt || creds.expiresAt) > now);
}
type TokenField = "accessToken" | "refreshToken" | "idToken" | "expiresAt" | "tokenExpiresAt";
export type PassiveTokens = Partial<Record<TokenField | "error", string>>;

const tokenString = (value: unknown) => (typeof value === "string" ? value : undefined);

export interface PassiveDeps {
  readConnection?: (id: string) => Promise<Record<string, unknown> | null>;
  requestRefresh?: (connectionId: string) => void;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

async function defaultReadConnection(id: string) {
  // Uncached SELECT (the readCache wrapper would hide the leader's write for up to 5 s).
  const { getProviderConnectionById } = await import("../codexAccount/write.ts");
  return (await getProviderConnectionById(id)) as Record<string, unknown> | null;
}

function adoptable(stored: Record<string, unknown> | null, creds: Snapshot, now: number) {
  if (!stored) return null;
  const accessToken = tokenString(stored.accessToken);
  const expiry = parseTokenExpiryMs(stored.tokenExpiresAt || stored.expiresAt);
  if (
    !accessToken ||
    !(expiry > now) ||
    accessToken === creds.accessToken ||
    getRejectedTokenFingerprints(creds).includes(opaqueTokenFingerprint(accessToken))
  ) {
    return null;
  }
  return {
    accessToken,
    refreshToken: tokenString(stored.refreshToken),
    idToken: tokenString(stored.idToken),
    expiresAt: new Date(expiry).toISOString(),
    tokenExpiresAt: new Date(expiry).toISOString(),
  };
}

/**
 * The newer stored token for this connection, or `{ error: "refresh_disabled" }`.
 * Reads only token fields; a rejected token never qualifies as its own replacement.
 */
export async function resolvePassiveTokens(
  creds?: Snapshot,
  deps: PassiveDeps = {}
): Promise<PassiveTokens> {
  const disabled = { error: "refresh_disabled" };
  const id = creds?.connectionId || creds?.id;
  if (!id) return disabled;
  const {
    readConnection = defaultReadConnection,
    requestRefresh = publishRefreshRequest,
    waitMs = isWorker() ? PASSIVE_WAIT_MS : 0,
    pollMs = PASSIVE_POLL_MS,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  try {
    const first = adoptable(await readConnection(id), creds, now());
    if (first || waitMs <= 0 || !needsNewToken(creds, now())) return first ?? disabled;

    requestRefresh(id);
    const deadline = now() + waitMs;
    while (now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      const next = adoptable(await readConnection(id), creds, now());
      if (next) return next;
    }
    return disabled;
  } catch {
    console.debug("[TOKEN_REFRESH]", { connectionId: id, reason: "passive re-read failed" });
    return disabled;
  }
}

/** Credentials with the adopted tokens merged in, or the input unchanged. */
export async function adoptPassiveTokens<T extends Snapshot>(credentials: T): Promise<T> {
  const tokens = await resolvePassiveTokens(credentials);
  return tokens.accessToken ? { ...credentials, ...tokens } : credentials;
}
