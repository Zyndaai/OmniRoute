# ── Common base with runtime deps ──────────────────────────────────────────
# Pinned to a patch release (Dependabot bumps it) instead of the floating `26-trixie-slim`
# tag: the floating tag let v3.8.52 ship with node 26.12.0, whose bundled root store still
# trusts the compromised eMudhra intermediates (https://emudhra.we-have-a-problem.com/).
# 26.12.1 is the first 26.x that rejects them; tests/unit/build/docker-ca-baseline.test.mjs
# keeps it from going below that.
FROM node:26.12.1-trixie-slim AS base
WORKDIR /app

# Mirrors for builders whose network cannot reach the default sources
# (deb.debian.org / registry.npmjs.org / nodejs.org). Defaults keep upstream
# behavior byte-identical; override at build time, e.g.:
#   podman build \
#     --build-arg APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     --build-arg NODE_DIST_URL=https://npmmirror.com/mirrors/node ...
# APT_MIRROR replaces the whole scheme-plus-host. The default matches the base
# image, whose single /etc/apt/sources.list.d/debian.sources lists both
# /debian and /debian-security under http://deb.debian.org, so the default
# substitution changes nothing. A mirror must serve both paths and include its
# own scheme (e.g. http://mirrors.example.cn).
# NODE_DIST_URL, when set, is exported as NODEJS_ORG_MIRROR only for the
# node-gyp rebuild in the builder stage (lib/process-release.js). Left empty,
# the variable is never set and node-gyp uses nodejs.org. The npm config write
# persists in ~/.npmrc for every stage derived from base.
ARG APT_MIRROR=http://deb.debian.org
ARG NPM_REGISTRY=
ARG NODE_DIST_URL=

# `apt-get upgrade` pulls the security-patched versions of the Debian (trixie)
# base-image packages at build time — clears the subset of container-scan CVEs
# (perl / util-linux / systemd / ncurses / zlib / tar / sqlite / shadow / pam …)
# that already have a fix published in trixie. CVEs without an upstream fix yet
# (local-only TOCTOU, etc.) remain until the distro patches them and the image
# is rebuilt; none are reachable from the proxy's request surface at runtime.
RUN --mount=type=cache,id=omniroute-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=omniroute-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  sed -i -E "s|https?://deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# npm's *bundled* node_modules (brace-expansion, ip-address, tar, undici) are
# npm's own internals — not application dependencies (the app resolves its own,
# already-fixed copies) — but the container scanner reads them off
# /usr/local/lib/node_modules/npm/node_modules and reports 9 HIGH/MEDIUM CVEs.
#
# Refreshing npm does NOT fix them. Measured on npm@12.0.2 (2026-08-12, latest):
#   brace-expansion 5.0.7  (needs >= 5.0.9)   CVE-2026-69152, CVE-2026-14257
#   ip-address      10.2.0 (needs >= 10.5.1)  CVE-2026-69192/-69198/-54272 + the
#                   isLinkLocal / NAT64 local-use SSRF advisories fixed in 10.5.1
#   tar             7.5.19 (needs >= 7.5.21)  GHSA-r292-9mhp-454m
#   undici          6.27.0 (needs >= 6.29.1)  GHSA-2m5v-pch6-74hx and October 2026 fixes
# No published npm release carries patched copies, so `npm install -g npm@latest`
# alone was pure build time for zero CVEs — it is kept only to land on a known,
# current npm tree, and the patched copies are overlaid on top below.
#
# Deleting npm from the runner stages is NOT an option: the application shells
# out to npm at runtime (src/lib/services/installers/utils.ts::runNpm for the
# embedded services). The previous version of this comment claimed the opposite;
# it was wrong.
#
# The overlay is semver-compatible with the ranges npm's own tree declares
# (minimatch → brace-expansion ^5.0.5, socks → ip-address ^10.1.1, node-gyp →
# tar ^7.5.4 and undici ^6.25.0 — hence undici stays on the 6.x line, NOT 8.x).
# --install-strategy=nested makes each replacement self-contained, so it cannot
# perturb the versions the rest of npm's flat tree resolves.
RUN set -eux; \
  npm install -g npm@latest; \
  npm install --prefix /tmp/npm-cve-patch --no-audit --no-fund --ignore-scripts \
    --install-strategy=nested \
    brace-expansion@5.0.12 ip-address@10.7.4 postcss-selector-parser@7.1.6 tar@7.5.22 undici@6.29.1; \
  for pkg in brace-expansion ip-address postcss-selector-parser tar undici; do \
    test -d "/usr/local/lib/node_modules/npm/node_modules/$pkg"; \
    rm -rf "/usr/local/lib/node_modules/npm/node_modules/$pkg"; \
    cp -R "/tmp/npm-cve-patch/node_modules/$pkg" \
      "/usr/local/lib/node_modules/npm/node_modules/$pkg"; \
  done; \
  rm -rf /tmp/npm-cve-patch; \
  node -e "for (const p of ['brace-expansion','ip-address','postcss-selector-parser','tar','undici']) console.log(p, require('/usr/local/lib/node_modules/npm/node_modules/'+p+'/package.json').version);"; \
  npm --version; \
  npm cache clean --force

# ── Builder ────────────────────────────────────────────────────────────────
FROM base AS builder
ARG NODE_DIST_URL=

# Build tools for native module compilation
# apt-get update needed here because base's rm -rf clears the shared cache
RUN --mount=type=cache,id=omniroute-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=omniroute-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Workspace package manifests MUST be present before `npm ci` so npm materializes
# the workspace and installs its *workspace-only* deps (e.g. safe-regex,
# @toon-format/toon — declared in open-sse/package.json, not hoisted to root).
# Without this, `npm ci` skips them and the application build fails with "Module not
# found" (root cause of the v3.8.39 Docker build break). workspaces = ["open-sse"].
COPY open-sse/package.json ./open-sse/package.json
COPY scripts/build/postinstall.mjs ./scripts/build/postinstall.mjs
COPY scripts/build/postinstallSupport.mjs ./scripts/build/postinstallSupport.mjs
COPY scripts/build/native-binary-compat.mjs ./scripts/build/native-binary-compat.mjs
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true
# --ignore-scripts blocks broad dependency install/postinstall hooks, closing
# the supply-chain attack surface where a transitive dep can run arbitrary code
# at install time. better-sqlite3 still needs a native binding for the target
# platform, so rebuild and smoke-test only that known runtime dependency below.
#
# We REQUIRE a committed package-lock.json so resolved dependency versions
# are reproducible.
RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds" >&2 && exit 1)
# `npm rebuild <pkg>` re-runs the package's own install script, so under npm 11 +
# `--ignore-scripts` on the parent `npm ci` it depends on npm's script-allowlist
# machinery correctly re-enabling that one package's script. Some self-hosted build
# environments (e.g. Dokploy) hit a broken/incomplete better-sqlite3 native binding
# from that indirection. Invoking `node-gyp rebuild` directly inside the package
# directory bypasses npm's script-running layer entirely and is deterministic
# regardless of npm version or ignore-scripts allowlist behavior.
# node-gyp comes from npm's own bundled copy (deterministic, already in the image)
# instead of `npx --yes`, which would install an arbitrary registry version
# on-demand and run its lifecycle scripts (Sonar docker:S6505).
RUN --mount=type=cache,id=omniroute-npm-cache,target=/root/.npm \
  npm ci --include=optional --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
  && (cd node_modules/better-sqlite3 \
      && if [ -n "${NODE_DIST_URL}" ]; then export NODEJS_ORG_MIRROR="${NODE_DIST_URL}"; fi \
      && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --force_build=1) \
  && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  && node -e "require('better-sqlite3')(':memory:').close()" \
  && node -e "const wreq=require('wreq-js'); if(typeof wreq.createTransport!=='function') process.exit(1)"

# The base path (reverse-proxy subpath) is fixed at build time: it becomes the router's
# `basename` and the asset URL prefix. An image serves only the subpath it was built for;
# the entrypoint warns when the container is started with a different one.
ARG OMNIROUTE_BASE_PATH=""
ENV OMNIROUTE_BASE_PATH=$OMNIROUTE_BASE_PATH

# #10273: the dashboard's `frame-ancestors` policy is inlined into the server bundle at
# build time (vite.config.ts, src/server/http/securityHeaders.ts), so it cannot be
# flipped with `-e` on a running container. Build with `--build-arg DASHBOARD_ALLOW_EMBED=vscode` to produce an
# image whose HTML pages may be framed by the VS Code Simple Browser
# (OmniCopilot's `dashboardOpen: "editor"`). Unset — the default — keeps every
# route on `frame-ancestors 'none'` + X-Frame-Options: DENY. Builder-stage only:
# the runner stage deliberately does not carry it, because a runtime value would
# suggest an effect it cannot have.
ARG DASHBOARD_ALLOW_EMBED=""
ENV DASHBOARD_ALLOW_EMBED=$DASHBOARD_ALLOW_EMBED

# Docker containers cannot run the MITM/Agent-Bridge stack (no host DNS/cert
# access), so keep @/mitm/manager on the graceful stub (#3390). This flag is
# Docker-only: npm/Electron/VPS builds must bundle the REAL manager (#6344).
ENV OMNIROUTE_MITM_STUB=1

# V8 heap ceiling for the build (scripts/build/build.mjs passes it to `react-router build`
# unless NODE_OPTIONS already sets one). Build-only; the runtime heap is set on the runner
# stage (OMNIROUTE_MEMORY_MB).
ARG OMNIROUTE_BUILD_MEMORY_MB=6144
ENV OMNIROUTE_BUILD_MEMORY_MB=${OMNIROUTE_BUILD_MEMORY_MB}

COPY . ./
# Build, then drop the build-only packages. The image keeps the repository layout: the
# server reads files relative to its working directory (PostgreSQL migrations, docs, MITM
# server, compression rules, the MCP server source that `omniroute mcp` runs through tsx),
# and the launcher in scripts/dev/ imports its helpers by relative path.
# `.build/app/app-root/` holds the worker bundles at the paths the server spawns them from.
RUN mkdir -p /app/data \
  && npm run build \
  && cp -R .build/app/app-root/. ./ \
  && rm -rf .build/app/app-root \
  && printf '%s' "${OMNIROUTE_BASE_PATH}" > .build/app/BASE_PATH \
  && npm prune --omit=dev --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
  && node -e "require('better-sqlite3')(':memory:').close()" \
  && rm -rf .react-router .source

# ── Runner base ────────────────────────────────────────────────────────────
FROM base AS runner-base

LABEL org.opencontainers.image.title="omniroute" \
  org.opencontainers.image.description="Unified AI proxy — route any LLM through one endpoint" \
  org.opencontainers.image.url="https://github.com/Zyndaai/OmniRoute" \
  org.opencontainers.image.source="https://github.com/Zyndaai/OmniRoute" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
# Runtime heap ceiling. 1024MB is enough for normal traffic but can be tight
# for large fusion-combo panels (many models fanned out in parallel, each
# response buffered in full — see open-sse/services/fusion.ts::FUSION_DEFAULTS
# .maxPanel, issue #1905). Override at `docker run` time with
# `-e OMNIROUTE_MEMORY_MB=2048` (or higher) if you raise fusionTuning.maxPanel
# above the default cap.
ENV OMNIROUTE_MEMORY_MB=1024
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_MEMORY_MB}"

# Data directory inside Docker — must match the volume mount in docker-compose.yml
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app /app/data

# PM2 runs a leader plus N workers in this one container when compose sets
# `command: ["pm2-runtime", "ecosystem.config.cjs"]` (docker-compose.cluster.yml). The app
# never imports it, so it is installed globally, pinned. The default CMD below starts a
# single process.
RUN npm install -g pm2@7.1.2 && npm cache clean --force

# #13679: default the PUBLISHED image to requiring an API key. A bare
# `docker run -p 20128:20128 … diegosouzapw/omniroute` (README/QUICK-START
# one-liners) does not pass `--env-file .env`, so without this default the
# anonymous /v1 LLM proxy would be both keyless AND world-reachable on the
# published container. This does NOT change the npm/CLI local-dev default
# (`REQUIRE_API_KEY` stays `"false"` in featureFlagDefinitions.ts) — only the
# shipped deployment artifact's posture. docker-compose.yml is unaffected: it
# loads the operator's own `.env` (env_file:) which overrides this ENV, and
# already binds loopback-only by default (#12568). Override with
# `-e REQUIRE_API_KEY=false` for an intentionally keyless deployment.
ENV REQUIRE_API_KEY=true

# This self-hosted copy builds and deploys its own image, so upstream's npm releases are not
# updates for it: the `omniroute` CLI must not print an update notice (bin/omniroute.mjs).
ENV OMNIROUTE_NO_UPDATE_NOTIFIER=1

# The whole application directory: build output (.build/app), production node_modules,
# the launcher (scripts/), PM2's ecosystem.config.cjs and the files the server reads at
# run time. .dockerignore keeps tests, docs translations and local data out of it.
COPY --chown=node:node --from=builder /app ./
RUN test -f /app/.build/app/server/index.js \
  && test -f /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node

# Every COPY above hands its files to the baked-in `node` non-root user
# (UID/GID 1000) at copy time. Do NOT add a `RUN chown -R node:node /app`
# afterwards: in the overlay filesystem changing ownership rewrites every file
# into a new layer, which stores the application twice (#13990).

EXPOSE 20128

# Drop to non-root before ENTRYPOINT/CMD.
USER node

# Warns if the mounted data volume has wrong ownership
COPY --chmod=755 scripts/check-permissions.sh /app/check-permissions.sh
ENTRYPOINT ["/app/check-permissions.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "scripts/dev/healthcheck.mjs"]

# The commit this image was built from, reported as `system.buildSha` on
# /api/monitoring/health (src/lib/monitoring/buildSha.ts). The publish workflow passes it;
# a local build leaves it empty. Last in the stage: it changes on every commit, so any layer
# after it would be rebuilt every time.
ARG OMNIROUTE_BUILD_SHA=""
ENV OMNIROUTE_BUILD_SHA=${OMNIROUTE_BUILD_SHA}

CMD ["node", "scripts/dev/run-standalone.mjs"]
