# Changelog

This is a private, self-hosted copy of OmniRoute. The release history before the import lives
upstream: <https://github.com/cheaper-inference/OmniRoute/blob/release/v3.8.53/CHANGELOG.md>.

## [Unreleased]

### ✨ New Features

- **feat(hardening):** Hardened-deployment support for server-to-server clients — the A2A Agent Card
  never advertises a `0.0.0.0` bind host, blocked providers return `503 provider_unavailable` and
  are skipped in combo preflight, unknown models return `404 model_not_found`, and
  `x-session-affinity` pins a session. Runbook: `docs/ops/HARDENED_DEPLOYMENT.md`.
- **ci:** build the `runner-base` Docker image and push it to GHCR on `main`.

### 🐛 Bug Fixes

- **fix(claude):** a client's `thinking: {type: "disabled"}` reaches Claude Sonnet 5.5 as
  `{type: "between_tools"}`, the value Anthropic's 400 names for it, instead of being dropped.
  Dropped, Sonnet fell back to adaptive thinking and every no-thinking call billed 200–350
  reasoning tokens (new spec field `disabledThinkingType`).
- **fix(claude):** "cursor" is no longer obfuscated with a zero-width joiner on the Claude OAuth
  path. As a plain word it is a paging cursor in tool descriptions and results, and on
  `/v1/messages` the joiner came back in the model's answers. Cursor's own prompts are still
  dropped by the `getcursor/cursor` paragraph anchor.

### 📝 Maintenance

- UI and CLI localization trimmed to English and Arabic; translated docs (`docs/i18n/`) removed.
- Upstream-only release, publish, nightly and translation workflows removed.
- Gamification removed: XP, badges, streaks, leaderboards, token sharing, invites, federation,
  its dashboard pages, `/api/gamification/*`, the 8 MCP tools and the per-request XP event. A
  10 RPS CPU profile put it at ~1.7% of CPU, and nothing here used it. Migrations 060 and 176
  stay (forward-only), so the tables are left in place, unused; the `xpAuditLog` retention
  setting went with it.
- perf(registry): `getGlobalModel()` memoizes by model id (bounded, cleared on registry
  changes) instead of scanning every provider list several times per request.

## [3.8.53] — 2026-10-31

_Imported from upstream `release/v3.8.53` at `139070680` (2026-10-31)._
