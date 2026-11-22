/**
 * Dashboard loaders and actions read and write through the API routes the dashboard already
 * calls from the browser, replayed in-process:
 *
 *   export async function loader() {
 *     return { providers: await apiJson<ProvidersResponse>("/api/providers") };
 *   }
 *
 * The call goes through the whole request pipeline (`../http/handler.ts`) with the headers of
 * the request that reached the server: the authz pipeline judges it on the `/api/...` path
 * (LOCAL_ONLY, always-protected paths, access-token scopes, session-only routes, body limits),
 * then the route runs with its own checks. A loader therefore gets exactly what the browser's
 * own `fetch("/api/...")` would get, and never more. Reading `@/lib/db/*` directly from a loader
 * would skip every rule that is keyed on the API path, so dashboard routes must not do that
 * (`tests/unit/dashboard-loaders-use-api.test.ts`).
 */
import { data, redirect } from "react-router";

import { currentIncoming } from "../requestContext";

export interface ApiCallInit {
  method?: string;
  /** JSON-encoded as the request body. */
  body?: unknown;
  /** Query string parameters appended to `path`. */
  query?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Request headers that describe the original body or that the replay sets itself. Everything
 * else (cookies, Authorization, Origin, the dashboard CSRF token, the peer stamps) is kept.
 */
const BODY_HEADERS = ["content-length", "content-type", "transfer-encoding", "content-encoding"];

function apiUrl(path: string, base: string, origin: string, query: ApiCallInit["query"]): URL {
  if (!path.startsWith("/api/")) {
    throw new Error(`dashboard API calls must target /api/... (got "${path}")`);
  }
  const url = new URL(`${base}${path}`, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

/** Runs the API route at `path` for the current request and returns its response as is. */
export async function apiRequest(path: string, init: ApiCallInit = {}): Promise<Response> {
  const incoming = currentIncoming();
  if (!incoming) throw new Error("apiRequest() runs only while the server handles a request");

  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(incoming.request.headers);
  for (const name of BODY_HEADERS) headers.delete(name);
  headers.set("accept", "application/json");

  const requestInit: RequestInit = { method, headers, signal: incoming.request.signal };
  if (init.body !== undefined && method !== "GET" && method !== "HEAD") {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(init.body);
  }

  const url = apiUrl(path, incoming.basePath, incoming.request.url, init.query);
  return incoming.fetch(new Request(url, requestInit));
}

/**
 * Redirect to the login page. The location carries the base path: a document request hands it
 * to the browser as is, and a data request's redirect has the base path stripped by React
 * Router before the client router re-applies it.
 */
function loginRedirect(): Response {
  return redirect(`${currentIncoming()?.basePath ?? ""}/login`);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The JSON body of a successful API call. A 401 redirects to the login page; any other error
 * is thrown as a React Router error response with the route's status and body, for the route's
 * error boundary.
 */
export async function apiJson<T = unknown>(path: string, init: ApiCallInit = {}): Promise<T> {
  const response = await apiRequest(path, init);
  const body = await readBody(response);
  if (response.ok) return body as T;
  if (response.status === 401) throw loginRedirect();
  throw data(body, { status: response.status });
}

/** Result of an action's API call: the body plus whether it succeeded, for forms to show. */
export type ApiActionResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: unknown };

/**
 * For actions: like `apiJson()`, but an error other than 401 is returned (with its status set
 * on the action's response) instead of thrown, so the form can show it next to its fields.
 */
export async function apiAction<T = unknown>(
  path: string,
  init: ApiCallInit
): Promise<ReturnType<typeof data<ApiActionResult<T>>>> {
  const response = await apiRequest(path, init);
  const body = await readBody(response);
  if (response.status === 401) throw loginRedirect();
  const result: ApiActionResult<T> = response.ok
    ? { ok: true, status: response.status, data: body as T }
    : { ok: false, status: response.status, error: body };
  return data(result, { status: response.status });
}
