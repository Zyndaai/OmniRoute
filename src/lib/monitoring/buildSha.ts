/**
 * Runtime build identity (#10427).
 *
 * The image carries the commit it was built from in `OMNIROUTE_BUILD_SHA` (a Dockerfile build
 * argument the publish workflow sets). Reporting it on /api/monitoring/health lets an
 * operator answer "what code is this box actually running?" over HTTP.
 *
 * Before this existed, answering that question during the 2026-08-14 gateway outage meant
 * SSH-ing into the host and grepping the compiled chunks — the deployed package turned out
 * to be built from a feature branch that predated the fix it was supposed to carry.
 *
 * Unknown (a local build, a dev run) → `null`, never a fabricated or guessed value.
 */

let cached: string | null | undefined;

export function readRunningBuildSha(): string | null {
  if (cached !== undefined) return cached;
  cached = process.env.OMNIROUTE_BUILD_SHA?.trim() || null;
  return cached;
}
