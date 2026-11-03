/**
 * Issue #13679 (PR E, item #6) — published container deployment posture.
 *
 * A default `docker run` of the image (README/QUICK-START one-liners, which do
 * NOT pass `--env-file .env`) publishes the app on a public interface (a bare
 * `docker run -p 20128:20128` binds 0.0.0.0 on the host) while
 * `REQUIRE_API_KEY` defaulted to unset/false —
 * combining "world-reachable" with "keyless" for the anonymous `/v1` LLM proxy.
 *
 * `docker-compose.yml` already mitigates this for the compose path (loopback
 * bind by default, #12568) and intentionally still follows the operator's own
 * `.env` (own `REQUIRE_API_KEY` choice) — this test does NOT touch that file.
 *
 * The npm/CLI local-dev default in `src/shared/constants/featureFlagDefinitions.ts`
 * (`REQUIRE_API_KEY` defaultValue `"false"`) is explicitly OUT of scope and must
 * stay unchanged — see AGENTS.md Hard Rule #20 precedent and the owner decision
 * on #13679 PR E.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

function read(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf-8");
}

test("Dockerfile ships REQUIRE_API_KEY=true by default for the published image", () => {
  const dockerfile = read("Dockerfile");
  assert.match(
    dockerfile,
    /^ENV REQUIRE_API_KEY=true$/m,
    "the published Dockerfile must default to REQUIRE_API_KEY=true so `docker run` without " +
      "an --env-file does not ship keyless AND world-reachable at once — override with " +
      "`-e REQUIRE_API_KEY=false` for an intentionally keyless deployment"
  );
});

test("the npm/CLI local-first REQUIRE_API_KEY default is untouched (#13679 PR E constraint)", () => {
  const definitions = read("src/shared/constants/featureFlagDefinitions.ts");
  assert.match(
    definitions,
    /key:\s*"REQUIRE_API_KEY"[\s\S]{0,200}?defaultValue:\s*"false"/,
    "the local-first npm/CLI default must stay REQUIRE_API_KEY=false — only the shipped " +
      "container/Fly deployment manifests change posture, per the #13679 owner decision"
  );
});
