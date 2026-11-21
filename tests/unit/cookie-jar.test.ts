import test from "node:test";
import assert from "node:assert/strict";

import {
  ResponseCookieJar,
  applyCookies,
  redirectWithCookies,
} from "../../src/lib/api/cookieJar.ts";

test("the jar reads cookies from the request it was built for", () => {
  const request = new Request("http://localhost/x", {
    headers: { cookie: "auth_token=abc; other=1" },
  });
  const jar = new ResponseCookieJar(request);
  assert.deepEqual(jar.get("auth_token"), { name: "auth_token", value: "abc" });
  assert.equal(jar.get("missing"), undefined);
});

test("set writes every attribute and defaults the path to /", () => {
  const jar = new ResponseCookieJar(new Request("http://localhost/x"));
  jar.set("auth_token", "tok", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 60 });
  jar.set("plain", "v");
  const response = applyCookies(jar, Response.json({ ok: true }));
  const [first, second] = response.headers.getSetCookie();
  assert.match(first, /^auth_token=tok;/);
  for (const attribute of ["Max-Age=60", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
    assert.ok(first.includes(attribute), `${attribute} missing from ${first}`);
  }
  assert.match(second, /^plain=v; Path=\//);
});

test("delete expires the cookie at the epoch", () => {
  const jar = new ResponseCookieJar(new Request("http://localhost/x"));
  jar.delete("auth_token");
  const [header] = applyCookies(jar, Response.json({})).headers.getSetCookie();
  assert.match(header, /^auth_token=;/);
  assert.ok(header.includes("Path=/"));
  assert.ok(header.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT"));
});

test("a redirect keeps its cookies and Location", () => {
  const jar = new ResponseCookieJar(new Request("http://localhost/x"));
  jar.set("oidc_state", "s", { maxAge: 600 });
  const response = redirectWithCookies(jar, "http://localhost/dashboard");
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/dashboard");
  assert.equal(response.headers.getSetCookie().length, 1);
});

test("applyCookies ignores a store that is not a jar", () => {
  const response = applyCookies({ set() {} }, Response.json({}));
  assert.equal(response.headers.getSetCookie().length, 0);
});
