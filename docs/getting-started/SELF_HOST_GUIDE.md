---
title: "🚀 Self-Host Guide — OmniRoute (零月费自托管 / zero-fee self-host)"
version: 3.8.52
lastUpdated: 2026-10-05
---

# 🚀 Self-Host Guide — OmniRoute

> **TL;DR** — three commands, one local endpoint, zero monthly fees. No SaaS
> billing, no multi-tenant isolation, no hosted prompt-processing hop. Your
> prompts go straight to the provider you pick.

> **Files:** the two files this flow uses (`docker-compose.selfhost.yml` and
> `.env.selfhost.example`) are at the root of this repository. Take them from
> your checkout of `Zyndaai/OmniRoute`; the upstream copies of the same names
> do not include PostgreSQL or this team's image.

```bash
mkdir omniroute && cd omniroute
cp /path/to/OmniRoute/docker-compose.selfhost.yml /path/to/OmniRoute/.env.selfhost.example .
cp .env.selfhost.example .env      # set POSTGRES_PASSWORD, then the lines marked "EDIT ME"
docker login ghcr.io               # the team image is private (token with read:packages)
docker compose -f docker-compose.selfhost.yml up -d
open http://127.0.0.1:20128
```

This is the **self-host carrier** for OmniRoute's "零月费 + 自托管" product
form: a packaged container/binary you run on your own machine in 5 minutes.

---

## Why this guide exists

`docker-compose.selfhost.yml` is the one-command path: **the published
`ghcr.io/zyndaai/omniroute` image, loopback-only, PostgreSQL and Redis
included, no build step.** A single-VPS production deployment uses `docker-compose.vps.yml` instead; see
the [DOCKER_GUIDE](../guides/DOCKER_GUIDE.md).

---

## Prerequisites

- Docker Engine 24+ (or Docker Desktop 4.30+) with the Compose v2 plugin.
- ~2 GB RAM free (see [Sizing](#sizing-the-container)).
- A provider API key from any supported provider (OpenAI, Anthropic, Google,
  or one of the [150+ free tiers](./FREE-TIERS-GUIDE.md)).

No build toolchain and no Node required: you copy two files (the compose file
and the env template, Step 1) and the images are pulled.

---

## Step 1 — Configure (1 min)

Copy the two self-host files from your checkout of this repository into an
empty directory, and create your `.env` from the template:

```bash
mkdir omniroute && cd omniroute
cp /path/to/OmniRoute/docker-compose.selfhost.yml /path/to/OmniRoute/.env.selfhost.example .
cp .env.selfhost.example .env
```

The compose file reads **`./.env` next to `docker-compose.selfhost.yml`**
(`env_file: .env`). It does **not** read `~/.omniroute/.env`: that file belongs
to the npm CLI install (`omniroute` command, see
[Local binary build](#local-binary-build-optional)) and has no effect on the
Docker flow.

Set the database password, then the two security lines, in `.env`:

```dotenv
POSTGRES_PASSWORD=<output of: openssl rand -hex 24>   # required; letters and digits only
REQUIRE_API_KEY=true          # was false — lock the endpoint down
APP_BIND_HOST=127.0.0.1       # keep loopback; see "Exposing" only if needed
```

`POSTGRES_PASSWORD` is required (compose refuses to start without it) and is used
when the database is first created, so set it before the first `up`. It goes into
a connection URL, which is why it should be letters and digits only.

`REQUIRE_API_KEY=true` makes `/v1` requests require an API key (a logged-in
dashboard session also works), and the
dashboard require login once a password exists. On first visit you create the
login password in the dashboard's onboarding wizard; skipping that step turns
dashboard login off, even with `REQUIRE_API_KEY=true`. Docker
port-forwarding makes your browser look non-local to the container, so after you
submit the password the wizard asks for a one-time bootstrap token, which the
container prints to its log at that moment:

```bash
docker logs omniroute | grep BOOTSTRAP
```

The other variables (`DASHBOARD_PORT`, `API_PORT`, `LIVE_WS_PORT`,
`OMNIROUTE_MEMORY_MB`) already have sane defaults. Leave them unless you know
you need to change them.

---

## Step 2 — Start (1 min)

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

Pulls the team image `ghcr.io/zyndaai/omniroute:latest` (built by
`.github/workflows/docker-build-push.yml`; private, so `docker login ghcr.io` first) and
`postgres:18-alpine` and `redis:8.6.5-alpine`, starts all three, and waits for
PostgreSQL and Redis to be healthy before the app boots. The app creates its
tables in PostgreSQL on first start.

### Step 3 — Verify (30 s)

```bash
# process lifecycle + readiness
curl -fsS http://127.0.0.1:20128/healthz && echo

# container health
docker inspect --format '{{.State.Health.Status}}' omniroute
```

You should see `{"status":"ok"}` and `healthy`. Then open the dashboard:

```
http://127.0.0.1:20128
```

Within ~300 s of `up -d` the endpoint is locally reachable and the healthcheck
is `healthy` — the acceptance bar from the self-host issue.

---

## Ports

| Port    | What                                        | Default bind |
| ------- | ------------------------------------------- | ------------ |
| `20128` | Dashboard + `/v1` LLM proxy (unified entry) | `127.0.0.1`  |
| `20129` | API port (server-to-server)                 | `127.0.0.1`  |
| `20132` | Live WebSocket (realtime dashboard updates) | `127.0.0.1`  |

All three bind to **loopback only** by default. PostgreSQL and Redis are **not**
published to the host at all — the app reaches them over the compose network.
This is deliberate: shipping a database or an unauthenticated Redis on `0.0.0.0`
is a footgun.

---

## Connecting a provider

1. Open the dashboard → **Providers**.
2. Add a provider and paste its API key. Keys are encrypted at rest with
   AES-256-GCM; the cleartext never leaves your machine.
3. Point your IDE / agent at the unified entry:

```
http://127.0.0.1:20128/v1
```

For provider choice, see the
[Free Tiers Guide](./FREE-TIERS-GUIDE.md) — OmniRoute aggregates 150+ free
tiers into one endpoint, so you can run `model: "auto"` to pick the best free
option per request.

---

## Sizing the container

The image pins `OMNIROUTE_MEMORY_MB=1024`. That is enough for the dashboard
and light chat. **Coding agents** (`POST /v1/responses` from Claude Code,
Codex, Grok, …) retain multiple large context graphs during compression and
can abort V8 at ~12 GiB old-space under two overlapping long contexts
([#7849](https://github.com/diegosouzapw/OmniRoute/issues/7849)).

`.env.selfhost.example` defaults to `OMNIROUTE_MEMORY_MB=2048` — a safe floor
for a single user running coding agents. Raise it if you fan out many models
in parallel (fusion combos) or hit `FATAL ERROR: Reached heap limit`:

```dotenv
OMNIROUTE_MEMORY_MB=4096
```

Memory is a V8 heap ceiling; native buffers (SQLite, better-sqlite3)
sit outside it, so size the container a few hundred MB above the heap.

---

## Local binary build (optional)

Prefer a binary over Docker? The npm package is the same code:

```bash
npm install -g omniroute
omniroute
```

This runs the OmniRoute server (the built bundle, started by `scripts/dev/run-server.mjs`) directly on your host, on the same
ports. It keeps its data and its `.env` in `~/.omniroute` by default
(when `~/.omniroute` does not exist: `%APPDATA%\omniroute` on Windows, or
`$XDG_CONFIG_HOME/omniroute` when that variable is set; `$DATA_DIR` overrides
all of these), not in the `./data` directory the Docker flow mounts.
Use it when you cannot run Docker
(e.g. a locked-down VM). The container path above is the recommended default
because it bundles the exact runtime the image was tested with.

From source (development only — not a deploy path):

```bash
git clone https://github.com/diegosouzapw/OmniRoute.git
cd OmniRoute
npm install
npm run build && npm start
```

---

## Exposing beyond localhost

**Do not** flip `APP_BIND_HOST=0.0.0.0` while `REQUIRE_API_KEY=false`. That
publishes an open `/v1` proxy on every LAN/WAN interface — anyone on the
network can burn your provider quotas. The order is fixed:

1. Set `REQUIRE_API_KEY=true` in `.env`.
2. Create the login password in the onboarding wizard (see above) and log in.
3. _Only then_ set `APP_BIND_HOST=0.0.0.0` (or put an auth-enforcing reverse
   proxy in front and keep loopback).

For TLS / a domain, run Caddy or Traefik in front and leave `APP_BIND_HOST`
at `127.0.0.1`. See the
[DOCKER_GUIDE — Caddy HTTPS](../guides/DOCKER_GUIDE.md#docker-compose-with-caddy-https-auto-tls)
and
[Cloudflare Quick Tunnel](../guides/DOCKER_GUIDE.md#cloudflare-quick-tunnel)
sections for copy-paste reverse-proxy configs.

---

## Data, backups, and resets

- **Data**: settings, provider connections, keys and logs live in the bundled
  PostgreSQL container, in the `postgres-data` Docker volume. `./data`
  (bind-mounted to `/app/data`) keeps local files such as the generated
  `server.env`; back up both.
- **Backups**: dump the database while it runs, and restore into a fresh volume:
  ```bash
  docker exec omniroute-postgres pg_dump -U omniroute omniroute > omniroute.sql
  docker exec -i omniroute-postgres psql -U omniroute omniroute < omniroute.sql
  ```
  The SQLite snapshot scripts (`bin/snapshot-data.sh`, `bin/restore-data.sh`,
  `bin/restore-policies.sh`) were removed with the move to PostgreSQL.
- **Upgrading an install from before PostgreSQL**: older installs kept their data in
  `./data/storage.sqlite`. This version does not read that file, and no transfer tool
  ships with it, so the new database starts empty (the file is left untouched).
- **Reset the dashboard password**:
  ```bash
  docker exec -it omniroute node bin/reset-password.mjs
  ```

---

## Common issues

<details>
<summary><code>cp: cannot stat '.env.selfhost.example': No such file or directory</code></summary>

The self-host files are not in your current directory. Copy them from your
checkout of this repository first (see [Step 1](#step-1--configure-1-min)).
</details>

<details>
<summary><code>required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD in .env</code></summary>

`docker compose` stops before starting anything because `.env` has no
`POSTGRES_PASSWORD`. Set it (letters and digits, for example
`openssl rand -hex 24`) and run `up -d` again.
</details>

<details>
<summary>Edited <code>~/.omniroute/.env</code> and nothing changed</summary>

That file is read by the npm CLI install only. The Docker flow reads the
`.env` next to `docker-compose.selfhost.yml`. Edit that one and re-run
`docker compose -f docker-compose.selfhost.yml up -d`.
</details>

<details>
<summary>Healthcheck stays <code>starting</code> / <code>unhealthy</code></summary>

- Check PostgreSQL and Redis are up:
  `docker inspect --format '{{.State.Health.Status}}' omniroute-postgres omniroute-redis`
- `password authentication failed` in `docker logs omniroute`: `POSTGRES_PASSWORD`
  changed after the database was created. Put the original value back, or change the
  password inside PostgreSQL (`ALTER USER omniroute PASSWORD '...'`) to match.
- Check app logs: `docker logs omniroute`
- The healthcheck probes `/healthz` and allows a 20 s start period. A slow
  first boot (cold migrations) can take longer — bump `start_period` in the
  compose file if your disk is slow.

</details>

<details>
<summary><code>FATAL ERROR: Reached heap limit</code> under coding agents</summary>

Raise `OMNIROUTE_MEMORY_MB` in `.env` (e.g. `4096`), then
`docker compose -f docker-compose.selfhost.yml up -d`. See
[Sizing the container](#sizing-the-container).
</details>

<details>
<summary><code>EACCES: permission denied</code> writing to <code>/app/data</code></summary>

`docker-compose.selfhost.yml` bind-mounts `./data:/app/data` by default, so
the container inherits the host directory's ownership. Some managed-deploy
platforms run the Docker daemon as root while the container process runs as
an unprivileged user, which can cause `EACCES` on the first write.

Two ways to fix it, without changing the documented default:

- **`chown` the host dir** to the container's user so the bind mount is
  writable. The image runs as the `node` user (UID/GID 1000):
  `sudo chown -R 1000:1000 ./data`.
- **Opt into a Docker-managed named volume** instead of the bind mount: in
  `docker-compose.selfhost.yml`, comment out the `- ./data:/app/data` line
  and uncomment the `- omniroute-data:/app/data` alternative right below it,
  plus the `omniroute-data:` entry under the top-level `volumes:`. Note that
  this changes where your data lives:
  - a new named volume starts **empty** — on an existing install, copy
    `./data` into it first, or OmniRoute will boot as a fresh instance;
  - a host-side backup of `./data` will not see a named volume's contents;
    back the volume up separately, for example:

    ```bash
    docker run --rm -v omniroute-data:/data -v "$PWD":/backup alpine \
      tar czf /backup/omniroute-data.tar.gz -C /data .
    ```

</details>

<details>
<summary>Web-cookie providers (Gemini Web, Claude Turnstile) fail with
<code>Executable doesn't exist at .../ms-playwright/chromium</code></summary>

The image is built from the `runner-base` stage and ships without Chromium.
This copy dropped upstream's browser image (`runner-web`), so web-cookie
providers are not supported on this image. See
[DOCKER_GUIDE — The image](../guides/DOCKER_GUIDE.md#the-image).
</details>

<details>
<summary>Port 20128 already in use</summary>

Set `DASHBOARD_PORT`, `API_PORT`, `LIVE_WS_PORT` in `.env` to free ports and
re-run `up -d`.
</details>

---

## What this deliberately is NOT

Per the self-host KISS constraint, this path **does not** include:

- ❌ SaaS billing / metering / plan tiers
- ❌ Multi-tenant isolation / per-tenant namespaces
- ❌ A hosted prompt-processing hop (your prompts go straight to the provider)
- ❌ Any baked-in credentials or secrets

It is a **pure local self-host** carrier — the simplest thing that makes the
"零月费 + 自托管" promise real.

---

## Security checklist (self-host)

Before you expose beyond loopback:

- [ ] `REQUIRE_API_KEY=true` in `.env`
- [ ] Dashboard login password set in the onboarding wizard to a strong, unique value
- [ ] `APP_BIND_HOST` left at `127.0.0.1` _unless_ behind an auth-enforcing proxy
- [ ] TLS terminated by Caddy/Traefik/Cloudflare in front (never plain HTTP on WAN)
- [ ] PostgreSQL and Redis not published to the host (the self-host compose already enforces this)
- [ ] `POSTGRES_PASSWORD` set to a random value (`openssl rand -hex 24`)
- [ ] PostgreSQL database backed up regularly (`pg_dump`)
- [ ] Provider keys rotated per the provider's own policy

For the security policy, see [SECURITY.md](../../SECURITY.md).

---

## Related

- [Docker Guide](../guides/DOCKER_GUIDE.md) — profiles, Caddy HTTPS, tunnels, image tags
- [Quick Start](./QUICK-START.md) — 3-minute path for first-time users
- [Free Tiers Guide](./FREE-TIERS-GUIDE.md) — 150+ free provider tiers
- [Providers Guide](./PROVIDERS-GUIDE.md) — connecting and configuring providers
- [Troubleshooting](../guides/TROUBLESHOOTING.md) — deeper issue resolution
