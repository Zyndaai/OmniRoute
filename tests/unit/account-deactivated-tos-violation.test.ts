import test from "node:test";
import assert from "node:assert/strict";

import { isAccountDeactivated } from "../../open-sse/services/accountFallback.ts";

// #19224: Google Cloud Code's TOS_VIOLATION ErrorInfo marks the account deactivated, but only
// with its cloudcode-pa domain: the reason alone could be a prompt echoed into another error.
test("tos_violation with the cloudcode-pa domain deactivates the account", () => {
  const body = JSON.stringify({
    error: {
      code: 403,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "TOS_VIOLATION",
          domain: "cloudcode-pa.googleapis.com",
        },
      ],
    },
  });
  assert.equal(isAccountDeactivated(body), true);
});

test("tos_violation alone, without cloudcode-pa, does not deactivate the account", () => {
  assert.equal(isAccountDeactivated('{"error":{"reason":"TOS_VIOLATION"}}'), false);
  assert.equal(isAccountDeactivated("the user wrote cloudcode-pa in a prompt"), false);
});
