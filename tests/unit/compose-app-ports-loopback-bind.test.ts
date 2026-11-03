import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

// .env.example shipping REQUIRE_API_KEY=false would put the anonymous /v1 LLM
// proxy on the network unless the server refuses a keyless non-loopback bind.
// Issue #12568.

test(".env.example does not ship REQUIRE_API_KEY=false without a boot-time non-loopback guard", () => {
  const env = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  const requireApiKeyFalse = /^REQUIRE_API_KEY=false\s*$/m.test(env);
  if (requireApiKeyFalse) {
    const guardHits = ["src/server", "src/lib", "open-sse"].some((dir) => {
      try {
        const files = fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true }) as string[];
        return files.some((f) => {
          if (!f.endsWith(".ts")) return false;
          const full = path.join(REPO_ROOT, dir, f);
          if (!fs.statSync(full).isFile()) return false;
          const content = fs.readFileSync(full, "utf8");
          return content.includes("non-loopback") && content.includes("REQUIRE_API_KEY");
        });
      } catch {
        return false;
      }
    });
    assert.ok(guardHits, "REQUIRE_API_KEY=false ships with no boot-time non-loopback guard");
  }
});
