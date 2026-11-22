import test from "node:test";
import assert from "node:assert/strict";

// Phase 2 usage-db ports with no database involved.

const { captureReasoningSnapshotMeta } = await import("../../src/lib/usage/callLogs.ts");
const { isAccountDeactivatedMessage } =
  await import("../../src/app/api/providers/[id]/test/publicErrorBoundary.ts");

test("captureReasoningSnapshotMeta keeps only scalars of the live response (#19052)", () => {
  assert.deepEqual(
    captureReasoningSnapshotMeta({
      output: [{ type: "reasoning", encrypted_content: "gAAAA-secret-blob" }],
    }),
    { snapshotSource: "encrypted", snapshotChars: null }
  );
  assert.deepEqual(
    captureReasoningSnapshotMeta({
      choices: [{ message: { content: "hi", reasoning_content: "thinking hard" } }],
    }),
    { snapshotSource: "content", snapshotChars: "thinking hard".length }
  );
  assert.deepEqual(captureReasoningSnapshotMeta({ choices: [{ message: { content: "hi" } }] }), {
    snapshotSource: null,
    snapshotChars: null,
  });
});

test("a huge reasoning output array does not overflow the stack", () => {
  const output = Array.from({ length: 200_000 }, () => ({ type: "message" }));
  assert.deepEqual(captureReasoningSnapshotMeta({ output }), {
    snapshotSource: null,
    snapshotChars: null,
  });
});

test("a Google Cloud Code TOS_VIOLATION 403 reads as a deactivated account (#19224)", () => {
  assert.equal(
    isAccountDeactivatedMessage(
      'PERMISSION_DENIED {"reason":"TOS_VIOLATION","domain":"cloudcode-pa.googleapis.com"}'
    ),
    true
  );
  assert.equal(isAccountDeactivatedMessage("This service has been disabled in this account."), true);
  assert.equal(isAccountDeactivatedMessage("tos_violation in some other provider"), false);
});
