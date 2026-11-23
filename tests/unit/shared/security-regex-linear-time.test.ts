// Inputs that made the email PII rule, the private-key credential rule and the exact token
// counter run in quadratic time, blocking the event loop for seconds on one request.
import test from "node:test";
import assert from "node:assert/strict";

import { CREDENTIAL_PATTERNS } from "../../../open-sse/utils/credentialPatterns.ts";
import { PII_PATTERNS, processPII } from "../../../src/shared/utils/inputSanitizer.ts";
import { countTextTokens } from "../../../src/shared/utils/tiktokenCounter.ts";

/** Generous: the old forms took several seconds on these inputs. */
const BUDGET_MS = 500;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

test("email PII detection is linear on a long run of local-part characters", () => {
  const text = "ab-".repeat(30_000);
  const { ms } = timed(() => processPII(text, true));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`);
});

test("email PII detection still finds ordinary and glued addresses", () => {
  const email = PII_PATTERNS.find((p) => p.name === "email");
  assert.ok(email);
  const match = (text: string) => text.match(new RegExp(email.pattern.source, "g"));
  assert.deepEqual(match("mail alice@example.com now"), ["alice@example.com"]);
  assert.deepEqual(match("a@b.co-x@c.dd"), ["a@b.co", "-x@c.dd"]);
});

test("private-key credential rule is linear on repeated BEGIN headers with no END", () => {
  const rule = CREDENTIAL_PATTERNS.find((p) => p.name === "private_key");
  assert.ok(rule, "private_key rule exists");
  const text = "-----BEGIN PRIVATE KEY-----\nAAAA\n".repeat(20_000);
  const { value, ms } = timed(() => text.match(new RegExp(rule.regex.source, "g")));
  assert.equal(value, null);
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`);
});

test("private-key credential rule still matches a complete PEM block", () => {
  const rule = CREDENTIAL_PATTERNS.find((p) => p.name === "private_key");
  assert.ok(rule);
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----";
  assert.deepEqual(`before ${pem} after`.match(new RegExp(rule.regex.source, "g")), [pem]);
});

test("token counting estimates long single-class runs and heavy non-ASCII text", () => {
  for (const text of [" ".repeat(7_000), "!".repeat(7_000), "汉".repeat(5_000)]) {
    const { value, ms } = timed(() => countTextTokens(text));
    assert.ok(value > 0);
    assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms for a ${text.length}-char run`);
  }
});
