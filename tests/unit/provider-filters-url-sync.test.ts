import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  providerFiltersToSearchParams,
  readProviderFiltersFromUrl,
  type ProviderFilterUrlState,
} from "../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts";

/** The query string the filters should produce from `search`, or null when it already matches. */
function sync(search: string, state: ProviderFilterUrlState): URLSearchParams | null {
  return providerFiltersToSearchParams(new URLSearchParams(search), state);
}

describe("readProviderFiltersFromUrl", () => {
  it("parses every supported param", () => {
    const state = readProviderFiltersFromUrl(
      new URLSearchParams("search=openai&model=gpt&mode=compact&cat=free&media=image")
    );
    assert.deepEqual(state, {
      searchQuery: "openai",
      modelSearchQuery: "gpt",
      displayMode: "compact",
      showFreeOnly: true,
      category: null,
      mediaKind: "image",
    });
  });

  it("reads a concrete category and the display mode", () => {
    const state = readProviderFiltersFromUrl(new URLSearchParams("cat=oauth&mode=configured"));
    assert.deepEqual(state, { displayMode: "configured", showFreeOnly: false, category: "oauth" });
  });

  it("ignores invalid category / media / mode values", () => {
    const state = readProviderFiltersFromUrl(
      new URLSearchParams("cat=bogus&mode=unknown&media=audio")
    );
    assert.deepEqual(state, {});
  });

  it("returns empty state for no params", () => {
    assert.deepEqual(readProviderFiltersFromUrl(new URLSearchParams("")), {});
  });
});

describe("providerFiltersToSearchParams", () => {
  it("writes all active filters", () => {
    const next = sync("", {
      searchQuery: "openai",
      modelSearchQuery: "gpt",
      displayMode: "compact",
      category: "oauth",
      showFreeOnly: false,
      mediaKind: "image",
    });
    assert.ok(next);
    assert.equal(next.get("search"), "openai");
    assert.equal(next.get("model"), "gpt");
    assert.equal(next.get("mode"), "compact");
    assert.equal(next.get("cat"), "oauth");
    assert.equal(next.get("media"), "image");
  });

  it("encodes the free-tier filter as cat=free", () => {
    const next = sync("", { showFreeOnly: true, category: null, displayMode: "all" });
    assert.ok(next);
    assert.equal(next.get("cat"), "free");
    assert.equal(next.has("mode"), false);
  });

  it("drops the display-mode param when set back to All", () => {
    const next = sync("mode=compact", { displayMode: "all" });
    assert.ok(next);
    assert.equal(next.has("mode"), false);
  });

  it("removes params whose filters have been cleared", () => {
    const next = sync("mode=compact&cat=oauth&media=image&search=openai", {});
    assert.ok(next);
    assert.equal(next.has("mode"), false);
    assert.equal(next.has("cat"), false);
    assert.equal(next.has("media"), false);
    assert.equal(next.has("search"), false);
  });

  it("preserves unrelated URL params", () => {
    const next = sync("tab=x&mode=compact", {});
    assert.ok(next);
    assert.equal(next.get("tab"), "x");
    assert.equal(next.has("mode"), false);
  });

  it("does not modify the params it was given", () => {
    const current = new URLSearchParams("mode=compact");
    providerFiltersToSearchParams(current, {});
    assert.equal(current.get("mode"), "compact");
  });

  it("returns null when nothing changed", () => {
    assert.equal(sync("search=openai", { searchQuery: "openai" }), null);
  });
});
