// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard (release v3.8.44 e2e finding): LocaleAutoDetect called
// router.refresh() on EVERY first visit — even when the detected browser
// locale was exactly the one the server had just rendered — re-navigating the
// page mid-interaction (Playwright: "Execution context was destroyed") and
// flashing for every new visitor. It must refresh ONLY when the detected
// locale differs from <html lang>.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

describe("LocaleAutoDetect refresh gating", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    refresh.mockReset();
    // Fresh visit: no locale cookie.
    document.cookie = "NEXT_LOCALE=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    localStorage.removeItem("NEXT_LOCALE");
    document.documentElement.dir = "ltr";
    Object.defineProperty(navigator, "languages", { value: ["en-US"], configurable: true });
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  async function mount() {
    const { LocaleAutoDetect } = await import("@/shared/components/LocaleAutoDetect");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(LocaleAutoDetect));
    });
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
    });
  }

  it("does NOT refresh when the detected locale equals the server-rendered <html lang>", async () => {
    document.documentElement.lang = "en";
    await mount();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes when the detected locale differs from the server-rendered <html lang>", async () => {
    document.documentElement.lang = "fr";
    await mount();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("persists the detected locale before refreshing server content on a first visit", async () => {
    document.documentElement.lang = "en";
    Object.defineProperty(navigator, "languages", { value: ["ar"], configurable: true });
    refresh.mockImplementation(() => {
      expect(document.cookie).toContain("NEXT_LOCALE=ar");
      expect(localStorage.getItem("NEXT_LOCALE")).toBe("ar");
      expect(document.documentElement.lang).toBe("ar");
      expect(document.documentElement.dir).toBe("rtl");
    });

    await mount();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // Only en and ar ship: a regional Arabic tag resolves to `ar`, and a browser
  // language with no configured locale writes no cookie and does not refresh.
  it("persists ar for a regional Arabic browser (ar-EG)", async () => {
    document.documentElement.lang = "en";
    Object.defineProperty(navigator, "languages", { value: ["ar-EG"], configurable: true });
    await mount();
    expect(document.cookie).toContain("NEXT_LOCALE=ar");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves an unsupported browser language alone", async () => {
    document.documentElement.lang = "en";
    Object.defineProperty(navigator, "languages", { value: ["fil"], configurable: true });
    await mount();
    expect(document.cookie).not.toContain("NEXT_LOCALE=");
    expect(refresh).not.toHaveBeenCalled();
  });
});
