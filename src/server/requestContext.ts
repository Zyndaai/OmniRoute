/**
 * The HTTP request being handled, for code that runs during a request but is not handed the
 * `Request` (shared auth helpers, translation lookup), and work deferred until its response has
 * been sent. The server wraps every request in `runWithRequest`; outside a request
 * `currentRequest()` returns `undefined`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { parseCookie } from "cookie";

export type AfterResponseCallback = () => unknown;

function runAfterResponseCallback(callback: AfterResponseCallback): void {
  const report = (error: unknown) => {
    console.error("[server] after-response task failed:", error);
  };
  try {
    const result = callback();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as PromiseLike<unknown>).then(undefined, report);
    }
  } catch (error) {
    report(error);
  }
}

function runSoon(callbacks: AfterResponseCallback[]): void {
  if (callbacks.length === 0) return;
  // A macrotask, so whatever finished the response (the last write, `end()`, the close event)
  // has returned before the first callback runs.
  setImmediate(() => {
    for (const callback of callbacks) runAfterResponseCallback(callback);
  });
}

/**
 * Callbacks waiting for one response to be sent. `release()` runs them once; a callback added
 * after that runs on the next macrotask.
 */
export class AfterResponseQueue {
  private callbacks: AfterResponseCallback[] = [];
  private released = false;

  get size(): number {
    return this.callbacks.length;
  }

  add(callback: AfterResponseCallback): void {
    if (this.released) runSoon([callback]);
    else this.callbacks.push(callback);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const callbacks = this.callbacks;
    this.callbacks = [];
    runSoon(callbacks);
  }
}

/**
 * The request as it reached the app (before the authz pipeline stripped and re-stamped its
 * trusted headers), with the pipeline that served it. A dashboard loader replays an API call
 * through `fetch` with these headers, so the call is judged exactly as the browser's own
 * request to that API path would be (see `./routing/dashboardApi.server.ts`). Server-side only:
 * the headers carry the per-process peer stamps and never leave the process.
 */
export interface IncomingScope {
  request: Request;
  /** Base path the app is served under (`""` at the root). */
  basePath: string;
  /** The app's request pipeline (redirects, authz, rewrites, React Router). */
  fetch: (request: Request) => Promise<Response>;
}

interface RequestScope {
  request?: Request;
  afterResponse?: AfterResponseQueue;
  incoming?: IncomingScope;
}

const storage = new AsyncLocalStorage<RequestScope>();

/**
 * Runs `fn` with `request` as the current request. `afterResponse` defaults to the queue of the
 * enclosing scope, so a rewritten request keeps the queue of the response being produced; the
 * incoming request is inherited the same way.
 */
export function runWithRequest<T>(
  request: Request,
  fn: () => T,
  afterResponse: AfterResponseQueue | undefined = storage.getStore()?.afterResponse
): T {
  return storage.run({ request, afterResponse, incoming: storage.getStore()?.incoming }, fn);
}

/** Runs `fn` with `incoming` recorded as the request that reached the app. */
export function runWithIncoming<T>(incoming: IncomingScope, fn: () => T): T {
  const store = storage.getStore();
  return storage.run({ ...store, incoming }, fn);
}

/** The request that reached the app, or `undefined` outside a request. */
export function currentIncoming(): IncomingScope | undefined {
  return storage.getStore()?.incoming;
}

/** Runs `fn` with `queue` collecting `afterResponse()` callbacks (the Node listener's scope). */
export function runWithAfterResponseQueue<T>(queue: AfterResponseQueue, fn: () => T): T {
  return storage.run({ afterResponse: queue }, fn);
}

/** The queue `afterResponse()` registers into, or `undefined` outside a response scope. */
export function currentAfterResponseQueue(): AfterResponseQueue | undefined {
  return storage.getStore()?.afterResponse;
}

export function currentRequest(): Request | undefined {
  return storage.getStore()?.request;
}

/**
 * Runs `callback` once the response to the current request has been sent (its body fully
 * written, or the client gone). Outside a request it runs on the next macrotask. A thrown error
 * or rejected promise is logged and never reaches the response.
 */
export function afterResponse(callback: AfterResponseCallback): void {
  const queue = storage.getStore()?.afterResponse;
  if (queue) queue.add(callback);
  else runSoon([callback]);
}

/** Value of a cookie on `request` (default: the request being handled), or `undefined`. */
export function requestCookie(name: string, request = currentRequest()): string | undefined {
  const header = request?.headers.get("cookie");
  return header ? parseCookie(header)[name] : undefined;
}
