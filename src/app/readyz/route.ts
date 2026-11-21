/**
 * Kubernetes-style readiness alias of /healthz.
 * Same lifecycle phase, same 200/503 bodies. Not a liveness probe.
 */
export { GET, HEAD } from "../healthz/route";
