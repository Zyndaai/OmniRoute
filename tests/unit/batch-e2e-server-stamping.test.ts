/**
 * The batch E2E suite (tests/integration/batch-e2e-rate-limit.test.ts) seeds a provider node and
 * mints an API key through the management API in open bootstrap mode. That window only stays open
 * for a loopback peer, and locality is derived from the TCP-peer stamp that the launcher in
 * scripts/dev/run-server.mjs writes. Booted without that stamp, the suite got `401` on
 * `POST /api/provider-nodes` before a single assertion ran. Pin the boot target here where every
 * unit run sees it (#11535, #14403).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const suiteSource = readFileSync(
  join(here, "..", "integration", "batch-e2e-rate-limit.test.ts"),
  "utf8"
);

test("batch E2E boots the peer-stamping launcher", () => {
  assert.match(suiteSource, /spawn\(process\.execPath, \["scripts\/dev\/run-server\.mjs", "dev"\]/);
});

test("batch E2E pins the loopback host and open bootstrap the management calls rely on", () => {
  assert.match(suiteSource, /HOST: "127\.0\.0\.1"/);
  assert.match(suiteSource, /OMNIROUTE_E2E_BOOTSTRAP_MODE: "open"/);
});
