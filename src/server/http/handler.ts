/**
 * The fetch-style request pipeline in front of React Router:
 *
 *   1. redirects (trailing slash, renamed pages)            -> 308
 *   2. headless gate for the dashboard                      -> 404 JSON
 *   3. a React Router data URL (`.data`) on an endpoint     -> 404 JSON
 *   4. authz pipeline on `AUTHZ_PATH_PATTERNS`, judged on the path the client sent; it may
 *      answer itself, and it re-stamps the trusted request headers the route receives
 *   5. rewrites (`/v1/*` -> `/api/v1/*`, ...)
 *   6. React Router, inside `runWithRequest()` so shared helpers can read the request
 *
 * Every decision uses the path React Router will match (see `./requestPath.ts`), so a request
 * can never be authorised as one route and served by another.
 *
 * `afterResponse()` callbacks registered while the request is handled run once the response
 * has been sent. Under the Node listener (`./nodeListener.ts`) that is the response's `close`
 * event; called on its own, this handler releases them when the body stream ends, errors or is
 * cancelled, or the request is aborted.
 */
import { buildErrorBody } from "@omniroute/open-sse/utils/error";

import { headlessGateResponse } from "@/lib/system/headless";

import { runAuthzPipeline } from "../authz/pipeline";
import { AfterResponseQueue, currentAfterResponseQueue, runWithRequest } from "../requestContext";
import { isAuthzPath } from "./authzPaths";
import { rebuildRequest } from "./rebuildRequest";
import { REDIRECT_STATUS, resolveRedirect } from "./redirects";
import {
  decodePathname,
  encodePathname,
  routingPathname,
  stripBasePath,
  stripDataSuffix,
} from "./requestPath";
import { resolveRewrite } from "./rewrites";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface AppHandlerOptions {
  /** Base path the app is served under (`""` at the root). */
  basePath: () => string | Promise<string>;
  /** Serves pages and endpoints (React Router's request handler). */
  render: FetchHandler;
}

function permanentRedirect(location: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    // `Refresh` for clients that do not follow a 308.
    headers: { Location: location, Refresh: `0;url=${location}` },
  });
}

/** `/api/...` and the root-level aliases rewritten onto it (`/v1/*`, `/models`, ...). */
function isEndpointPath(pathname: string): boolean {
  return /^\/api(?:\/|$)/i.test(pathname) || resolveRewrite(pathname) !== null;
}

/**
 * React Router serves `/x.data` as a data request for `/x`. An endpoint is never meant to be
 * reached that way: it would answer for a different path than the one requested, run every
 * layout loader above it, and buffer a streamed body. So the suffix gets a plain 404.
 */
function isEndpointDataRequest(decoded: string): boolean {
  const withoutSuffix = stripDataSuffix(decoded);
  return withoutSuffix !== decoded && isEndpointPath(withoutSuffix.replace(/\/+$/, "") || "/");
}

function endpointNotFound(): Response {
  return Response.json(
    buildErrorBody(404, "Not Found", undefined, { type: "not_found", code: "unknown_route" }),
    { status: 404 }
  );
}

/**
 * `response` with `queue` released once its body has been read to the end, failed, or been
 * cancelled; at once when there is no body; and when `signal` aborts (a client that leaves
 * before the body is read never reads or cancels it).
 */
function releaseAfterBody(
  response: Response,
  queue: AfterResponseQueue,
  signal: AbortSignal
): Response {
  if (queue.size === 0 || !response.body) {
    queue.release();
    return response;
  }
  const release = () => queue.release();
  if (signal.aborted) release();
  else signal.addEventListener("abort", release, { once: true });

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            release();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
          release();
        }
      },
      cancel(reason) {
        release();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createAppHandler({ basePath, render }: AppHandlerOptions): FetchHandler {
  async function handle(request: Request, queue: AfterResponseQueue): Promise<Response> {
    const serve: FetchHandler = (incoming) =>
      runWithRequest(incoming, () => render(incoming), queue);

    const url = new URL(request.url);
    const base = await basePath();
    const stripped = stripBasePath(url.pathname, base);
    if (stripped === null) return serve(request);

    const decoded = decodePathname(stripped);
    const redirectTo = resolveRedirect(decoded);
    if (redirectTo !== null) {
      return permanentRedirect(`${base}${encodePathname(redirectTo)}${url.search}`);
    }

    const pathname = routingPathname(decoded);
    const headless = headlessGateResponse(pathname);
    if (headless) return headless;
    if (isEndpointDataRequest(decoded)) return endpointNotFound();

    const forward: FetchHandler = async (incoming) => {
      const target = resolveRewrite(decoded);
      if (target === null && decoded === stripped) return serve(incoming);
      const targetUrl = new URL(`${base}${encodePathname(target ?? decoded)}${url.search}`, url);
      return serve(rebuildRequest(incoming, { url: targetUrl.href }));
    };

    if (!isAuthzPath(pathname)) return forward(request);
    return runAuthzPipeline(request, { enforce: true, pathname, basePath: base, next: forward });
  }

  return async (request) => {
    // The Node listener owns the queue and releases it when the response closes.
    const listenerQueue = currentAfterResponseQueue();
    const queue = listenerQueue ?? new AfterResponseQueue();
    let response: Response;
    try {
      response = await handle(request, queue);
    } catch (error) {
      queue.release();
      throw error;
    }
    return listenerQueue ? response : releaseAfterBody(response, queue, request.signal);
  };
}
