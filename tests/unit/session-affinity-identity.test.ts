import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-affinity-identity-"));
process.env.DATA_DIR = dataDir;
delete process.env.REDIS_URL;
const core = await import("../../src/lib/db/core.ts");
const affinity = await import("../../src/lib/db/sessionAccountAffinity.ts");
const pin = await import("../../src/sse/services/sessionAffinityPin.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("SQLite affinity resolves the stored account identity before a colliding connection id", async () => {
  const now = Date.now();
  const selected = {
    id: "local-b",
    provider: "codex",
    authType: "oauth",
    providerSpecificData: {
      workspaceId: "synthetic-workspace",
      chatgptUserId: "synthetic-user",
    },
  };
  // Digest computed with the existing usage-account identity boundaries.
  const record = {
    connectionId: "local-a",
    accountIdentity: "",
    createdAt: new Date(now).toISOString(),
    lastUsedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  record.accountIdentity = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        "oauth",
        "codex",
        "workspace",
        "synthetic-workspace",
        "user",
        "synthetic-user",
      ])
    )
    .digest("hex");
  await affinity.upsertSessionAccountAffinity(
    "identity-session",
    "codex",
    record.connectionId,
    now,
    60_000,
    record.accountIdentity
  );
  const stored = await affinity.getSessionAccountAffinity("identity-session", "codex", 60_000);
  const plan = pin.planSessionAffinityConnection(
    "codex",
    "identity-session",
    [
      { ...selected, id: "local-a", providerSpecificData: { chatgptUserId: "other-user" } },
      selected,
    ],
    60_000,
    stored
  );
  assert.equal(plan?.connection.id, selected.id);
  await affinity.touchSessionAccountAffinity("identity-session", "codex", now + 1, 60_000);
  assert.equal(
    (await affinity.getSessionAccountAffinity("identity-session", "codex", 60_000))?.accountIdentity,
    record.accountIdentity
  );
});
