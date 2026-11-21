/**
 * The resource route behind every HTTP endpoint. `src/app/routes.ts` registers this module once
 * per `route.ts` file; a request arrives here with the route pattern React Router matched, and
 * is passed to that file's handler for the request method (`GET`, `POST`, ...).
 *
 * React Router sends GET/HEAD/OPTIONS to `loader` and every other method to `action`.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  API_METHODS,
  apiRouteTable,
  type ApiMethod,
  type ApiRouteContext,
  type ApiRouteModule,
} from "./apiHandlers.server";

function allowHeader(module: ApiRouteModule): string {
  const allowed = new Set<string>(API_METHODS.filter((method) => module[method]));
  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");
  return [...allowed].join(", ");
}

async function handle({
  request,
  params,
  pattern,
}: LoaderFunctionArgs | ActionFunctionArgs): Promise<Response> {
  // `/x.data` is React Router's data URL for `/x`; an endpoint never answers one (see
  // `isEndpointDataRequest` in ../http/handler.ts, which catches the `/api` and alias paths first).
  if (new URL(request.url).pathname.endsWith(".data")) {
    return new Response(null, { status: 404 });
  }

  const entry = apiRouteTable.get(pattern.startsWith("/") ? pattern : `/${pattern}`);
  if (!entry) throw new Error(`No route file is registered for pattern "${pattern}"`);
  const module = await entry.load();

  const { "*": rest, ...named } = params;
  const routeParams: Record<string, string | string[] | undefined> = named;
  // A `[...name]` folder receives the rest of the path as a list of segments.
  if (entry.restParam) routeParams[entry.restParam] = rest ? rest.split("/") : undefined;
  const context: ApiRouteContext = { params: Promise.resolve(routeParams) };

  const method = request.method.toUpperCase() as ApiMethod;
  const handler = module[method];
  if (handler) return handler(request, context);

  if (method === "HEAD" && module.GET) {
    const response = await module.GET(request, context);
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const allow = allowHeader(module);
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: allow } });
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

export const loader = handle;
export const action = handle;
