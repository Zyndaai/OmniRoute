# PostgreSQL cut-over (omniport.ink)

Moves production from the single SQLite container to the cluster: PostgreSQL, Redis and one
OmniRoute container running a leader and 2 workers under PM2 (`docker-compose.cluster.yml`).
The VPS expert session runs it, from `/opt/omniroute`, with the owner's approval.

Priorities (owner): the provider accounts must carry over so nobody logs in again; downtime does
not matter. The rules that protect the logins:

- **Same secrets.** `STORAGE_ENCRYPTION_KEY`, `API_KEY_SECRET` and `JWT_SECRET` in `.env` stay
  exactly as they are. A new storage key makes every credential unreadable; a new API key secret
  changes the Claude identity values.
- **Stop production before the transfer.** Subscription logins rotate their refresh token on
  every refresh. A copy taken while the old app still runs goes stale the moment it refreshes.
- **One owner per token.** After the switch the old container never starts again with its data.
  The rehearsal copy runs with no route to the internet and every connection switched off.

`IMAGE` below is `ghcr.io/zyndaai/omniroute:<sha>`, the image built from the commit being
deployed. Autodeploy is paused (`/opt/omniroute/AUTODEPLOY_PAUSED`) and stays paused after the
cut-over: its script still deploys the SQLite compose file.

## A. Rehearsal on a copy (about an hour, production keeps running)

Proves the image boots as a cluster on production's data, and produces the transfer baseline.
Run as root in a shell where nothing is printed from `.env`.

```bash
cd /opt/omniroute
export OMNIROUTE_TAG=<sha>                        # the new image
export POSTGRES_PASSWORD=$(openssl rand -hex 24)  # rehearsal only, thrown away
R="docker compose -p omniroute-rehearsal -f docker-compose.cluster.yml -f docker-compose.server-rehearsal.yml"
# docker-compose.cluster.yml and docker-compose.server-rehearsal.yml copied from the repo first.

$R pull omniroute
$R up -d postgres redis                           # creates the rehearsal network and volumes

# 1. A copy of the live database (SQLite backup API: safe while the app runs).
docker exec -w /app omniroute node -e '
const D = require("better-sqlite3");
const db = new D("/app/data/storage.sqlite", { readonly: true });
db.backup("/tmp/rehearsal.sqlite").then(() => db.close());'
docker cp omniroute:/tmp/rehearsal.sqlite /root/rehearsal.sqlite && docker exec omniroute rm -f /tmp/rehearsal.sqlite
docker run --rm -v omniroute-rehearsal_rehearsal-data:/data -v /root/rehearsal.sqlite:/src.sqlite:ro \
  alpine sh -c 'cp /src.sqlite /data/storage.sqlite && chown -R 1000:1000 /data'
rm -f /root/rehearsal.sqlite

# 2. The transfer, with the image's own tool (this is the cut-over baseline).
$R run --rm --no-deps --entrypoint sh omniroute -c \
  'OMNIROUTE_TRANSFER_TARGET_URL="$OMNIROUTE_POSTGRES_URL" exec node src/lib/db/backends/transfer/cli.js --source /app/data/storage.sqlite --receipt /app/data/transfer-receipt.json'
echo "exit $?"     # 0 = verified; 3 = verified with review items (keep them for B6); 1 = stop
docker run --rm -v omniroute-rehearsal_rehearsal-data:/data alpine cat /data/transfer-receipt.json \
  > /root/omniroute-migration/cutover-baseline-receipt.json && chmod 600 /root/omniroute-migration/cutover-baseline-receipt.json

# 3. Switch every connection off in the copy, then start the cluster.
docker exec omniroute-rehearsal-postgres psql -U omniroute -d omniroute -qc \
  "UPDATE provider_connections SET is_active = false, updated_at = now()"
$R up -d omniroute
```

Checks (all must pass):

```bash
docker exec omniroute-rehearsal pm2 ls                    # leader, worker-0, worker-1 online
docker logs omniroute-rehearsal 2>&1 | grep '\[CLUSTER\]' # role=leader ... (leader fence held),
                                                          # two role=worker ... (bus subscribed)
docker exec omniroute-rehearsal node -e '
for (const p of [20128, 20200, 20201])
  for (const path of ["/healthz", "/login"])
    fetch(`http://127.0.0.1:${p}${path}`).then((r) => console.log(p, path, r.status));'
# A crashed worker comes back:
docker exec omniroute-rehearsal sh -c 'kill -9 $(pm2 pid worker-0)'; sleep 5; docker exec omniroute-rehearsal pm2 ls
```

Then remove everything the rehearsal made, keep only the baseline receipt:

```bash
$R down -v
```

Send the main OmniRoute session the transfer summary (exit code, the `review` list) and the
check results.

## B. Cut-over (owner's go)

```bash
cd /opt/omniroute
OLD_IMAGE=$(docker inspect omniroute --format '{{.Config.Image}}')
mkdir -p /root/omniroute-migration/pre-cutover
cp docker-compose.yml .env /root/omniroute-migration/pre-cutover/
docker tag "$OLD_IMAGE" omniroute-rollback:sqlite
```

1. **Stop the old app** (from here on, nothing may start it with the live volume except the
   rollback below): `docker compose stop omniroute`
2. **Check the WAL.** `docker run --rm -v omniroute-data:/d alpine ls -la /d/` — if
   `storage.sqlite-wal` exists and is not empty, fold it into the database file (the transfer
   refuses a non-empty WAL):
   ```bash
   docker run --rm -w /app -v omniroute-data:/app/data --entrypoint node omniroute-rollback:sqlite -e '
   const D = require("better-sqlite3"); const d = new D("/app/data/storage.sqlite");
   d.pragma("wal_checkpoint(TRUNCATE)"); d.close();'
   ```
3. **Back up the volume** (container stopped): `docker run --rm -v omniroute-data:/d -v
   /root/omniroute-migration/pre-cutover:/b alpine tar czf /b/omniroute-data.tgz -C /d .`
4. **New compose and env.** Copy `docker-compose.cluster.yml` over `docker-compose.yml`. In
   `.env`: set `OMNIROUTE_TAG=<sha>`, add `POSTGRES_PASSWORD=<openssl rand -hex 24>` and
   `OMNIROUTE_WORKERS=2`. Change nothing else. `docker compose pull`
5. **Database up:** `docker compose up -d postgres redis` (waits for both health checks).
6. **Transfer:**
   ```bash
   docker compose run --rm --no-deps --entrypoint sh omniroute -c \
     'OMNIROUTE_TRANSFER_TARGET_URL="$OMNIROUTE_POSTGRES_URL" exec node src/lib/db/backends/transfer/cli.js --source /app/data/storage.sqlite --receipt /app/data/transfer-receipt.json'
   ```
   Go on only with exit 0, or exit 3 whose `review` list holds nothing that the baseline
   (`cutover-baseline-receipt.json`) does not. Anything new: stop and roll back.
7. **Start the cluster:** `docker compose up -d omniroute`, then the checks from part A
   (`pm2 ls`, the `[CLUSTER]` lines, `/healthz` on 20128/20200/20201).
8. **Smoke test, through https://omniport.ink** (the host Caddy still sends everything to 20128,
   which is now the leader):
   - the owner logs in; the providers page lists every account, none "credential unreadable";
   - one `/v1/chat/completions` with Zynda's existing production key, once streaming and once not;
   - the request appears in the dashboard's request log;
   - a local-only route from outside is refused (`curl -s -o /dev/null -w '%{http_code}'
     https://omniport.ink/api/mcp/stream` must not be 200).

   **Go/no-go within the first minutes.** Rolling back loses nothing while the new stack has not
   refreshed a token; later, refresh tokens may have rotated in PostgreSQL only, and going back
   to SQLite could cost those logins.
9. **Caddy** (the VPS expert's host Caddyfile): management plane (`/dashboard*`, `/home*`,
   `/api/*` except `/api/v1/*`, `/live-ws*`) to `127.0.0.1:20128` only; inference (`/v1/*`,
   `/api/v1/*`) to 20128, 20200 and 20201 with `lb_policy header X-Session-Affinity { fallback
   ip_hash }`, `health_uri /healthz`, `flush_interval -1`. Keep reverse_proxy's default
   X-Forwarded-For (without it LOCAL_ONLY routes open to the internet). Reference:
   `scripts/docker/rehearsal/Caddyfile`.
10. **First PostgreSQL backup:** `docker compose exec -T postgres pg_dump -U omniroute -Fc
    omniroute > /root/omniroute-migration/post-cutover.dump`
11. Autodeploy stays paused until its script is rewritten for PostgreSQL (`pg_dump` /
    `pg_restore`, leader first).

### Rollback

```bash
cd /opt/omniroute
docker compose down                                   # keeps the volumes
cp /root/omniroute-migration/pre-cutover/docker-compose.yml /root/omniroute-migration/pre-cutover/.env .
docker compose up -d                                  # the old image on the untouched SQLite file
```

The transfer only reads `storage.sqlite`, so the SQLite data is as it was at step 1. The
PostgreSQL volume (`omniroute_omniroute-pg`) stays for a later retry; `docker volume rm` it to
start the next transfer from an empty database.
