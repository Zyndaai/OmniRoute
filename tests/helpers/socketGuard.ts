// Network guard for node:test files: every outbound socket throws, except the connection to the
// test PostgreSQL server (tests/_setup/isolatePostgres.ts sets OMNIROUTE_POSTGRES_URL before
// the test module loads). A blanket `Socket.prototype.connect` throw also blocks the database
// driver, and node-postgres then waits forever on a connect that threw synchronously, so the
// whole file hangs instead of failing.
import { Socket } from "node:net";
import { mock } from "node:test";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function testDatabaseTarget(): { host: string; port: number } | null {
  const raw = process.env.OMNIROUTE_POSTGRES_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return { host: url.hostname, port: Number(url.port || 5432) };
  } catch {
    return null;
  }
}

/** `socket.connect(options)`, `connect(port, host?)` or `connect(path)` -> host/port. */
function connectTarget(args: unknown[]): { host: string; port: number } | null {
  const [first, second] = args;
  if (first && typeof first === "object") {
    const options = first as { host?: unknown; port?: unknown };
    if (options.port === undefined) return null;
    return { host: String(options.host ?? "localhost"), port: Number(options.port) };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return { host: typeof second === "string" ? second : "localhost", port: Number(first) };
  }
  return null;
}

function sameHost(a: string, b: string): boolean {
  return a === b || (LOOPBACK.has(a) && LOOPBACK.has(b));
}

/**
 * Mocks `Socket.prototype.connect`; restore with the returned mock's `.mock.restore()`.
 * `onBlocked` runs for every refused (non-database) connection, for tests that count them.
 */
export function guardSocketsExceptTestDb(message: string, onBlocked?: () => void) {
  const original = Socket.prototype.connect;
  const database = testDatabaseTarget();
  return mock.method(Socket.prototype, "connect", function (this: Socket, ...args: unknown[]) {
    const target = connectTarget(args);
    if (
      database &&
      target &&
      target.port === database.port &&
      sameHost(target.host, database.host)
    ) {
      return (original as (...a: unknown[]) => Socket).apply(this, args);
    }
    onBlocked?.();
    throw new Error(message);
  });
}
