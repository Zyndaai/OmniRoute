import test from "node:test";
import assert from "node:assert/strict";

import {
  isVertexSharedCapacity429,
  isVertexSharedCapacityBody,
  isVertexSharedCapacityResponse,
} from "../../../open-sse/services/vertexSharedCapacity.ts";

const bare = {
  error: { code: 429, message: "Resource exhausted. Please try again later.", status: "RESOURCE_EXHAUSTED" },
};

test("a bare Vertex 'Resource exhausted' 429 is shared capacity, not account quota", () => {
  assert.equal(isVertexSharedCapacityBody("vertex", 429, bare), true);
  assert.equal(isVertexSharedCapacityBody("vertex-partner", 429, [bare]), true);
  assert.equal(isVertexSharedCapacity429("vertex", 429, JSON.stringify(bare)), true);
  assert.equal(isVertexSharedCapacityResponse("vertex", 429, JSON.stringify(bare), false), true);
});

test("quota wording, retry details, other statuses and other providers keep their cooldown", () => {
  const quota = {
    error: { ...bare.error, message: "Resource exhausted: quota exceeded. Try again later." },
  };
  const withDetails = { error: { ...bare.error, details: [{ "@type": "RetryInfo" }] } };
  assert.equal(isVertexSharedCapacityBody("vertex", 429, quota), false);
  assert.equal(isVertexSharedCapacityBody("vertex", 429, withDetails), false);
  assert.equal(isVertexSharedCapacityBody("vertex", 503, bare), false);
  assert.equal(isVertexSharedCapacityBody("gemini", 429, bare), false);
  assert.equal(isVertexSharedCapacityBody("vertex", 429, null), false);
});

test("a client-safe projection without status needs the absence of a retry hint", () => {
  const projected = { error: { message: "Resource exhausted. Please try again later." } };
  assert.equal(isVertexSharedCapacityResponse("vertex", 429, JSON.stringify(projected), false), true);
  assert.equal(isVertexSharedCapacityResponse("vertex", 429, JSON.stringify(projected), true), false);
});
