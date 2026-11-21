/**
 * Decide whether the build should alias `better-sqlite3` to the build-time stub
 * (src/lib/db/better-sqlite3.stub.js); vite.config.ts adds the alias when this returns true.
 *
 * History (#11343): the alias was UNCONDITIONAL, added to keep a build worker from loading the
 * native addon, whose thread teardown can abort with SIGABRT (#10060). An alias rewrites the
 * request before the bundler decides what stays external, so the stub was baked into the
 * server bundle and every route answered HTTP 500: the stub's default export is not a
 * constructor and boot aborted.
 *
 * Same failure shape as #6344 (the @/mitm/manager stub shipping to every artifact), same
 * treatment: opt-in, and a default build gets the real, external native package.
 *
 * Set OMNIROUTE_BETTER_SQLITE3_STUB=1 ONLY on a build host that actually hits the SIGABRT, and
 * never for an artifact that will be run: the resulting bundle cannot open a database.
 */
export function shouldStubBetterSqlite3(env = process.env) {
  return env.OMNIROUTE_BETTER_SQLITE3_STUB === "1";
}
