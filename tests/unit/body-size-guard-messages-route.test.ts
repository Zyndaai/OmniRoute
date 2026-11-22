import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_BYTES_LLM_API,
  getBodySizeLimit,
} from "../../src/shared/middleware/bodySizeGuard.ts";
import { requestBodyLimitMbToBytes } from "../../src/shared/constants/bodySize.ts";

test("/api/v1/messages gets the 50 MB LLM API floor by default", () => {
  assert.equal(getBodySizeLimit("/api/v1/messages"), MAX_BODY_BYTES_LLM_API);
  assert.equal(getBodySizeLimit("/api/v1/messages", { maxBodySizeMb: 10 }), MAX_BODY_BYTES_LLM_API);
});

test("/api/v1/messages honours a larger saved limit", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/messages", { maxBodySizeMb: 200 }),
    requestBodyLimitMbToBytes(200)
  );
});
