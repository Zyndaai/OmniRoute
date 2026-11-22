#!/bin/bash
# Production dry run of the SQLite -> PostgreSQL transfer (src/lib/db/backends/transfer/).
# Run as root on the VPS while the SQLite build is still serving; the app is never started on the
# copy, so no OAuth token can be refreshed from it. Production data never leaves the server: the
# snapshot and the throwaway PostgreSQL are deleted at the end, only the receipt stays
# (/root/omniroute-transfer/data/receipt.json). Exit code: the transfer's own (0 verified,
# 3 verified with items to review, 1 mismatches or failure).
#
# Prepare /tmp/omni-xfer/ first (from a checkout):
#   npx esbuild src/lib/db/backends/transfer/cli.ts --bundle --platform=node \
#     --packages=external --format=esm --outfile=<dir>/cli.js
#   printf '{"type":"module","private":true}\n' > <dir>/package.json
#   cp src/lib/db/backends/postgres/migrations/*.sql <dir>/migrations/
#   scp -r <dir>/* <server>:/tmp/omni-xfer/
# Once an image built from this tree runs on the server, use its own
# /app/src/lib/db/backends/transfer/cli.js instead (no bundle, no OMNIROUTE_PG_MIGRATIONS_DIR).
#
# First run: 2026-11-22, 82.5 MB, 25 s, every table verified (receipt kept locally as the
# baseline for the cut-over: anything new in its skips, adjustments or drops means stop).
set -euo pipefail
W=/root/omniroute-transfer
PROD_IMAGE=$(docker inspect omniroute --format '{{.Config.Image}}')
NET=omni-xfer-net
PG=omni-xfer-pg

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f "$W/data/source.sqlite" "$W/key.env"
}
trap cleanup EXIT

rm -rf "$W" && mkdir -p "$W/tool" "$W/data"
# The production image runs as `node` (uid 1000): it writes the receipt into data/.
chown 1000:1000 "$W/data" && chmod 700 "$W/data"
chmod 711 "$W"
cp -r /tmp/omni-xfer/. "$W/tool/"

echo "[1/5] tool dependency pg (pure JS; the SQLite-era image has better-sqlite3 but not pg)"
docker run --rm -v "$W/tool:/tool" -w /tool node:26.12.1-trixie-slim \
  npm install --no-audit --no-fund --no-save pg@8.23.1 >/dev/null 2>&1
test -d "$W/tool/node_modules/pg"

echo "[2/5] snapshot of the live database (SQLite backup API, safe while the app runs)"
docker exec -w /app omniroute node -e '
const D = require("better-sqlite3");
const db = new D("/app/data/storage.sqlite", { readonly: true });
db.backup("/tmp/xfer-snapshot.sqlite").then(() => { db.close(); });'
docker cp omniroute:/tmp/xfer-snapshot.sqlite "$W/data/source.sqlite" >/dev/null
docker exec omniroute rm -f /tmp/xfer-snapshot.sqlite
ls -la "$W/data/source.sqlite" | awk '{print "      snapshot bytes:", $5}'

echo "[3/5] throwaway PostgreSQL 18 on an internal network (no route out)"
docker network create --internal "$NET" >/dev/null
PGPASS=$(head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9)
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD="$PGPASS" postgres:18-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
docker exec "$PG" psql -U postgres -qc \
  "CREATE DATABASE omniroute TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'"

echo "[4/5] transfer (production image's node + better-sqlite3, tool mounted under /app)"
# The storage key decrypts credentials for the receipt's checks; it is never printed.
grep -E '^STORAGE_ENCRYPTION_KEY=' /opt/omniroute/.env > "$W/key.env" || true
chmod 600 "$W/key.env"
set +e
docker run --rm --network "$NET" --entrypoint node \
  --env-file "$W/key.env" \
  -e OMNIROUTE_TRANSFER_TARGET_URL="postgres://postgres:${PGPASS}@${PG}:5432/omniroute" \
  -e OMNIROUTE_PG_MIGRATIONS_DIR=/app/xfer-tool/migrations \
  -v "$W/tool:/app/xfer-tool" -v "$W/data:/xfer" -w /xfer \
  "$PROD_IMAGE" /app/xfer-tool/cli.js --source /xfer/source.sqlite --receipt /xfer/receipt.json
STATUS=$?
set -e

echo "[5/5] cleanup (snapshot, key file, PostgreSQL, network); receipt kept"
echo "TRANSFER EXIT $STATUS"
exit "$STATUS"
