import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "@/app/api/health/route";

test("GET /api/health stays minimal: 200, no version anywhere", async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("ETag"), null);
  assert.equal(res.headers.get("X-OmniRoute-Version"), null);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.ok(typeof body.timestamp === "string");
  assert.ok(!("version" in body));
});
