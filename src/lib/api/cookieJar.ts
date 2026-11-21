import { stringifySetCookie, type SetCookie } from "cookie";

import { requestCookie } from "@/server/requestContext";

export type CookieOptions = Omit<SetCookie, "name" | "value">;

/** The subset of a cookie store that route handlers (and tests that stand in for it) use. */
export interface CookieStore {
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, options?: CookieOptions): unknown;
  delete(name: string): unknown;
}

/**
 * Reads cookies from the incoming request and collects the `Set-Cookie` headers a handler wants
 * to send. A `Response` carries nothing until `applyCookies` copies them onto it.
 */
export class ResponseCookieJar implements CookieStore {
  readonly setCookieHeaders: string[] = [];

  constructor(private readonly request?: Request) {}

  get(name: string): { name: string; value: string } | undefined {
    const value = requestCookie(name, this.request);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    this.setCookieHeaders.push(stringifySetCookie({ path: "/", ...options, name, value }));
  }

  delete(name: string): void {
    this.setCookieHeaders.push(
      stringifySetCookie({ name, value: "", path: "/", expires: new Date(0) })
    );
  }
}

/** Appends the jar's `Set-Cookie` headers to `response`; any other store type is ignored. */
export function applyCookies<T extends Response>(store: unknown, response: T): T {
  if (store instanceof ResponseCookieJar) {
    for (const header of store.setCookieHeaders) response.headers.append("Set-Cookie", header);
  }
  return response;
}

/**
 * A redirect whose headers stay writable (`Response.redirect` returns immutable headers, so it
 * cannot carry cookies). `url` must be absolute.
 */
export function redirectResponse(url: string | URL, status: 301 | 302 | 303 | 307 | 308 = 307) {
  return new Response(null, { status, headers: { Location: new URL(url).toString() } });
}

/** `redirectResponse` carrying the cookies the handler set on `store`. */
export function redirectWithCookies(
  store: unknown,
  url: string | URL,
  status: 301 | 302 | 303 | 307 | 308 = 307
) {
  return applyCookies(store, redirectResponse(url, status));
}
