/**
 * Cluster bus transport on PostgreSQL LISTEN/NOTIFY (the default when REDIS_URL is unset).
 *
 * Publishing is `SELECT pg_notify(channel, payload)` on any pooled connection. Listening
 * needs a DEDICATED connection (a LISTEN belongs to its session). When that connection
 * drops, notifications sent meanwhile are lost, so after every reconnect the transport
 * calls `onReconnect` (the bus resync: drop every local cache).
 *
 * Payloads stay far below PostgreSQL's 8000-byte NOTIFY limit (scope + id + origin).
 */

import type { BusPublisher, BusSubscriber } from "./bus";

export interface PgNotification {
  channel: string;
  payload?: string;
}

/** The subset of a node-postgres `Client` the listener needs. */
export interface PgListenClient {
  query(text: string): Promise<unknown>;
  on(event: "notification", listener: (message: PgNotification) => void): unknown;
  on(event: "error" | "end", listener: (...args: unknown[]) => void): unknown;
  end(): Promise<void>;
}

export function createPgBusPublisher(
  query: (text: string, values: unknown[]) => Promise<unknown>
): BusPublisher {
  return {
    publish: (channel, message) => query("SELECT pg_notify($1, $2)", [channel, message]),
  };
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface PgBusSubscriberOptions {
  /** Opens a new connected client (called again after every drop). */
  connect: () => Promise<PgListenClient>;
  /** Called after a successful RE-connect (not the first connect). */
  onReconnect: () => void;
  minRetryMs?: number;
  maxRetryMs?: number;
  warn?: (line: string, error?: unknown) => void;
}

export interface PgBusSubscriber extends BusSubscriber {
  close(): Promise<void>;
}

export function createPgBusSubscriber(options: PgBusSubscriberOptions): PgBusSubscriber {
  const {
    connect,
    onReconnect,
    minRetryMs = 500,
    maxRetryMs = 30_000,
    warn = console.warn,
  } = options;
  const channels: string[] = [];
  let listener: ((channel: string, message: string) => void) | null = null;
  let client: PgListenClient | null = null;
  let closed = false;
  let retryMs = minRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = async (isReconnect: boolean): Promise<void> => {
    const next = await connect();
    let dropped = false;
    const drop = (reason: string) => {
      if (dropped) return;
      dropped = true;
      if (client === next) client = null;
      next.end().catch(() => undefined);
      if (!closed) {
        warn(`[CLUSTER] bus listener connection lost (${reason}); reconnecting`);
        scheduleReconnect();
      }
    };
    next.on("notification", (message: PgNotification) => {
      if (listener && typeof message.payload === "string")
        listener(message.channel, message.payload);
    });
    next.on("error", (error: unknown) =>
      drop(error instanceof Error ? error.message : String(error))
    );
    next.on("end", () => drop("connection closed"));
    for (const channel of channels) await next.query(`LISTEN ${quoteIdent(channel)}`);
    if (closed) {
      await next.end().catch(() => undefined);
      return;
    }
    client = next;
    retryMs = minRetryMs;
    if (isReconnect) onReconnect();
  };

  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, maxRetryMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open(true).catch((error: unknown) => {
        warn("[CLUSTER] bus listener reconnect failed", error);
        scheduleReconnect();
      });
    }, delay);
    retryTimer.unref?.();
  };

  return {
    on(_event, fn) {
      listener = fn;
    },
    async subscribe(...names) {
      channels.push(...names.filter((name) => !channels.includes(name)));
      await open(false);
    },
    async close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const current = client;
      client = null;
      await current?.end().catch(() => undefined);
    },
  };
}
