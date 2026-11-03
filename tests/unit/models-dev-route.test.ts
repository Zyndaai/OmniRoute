import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/settings/models-dev/route";
import { createManagementSessionHeaders } from "../helpers/managementSession.ts";

// A body that fails validation used to return `validation.response`, a field the
// validateBody() failure never has, so the route handed Next.js `undefined`.
test("models-dev POST rejects an invalid action with a 400 naming the field", async () => {
  const request = new NextRequest("http://localhost/api/settings/models-dev", {
    method: "POST",
    headers: await createManagementSessionHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ action: "explode" }),
  });

  const response = await POST(request);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /^action: /);
  assert.equal(body.details[0].field, "action");
});
