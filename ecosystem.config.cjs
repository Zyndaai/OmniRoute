/**
 * PM2 process file for running OmniRoute as one leader plus N workers in ONE container
 * (or directly on a host). Started with `pm2-runtime ecosystem.config.cjs` in the image and
 * `pm2 start ecosystem.config.cjs` locally.
 *
 * Fork mode, one PM2 app per process, each on its own port (not PM2 cluster mode): a load
 * balancer in front (Caddy) can then health-check every process separately and keep a
 * conversation on one process with `x-session-affinity`. The app script is the same
 * dev/run-standalone.mjs the image already runs, so env bootstrap and heap sizing do not change.
 *
 * Roles (src/lib/cluster/role.ts): exactly one `leader` (migrations, background jobs, token
 * refresh for rotating OAuth providers); every other process is a `worker` (serves requests,
 * never refreshes rotating tokens). Each process needs a unique OMNIROUTE_INSTANCE_ID: the
 * cluster bus ignores messages whose origin equals its own id.
 *
 * Secrets (JWT_SECRET, API_KEY_SECRET, STORAGE_ENCRYPTION_KEY, OMNIROUTE_POSTGRES_URL, ...)
 * are NOT set here: every app inherits them from the environment PM2 is started with.
 *
 * Settings (environment):
 *   OMNIROUTE_WORKERS            number of workers (default 2; 0 = leader only)
 *   OMNIROUTE_LEADER_PORT        leader port (default 20128: dashboard, management, /v1)
 *   OMNIROUTE_WORKER_BASE_PORT   first worker port (default 20200; worker i uses base + i)
 *   OMNIROUTE_LEADER_MEMORY_MB   leader heap in MB (default 1024)
 *   OMNIROUTE_WORKER_MEMORY_MB   worker heap in MB (default 768)
 *   OMNIROUTE_APP_DIR            directory holding dev/run-standalone.mjs (default: this file's)
 *
 * Operations: restart the leader with `pm2 restart leader`, never `pm2 reload leader` (reload
 * starts the new process before stopping the old one; the new leader would hit the leader
 * fence and exit in a loop). `pm2 reload worker-0` is fine.
 */

const os = require("node:os");

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const workers = intFromEnv("OMNIROUTE_WORKERS", 2);
const leaderPort = intFromEnv("OMNIROUTE_LEADER_PORT", 20128);
const workerBasePort = intFromEnv("OMNIROUTE_WORKER_BASE_PORT", 20200);
const leaderMemoryMb = intFromEnv("OMNIROUTE_LEADER_MEMORY_MB", 1024);
const workerMemoryMb = intFromEnv("OMNIROUTE_WORKER_MEMORY_MB", 768);
const cwd = process.env.OMNIROUTE_APP_DIR || __dirname;

// The instance id must be unique across the whole cluster, so it includes the host name
// (a container id in Docker). Same alphabet as role.ts: [A-Za-z0-9._:-], at most 64.
const host = os
  .hostname()
  .replace(/[^A-Za-z0-9._:-]/g, "-")
  .slice(0, 40);

function app(name, port, memoryMb, env) {
  return {
    name,
    script: "dev/run-standalone.mjs",
    cwd,
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    // Graceful shutdown flushes spend writes and releases the leader fence.
    kill_timeout: 15_000,
    // A crash loop backs off instead of hammering PostgreSQL.
    exp_backoff_restart_delay: 200,
    // The heap is capped by OMNIROUTE_MEMORY_MB; restart only if the process grows well past it.
    max_memory_restart: `${Math.round(memoryMb * 1.4)}M`,
    // run-standalone.mjs spawns the real server as a child: stop the whole tree.
    treekill: true,
    time: true,
    env: {
      OMNIROUTE_INSTANCE_ID: `${host}-${name}`,
      PORT: String(port),
      DASHBOARD_PORT: String(port),
      API_PORT: String(port),
      OMNIROUTE_MEMORY_MB: String(memoryMb),
      ...env,
    },
  };
}

const apps = [app("leader", leaderPort, leaderMemoryMb, { OMNIROUTE_ROLE: "leader" })];
for (let i = 0; i < workers; i++) {
  apps.push(
    app(`worker-${i}`, workerBasePort + i, workerMemoryMb, {
      OMNIROUTE_ROLE: "worker",
      // PM2 already captures every process's stdout. The app log file stays the leader's,
      // which is the process that serves the dashboard's console-log page.
      APP_LOG_TO_FILE: "false",
    })
  );
}

module.exports = { apps };
