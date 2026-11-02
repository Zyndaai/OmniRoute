# Changelog

This is a private, self-hosted copy of OmniRoute. The release history before the import lives
upstream: <https://github.com/cheaper-inference/OmniRoute/blob/release/v3.8.53/CHANGELOG.md>.

## [Unreleased]

### ✨ New Features

- **feat(zynda):** Zynda integration hardening — the A2A Agent Card never advertises a `0.0.0.0`
  bind host, blocked providers return `503 provider_unavailable` and are skipped in combo
  preflight, unknown models return `404 model_not_found`, and `x-session-affinity` pins a
  session. Runbook: `docs/ZYNDA_INTEGRATION.md`.
- **ci:** build the `runner-base` Docker image and push it to GHCR on `main`.

### 📝 Maintenance

- UI and CLI localization trimmed to English and Arabic; translated docs (`docs/i18n/`) removed.
- Upstream-only release, publish, nightly and translation workflows removed.

## [3.8.53] — 2026-10-31

_Imported from upstream `release/v3.8.53` at `139070680` (2026-10-31)._
