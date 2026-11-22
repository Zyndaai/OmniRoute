---
title: "🐳 Docker Guide — OmniRoute"
version: 3.8.51
lastUpdated: 2026-10-16
---

# 🐳 Docker Guide — OmniRoute

> Docker reference for this self-hosted copy of OmniRoute (`Zyndaai/OmniRoute`).

## Table of Contents

- [The image](#the-image)
- [Running it](#running-it)
- [Configuring host CLI tools when OmniRoute runs in Docker](#configuring-host-cli-tools-when-omniroute-runs-in-docker)
- [Build-time resources](#build-time-resources)
- [Critical Environment Variables](#critical-environment-variables)
- [Docker Compose with Caddy (HTTPS)](#docker-compose-with-caddy-https-auto-tls)
- [Cloudflare Quick Tunnel](#cloudflare-quick-tunnel)
- [Updating the deployed image](#updating-the-deployed-image)
- [Prometheus metrics exporter](#prometheus-metrics-exporter)
- [Availability: default SQLite is single-replica](#availability-default-sqlite-is-single-replica)
- [Gemini regional errors inside Docker](#gemini-regional-errors-inside-docker)
- [Important Notes](#important-notes)

---

## The image

There is one image: `ghcr.io/zyndaai/omniroute`, built from the `runner-base` stage of the
`Dockerfile` by `.github/workflows/docker-build-push.yml`. The workflow never runs on a push: a
maintainer starts it from the Actions tab ("Run workflow"), and it refuses any branch but `main`.
Each build is tagged `:latest` and `:<commit sha>`. The package is public, so a host pulls it
without logging in.

The `Dockerfile` has three stages: `base` (Node 26 on Debian trixie), `builder` (installs
dependencies and runs `npm run build`) and `runner-base` (the application directory with the build output in `.build/app`, production
`node_modules` and the launcher in `scripts/dev/`; no browsers and no provider CLIs). Upstream's `runner-web` (Chromium for web-cookie providers) and
`runner-cli` (bundled Codex, Claude Code, Droid, OpenClaw and Qoder CLIs) targets were removed;
web-cookie providers such as `gemini-web` and `claude-web` fail at request time on this image.

## Running it

- **Single-VPS production (behind Caddy):** `docker-compose.vps.yml` is meant to be copied to
  `/opt/omniroute/docker-compose.yml` on the VPS. It runs the image pinned by `OMNIROUTE_TAG`
  (a commit sha) with one data volume.
- **Self-host with Redis:** `docker-compose.selfhost.yml` runs the image plus a Redis sidecar on
  loopback. See the [Self-Host Guide](../getting-started/SELF_HOST_GUIDE.md).
- **Single container:**

```bash
docker run -d \
  --name omniroute \
  --restart unless-stopped \
  --stop-timeout 40 \
  --env-file .env \
  -p 127.0.0.1:20128:20128 \
  -v omniroute-data:/app/data \
  ghcr.io/zyndaai/omniroute:latest
```

## Configuring host CLI tools when OmniRoute runs in Docker

`omniroute setup-codex`, `setup-claude`, `config set <tool>` and the dashboard's
**Save config** button all write files like `~/.codex/*.config.toml`. Those paths
only mean something on the machine where the CLI actually runs. Run them inside
the container and the write lands in the container's own home (`/home/node` —
the image runs `USER node`), where no host CLI will ever read it and where it is
discarded the moment the container is recreated.

OmniRoute detects this and refuses the write with instructions instead of
reporting a success you cannot use: the CLI exits `2`, and the API answers `422`
with `containerEphemeralTarget: true`.

### Recommended: run the CLI on the host, OmniRoute in Docker

The container serves the API; the CLI configures your host tools.

```bash
npm install -g omniroute
omniroute connect http://localhost:20128   # point the CLI at the container
omniroute setup-codex                      # writes the real ~/.codex on your host
```

This is the right choice when Codex, Claude Code, Cursor or similar run on your
laptop — which is the usual setup.

### Alternative: bind-mount the host config dirs

If you want the container itself to write your host config, mount the
directories in and point `CLI_CONFIG_HOME` at the mount root:

```yaml
environment:
  - CLI_CONFIG_HOME=/host-home
  - CLI_ALLOW_CONFIG_WRITES=true
volumes:
  - ~/.codex:/host-home/.codex:rw
  - ~/.claude:/host-home/.claude:rw
```

A bind mount is what makes the path trustworthy: OmniRoute reads
`/proc/self/mountinfo` and allows writes to mounted paths (and to directories
whose children are mounts, which is exactly the `/host-home` shape above) while
still refusing unmounted ones.

### Escape hatch: configure the container's own CLIs (use sparingly)

When the write is intentional, pass `--allow-container-write` to any `setup-*`
command, or set `OMNIROUTE_ALLOW_CONTAINER_CONFIG_WRITE=true` for the server. The
write proceeds with a warning that it will not survive the container.

> See `docs/security/MITM-TPROXY-DECRYPT.md` (git; not compiled into `/docs`) for the related threat model
> around MITM.

## Build-time resources

The image is built with `npm run build` (React Router + Vite, `scripts/build/build.mjs`).
One build arg controls what the `builder` stage costs. It is build-time only —
`OMNIROUTE_MEMORY_MB` (below) is a separate, runtime knob.

| Build arg                   | Default | Effect                                                                                                 |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `OMNIROUTE_BUILD_MEMORY_MB` | `6144`  | V8 heap ceiling (`--max-old-space-size`) for the build; ignored if `NODE_OPTIONS` already sets one. |

Size the builder's container ceiling above this heap value: native memory and the esbuild worker
bundling sit outside the V8 heap. The memory figures measured for the former Next.js build
(Turbopack, webpack, page-data workers) no longer apply and have not been re-measured for the
Vite build.

### Runtime defaults

Defaults exported by `runner-base`: `PORT=20128`, `HOSTNAME=0.0.0.0`, `OMNIROUTE_MEMORY_MB=1024`, `NODE_OPTIONS=--max-old-space-size=1024`, `DATA_DIR=/app/data`, `OMNIROUTE_MIGRATIONS_DIR=/app/migrations`.

Memory behavior in Docker:

- The image sets `OMNIROUTE_MEMORY_MB=1024` and derives `NODE_OPTIONS=--max-old-space-size=1024` from it.
- The actual server process is started by `scripts/dev/run-standalone.mjs` (the image CMD, which wraps the launcher `scripts/dev/run-server.mjs`), which reads `OMNIROUTE_MEMORY_MB` and appends `--max-old-space-size=<OMNIROUTE_MEMORY_MB>`.
- Node uses the last repeated `--max-old-space-size` value, so setting `OMNIROUTE_MEMORY_MB` controls the effective Docker heap limit.
- Because the image always sets it, the launcher's own RAM-calibrated fallback never applies under Docker. Raise it explicitly for the workload (table below). `2048` is still too small for coding-agent `/v1/responses`.

### Runtime RAM for coding agents

The 1 GiB Docker default is a dashboard/light-chat floor, not a production size. Long `POST /v1/responses` bodies (hundreds of messages, tens of tools) retain multiple in-memory graphs during compression. Two overlapping ~3 MiB / ~750k-token requests have aborted V8 at a **12 GiB** old-space (`FATAL ERROR: Reached heap limit`) and also hit a 16 GiB cgroup OOM. See [#7849](https://github.com/diegosouzapw/OmniRoute/issues/7849).

Size **cgroup `--memory` above the heap** — native buffers, SQLite, and compression intermediates sit outside V8.

| Workload                             | `OMNIROUTE_MEMORY_MB`  | Container / cgroup   | Notes                                                                                       |
| ------------------------------------ | ---------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| Dashboard, one light chat            | `1024` (image default) | ≥2 GiB               |                                                                                             |
| One coding agent (Claude/Codex/Grok) | `8192`                 | ≥10 GiB              | Typical single-session `/v1/responses`                                                      |
| Two concurrent long `/v1/responses`  | `10240`–`12288`        | ≥12–16 GiB           | Measured V8 abort at ~12 GiB heap                                                           |
| Three+ concurrent long contexts      | do not on one process  | serialize / more RAM | Default heavyweight admission is 1 in-flight; raising it without RAM reintroduces the abort |

`omniroute serve` on bare metal calibrates ~35% of RAM (clamped `[512, 4096]`) when `OMNIROUTE_MEMORY_MB` is **unset**. Docker always sets `1024`, so that calibration never runs in the official image.

```bash
docker run -d --name omniroute --restart unless-stopped --stop-timeout 40 \
  -e OMNIROUTE_MEMORY_MB=8192 --memory=10g \
  -p 127.0.0.1:20128:20128 -v omniroute-data:/app/data ghcr.io/zyndaai/omniroute:latest
```

## Critical Environment Variables

Beyond the defaults documented in [ENVIRONMENT.md](../reference/ENVIRONMENT.md), the following variables matter most when running under Docker:

| Variable                      | Purpose                                                                                                                                                                                                                                              | Default                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `OMNIROUTE_WS_BRIDGE_SECRET`  | Shared secret for the WebSocket bridge. **Required in production** — set to a strong random string.                                                                                                                                                  | unset (must be provided) |
| `REDIS_URL`                   | Connection string for the rate limiter / cache backend                                                                                                                                                                                               | `redis://redis:6379`     |
| `OMNIROUTE_MEMORY_MB`         | Runtime Node heap ceiling for the Docker server process; overrides the image default above. Coding agents: `8192`+ (see [runtime RAM](#runtime-ram-for-coding-agents)).                                                                           | `1024`                   |
| `DASHBOARD_PORT` / `API_PORT` | Override exposed ports for dashboard (20128) and API (20129)                                                                                                                                                                                         | `20128` / `20129`        |
| `OMNIROUTE_PLUGINS_DIR`       | Directory the runtime plugin scanner reads and installs into. Set it when plugins are bind-mounted: the default follows `HOME`, which an image need not export.                                                                                      | `~/.omniroute/plugins`   |
| `OMNIROUTE_BASE_PATH`         | URL subpath when the app is published behind a reverse proxy (e.g. `/omniroute`)                                                                                                                                                                     | _(empty = root)_         |
| `NEXT_PUBLIC_BASE_URL`        | Public browser origin including the subpath (e.g. `https://host/omniroute`)                                                                                                                                                                          | unset                    |
| `OMNIROUTE_NO_UPDATE_NOTIFIER` | Set in the image: no npm/GitHub/news lookups and no "update available" banner                                                                                                                                                                        | `1`                      |

## Reverse Proxy on a Subpath (Traefik / nginx)

The base path is compiled into the build: it becomes the React Router `basename` and the
Vite asset prefix. The `Dockerfile` records the value it was built with in
`.build/app/BASE_PATH`. When the container starts, `scripts/check-permissions.sh` (the
entrypoint) runs `scripts/docker/check-base-path.mjs`, which compares that sentinel with
`OMNIROUTE_BASE_PATH` and prints a warning when they differ. It never rewrites the bundle and
never blocks the start: a different runtime value has no effect until the image is rebuilt.

### Subpath image

The `ghcr.io/zyndaai/omniroute` images are built for the domain root. To serve a subpath, build
the image for it with the `OMNIROUTE_BASE_PATH` build arg (`docker build --build-arg
OMNIROUTE_BASE_PATH=/omniroute ...`), then set the same value at runtime together with the
matching public origin:

```yaml
services:
  omniroute:
    image: ghcr.io/zyndaai/omniroute:latest
    environment:
      OMNIROUTE_BASE_PATH: /omniroute
      NEXT_PUBLIC_BASE_URL: https://myhostname.example.com/omniroute
```

Configure the reverse proxy to forward the **full** external path (do not strip the
prefix). Traefik should route `PathPrefix(`/omniroute`)` to the container without
`StripPrefix`, so the server receives `/omniroute/...` and serves assets from
`/omniroute/assets/...`.

The Docker healthcheck probes the lightweight `/healthz` lifecycle endpoint prefixed
with the active `OMNIROUTE_BASE_PATH`. `/api/monitoring/health` remains available for
human/dashboard diagnostics; to point the container HEALTHCHECK back at it (for example
for deep health enforcement), set `OMNIROUTE_HEALTHCHECK_PATH=/api/monitoring/health`.
That path is a **deep** check (DB + monitoring summary) — appropriate for Docker's
infrequent `HEALTHCHECK` if you opt back in, but **not** for Kubernetes `livenessProbe`
intervals.

For orchestrators (Kubernetes, Nomad, etc.):

| Probe           | Prefer                                                               | Avoid                                             |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| Liveness        | HTTP `GET /livez`, or TCP on the main port (`PORT`, default `20128`) | `/api/monitoring/health` as liveness              |
| Readiness       | HTTP `GET /healthz`                                                  | Tight timeouts that treat event-loop busy as dead |
| Deep / blackbox | `/api/monitoring/health`                                             | —                                                 |

`/healthz` reports process lifecycle (`ok` / `starting` / `stopping`). `/livez` is
process-alive only (200 whenever the handler can run; it does not wait for
readiness). Both still run on the same Node event loop as request handling, so
CPU-bound catalog or compression work can delay them — busy ≠ dead. Prefer TCP
liveness if HTTP probes time out. Full probe guidance:
[Monitoring guide — Kubernetes probe recommendations](../ops/MONITORING_GUIDE.md#kubernetes-probe-recommendations).

## Docker Compose with Caddy (HTTPS Auto-TLS)

OmniRoute can be securely exposed using Caddy's automatic SSL provisioning. Ensure your domain's DNS A record points to your server's IP.

```yaml
services:
  omniroute:
    image: ghcr.io/zyndaai/omniroute:latest
    container_name: omniroute
    restart: unless-stopped
    volumes:
      - omniroute-data:/app/data
    environment:
      - PORT=20128
      # Browser-facing origin for OAuth callbacks, dashboard links, and generated public URLs.
      - NEXT_PUBLIC_BASE_URL=https://your-domain.com
      # Internal server-to-server URL for scheduled jobs / self-fetches.
      - BASE_URL=http://omniroute:20128
      - AUTH_COOKIE_SECURE=true

  caddy:
    image: caddy:latest
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    command: caddy reverse-proxy --from https://your-domain.com --to http://omniroute:20128

volumes:
  omniroute-data:
```

Caddy sets the standard forwarding headers for the upstream container. OmniRoute uses
`NEXT_PUBLIC_BASE_URL` as the canonical public origin for OAuth callbacks and generated public
links; authenticated dashboard writes use same-origin requests plus session-bound CSRF
protection. Only enable `OMNIROUTE_TRUST_PROXY` for advanced deployments where you intentionally
want OmniRoute to derive the public origin from trusted forwarded headers instead of explicit
configuration.

## Cloudflare Quick Tunnel

Dashboard support for Docker deployments includes a one-click **Cloudflare Quick Tunnel** on `Dashboard → Endpoints`. The first enable downloads `cloudflared` only when needed, starts a temporary tunnel to your current `/v1` endpoint, and shows the generated `https://*.trycloudflare.com/v1` URL directly below your normal public URL.

Endpoint tunnel panels (Cloudflare, Tailscale, ngrok) can be shown or hidden from `Settings → Appearance` without changing active tunnel state.

### Tunnel Notes

- Quick Tunnel URLs are temporary and change after every restart.
- Quick Tunnels are not auto-restored after an OmniRoute or container restart. Re-enable them from the dashboard when needed.
- Managed install currently supports Linux, macOS, and Windows on `x64` / `arm64`.
- Managed Quick Tunnels default to HTTP/2 transport to avoid noisy QUIC UDP buffer warnings in constrained container environments. Set `CLOUDFLARED_PROTOCOL=quic` or `auto` if you want a different transport.
- Docker images bundle system CA roots and pass them to managed `cloudflared`, which avoids TLS trust failures when the tunnel bootstraps inside the container.
- Set `CLOUDFLARED_BIN=/absolute/path/to/cloudflared` if you want OmniRoute to use an existing binary instead of downloading one.

## Updating the deployed image

The image sets `OMNIROUTE_NO_UPDATE_NOTIFIER=1`, so the dashboard never offers upstream's npm
releases as updates and never shows upstream's news feed. Updating the hosted instance is a deploy:

1. Push to `main`, then start "Build and Push Docker Image" from the Actions tab. It builds and
   pushes `ghcr.io/zyndaai/omniroute:<sha>` and `:latest`.
2. The VPS deploys the new `:latest` by itself within about 5 minutes:
   `scripts/docker/autodeploy/omniroute-autodeploy` runs from a systemd timer on the cluster stack
   (`docker-compose.cluster.yml` as `/opt/omniroute/docker-compose.yml`; it refuses a compose
   file without a `postgres` service). When the `:latest` digest changes it pulls the image,
   stops the app container, takes a `pg_dump` of the database, starts the new image (the leader
   migrates, the workers wait for it) and waits until the container is healthy and every PM2
   process is online. If not, it recreates the database from the dump, restores the previous
   `OMNIROUTE_TAG`, starts the old image again and skips that digest from then on. PostgreSQL and
   Redis keep running. It logs to `journalctl -u omniroute-autodeploy`.
3. To hold deploys, `touch /opt/omniroute/AUTODEPLOY_PAUSED`; delete the file to resume. To deploy
   by hand instead, set `OMNIROUTE_TAG` in `/opt/omniroute/.env` and run
   `docker compose pull omniroute && docker compose up -d omniroute` in `/opt/omniroute`, after a
   `pg_dump` (see `docs/ops/POSTGRES_CUTOVER.md`).
4. The auto-deploy rewrites only `OMNIROUTE_TAG`, so any other setting in `/opt/omniroute/.env`
   survives deploys. The hosted instance sets `OMNIROUTE_DISABLE_CONVERSATION_TRACKING=1` there
   (since 2026-11-12): tracking fed only the dashboard's conversation view and cost ~5% of CPU
   under load.

Install the auto-deploy on a host (as root):

```bash
install -m 750 scripts/docker/autodeploy/omniroute-autodeploy /usr/local/sbin/
install -m 644 scripts/docker/autodeploy/omniroute-autodeploy.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now omniroute-autodeploy.timer
```

## Prometheus metrics exporter

OmniRoute has no Prometheus endpoint of its own. `scripts/ops/metrics-exporter.mjs` (no
dependencies) reads `GET /api/usage/provider-limits`, `/api/provider-metrics` and `/api/providers`
and serves them on `:9464/metrics`:

| Metric | Labels | Meaning |
|---|---|---|
| `omniroute_quota_used_ratio` | connection, provider, plan, scope (account/model), window, period (weekly/session/other) | share of a quota window used, 0 to 1; absent for an unlimited window |
| `omniroute_quota_reset_seconds` | same | seconds until the window resets |
| `omniroute_quota_limit_reached` | connection, provider | 1 when the connection reports its limit reached (only when reported) |
| `omniroute_quota_last_sync_timestamp_seconds` | connection, provider | when OmniRoute last synced that connection's quota |
| `omniroute_provider_requests_total`, `omniroute_provider_successes_total` | provider | all-time counters from the call log; use `rate()` |
| `omniroute_exporter_source_up` | endpoint | 1 when the route was readable on the last scrape |

- **Credential:** a `read`-scope access token (`oma_...`, created at `POST /api/cli/tokens`). It can
  GET these routes and is refused on every write. Mount it as a file
  (`OMNIROUTE_METRICS_TOKEN_FILE`); keep it out of Prometheus and Grafana config.
- **Safe to scrape every minute:** the quota GET reads OmniRoute's cache, which it syncs on its own
  timer. Never point anything at `POST /api/usage/provider-limits`, which forces a live quota call on
  every subscription login.
- **No names in labels:** connection names are often account emails, so series carry the
  connection and provider ids only. Connections whose name matches `EXPORTER_EXCLUDE` (default
  `stressmock`) are dropped, with their provider's counters.
- **Network:** run it on the OmniRoute network so it reaches `http://omniroute:20128` (set
  `OMNIROUTE_URL` otherwise). A peer on that network still needs the token; it gets 401 without it.

Run it from the stock Node image, no build needed:

```bash
docker run -d --name omniroute-metrics-exporter --restart unless-stopped \
  --network omniroute_default \
  -v /opt/omni-monitoring/exporter/metrics-exporter.mjs:/app/exporter.mjs:ro \
  -v /opt/omni-monitoring/secrets/omniroute-metrics-token:/run/secrets/token:ro \
  -e OMNIROUTE_METRICS_TOKEN_FILE=/run/secrets/token \
  node:26-alpine node /app/exporter.mjs
```

## Availability: default SQLite is single-replica

Stock Docker / Kubernetes OmniRoute is **one Node process + one SQLite writer**. High availability is **not supported** on that topology.

| Constraint                            | Consequence                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single writer                         | Do **not** run multiple replicas against the same SQLite file. That corrupts the DB.                                                                                                                                                                                                                    |
| Recreate / restart / HEALTHCHECK kill | **Full outage** of in-flight SSE, dashboard sessions, and in-memory state. Every connected client drops. New requests during the empty-endpoint window get a reverse-proxy **`502 Bad Gateway: Unknown error`**, not OmniRoute JSON — clients cannot distinguish this from a provider failure (#11015). |
| Same event loop as `/healthz`         | A busy catalog or compression tick can delay probes; a short timeout then restarts the **only** replica.                                                                                                                                                                                                |

**Probe matrix** (see also [Kubernetes probe recommendations](../ops/MONITORING_GUIDE.md#kubernetes-probe-recommendations)):

| Probe         | Target                                                   | Do not use                                        |
| ------------- | -------------------------------------------------------- | ------------------------------------------------- |
| Liveness      | TCP on `PORT` (default `20128`), or soft HTTP `/healthz` | `/api/monitoring/health`                          |
| Readiness     | HTTP `GET /healthz`                                      | Tight timeouts that treat event-loop busy as dead |
| Deep / humans | `/api/monitoring/health`                                 | Automated kubelet liveness                        |

**Upgrades:** expect every session to drop. Drain clients if you can; there is no rolling update on default SQLite. Compose `restart: unless-stopped` plus Docker `HEALTHCHECK` will also replace the only process when the container is Unhealthy — same blast radius.

Kubernetes snippet for a **single replica** (Recreate is required; do not raise `replicas` against one SQLite file):

```yaml
spec:
  replicas: 1
  strategy:
    type: Recreate
  template:
    spec:
      terminationGracePeriodSeconds: 90
      containers:
        - name: omniroute
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sleep", "15"]
          readinessProbe:
            httpGet:
              path: /healthz
              port: 20128
            periodSeconds: 5
          livenessProbe:
            tcpSocket:
              port: 20128
            periodSeconds: 20
```

`preStop` sleep lets kube drop Service endpoints before SIGTERM so **new** traffic stops hitting the dying process. In-flight `/v1/responses` SSE is drained up to `SHUTDOWN_TIMEOUT_MS` (default 30s) via heavyweight admission leases (#11015). New requests that still reach the process get `503` + `Retry-After: 5`. The Recreate empty-endpoint gap until the replacement is Ready remains a hard outage — that is the SQLite topology, not a probe misconfig.

External Postgres / multi-writer HA is **not** a documented stock path. If you need HA, keep a single replica or run a topology the project has tested and documented separately. The Postgres/MySQL work lives in [#8075](https://github.com/diegosouzapw/OmniRoute/issues/8075). Until that ships, the only supported way to multiply **large** `/v1/responses` capacity is N independent processes (next section), not `replicas > 1` on one volume.

## Scale-out: N independent processes

One process uses one core: on the hosted 6-vCPU VPS it saturated at about 20–25 streaming
requests a second while the host sat at 23% CPU ([load test](../ops/LOAD_TESTING.md)). More
throughput means more processes as below, not a bigger server. Node's cluster mode and
`reusePort` are not a shortcut: they start N copies on one data folder, each running the boot
jobs (token refresh with single-use refresh tokens, quota sync, cleanup) and keeping its own
rate limits and pins. Split the provider accounts between processes, and have the load balancer
pin by conversation (`x-session-affinity`) rather than by API key when one client key carries
all the traffic.

### Codex token rotation ownership

Copies of one Codex account must not independently consume its single-use refresh
token. On instances that only consume synchronized credentials, set
`OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS=codex` (alias `cx`). Leave it unset on the
single rotation owner. Each process still needs its own `DATA_DIR`; this option
neither shares SQLite nor supplies token synchronization or a distributed lock.

The passive instance rereads the connection when a refresh is needed and adopts
only a different, unexpired access token. Otherwise refresh is disabled without
expiring or deactivating the connection or counting a refresh-breaker failure.
Real upstream authentication failures still use normal failure accounting,
exponential cooldown and the normal client error; account deactivation remains
permanent. Synchronize the owner's rotated tokens before access tokens expire
(the default proactive refresh lead is five minutes), or re-import the Codex auth
file. Passive imports store the supplied tokens without validating them at the
token endpoint. Manual dashboard/API refresh returns `409 refresh_disabled`;
new OAuth logins are unchanged. See [environment reference](../reference/ENVIRONMENT.md#passive-codex-token-refresh).

One Node process is **one V8 heap**. Two overlapping ~3 MiB / ~750k-token coding-agent `POST /v1/responses` (RTK + Caveman) abort that heap at ~12 Gi (`FATAL ERROR: Reached heap limit`) and can OOM a 16 Gi cgroup. See [#7849](https://github.com/diegosouzapw/OmniRoute/issues/7849). That measurement is a **memory-budget** warning, not a product hard-max of two concurrent long `/v1/responses`. Heavyweight chat admission is gated by an auto-derived ingest byte budget (`OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES`, `src/shared/middleware/admissionBudget.ts`) sized from that same V8/cgroup ceiling — overriding it upward (or setting the legacy `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` request-count cap) on an already-sized process reintroduces the abort. Small chats, `/healthz`, `/v1/models`, and MCP are **not** in that cap.

### One-process: more than two long `/v1/responses`

A **healthy** process (heap below `OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO`, default `0.75`) **may** run more than two concurrent long `POST /v1/responses` when the process-wide inflight-byte budget (`OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES` / #10110) still has room. Bodies at or above `OMNIROUTE_CHAT_LARGE_BODY_BYTES` (default 256 KiB) take the same heavyweight lease as structure-heavy requests and use the same [#10437](https://github.com/diegosouzapw/OmniRoute/pull/10437) `tryAcquireHealthyHeadroom` escape (`OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM`). Tens of concurrent long SSE clients (operators often need 40–50) is a **memory-budget** question — size heap + primary/headroom slots + `OMNIROUTE_CHAT_MAX_INFLIGHT_BYTES` — not a hard “max 2” product limit. A pressured heap still sheds with retryable `503` so #7849 does not return.

To **multiply heaps** (independent V8 old-spaces) **today**:

| Do                                                                                                                                      | Do not                                               |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Run **N containers/pods**, each with its **own** `DATA_DIR` / volume                                                                    | Set `replicas > 1` against one SQLite file           |
| Size heavy in-flight + healthy-headroom from heap / inflight-byte budget; 1–2 is the conservative #7849 default, not a hard product max | Give one process 8× RAM and an unbounded count cap   |
| Optional: `QUOTA_STORE_DRIVER=redis` + `QUOTA_STORE_REDIS_URL` for **shared quota counters**                                            | Treat Redis as shared SQLite — it is not             |
| Duplicate provider secrets into each instance (or accept partitioned dashboards)                                                        | Expect one dashboard / one call-log across instances |
| Front with any load balancer; sticky by API key or session is enough                                                                    | Require a vendor-specific size-aware middleware      |

Session-to-account affinity can also be shared through Redis: set
`OMNIROUTE_SESSION_AFFINITY_STORE=redis` and `REDIS_URL` on each process, with the
same `REDIS_KEY_PREFIX` and a positive `sessionAffinityTtlMs` setting. Pins resolve
hashed usage-account identities to each process's eligible local connection, so
OAuth accounts with matching identity metadata need not have matching connection
IDs. Known account identities take precedence over contradictory local IDs in
pin resolution and guarded eviction; records without identity (or eviction callers
without identity) retain the legacy ID guard. Accounts without a stable usage
identity still require matching IDs. Redis
errors or calls exceeding 100 ms fall back to local SQLite. Each Redis affinity
store caps outstanding operations at 8, bypasses Redis immediately when full, and
releases slots only when the underlying work settles, not at the caller deadline.
During a Redis outage
there is no shared truth: each instance falls back to its own local affinity,
sessions may re-pin once per instance, and instances may diverge. Stickiness
re-converges through Redis when it recovers. The timeout bounds waiting, not a sent
EVAL, which may land after fallback. Routing writes compare the exact value
observed by the routing decision, not a fresh mutation-time read; an observed miss
or a SQLite fallback observation compares as an absent Redis key. Obsolete pins
are replaced in one CAS, so a late command cannot replace or delete a newer,
different pin. Redis reads atomically return the value and remaining server TTL;
positive PTTL (or no expiry) determines liveness, not the writer's JSON timestamp
or the reader's clock. Local snapshots map that remaining TTL to a local deadline;
existing JSON keys remain readable and their raw bytes are retained for CAS.
Redis is the only source of truth while it answers. Confirmed shared upserts,
touches and deletes remove the local entry, never install or refresh it. SQLite
on the Redis path holds only this instance's own fallback decisions from Redis
errors, timeouts or admission saturation,
TTL-bounded as before. A missing local pin on a later outage costs one fresh pick
(one prompt-cache miss), not a wrong or evicted account. Rejected upserts return
the shared winner and its remaining TTL atomically: ordinary selection rechecks
the mapped local deadline
and uses a still-live eligible winner, touching usage and logging for that account
without another shared write.
If it is unavailable, selection keeps the local candidate, leaves the
shared pin unchanged and emits one debug message. Rejected CAS does not write
SQLite; Redis errors, timeouts or admission saturation apply the existing local
operation instead. If a
sent mutation's reply arrives after timeout (accepted, rejected or error), a
synchronous exact serialized-value compare-and-delete removes only the
byte-identical timeout fallback row. There is no await between that comparison
and deletion; a newer outage write is preserved. Guarded eviction removes the
failed account's own local pin even with Redis down, and cleans it again after
confirmed shared eviction. Pending earlier shared replies cannot restore an
evicted local pin because shared successes never write SQLite. A later outage
fallback can repin an account; a later accepted shared write exists only in Redis.
Redis misses do not consult local fallback state. With the driver off, newly selected pins
retain the legacy four-field SQLite JSON shape; only Redis routing adds the hashed
account identity. Prefetched pins are rechecked at their expiry boundary. Redis
non-lease selection re-reads the store, but synchronous lease planning can still
use a pin evicted between prefetch and planning (an accepted best-effort window).
A lease commit cannot switch accounts after a durable claim: on rejected upsert it
keeps the claimed candidate for that request only and leaves the shared winner
untouched, so agreement across instances is bounded on that path.
The rest of the table still applies:
this does not share combo session stickiness, native Codex turn pins, account
semaphores, lockouts, spend limits, configuration or call logs.

Hardware: per-instance concurrent long `/v1/responses` is a **memory-budget** question (heap + inflight-byte / #10110). `N` independent `DATA_DIR`s still multiply heaps: host RAM must cover `N × cgroup`, not “one 16 Gi pod with N=8.” Never `replicas > 1` on one SQLite file.

Compose sketch (two heaps, two volumes — not `deploy.replicas: 2`):

```yaml
services:
  omniroute-a:
    image: ghcr.io/zyndaai/omniroute:latest
    environment:
      DATA_DIR: /app/data
      OMNIROUTE_MEMORY_MB: "12288"
      QUOTA_STORE_DRIVER: redis
      QUOTA_STORE_REDIS_URL: redis://redis:6379
    volumes: [omniroute-a-data:/app/data]
    ports: ["20128:20128"]
  omniroute-b:
    image: ghcr.io/zyndaai/omniroute:latest
    environment:
      DATA_DIR: /app/data
      OMNIROUTE_MEMORY_MB: "12288"
      QUOTA_STORE_DRIVER: redis
      QUOTA_STORE_REDIS_URL: redis://redis:6379
    volumes: [omniroute-b-data:/app/data]
    ports: ["20138:20128"]
volumes:
  omniroute-a-data:
  omniroute-b-data:
```

In-process density (compression off the HTTP isolate) is [#11023](https://github.com/diegosouzapw/OmniRoute/issues/11023). One logical cluster on shared durable state is [#8075](https://github.com/diegosouzapw/OmniRoute/issues/8075).

## Gemini regional errors inside Docker

Google AI Studio / Gemini API can return HTTP 400 with FAILED_PRECONDITION and
`User location is not supported for the API use.` A successful request on the host
does not prove that the container uses the same outbound route. DNS ordering,
IPv4/IPv6 connectivity, VPN routing and configured proxies can differ. Check
[Google's supported regions](https://ai.google.dev/gemini-api/docs/available-regions)
as well as the actual connection route; this error alone does not identify a bad API key.

### Prefer a connection-specific proxy

Use OmniRoute's [per-connection proxy configuration](../ops/PROXY_GUIDE.md#4-level-proxy-system)
for the affected Gemini connection, then repeat **Test Connection** and a small request
with the same model. This keeps the routing change scoped to that connection. Verify
that the proxy is reachable from the container, and that the connection really selects
it. Changing the route does not guarantee upstream regional eligibility.

### Compare host and container networking

Keep the key, model and request identical when comparing authenticated results; never
paste credentials, proxy passwords or complete authorization headers into an issue.
First inspect which address families the OS resolver offers, using the same command
on the host and inside the container:

```bash
node -e 'require("node:dns").lookup("generativelanguage.googleapis.com", {all: true}, (error, addresses) => { if (error) { console.error(error.code); process.exitCode = 1; return; } console.log(addresses.map(({family}) => family)); })'
docker compose exec omniroute node -e 'require("node:dns").lookup("generativelanguage.googleapis.com", {all: true}, (error, addresses) => { if (error) { console.error(error.code); process.exitCode = 1; return; } console.log(addresses.map(({family}) => family)); })'
```

Replace `omniroute` with the service you run (for example, `omniroute-web`). These
commands print address families without credentials or IP addresses. A returned `6`
only shows an IPv6 DNS result: it does **not** prove a usable IPv6 route or API access.
Where `curl` is installed, compare `curl -4 -I https://generativelanguage.googleapis.com`
with `curl -6 -I https://generativelanguage.googleapis.com` in both environments.
An HTTP response proves connectivity for that probe, even if it is an unauthenticated
error; only the authenticated model request tests Gemini eligibility.

### Host-level alternative: working IPv6 and resolver policy

The reporter of [#12762](https://github.com/diegosouzapw/OmniRoute/issues/12762) restored
access in their environment by enabling container IPv6 and changing glibc address
selection. Treat this as an environment-specific alternative. Confirm working host
IPv6, container egress/routing and firewall rules before adjusting resolver preferences.
A private ULA address by itself does not establish public IPv6 connectivity.

For services already attached to Compose's default network, this fragment enables
IPv6 on that network; retain the rest of your service, ports, volumes and configuration:

```yaml
networks:
  default:
    enable_ipv6: true
```

For a named network, enable it on the network the service actually joins. Docker can
allocate a ULA subnet; select an explicit, non-overlapping subnet only when your network
requires it. See [Docker IPv6 networking](https://docs.docker.com/engine/daemon/ipv6/)
and [Compose network options](https://docs.docker.com/reference/compose-file/networks/#enable_ipv6).

On a **glibc-based image**, `/etc/gai.conf` can change address selection. The current
repository Dockerfile uses Debian; custom musl-based images do not share this mechanism.
The reported adjustment changes the ULA label from `label fc00::/7 6` to
`label fc00::/7 1`. Start from the image's complete policy table and preserve its other
entries: adding a `label` or `precedence` entry replaces that default table, so a file
containing only the changed line is insufficient. The
[glibc configuration reference](https://github.com/bminor/glibc/blob/master/posix/gai.conf)
documents those semantics. Bind-mount the reviewed file read-only at `/etc/gai.conf`
and recreate the service to apply it.

This changes OS address selection for **all outbound traffic in that container**.
It does not force every application to choose IPv6: Node's DNS order and connection
selection also matter. In particular, `--dns-result-order=ipv4first` prefers IPv4 and
is not a remedy for an IPv4-only failure. See [Node DNS ordering](https://nodejs.org/api/dns.html#dnssetdefaultresultorderorder).

Re-test Gemini and your other providers after any host-level change. To roll back,
remove the custom `gai.conf` mount, restore the previous network configuration and
recreate the affected service/network during a maintenance window. Recreating a network
can interrupt other containers attached to it; do not delete the persistent data volume.

## Important Notes

- **SQLite WAL Mode:** `docker stop` should be allowed to finish so OmniRoute can checkpoint the latest changes back into `storage.sqlite`. The bundled Compose files already set a 40s stop grace period. If you run the image directly, keep `--stop-timeout 40`.
- **`DISABLE_SQLITE_AUTO_BACKUP`:** Set to `true` if routine/pre-write backups are managed externally. Existing-database migrations still require their own durable safety snapshot and mass-migration guard.
- **Data Persistence:** Always mount a volume to `/app/data` to persist your database, keys, and configurations across container restarts.
- **Port Configuration:** Override `PORT` environment variable to change the default `20128` port.

## See Also

- [VM Deployment Guide](../ops/VM_DEPLOYMENT_GUIDE.md) — VM + nginx + Cloudflare setup
- [Environment Config](../reference/ENVIRONMENT.md) — Complete `.env` reference
