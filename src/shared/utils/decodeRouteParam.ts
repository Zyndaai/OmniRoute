/**
 * decodeRouteParam — guarded percent-decoding for dynamic route params.
 *
 * Decodes percent-encoded reserved characters left in a param (`auto%2Ffast`
 * becomes `auto/fast`), so page components and API handlers see the same
 * canonical id.
 *
 * Already-decoded values (no `%`) pass through untouched, so callers can
 * apply it unconditionally. Malformed sequences (`foo%2F`) fall back to
 * the raw value instead of throwing — same contract as decodeUserinfo.
 */
export function decodeRouteParam(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
