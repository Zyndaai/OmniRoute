// @vitest-environment jsdom
/**
 * HighlightableProviderCard — the wrapper owning the back-navigation
 * highlight concern: per-instance highlighted-id state initialized from
 * the id recorded for the current history entry (`location.key`), ref wiring into ProviderCard's
 * imperative handle, and click-time navigation recording.
 *
 * Complements providerPageHighlightLogic.test.tsx (pure utils) and
 * providerCardHandle.test.tsx (imperative handle) by covering the wiring
 * between them.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HighlightableProviderCard from "@/app/(dashboard)/dashboard/providers/components/HighlightableProviderCard";
import {
  readRecordedProvider,
  recordProviderNavigation,
} from "@/app/(dashboard)/dashboard/providers/providerPageHighlightUtils";

const LOCATION_KEY = "list-entry";

vi.mock("use-intl", () => ({ useTranslations: () => (k: string) => k }));
vi.mock("@/shared/components/ProviderTestSlideOver", () => ({ default: () => null }));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));
// Deterministic anchor so the click path does not depend on a router context.
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => () => {},
  useLocation: () => ({ key: LOCATION_KEY, pathname: "/dashboard/providers", search: "" }),
  Link: React.forwardRef(function MockLink(
    { to, children, ...rest }: { to: string; children: React.ReactNode },
    ref: React.Ref<HTMLAnchorElement>
  ) {
    return (
      <a href={to} ref={ref} {...rest}>
        {children}
      </a>
    );
  }),
}));

// jsdom does not implement scrollIntoView or animate. Plain no-ops (not
// vi.fn()) so per-test vi.spyOn never inherits call history through
// vi.restoreAllMocks() restoring a shared mock.
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: () => {},
    writable: true,
    configurable: true,
  });
}
if (typeof Element.prototype.animate === "undefined") {
  Object.defineProperty(Element.prototype, "animate", {
    value: () => ({ cancel: () => {}, finished: Promise.resolve() }),
    writable: true,
    configurable: true,
  });
}

function renderCards(...providerIds: string[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <>
        {providerIds.map((id) => (
          <HighlightableProviderCard
            key={id}
            providerId={id}
            provider={{ id, name: id }}
            stats={{ total: 1, connected: 1, error: 0, warning: 0 }}
            authType="apikey"
            onToggle={() => {}}
          />
        ))}
      </>
    );
  });
  return container;
}

describe("HighlightableProviderCard", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    if (container) {
      document.body.removeChild(container);
      container = null;
    }
  });

  it("scrolls and highlights on mount when the recorded provider id matches", () => {
    recordProviderNavigation(LOCATION_KEY, "openai");
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const animateSpy = vi.spyOn(Element.prototype, "animate");

    container = renderCards("openai");

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(animateSpy).toHaveBeenCalled();
  });

  it("does not scroll or highlight when the recorded id is a different provider", () => {
    recordProviderNavigation(LOCATION_KEY, "anthropic");
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const animateSpy = vi.spyOn(Element.prototype, "animate");

    container = renderCards("openai");

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("does not highlight a provider recorded for another history entry", () => {
    recordProviderNavigation("some-other-entry", "openai");
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    container = renderCards("openai");

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does nothing when nothing was recorded", () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const animateSpy = vi.spyOn(Element.prototype, "animate");

    container = renderCards("openai");

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("among several cards only the one matching the recorded provider id reacts", () => {
    recordProviderNavigation(LOCATION_KEY, "cursor");
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const animateSpy = vi.spyOn(Element.prototype, "animate");

    container = renderCards("openai", "cursor", "kimi-coding");

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(animateSpy).toHaveBeenCalledTimes(1);
  });

  it("records the clicked provider id against the current history entry", () => {
    container = renderCards("openai");
    const link = container.querySelector("a");
    expect(link).not.toBeNull();

    act(() => {
      link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(readRecordedProvider(LOCATION_KEY)).toBe("openai");
  });
});
