/**
 * Cluster role of this process: who migrates, who runs background jobs, and who may
 * refresh single-use OAuth tokens. See docs/architecture/persistence-shared-state.md.
 *
 * - `standalone` (OMNIROUTE_ROLE unset): one process, exactly the pre-cluster behaviour.
 *   Used by `npm run dev`, the tests and the single-container deployment.
 * - `leader`: the one process that migrates, runs the background jobs and refreshes
 *   rotating OAuth tokens. Exactly one per cluster (enforced by the leader fence).
 * - `worker`: serves requests only. Never migrates, never runs jobs, never refreshes a
 *   rotating provider's token (it adopts the token the leader stored).
 *
 * Coordination (fence, bus, shared limiter) runs on PostgreSQL by default and on Redis
 * when REDIS_URL is set. Either way it fails closed.
 *
 * Dependency-free (no Node built-ins, no DB) so open-sse and the boot code can both read it.
 */

export type ClusterRole = "standalone" | "leader" | "worker";

type EnvLike = Readonly<Record<string, string | undefined>>;

export const CLUSTER_ROLE_ENV = "OMNIROUTE_ROLE";
export const INSTANCE_ID_ENV = "OMNIROUTE_INSTANCE_ID";

const ROLES: ReadonlySet<string> = new Set(["leader", "worker"]);
// Same alphabet as peer routing (src/shared/resilience/peerRouting.ts).
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const TRUTHY = new Set(["1", "true", "yes", "on"]);

function flag(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

/**
 * The role from `OMNIROUTE_ROLE`. Unset or empty means `standalone`; any other value
 * than `leader`/`worker` throws, so a typo can never silently start a second leader.
 */
export function getRole(env: EnvLike = process.env): ClusterRole {
  const raw = (env[CLUSTER_ROLE_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return "standalone";
  if (ROLES.has(raw)) return raw as ClusterRole;
  throw new Error(
    `${CLUSTER_ROLE_ENV}="${env[CLUSTER_ROLE_ENV]}" is not a valid role. Use "leader" or "worker", or leave it unset for a single process.`
  );
}

export function isClusterMode(env: EnvLike = process.env): boolean {
  return getRole(env) !== "standalone";
}

/** True when this process must not refresh rotating (single-use) OAuth tokens itself. */
export function isWorker(env: EnvLike = process.env): boolean {
  return getRole(env) === "worker";
}

/** `OMNIROUTE_INSTANCE_ID` when valid, else `"standalone"` (cluster mode requires a valid id). */
export function getInstanceId(env: EnvLike = process.env): string {
  const value = (env[INSTANCE_ID_ENV] ?? "").trim();
  return INSTANCE_ID_PATTERN.test(value) ? value : "standalone";
}

export interface BootPlan {
  role: ClusterRole;
  instanceId: string;
  clusterMode: boolean;
  /** Apply migrations and partition DDL. Workers wait for the migration head instead. */
  applyMigrations: boolean;
  /**
   * One-process duties: startup data fixes and seeds, cleanup and health schedulers,
   * the local helper servers. Running them in N processes would repeat writes N times.
   */
  leaderDuties: boolean;
  /** Background jobs (job registry incl. token health check, quota refresh, syncs). */
  backgroundJobs: boolean;
  /** Optional subsystems (dashboard WS, catalog enrichment, embedded services). */
  optionalSubsystems: boolean;
  /** May generate and persist JWT_SECRET / API_KEY_SECRET when they are missing. */
  generateSecrets: boolean;
  /** Take the leader fence and exit if another process holds it. */
  takeLeaderFence: boolean;
  /** Coordination transport: Redis when REDIS_URL is set, else PostgreSQL. */
  coordination: "postgres" | "redis";
}

/**
 * What this process does at boot. `OMNIROUTE_DISABLE_BACKGROUND_SERVICES` and
 * `OMNIROUTE_HEADLESS` keep their meaning and narrow the plan further.
 */
export function resolveBootPlan(env: EnvLike = process.env): BootPlan {
  const role = getRole(env);
  const clusterMode = role !== "standalone";
  const leaderDuties = role !== "worker";
  const redisConfigured = (env.REDIS_URL ?? "").trim() !== "";
  return {
    role,
    instanceId: getInstanceId(env),
    clusterMode,
    applyMigrations: leaderDuties,
    leaderDuties,
    backgroundJobs: leaderDuties && !flag(env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES),
    optionalSubsystems: leaderDuties && !flag(env.OMNIROUTE_HEADLESS),
    generateSecrets: !clusterMode,
    // Standalone takes the fence too (owner, 2026-11-18): two role-less processes on one
    // database would both refresh single-use tokens, so the second one exits instead.
    takeLeaderFence: role !== "worker",
    coordination: redisConfigured ? "redis" : "postgres",
  };
}

/**
 * Configuration errors that must stop the boot. Empty in standalone mode.
 * Cluster mode needs a valid instance id and secrets shared through env: a worker that
 * generated its own JWT secret would reject every leader-issued session.
 */
export function clusterConfigErrors(env: EnvLike = process.env): string[] {
  const errors: string[] = [];
  let role: ClusterRole;
  try {
    role = getRole(env);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (role === "standalone") return errors;
  if (!INSTANCE_ID_PATTERN.test((env[INSTANCE_ID_ENV] ?? "").trim())) {
    errors.push(
      `${INSTANCE_ID_ENV} is required when ${CLUSTER_ROLE_ENV}=${role} (letters, digits, ".", "_", ":", "-"; at most 64).`
    );
  }
  for (const name of ["JWT_SECRET", "API_KEY_SECRET"]) {
    if (!(env[name] ?? "").trim()) {
      errors.push(`${name} must be set in the environment when ${CLUSTER_ROLE_ENV}=${role}.`);
    }
  }
  return errors;
}
