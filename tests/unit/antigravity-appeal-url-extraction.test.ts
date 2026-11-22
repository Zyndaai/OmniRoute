import test from "node:test";
import assert from "node:assert/strict";

import {
  extractVerificationUrl,
  isGoogleVerificationUrl,
  redactVerificationUrls,
} from "../../open-sse/services/antigravityVerification.ts";

const TOS_BODY = {
  error: {
    code: 403,
    message:
      "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "TOS_VIOLATION",
        domain: "cloudcode-pa.googleapis.com",
        metadata: { appeal_url: "https://forms.gle/hGzM9MEUv2azZsrb9" },
      },
    ],
  },
};

test("extracts the Google Forms appeal URL from a TOS_VIOLATION 403", () => {
  const url = extractVerificationUrl(TOS_BODY);
  assert.equal(url, "https://forms.gle/hGzM9MEUv2azZsrb9");
  assert.equal(isGoogleVerificationUrl(url), true);
});

test("only Google account and Forms hosts are accepted as links", () => {
  assert.equal(isGoogleVerificationUrl("https://docs.google.com/forms/d/e/abc/viewform"), true);
  assert.equal(isGoogleVerificationUrl("https://docs.google.com/document/d/abc"), false);
  assert.equal(isGoogleVerificationUrl("https://forms.gle.evil.example/x"), false);
  assert.equal(isGoogleVerificationUrl("http://forms.gle/x"), false);
});

test("redactVerificationUrls masks account and appeal links in a raw body", () => {
  const raw = `{"appeal_url":"https://forms.gle/abc","u":"https://accounts.google.com/signin/continue?x=1"}`;
  const masked = redactVerificationUrls(raw);
  assert.ok(!masked.includes("forms.gle"));
  assert.ok(!masked.includes("accounts.google.com"));
});
