/**
 * Decide whether the build should alias @/mitm/manager to the feature-degraded stub
 * (src/mitm/manager.stub.ts); vite.config.ts adds the alias when this returns true.
 *
 * History (#6344): the alias used to be UNCONDITIONAL, which was harmless while Docker images
 * were its only consumers. Once every build carried it, the stub shipped to every npm / VPS
 * artifact and Agent Bridge start threw "MITM manager stub reached at runtime" for all
 * non-Docker users.
 *
 * The stub is only correct where the runtime genuinely cannot run the MITM stack (containers
 * without host access, #3390 graceful degradation), so it is opt-in via OMNIROUTE_MITM_STUB=1,
 * set by the Dockerfile.
 */
export function shouldStubMitmManager(env = process.env) {
  return env.OMNIROUTE_MITM_STUB === "1";
}
