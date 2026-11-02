import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ar = require("../../src/i18n/messages/ar.json");
const en = require("../../src/i18n/messages/en.json");

// ─── AR namespace presence ────────────────────────────────────────────────────

test("ar has cliCommon namespace", () => {
  assert.ok(ar.cliCommon, "expected ar.json to have 'cliCommon' namespace");
});

test("ar has cliCode namespace", () => {
  assert.ok(ar.cliCode, "expected ar.json to have 'cliCode' namespace");
});

test("ar has cliAgents namespace", () => {
  assert.ok(ar.cliAgents, "expected ar.json to have 'cliAgents' namespace");
});

test("ar has acpAgents namespace", () => {
  assert.ok(ar.acpAgents, "expected ar.json to have 'acpAgents' namespace");
});

// ─── AR page titles ───────────────────────────────────────────────────────────

test("ar cliCode.title is a non-empty string distinct from English", () => {
  assert.equal(typeof ar.cliCode.title, "string");
  assert.notEqual(ar.cliCode.title, en.cliCode.title);
});

test("ar cliAgents.pageTitle is 'وكلاء CLI'", () => {
  assert.equal(ar.cliAgents.pageTitle, "وكلاء CLI");
});

test("ar acpAgents.pageTitle is 'وكلاء ACP'", () => {
  assert.equal(ar.acpAgents.pageTitle, "وكلاء ACP");
});

// ─── AR cliCommon content ─────────────────────────────────────────────────────

test("ar cliCommon.concept.code.phrase is a non-empty string", () => {
  assert.ok(
    typeof ar.cliCommon.concept?.code?.phrase === "string" &&
      ar.cliCommon.concept.code.phrase.length > 0
  );
});

test("ar cliCommon.comparison.title is non-empty string", () => {
  assert.ok(
    typeof ar.cliCommon.comparison?.title === "string" && ar.cliCommon.comparison.title.length > 0
  );
});

// ─── AR sidebar keys ──────────────────────────────────────────────────────────

test("ar sidebar has cliCode key", () => {
  assert.ok(ar.sidebar?.cliCode, "expected ar sidebar to have 'cliCode' key");
});

test("ar sidebar has cliAgents key", () => {
  assert.ok(ar.sidebar?.cliAgents, "expected ar sidebar to have 'cliAgents' key");
});

test("ar sidebar has acpAgents key", () => {
  assert.ok(ar.sidebar?.acpAgents, "expected ar sidebar to have 'acpAgents' key");
});

// ─── EN namespace presence ────────────────────────────────────────────────────

test("en has cliCommon namespace", () => {
  assert.ok(en.cliCommon, "expected en.json to have 'cliCommon' namespace");
});

test("en has cliCode namespace", () => {
  assert.ok(en.cliCode, "expected en.json to have 'cliCode' namespace");
});

test("en has cliAgents namespace", () => {
  assert.ok(en.cliAgents, "expected en.json to have 'cliAgents' namespace");
});

test("en has acpAgents namespace", () => {
  assert.ok(en.acpAgents, "expected en.json to have 'acpAgents' namespace");
});

// ─── EN page titles ───────────────────────────────────────────────────────────

test("en cliCode.title is 'CLI Code'", () => {
  assert.equal(en.cliCode.title, "CLI Code");
});

test("en cliAgents.pageTitle is 'CLI Agents'", () => {
  assert.equal(en.cliAgents.pageTitle, "CLI Agents");
});

test("en cliAgents.pageTitle is 'ACP Agents'", () => {
  assert.equal(en.acpAgents.pageTitle, "ACP Agents");
});

// ─── EN cliCommon content ─────────────────────────────────────────────────────

test("en cliCommon.concept.code.phrase is a non-empty string", () => {
  assert.ok(
    typeof en.cliCommon.concept?.code?.phrase === "string" &&
      en.cliCommon.concept.code.phrase.length > 0
  );
});

// ─── EN sidebar keys ──────────────────────────────────────────────────────────

test("en sidebar has cliCode key", () => {
  assert.ok(en.sidebar?.cliCode, "expected en sidebar to have 'cliCode' key");
});

test("en sidebar has cliAgents key", () => {
  assert.ok(en.sidebar?.cliAgents, "expected en sidebar to have 'cliAgents' key");
});

test("en sidebar has acpAgents key", () => {
  assert.ok(en.sidebar?.acpAgents, "expected en sidebar to have 'acpAgents' key");
});
