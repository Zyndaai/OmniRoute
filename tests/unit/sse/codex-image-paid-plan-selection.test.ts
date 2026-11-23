// Upstream #19134 (selection half): Codex image selection never picks a Free plan first and does
// not bypass connection scope. The cached-text-quota provenance half needs the DB layer (deferred).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-image-plan-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET ||= "codex-image-plan-test-secret";

const { resetTestDb } = await import("../../helpers/postgres.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const { imageQuotaPreflightOptions } =
  await import("../../../src/sse/services/imageQuotaSelectionPolicy.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function seed(plan: string, priority: number) {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    email: `${plan}-${priority}@example.com`,
    accessToken: `${plan}-${priority}-access`,
    refreshToken: `${plan}-${priority}-refresh`,
    isActive: true,
    testStatus: "active",
    priority,
    providerSpecificData: { workspacePlanType: plan },
  });
}

test("image selection skips a higher-priority Free plan for a paid one", async () => {
  const free = await seed("free", 1);
  const plus = await seed("plus", 2);

  const text = await auth.getProviderCredentials("codex", null, null, "gpt-5.5");
  assert.equal(text?.connectionId, free.id, "text keeps priority order");

  const image = await auth.getProviderCredentials(
    "codex",
    null,
    null,
    "gpt-5.5",
    imageQuotaPreflightOptions("codex")
  );
  assert.equal(image?.connectionId, plus.id);
});

test("image selection keeps the API-key connection scope", async () => {
  const free = await seed("free", 1);
  await seed("plus", 2);
  const image = await auth.getProviderCredentials(
    "codex",
    null,
    [free.id],
    "gpt-5.5",
    imageQuotaPreflightOptions("codex")
  );
  assert.equal(image, null, "a key scoped to a Free account cannot reach images");
});
