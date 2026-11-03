# OmniRoute agent guide

> **Single source of truth.** This file holds ALL project rules, conventions, architecture notes
> and Hard Rules for every AI assistant working this repository (Claude Code, Gemini, Codex,
> Copilot, and any other agent). `CLAUDE.md` and `GEMINI.md` only add assistant-specific deltas
> and point back here. When a rule needs to change, change it HERE — never re-fork it into an
> assistant-specific file.

## Quick Start

```bash
npm install                    # Install deps (auto-generates .env from .env.example)
npm run dev                    # Dev server at http://localhost:20128
npm run build                  # Production build (Next.js 16 standalone)
npm run lint                   # ESLint (0 errors expected; warnings are pre-existing)
npm run typecheck:core         # TypeScript check (should be clean)
npm run typecheck:noimplicit:core  # Strict check (no implicit any)
npm run test:coverage          # Unit tests + coverage (60% floor, hardcoded in test:coverage)
npm run check                  # lint + test combined
```

This is a private self-hosted copy of OmniRoute: the only CI is `.github/workflows/docker-build-push.yml`
(builds the image on push to `main`). Upstream's CI, quality-gate scripts, ratchets, git hooks,
release tooling and Dependabot were removed, so nothing runs lint, tests or typecheck for you.

Running tests: see [Testing](#testing) below (run the most focused test for changed code first).

---

## Project at a Glance

**OmniRoute** — unified AI proxy/router. One endpoint, 380 LLM providers, auto-fallback.

- API Routes — `src/app/api/v1/` (Next.js App Router entry points)
- Handlers — `open-sse/handlers/` (request processing: chat, embeddings, etc)
- Executors — `open-sse/executors/` (provider-specific HTTP dispatch)
- Translators — `open-sse/translator/` (format conversion OpenAI↔Claude↔Gemini)
- Transformer — `open-sse/transformer/` (Responses API ↔ Chat Completions)
- Services — `open-sse/services/` (combo routing, rate limits, caching, etc)
- Database — `src/lib/db/` (SQLite domain modules, 219 migrations)
- Domain/Policy — `src/domain/` (policy engine, cost rules, fallback logic)
- MCP Server — `open-sse/mcp-server/` (110 tools: 45 canonical + memory/skill/GitHub/pool/gamification/plugin/Notion/Obsidian/local-corpus/RTK modules; 3 transports: stdio / SSE / Streamable HTTP; 33 scopes)
- A2A Server — `src/lib/a2a/` (JSON-RPC 2.0 agent protocol)
- Skills — `src/lib/skills/` (extensible skill framework); Memory — `src/lib/memory/` (persistent conversational memory)

Monorepo: `src/` (Next.js 16 app), `open-sse/` (streaming engine workspace), `tests/`, `bin/` (CLI entry point).

---

## Request Pipeline

```
Client → /v1/chat/completions (Next.js route)
  → CORS → Zod validation → auth? → policy check → prompt injection guard
  → handleChatCore() [open-sse/handlers/chatCore.ts]
    → cache check → rate limit → combo routing?
      → resolveComboTargets() → handleSingleModel() per target
    → translateRequest() → getExecutor() → executor.execute()
      → fetch() upstream → retry w/ backoff
    → response translation → SSE stream or JSON
    → If Responses API: responsesTransformer.ts TransformStream
```

API routes follow a consistent pattern: `Route → CORS preflight → Zod body validation → Optional auth (extractApiKey/isValidApiKey) → API key policy enforcement → Handler delegation (open-sse)`. No global Next.js middleware — interception is route-specific.

**Combo routing** (`open-sse/services/combo.ts`): 20 public strategies (priority, weighted, fill-first, round-robin, p2c, random, least-used, cost-optimized, reset-aware, reset-window, headroom, quota-weighted, strict-random, auto, lkgp, context-optimized, cache-optimized, context-relay, fusion, pipeline). Each target calls `handleSingleModel()` (wraps `handleChatCore()` with per-target error handling + circuit breaker checks); the `fusion` strategy instead fans out to a panel of models in parallel and a judge model synthesizes one final answer (`open-sse/services/fusion.ts`). 16-factor Auto-Combo scoring + full strategy table: `docs/routing/AUTO-COMBO.md`; the 3 resilience layers: `docs/architecture/RESILIENCE_GUIDE.md`.

---

## Resilience Runtime State

Three related but distinct temporary-failure mechanisms — keep their **scope** separate when debugging routing:

- **Provider Circuit Breaker** — scope: whole provider. 4 states (CLOSED/DEGRADED/OPEN/HALF_OPEN); lazy recovery — `getStatus()`/`canExecute()` refresh an expired `OPEN`, no background timer.
- **Connection Cooldown** — scope: one connection/account/key. Lazy `rateLimitedUntil` skip + exponential backoff; terminal states (`banned`/`expired`/`credits_exhausted`) are NOT cooldowns.
- **Model Lockout** — scope: provider + connection + model. One bad model never disables the whole connection (`open-sse/services/accountFallback.ts`).

Defaults: `open-sse/config/constants.ts` → `PROVIDER_PROFILES` (overridable via
`OMNIROUTE_PROVIDER_BREAKER_*` / `OMNIROUTE_CIRCUIT_BREAKER_*`). Only provider-level statuses
`408/500/502/503/504` trip the provider breaker — most `401`/`403`/`429` belong to connection
cooldown or model lockout. Full agent reference (files, states, thresholds, debugging):
[`docs/architecture/RESILIENCE_GUIDE.md` → "Runtime state — agent quick reference"](docs/architecture/RESILIENCE_GUIDE.md#runtime-state--agent-quick-reference).

---

## Repository map

Read the nearest `AGENTS.md` and the linked deep-dive before making a non-trivial change.

- API routes — `src/app/api/v1/` → `docs/architecture/ARCHITECTURE.md`
- Streaming request handling — `open-sse/handlers/` → `docs/architecture/ARCHITECTURE.md`
- Provider execution and translation — `open-sse/executors/`, `open-sse/translator/` → `docs/architecture/CODEBASE_DOCUMENTATION.md`
- Routing and resilience — `open-sse/services/` → `open-sse/services/AGENTS.md`, `docs/routing/AUTO-COMBO.md`
- Database and migrations — `src/lib/db/`, `src/lib/db/migrations/` → `src/lib/db/AGENTS.md`
- Domain policy — `src/domain/` → `docs/architecture/ARCHITECTURE.md`
- MCP and A2A — `open-sse/mcp-server/`, `src/lib/a2a/` → `docs/frameworks/MCP-SERVER.md`, `docs/frameworks/A2A-SERVER.md`
- Agent features — `src/lib/{acp,memory,skills,cloudAgent}/` → `docs/frameworks/AGENT_PROTOCOLS_GUIDE.md`, `docs/frameworks/SKILLS.md`
- Safety and governance — `src/lib/{guardrails,compliance}/`, `src/server/authz/` → `docs/security/GUARDRAILS.md`, `docs/architecture/AUTHZ_GUIDE.md`
- Operations — `src/mitm/`, tunnel modules → `docs/ops/TUNNELS_GUIDE.md`
- UI kit — `packages/ui-kit/` (vendored Keak CI UI Kit; adapters in `src/shared/components/`) → `docs/architecture/DESIGN_SYSTEM.md`

---

## File placement & repo-root hygiene

- **Test files**: ALL unit tests, integration tests, ecosystem tests, or Vitest files MUST strictly be placed within the `tests/` directory (e.g., `tests/unit/`, `tests/integration/`). NEVER create test files in the project root (`/`).
- **Scripts and utilities**: ALL maintenance, debugging, generation, or experimental scripts (`.cjs`, `.mjs`, `.js`, `.ts`) MUST be placed strictly inside one of the `scripts/` subfolders (`build/`, `dev/`, `check/`, `docs/`, `i18n/`, `homolog/`, `packs/`, `skills/`, `cli/`, `devin-bridge/`, `docker/`). One-shot or experimental code goes under `scripts/ad-hoc/` (create it when needed). NEVER dump loose scripts in the project root (`/`) or the top-level `scripts/` folder.

**The project root MUST ONLY contain:**

- Configuration files (`vitest.config.ts`, `next.config.mjs`, `eslint.config.mjs`, `tsconfig*.json`, `playwright.config.ts`, `prettier.config.mjs`, `postcss.config.mjs`, `docker-compose*.yml`, `Dockerfile`)
- Dependency files (`package.json`, `package-lock.json`)
- Documentation files (`README.md`, `CHANGELOG.md`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SECURITY.md`, `llm.txt`)
- CI/CD files and ignore definitions (`.gitignore`, `.dockerignore`, `.npmignore`, `.npmrc`, `.node-version`, `.nvmrc`, `.env.example`)

When creating _any_ validation tests or one-off logic scripts, default to `scripts/ad-hoc/` or `tests/unit/` according to your goals. Do not pollute the `/` root context.

- **Root `_*` paths are private and NEVER tracked** (`_artifacts/` and any other `_<name>`): they
  live on disk only and are gitignored by the anchored patterns `/_*/` + `/_*`. Never `git add`
  anything inside them (never use `-f`). Scratch and working files go in `_artifacts/`. No gate
  checks this, so check `git status` before committing.

---

## Key Conventions

### Code Style

- **2 spaces**, semicolons, double quotes, 100 char width, es5 trailing commas (Prettier; no hook runs it) — run Prettier on changed files
- **Imports**: external → internal (`@/`, `@omniroute/open-sse`) → relative
- **Naming**: files=camelCase/kebab, components=PascalCase, constants=UPPER_SNAKE
- **ESLint**: `no-eval`, `no-implied-eval`, `no-new-func` = error everywhere; `no-explicit-any` = **error** in `open-sse/` and `tests/` (since #6218 — pre-existing violations are frozen in `config/quality/eslint-suppressions.json`, new ones must be fixed; `npm run lint` applies the suppressions)
- **TypeScript**: `strict: false`, target ES2022, module esnext, resolution bundler. Prefer explicit types.

### Database

- **Always** go through `src/lib/db/` domain modules — **never** write raw SQL in routes or handlers
- **Never** barrel-import from `localDb.ts` — import specific `src/lib/db/*` modules
- DB singleton: `getDbInstance()` from `src/lib/db/core.ts` (WAL journaling)
- Migrations: `src/lib/db/migrations/` — versioned SQL files, idempotent, run in transactions

### Error Handling

- try/catch with specific error types, log with pino context
- Never swallow errors in SSE streams — use abort signals for cleanup
- Return proper HTTP status codes (4xx/5xx)

### Security

- **Never** use `eval()`, `new Function()`, or implied eval
- Validate all inputs with Zod schemas
- Encrypt credentials at rest (AES-256-GCM); never log SQLite encryption keys
- Sanitize user HTML with DOMPurify
- Upstream header denylist: `src/shared/constants/upstreamHeaders.ts` — keep sanitize, Zod schemas, and unit tests aligned when editing
- **Public upstream credentials** (for example, OAuth client_id/secret values or Firebase Web keys extracted from public CLIs): **MUST** be embedded via `resolvePublicCred()` from `open-sse/utils/publicCreds.ts` — **never** as string literals. See `docs/security/PUBLIC_CREDS.md` for the mandatory pattern.
- **Error responses** (HTTP / SSE / executor / MCP handler): **MUST** route through `buildErrorBody()` or `sanitizeErrorMessage()` from `open-sse/utils/error.ts` — **never** put raw `err.stack` or `err.message` in a response body. See `docs/security/ERROR_SANITIZATION.md`.
- **Shell commands built from variables**: when calling `exec()`/`spawn()` with a script that needs runtime values, pass them via the `env` option (shell-escaped automatically) — **never** string-interpolate untrusted/external paths into the script body. Reference: `src/mitm/cert/install.ts::updateNssDatabases`.
- **Secure-by-default libraries** ([tldrsec/awesome-secure-defaults](https://github.com/tldrsec/awesome-secure-defaults)): prefer Helmet.js, DOMPurify, ssrf-req-filter, safe-regex, Google Tink over custom implementations whenever adding new security-sensitive surfaces.

---

## Documentation accuracy

Documentation must describe verified behavior, not plausible behavior.

1. Before documenting an API name, endpoint, path, CLI command, or environment variable,
   search for it: `rg -n "name" src/ open-sse/ bin/`. If it has no source match, do not
   document it.
2. Measure mutable counts instead of writing them from memory: use `wc -l <file>` or a
   directory-specific count command.
3. Copy code examples from working usage or run them. Prefer a source link such as
   `path/to/file.ts:line` to an invented signature.

---

## Common Modification Scenarios

Full step-by-step recipes: [`docs/architecture/MODIFICATION_SCENARIOS.md`](docs/architecture/MODIFICATION_SCENARIOS.md). Quick index:

- **New provider**: check `docs/reference/REMOVED_PROVIDERS.md` first (blocklist-guarded — never reintroduce), then `src/shared/constants/providers.ts` → executor → translator → OAuth config (`resolvePublicCred()`, never a literal) → `open-sse/config/providerRegistry.ts` → tests.
- **Dual auth (multiple API keys) for a provider**: add its ID to `DUAL_AUTH_PROVIDER_IDS` (`src/shared/constants/providers.ts`) + update its `authHint`; each key becomes its own connection row, rotated by `getProviderCredentials()`.
- **New API route**: `src/app/api/v1/<route>/route.ts` — CORS → Zod → optional auth → handler in `open-sse/handlers/`; errors via `buildErrorBody()`; tests assert no stack-trace leak.
- **New DB module**: `src/lib/db/<module>.ts` (`getDbInstance`) → migration if new tables → tests.
- **New MCP tool**: `open-sse/mcp-server/tools/` (Zod schema) → register → scope → tests.
- **New A2A skill**: `src/lib/a2a/skills/` → `A2A_SKILL_HANDLERS` → Agent Card → tests + doc table.
- **New cloud agent**: `src/lib/cloudAgent/agents/` (extends `CloudAgentBase`) → `registry.ts` → OAuth → tests + doc.
- **New embedded service**: installer → `bootstrap.ts` → DB seed → 8 API endpoints + `isLocalOnlyPath()` guard → UI tab → docs + OpenAPI → tests.
- **Guardrail / eval / skill / webhook / log-export destination**: see the detail doc.

---

## Reference Documentation

For any non-trivial change, read the matching deep-dive first:

- Repo navigation — `docs/architecture/REPOSITORY_MAP.md` · Architecture — `docs/architecture/ARCHITECTURE.md` · Engineering reference — `docs/architecture/CODEBASE_DOCUMENTATION.md`
- Auto-Combo (16-factor scoring, 20 strategies) — `docs/routing/AUTO-COMBO.md` · Reasoning replay — `docs/routing/REASONING_REPLAY.md`
- Resilience (3 mechanisms + debugging) — `docs/architecture/RESILIENCE_GUIDE.md`
- Modification recipes — `docs/architecture/MODIFICATION_SCENARIOS.md`
- Skills framework — `docs/frameworks/SKILLS.md` · Radar (free-model catalog overlay) — `docs/frameworks/RADAR.md` · Memory system (FTS5 + Qdrant) — `docs/frameworks/MEMORY.md`
- Cloud agents — `docs/frameworks/CLOUD_AGENT.md` · Agent protocols (A2A / ACP / Cloud) — `docs/frameworks/AGENT_PROTOCOLS_GUIDE.md`
- Guardrails (PII / injection / vision) — `docs/security/GUARDRAILS.md` · Public upstream credentials (Gemini/etc.) — `docs/security/PUBLIC_CREDS.md` · Error message sanitization — `docs/security/ERROR_SANITIZATION.md` · Compliance / audit — `docs/security/COMPLIANCE.md` · Stealth (TLS / fingerprint) — `docs/security/STEALTH_GUIDE.md`
- Evals — `docs/frameworks/EVALS.md` · Webhooks — `docs/frameworks/WEBHOOKS.md` · Log export (call logs → BigQuery/…) — `docs/frameworks/LOG-EXPORT.md`
- Authorization pipeline — `docs/architecture/AUTHZ_GUIDE.md`
- MCP server — `docs/frameworks/MCP-SERVER.md` · A2A server — `docs/frameworks/A2A-SERVER.md`
- API reference + OpenAPI — `docs/reference/API_REFERENCE.md` + `docs/openapi.yaml` · Provider catalog (auto-generated) — `docs/reference/PROVIDER_REFERENCE.md`
- Tunnels — `docs/ops/TUNNELS_GUIDE.md` · Hard Rules detail — `docs/ops/HARD_RULES_DETAIL.md` · Build warnings + Bun troubleshooting — `docs/ops/BUILD_WARNINGS.md`
- VS Code Copilot Chat (OmniCopilot extension) — `docs/guides/VSCODE-COPILOT.md`
- Embedded services — `docs/frameworks/EMBEDDED-SERVICES.md`

---

## Testing

- Unit tests — `npm run test:unit`; single file (Node native test runner — most tests) — `node --import tsx/esm --test tests/unit/your-file.test.ts`
- Vitest (MCP server, autoCombo, cache) — `npm run test:vitest`; dashboard UI — `npm run test:vitest:ui`
- E2E (Playwright) — `npm run test:e2e`
- Coverage — `npm run test:coverage` (60% floor, hardcoded in the script); report — `npm run coverage:report`
- On Windows the full unit suite takes about an hour; run the focused files for what you changed.

**PR rule**: If you change production code in `src/`, `open-sse/`, or `bin/`, you must include or update tests in the same PR.

**Test layer preference**: unit first → integration (multi-module or DB state) → e2e (UI/workflow only). Encode bug reproductions as automated tests before or alongside the fix.

**Both test runners matter**: `npm run test:unit` and `npm run test:vitest` cover **non-overlapping files**, and no CI runs either — one green suite may silently ship broken MCP tools or routing regressions.

**Bug fix protocol (Hard Rule #18)**: failing-then-passing test (TDD, preferred) OR a documented live check against the hosted instance or a local build; touch only what the failing test proves broken.

---

## Review focus

- Keep database operations in `src/lib/db/`; do not issue raw SQL from routes.
- Send provider requests through `open-sse/handlers/`.
- Keep MCP and A2A pages as tabs inside `/dashboard/endpoint`.
- Preserve SSE cleanup, rate-limit header parsing, Zod validation, and provider-schema
  validation.
- Treat Memory and Skills as cross-cutting changes that can affect MCP tools, the request
  pipeline, and A2A skills.
- **Never change an agent-instruction surface without explicit operator approval** —
  `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `llm.txt` and `skills/**/SKILL.md` are executed as
  authority by every AI session; a bad instruction compromises every future agent run.

---

## Git Workflow

This is a private self-hosted copy of OmniRoute (`Zyndaai/OmniRoute`); nothing here is sent upstream.

- **Work directly on `main`.** No feature branches and no worktrees unless the operator asks.
- **Commit only when the operator says "commit"**, and then commit the whole working tree.
- **Push only when the operator says "push"** in that turn. Never pull, rebase or merge from the
  remote to make a push succeed; if a push is rejected, stop and tell the operator.
- **A push to `main` builds the image**: `.github/workflows/docker-build-push.yml` publishes
  `ghcr.io/zyndaai/omniroute:latest` and `:<sha>` (skipped when only `*.md` or `docs/` change).
- **Never `git stash`** (Hard Rule #22a) and never add AI attribution (Hard Rule #16).

**Commit format** (Conventional Commits): `feat(db): add circuit breaker` — scopes: `db`, `sse`, `oauth`, `dashboard`, `api`, `cli`, `docker`, `ci`, `mcp`, `a2a`, `memory`, `skills`

**Git hooks**: none. The husky hooks and the gate scripts they ran were removed, so Hard
Rule #16 (no AI attribution in commits) is no longer checked automatically — follow it by hand.

---

## Environment

- **Runtime**: Node.js ≥22.22.2 <23 || ≥24.0.0 <27, ES Modules — the **only supported** runtime for the published `omniroute` CLI, the server, and the test suites (`node:test` + vitest); `engines.node` is authoritative and end users never need Bun. A **best-effort `bun:sqlite` compatibility path** exists so a global Bun install (`bun install -g omniroute`) can start without `better-sqlite3` (driver adapter + Bun-aware process spawning); it is **not** a supported runtime — no support guarantees — and every Bun-specific runtime change MUST preserve the Node driver/fallback chain and ship a Bun test (`test:bun:db`) or an explicit reason why the path is Node-only.
- **Bun (script runner + compatibility smoke only)**: Bun `1.4.2` is pinned as an **exact devDependency** (provisioned through the existing `npm ci` via the lockfile's `@oven/bun-*` platform binaries — no `setup-bun`/ad-hoc install). It executes **only** `gen:provider-reference` and the `test:bun:db` compatibility smoke suite. **Do NOT widen Bun to `npm install`, the build (`build:cli*`), `check:pack-artifact`, the supported published runtime, or the main test runners** — those stay on Node. Any new Bun-invoking script must be validated byte-identical against its `node --import tsx` output first. Bun failing (`bun: not found`, or the skipped-`postinstall` placeholder binary): `docs/ops/BUILD_WARNINGS.md` → "Bun script-runner failures".
- **TypeScript**: 6.0+, target ES2022, module esnext, resolution bundler
- **Path aliases**: `@/*` → `src/`, `@omniroute/open-sse` → `open-sse/`, `@omniroute/open-sse/*` → `open-sse/*`
- **Default port**: 20128 (API + dashboard on same port)
- **Data directory**: `DATA_DIR` env var, defaults to `~/.omniroute/`
- **Key env vars**: `PORT`, `JWT_SECRET`, `API_KEY_SECRET`, `INITIAL_PASSWORD`, `REQUIRE_API_KEY`, `APP_LOG_LEVEL`
- Setup: `cp .env.example .env` then generate `JWT_SECRET` (`openssl rand -base64 48`) and `API_KEY_SECRET` (`openssl rand -hex 32`)

---

## Quality gates

Upstream's ~90 gate scripts (`scripts/quality/`, most of `scripts/check/`), their baselines in
`config/quality/` and the CI jobs that ran them were removed from this copy. What remains:
`scripts/check/check-native-deps.mjs` (the `prebuild` hook), and in `config/quality/` the
runtime data `model-lifecycle.json` (read by `open-sse/services/autoCombo/taskFitness.ts`), the
free-catalog evidence files, and `eslint-suppressions.json` (used by `npm run lint`). Comments in
`src/` and `open-sse/` that cite a file-size or boundary ratchet describe history, not a live
check.

---

## Hard Rules

Rule numbers are stable and cited across scripts, tests and docs — never renumber. Rules marked
_retired_ were upstream process rules that do not apply to this copy. Where a rule below is a
short form, its complete text, rationale and incident history are in
[`docs/ops/HARD_RULES_DETAIL.md`](docs/ops/HARD_RULES_DETAIL.md) under the same number; this file
wins where the two disagree.

1. Never commit secrets or credentials
2. Never barrel-import from `localDb.ts` — import specific `src/lib/db/*` modules
3. Never use `eval()` / `new Function()` / implied eval
4. _Retired:_ upstream banned commits to `main`; this copy commits directly on `main` (see Git Workflow).
5. Never write raw SQL in routes — use `src/lib/db/` modules
6. Never silently swallow errors in SSE streams
7. Always validate inputs with Zod schemas
8. Always include tests when changing production code
9. Coverage must not drop below 60% (statements/lines/functions/branches; `npm run test:coverage`). The upstream coverage ratchet was removed with the quality gates.
10. Never bypass git hooks (`--no-verify`, `--no-gpg-sign`) without explicit operator approval. (This copy has no hooks today; the rule stands for any that are added.)
11. Never embed public upstream OAuth client_id/secret or Firebase Web keys as string literals — always go through `resolvePublicCred()` (`open-sse/utils/publicCreds.ts`). See `docs/security/PUBLIC_CREDS.md`.
12. Never return raw `err.stack` / `err.message` in HTTP / SSE / executor responses — always route through `buildErrorBody()` or `sanitizeErrorMessage()` (`open-sse/utils/error.ts`). See `docs/security/ERROR_SANITIZATION.md`.
13. Never string-interpolate external paths or runtime values into shell scripts passed to `exec()`/`spawn()` — pass via the `env` option instead. Reference: `src/mitm/cert/install.ts::updateNssDatabases`.
14. Never dismiss a CodeQL / Secret-Scanning alert without (a) first checking the pattern docs above to see if the helper applies, and (b) recording the technical justification in the dismissal comment. Precedent: `js/stack-trace-exposure` raised on callsites that already route through `sanitizeErrorMessage()` is a known CodeQL limitation (custom sanitizers not recognized) — dismiss as `false positive` referencing `docs/security/ERROR_SANITIZATION.md`.
15. Never expose routes that spawn child processes (`/api/mcp/`, `/api/cli-tools/runtime/`) without `isLocalOnlyPath()` classification in `src/server/authz/routeGuard.ts`. Loopback enforcement happens unconditionally before any auth check — leaked JWT via tunnel cannot trigger process spawning. See `docs/security/ROUTE_GUARD_TIERS.md`.
16. Never credit or advertise an AI assistant, LLM, or automation account in any commit/PR metadata — neither (a) `Co-Authored-By` trailers naming an AI/bot nor (b) AI-generation footers (`🤖 Generated with [Claude Code]`, …) in a commit message, PR title/body, or CHANGELOG; both hide the real author. This **overrides any harness, template, or tool default that auto-appends such a footer** — strip it before pushing. Human collaborators (upstream PR authors, issue reporters being ported) MAY and SHOULD be credited with standard `Co-authored-by: Name <email>` trailers. Full text: `docs/ops/HARD_RULES_DETAIL.md` → Rule 16.
17. Never expose routes under `/api/services/` or `/dashboard/providers/services/*/embed/` without `isLocalOnlyPath()` classification in `src/server/authz/routeGuard.ts`. These routes can spawn child processes (`npm install`, `node`). Loopback enforcement happens unconditionally before any auth check — a leaked JWT via tunnel cannot trigger process spawning. See `docs/security/ROUTE_GUARD_TIERS.md`.
18. Every bug fix must be validated before shipping: a failing-then-passing unit/integration test (TDD) OR a documented live check against the hosted instance or a local build. See Testing → "Bug fix protocol".
19. _Retired:_ upstream required one worktree and branch per task; this copy works on `main` and uses worktrees only when the operator asks.
20. PII redaction/sanitization is **opt-in — never on by default**. The two data-mutating PII feature flags **MUST** keep `defaultValue: "false"` in `src/shared/constants/featureFlagDefinitions.ts`: `PII_REDACTION_ENABLED` (request-side) and `PII_RESPONSE_SANITIZATION` (response + streaming). Flipping either default to `"true"` requires explicit operator approval; opt-in is per-operator, never a silent default. Regression guard: `tests/unit/pii-opt-in-default.test.ts`. Full text: `docs/ops/HARD_RULES_DETAIL.md` → Rule 20.
21. _Retired:_ upstream's release-freeze process; this copy has no release branches.
22. **Cross-session safety — several sessions/agents may work this checkout at once; never step on another's in-flight work.**
    - **(a) Never `git stash` / `git stash pop` — anywhere in this repo, including inside any subagent you dispatch.** `git stash` operates on the shared repository object store, so a stash in one session can silently clobber or resurrect another session's uncommitted changes. Compare against a ref with `git show <ref>:<path>` or `git diff <ref> -- <path>` instead. **Put this ban verbatim in the prompt of every subagent that touches git.**
    - **(b) Never commit, push or rewrite work that another session is actively doing.** If another session is editing the tree, leave its files alone and ask the operator.
23. _Retired:_ upstream's private `_tasks/` repository; root `_*` paths stay untracked (see File placement).

---

## PII & Stream Sanitization Learnings

### 1. Regex Security (ReDoS)

All regex patterns matching variable-length strings (e.g. IPv6 address, credit cards) must use strictly bounded, non-overlapping sequences (e.g., limit occurrences with bounded ranges `{1,7}`) to prevent catastrophic backtracking when processing untrusted inputs.

### 2. SSE Snapshot Handling

When parsing streaming LLM responses (e.g. Responses API), check if a chunk represents a final snapshot (`done` or `completed` events). Snapshot text must be sanitized directly as a standalone string (bypassing rolling delta buffers) to prevent text duplication at the end of the stream.

### 3. Database Handles in Tests

Ensure that any unit tests that trigger database migrations or establish SQLite connections call `resetDbInstance()` and properly clean up/close all DB handles in a `test.after(...)` hook. Failure to release database connection handles will cause Node's native test runner to hang indefinitely.

---

## Local development access

Dashboard at the operator's chosen URL/port (default `http://localhost:20128`). Credentials are operator-specific: the **initial admin password** is read from `INITIAL_PASSWORD` on first install (defaults to `CHANGEME` in `.env.example`; rotate immediately after first login); for **local VPS / shared dev environments**, ask the operator — credentials live in their personal vault, NOT in this repo. Any credential observed in a previous version of this file was a non-production demo value; treat it as compromised and do not reuse it.

---

## Managing a hosted instance (HTTP API and MCP)

Agents change a running deployment's configuration through its HTTP API (or MCP) with a
management-scoped API key, never through the database or the server's files.

**Credentials.** The instance URL and key live in `.env.operator` at the repo root
(`OMNIROUTE_OPERATOR_URL`, `OMNIROUTE_OPERATOR_KEY`; template `.env.operator.example`). The file
is gitignored and the server never loads it. Load it into the shell and use the variable; never
print, log, echo or commit the key, and never write it into a committed MCP-client config:

```bash
set -a; . ./.env.operator; set +a
curl -s -H "Authorization: Bearer $OMNIROUTE_OPERATOR_KEY" "$OMNIROUTE_OPERATOR_URL/api/settings"
```

**No key yet, or 401/403 on a management route.** Do not assume the operator has a key. Ask them
to create one in the dashboard (API Keys, scope `manage`) and to run
`pwsh scripts/ops/set-operator-key.ps1` in their own terminal: it reads the key without echo and
writes `.env.operator`. Never ask for the key in chat.

**Workflow for every change.**

1. Read the current state first (`GET`).
2. Propose the exact call (method, path, body) and wait for the operator's go-ahead.
3. Apply it, then read the state back to confirm.

**What the key reaches.**

- **HTTP API, manage scope:** combos (`/api/combos`), API keys and their model access
  (`/api/keys`), provider connections (`/api/providers`), most settings (`PATCH /api/settings`, e.g.
  `blockedProviders`, `mcpEnabled`), resilience, pricing, usage and costs.
- **Logs and audit:** `/api/usage/request-logs`, `/api/usage/call-logs`, `/api/logs/console` (last
  hour), `/api/compliance/audit-log`, `/api/mcp/audit`.
- **Dashboard session only (a key gets 403 by design):** database backup export/import, settings
  export/import, and security settings (require-login, password, CORS origins, OIDC/SSO,
  brute-force protection). The operator does these in the browser.
- **Server environment only (set on the host at deploy):** `STORAGE_ENCRYPTION_KEY`,
  `OMNIROUTE_MCP_ENFORCE_SCOPES`. Provider account logins (OAuth) also need the operator's browser.

**MCP.** Streamable HTTP at `$OMNIROUTE_OPERATOR_URL/api/mcp/stream` with the same bearer key. It
answers `503 "MCP server is disabled"` until the `mcpEnabled` setting is on; turning it on is a
settings change like any other (propose, then apply). While `OMNIROUTE_MCP_ENFORCE_SCOPES` is off,
the key reaches every MCP tool, plugin installs included, so prefer the HTTP API for writes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
