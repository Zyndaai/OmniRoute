/**
 * The merged message catalog, shared by the server (root loader, endpoints) and the browser
 * (`entry.client.tsx`). The dynamic `import()` below makes the bundler emit one chunk per
 * locale for the browser; the loaded result is cached per locale for the life of the process
 * (or the page) and read synchronously by `IntlRoot`.
 */

const FALLBACK_LOCALE = "en";

/**
 * Sentinel prefix written by `scripts/i18n/sync-ui-keys.mjs` when backfilling a
 * locale file with an untranslated key: `__MISSING__:<english value>`. Kept in
 * sync manually with the scripts (plain .mjs, no shared TS module) — see
 * `scripts/i18n/sync-ui-keys.mjs` and `scripts/i18n/check-ui-keys-coverage.mjs`.
 */
export const PLACEHOLDER_PREFIX = "__MISSING__:";

function isUntranslatedPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * Deep merge that mutates `target` with values from `source`.
 * If both have an object at the same key, recurse.
 * Otherwise prefer the existing value in `target` (locale-specific wins) —
 * unless the target value is an untranslated `__MISSING__:` sentinel written
 * by the i18n sync script, in which case it is treated as absent so the
 * clean English fallback value wins instead (#7258).
 */
export function deepMergeFallback(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  for (const [key, sourceValue] of Object.entries(source)) {
    // Guard against prototype pollution from a crafted locale message tree.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const targetValue = target[key];
    if (
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      deepMergeFallback(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else if (targetValue === undefined || isUntranslatedPlaceholder(targetValue)) {
      target[key] = sourceValue;
    }
  }
  return target;
}

function setNestedValue(target: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const segments = dottedKey.split(".");
  let cursor: Record<string, unknown> = target;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      !segment ||
      segment === "__proto__" ||
      segment === "constructor" ||
      segment === "prototype"
    ) {
      return;
    }

    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }

    const next = cursor[segment];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
      continue;
    }

    const created: Record<string, unknown> = {};
    cursor[segment] = created;
    cursor = created;
  }
}

/** Dotted keys under `compliance.eventTypes` become nested objects (ICU keys cannot contain dots). */
export function normalizeComplianceEventTypes(
  messages: Record<string, unknown>
): Record<string, unknown> {
  const compliance =
    messages.compliance &&
    typeof messages.compliance === "object" &&
    !Array.isArray(messages.compliance)
      ? (messages.compliance as Record<string, unknown>)
      : null;
  const eventTypes =
    compliance?.eventTypes &&
    typeof compliance.eventTypes === "object" &&
    !Array.isArray(compliance.eventTypes)
      ? (compliance.eventTypes as Record<string, unknown>)
      : null;

  if (!compliance || !eventTypes) return messages;

  const normalizedEventTypes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(eventTypes)) {
    if (key.includes(".")) {
      setNestedValue(normalizedEventTypes, key, value);
    } else {
      normalizedEventTypes[key] = value;
    }
  }

  return {
    ...messages,
    compliance: {
      ...compliance,
      eventTypes: normalizedEventTypes,
    },
  };
}

/**
 * Accepts a catalog either as raw JSON text or as an already parsed object, so a loader that
 * hands back the file's source text (a plain `?raw`-style import) still works.
 */
export function parseLocaleMessages(source: unknown): Record<string, unknown> {
  return (typeof source === "string" ? JSON.parse(source) : source) as Record<string, unknown>;
}

type CatalogImporter = (locale: string) => Promise<unknown>;

/**
 * Parses each locale's catalog once and then returns the same object for the
 * life of the process (or page).
 */
export function createLocaleMessagesLoader(importCatalog: CatalogImporter) {
  const parsed = new Map<string, Record<string, unknown>>();
  return async function loadLocaleMessages(locale: string): Promise<Record<string, unknown>> {
    const cached = parsed.get(locale);
    if (cached) return cached;
    const messages = parseLocaleMessages(await importCatalog(locale));
    parsed.set(locale, messages);
    return messages;
  };
}

const loadLocaleMessages = createLocaleMessagesLoader(
  async (locale) => (await import(`./messages/${locale}.json`)).default
);

/**
 * Builds the catalog for `locale`: the locale's own messages, with English filling every key
 * that is missing or still an untranslated `__MISSING__:` placeholder, and English filling
 * whole namespaces the locale file does not have yet.
 */
export function mergeWithFallback(
  localeMessages: Record<string, unknown>,
  fallbackMessages: Record<string, unknown>
): Record<string, unknown> {
  const merged = deepMergeFallback({ ...localeMessages }, fallbackMessages);
  return { ...fallbackMessages, ...merged };
}

const merged = new Map<string, Promise<Record<string, unknown>>>();
const resolved = new Map<string, Record<string, unknown>>();

/** The merged catalog for `locale`, loaded once and cached. */
export function loadMessages(locale: string): Promise<Record<string, unknown>> {
  let pending = merged.get(locale);
  if (!pending) {
    pending = (async () => {
      const own = normalizeComplianceEventTypes(await loadLocaleMessages(locale));
      let result = own;
      if (locale !== FALLBACK_LOCALE) {
        const fallback = normalizeComplianceEventTypes(await loadLocaleMessages(FALLBACK_LOCALE));
        result = mergeWithFallback(own, fallback);
      }
      resolved.set(locale, result);
      return result;
    })();
    // A failed load must not be cached: the next request retries.
    pending.catch(() => merged.delete(locale));
    merged.set(locale, pending);
  }
  return pending;
}

/** The catalog for `locale` if `loadMessages(locale)` has already finished, else `undefined`. */
export function getLoadedMessages(locale: string): Record<string, unknown> | undefined {
  return resolved.get(locale);
}
