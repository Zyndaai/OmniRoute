/**
 * Verifies that the logs/activity route permanently redirects to /dashboard/activity.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loader } from "../../../src/app/(dashboard)/dashboard/logs/activity/page.tsx";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PAGE_PATH = resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "../../../src/app/(dashboard)/dashboard/logs/activity/page.tsx"
);

test("logs/activity loader throws a permanent redirect to /dashboard/activity", () => {
  let thrown: unknown;
  try {
    loader();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Response, "loader must throw a redirect response");
  assert.equal(thrown.status, 308);
  assert.equal(thrown.headers.get("Location"), "/dashboard/activity");
});

test("logs/activity/page.tsx does NOT import AuditLogTab anymore", () => {
  const src = readFileSync(PAGE_PATH, "utf-8");
  assert.ok(
    !src.includes("AuditLogTab"),
    "page.tsx must not reference AuditLogTab after F4 cleanup"
  );
});

test("AuditLogTab.tsx no longer exists (deleted by F4)", () => {
  const AUDIT_LOG_TAB_PATH = resolve(
    import.meta.dirname ?? new URL(".", import.meta.url).pathname,
    "../../../src/app/(dashboard)/dashboard/logs/AuditLogTab.tsx"
  );
  let exists = false;
  try {
    readFileSync(AUDIT_LOG_TAB_PATH);
    exists = true;
  } catch {
    exists = false;
  }
  assert.ok(!exists, "AuditLogTab.tsx must have been deleted");
});

// Also confirm the activity route reads the audit log (its loader) and renders ActivityFeedClient
test("activity/page.tsx loads the audit log and renders ActivityFeedClient", () => {
  const dir = resolve(
    import.meta.dirname ?? new URL(".", import.meta.url).pathname,
    "../../../src/app/(dashboard)/dashboard/activity"
  );
  let src: string;
  try {
    readFileSync(resolve(dir, "ActivityFeedClient.tsx"), "utf-8");
    src = readFileSync(resolve(dir, "page.tsx"), "utf-8");
  } catch {
    assert.fail("activity/page.tsx or ActivityFeedClient.tsx does not exist");
    return;
  }
  assert.ok(src.includes("/api/compliance/audit-log"), "Loader must read the audit-log endpoint");
  // The loader sets level: "high" in the query (produces level=high in the query string)
  assert.ok(
    src.includes('level: "high"') || src.includes("level=high"),
    "Loader must request level=high"
  );
});
