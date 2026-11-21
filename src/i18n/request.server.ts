import { createTranslator } from "use-intl/core";

import { currentRequest, requestCookie } from "@/server/requestContext";

import { DEFAULT_LOCALE, LOCALES, LOCALE_ALIASES, LOCALE_COOKIE, RTL_LOCALES } from "./config";
import { loadMessages } from "./messages";
import { resolveRequestedLocale } from "./resolveRequestedLocale";

export { loadMessages as getMessages } from "./messages";

/**
 * The UI locale of a request: cookie `NEXT_LOCALE`, then header `x-locale`, then the default.
 * Without an argument it reads the request being handled (see `@/server/requestContext`).
 */
export function getRequestLocale(request: Request | undefined = currentRequest()): string {
  const requested = requestCookie(LOCALE_COOKIE, request) || request?.headers.get("x-locale") || "";
  return resolveRequestedLocale(requested, LOCALES, LOCALE_ALIASES, DEFAULT_LOCALE);
}

/** A translate function over the merged catalog; keys are plain strings (the catalog is loaded at run time). */
export type ServerTranslator = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

/**
 * A translator for loaders and endpoints (components use `useTranslations`). Resolves the
 * request's locale and the merged catalog. The catalog is typed `Record<string, unknown>`, so
 * `createTranslator` would derive an empty key type from it; the result is exposed as a
 * `ServerTranslator` instead.
 */
export async function getTranslator(
  namespace?: string,
  request?: Request
): Promise<ServerTranslator> {
  const locale = getRequestLocale(request);
  const messages = await loadMessages(locale);
  return createTranslator({ locale, messages, namespace }) as ServerTranslator;
}

/**
 * What the root loader returns for `IntlRoot`: small and serialisable. The catalog itself is
 * not part of it; loading it here fills the cache `IntlRoot` reads while rendering on the
 * server, and the browser loads the same catalog in `entry.client.tsx`.
 *
 * `timeZone` and `now` are pinned by the server so the HTML the server renders and the page
 * the browser hydrates format dates identically.
 */
export async function getRootIntlData(request?: Request) {
  const locale = getRequestLocale(request);
  await loadMessages(locale);
  return {
    locale,
    dir: RTL_LOCALES.includes(locale) ? ("rtl" as const) : ("ltr" as const),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: new Date().toISOString(),
  };
}
