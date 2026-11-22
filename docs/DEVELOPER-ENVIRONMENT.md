# Developer environment notes

This page explains the project's local `.env` behavior and how to handle environment files and secrets when developing OmniRoute.

## .env postinstall behavior

The project may generate a local `.env` file during `npm install` / `postinstall` for developer convenience. This file is intended only for local development and testing and must never be committed to version control.

Key points:

- The repository's `.gitignore` already ignores `.env*` files (see the `.gitignore` entry). Do not remove or alter that rule unless you deliberately intend to commit a specific example file and have a documented process for it.
- If a real secret is accidentally committed to the repo, rotate/revoke the credential immediately and remove it from the repository history (for example, using `git filter-repo` or an equivalent remediation workflow). Contact the security/contact owner if you need help.
- For CI and production, use the CI secrets or a secrets manager (GitHub Actions Secrets, Azure Key Vault, HashiCorp Vault, etc.) rather than committing secrets to files.

## Recommended local workflow

- Keep `.env` in your local workspace only. Use `.env.example` (already tracked) to document required variables and acceptable example values.
- When running tests locally that require secret-like values, prefer synthetic placeholders or runtime-generated ephemeral keys rather than real credentials.
- Add a short comment in tests that use placeholders so reviewers understand the fixture is synthetic.

## Running the tests against PostgreSQL

The unit tests need a disposable PostgreSQL server (for example a local Docker container).
Point `OMNIROUTE_TEST_POSTGRES_URL` at it with an admin user; keep the URL in a local env file
outside the repository and load it into the shell before a run, never print or commit it.

- `tests/_setup/isolatePostgres.ts` (loaded with `--import` by `npm run test:unit`) gives each
  test process its own database, cloned from a migrated template (`scripts/db/test-db.mjs`), and
  drops it when the process exits. Without `OMNIROUTE_TEST_POSTGRES_URL` it does nothing and
  database tests fail.
- `node scripts/db/test-db.mjs tune` once per new server; `clean` removes databases left behind
  by killed test processes.
- Between test cases in one file, call `resetTestDb()` (`tests/helpers/postgres.ts`): it empties
  every table, restores the seed rows and drops the process read caches. `resetDbInstance()` only
  closes the pool, so rows leak into the next case.
- A test that writes `provider_model_catalog`, `model_capability_overrides`,
  `model_context_overrides`, or the API-key policy tables (`teams`, `api_key_quota_limits`,
  `api_key_token_limits`, `quota_allocations`, ...) with raw SQL after something already read
  them must call `invalidateDbCache("model-capabilities")` or `invalidateDbCache()` afterwards:
  those reads are cached per process (`src/lib/db/readCache.ts`). Writes through the domain
  functions invalidate on their own.
- On Windows, a test that spawns a process passes `windowsHide: true` (otherwise a console window
  flashes), and a CLI test that replaces `HOME` also replaces `USERPROFILE` (otherwise it writes
  the real `~/.omniroute`).

## Scanner notes

- Some compiled or binary assets (e.g., embedded base64 WASM blobs) can contain ASCII substrings that look like credentials and may trigger text-based secret scanners. If these assets are legitimate, either mark them in the scanner's allowlist or exclude the directories in the scanner config.

## If you find a leak

1. Rotate/revoke the key immediately.
2. Remove the secret from the history and force-push a cleaned branch if necessary.
3. Notify maintainers and follow your org's incident response checklist.
