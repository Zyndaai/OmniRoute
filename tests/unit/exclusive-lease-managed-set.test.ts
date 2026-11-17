import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lease-managed-set-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");

await apiKeys.getApiKeys();

async function insertKey(input: {
  id: string;
  allowedConnections: string[];
  scopes: string[];
  isActive?: boolean;
  revokedAt?: string | null;
  expiresAt?: string | null;
}): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO api_keys
       (id, name, key, key_hash, machine_id, allowed_models, allowed_connections, scopes, no_log,
        is_active, revoked_at, expires_at, created_at)
     VALUES ($1, $1, $2, $3, 'test', '[]'::jsonb, $4::jsonb, $5::jsonb, true, $6, $7, $8, $9)`,
    [
      input.id,
      `sk-${input.id}`,
      createHash("sha256").update(`sk-${input.id}`).digest("hex"),
      JSON.stringify(input.allowedConnections),
      JSON.stringify(input.scopes),
      input.isActive !== false,
      input.revokedAt ?? null,
      input.expiresAt ?? null,
      new Date().toISOString(),
    ]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("derives the overlapping managed set from active scoped key allowlists", async () => {
  await insertKey({
    id: "managed-a",
    allowedConnections: ["conn-a", "conn-overlap"],
    scopes: ["lease:exclusive"],
  });
  await insertKey({
    id: "managed-b",
    allowedConnections: ["conn-b", "conn-overlap"],
    scopes: ["lease:exclusive"],
  });
  await insertKey({ id: "ordinary", allowedConnections: ["conn-unmanaged"], scopes: [] });
  await insertKey({
    id: "inactive",
    allowedConnections: ["conn-inactive"],
    scopes: ["lease:exclusive"],
    isActive: false,
  });
  await insertKey({
    id: "revoked",
    allowedConnections: ["conn-revoked"],
    scopes: ["lease:exclusive"],
    revokedAt: new Date().toISOString(),
  });
  await insertKey({
    id: "expired",
    allowedConnections: ["conn-expired"],
    scopes: ["lease:exclusive"],
    expiresAt: "2020-01-01T00:00:00.000Z",
  });

  const managed = await apiKeys.getExclusiveLeaseConnectionIds();
  assert.deepEqual([...managed].sort(), ["conn-a", "conn-b", "conn-overlap"]);
});

test("re-derives managed membership after a key expires without cache clearing", async () => {
  await insertKey({
    id: "managed-expiring",
    allowedConnections: ["conn-expiring"],
    scopes: ["lease:exclusive"],
  });
  assert.equal((await apiKeys.getExclusiveLeaseConnectionIds()).has("conn-expiring"), true);

  await getTestBackend().execute("UPDATE api_keys SET expires_at = $1 WHERE id = $2", [
    "2020-01-01T00:00:00.000Z",
    "managed-expiring",
  ]);

  assert.equal((await apiKeys.getExclusiveLeaseConnectionIds()).has("conn-expiring"), false);
});
