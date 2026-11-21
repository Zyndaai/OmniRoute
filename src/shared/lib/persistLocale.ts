import { LOCALE_COOKIE } from "@/i18n/config";
import type { Locale } from "@/i18n/config";

/**
 * Persist the locale preference in the cookie the server reads when it
 * renders the document, plus localStorage as a client-side convenience mirror.
 *
 * Shared by every client-side locale writer (manual selection in
 * `LanguageSelector`, first-visit auto-detection in `LocaleAutoDetect`) so
 * there is a single source of truth for the cookie name/format. The caller
 * reloads the document afterwards: the catalog, `<html lang>` and `<html dir>`
 * all come from the server render, so a reload is what applies the new locale.
 */
export function persistLocale(code: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${code};path=/;max-age=${365 * 24 * 60 * 60};samesite=lax`;
  try {
    localStorage.setItem(LOCALE_COOKIE, code);
  } catch {
    // Ignore (e.g. storage disabled/full)
  }
}
