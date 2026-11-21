// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";

import ComboControlCenterPage, {
  loader,
} from "../../src/app/(dashboard)/dashboard/combos/[id]/page";
import ComboControlCenterClient from "@/app/(dashboard)/dashboard/combos/ComboControlCenterClient";
import Breadcrumbs from "@/shared/components/Breadcrumbs";

// The page delegates rendering to this client component — mock it so the test
// exercises only the param boundary, not the whole control-center graph.
vi.mock("@/app/(dashboard)/dashboard/combos/ComboControlCenterClient", () => ({
  default: function MockComboControlCenterClient() {
    return null;
  },
}));

vi.mock("use-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key;
    t.has = () => false;
    return t;
  },
}));

const loaderState = vi.hoisted(() => ({ data: { id: "" } }));

vi.mock("react-router", () => ({
  useLoaderData: () => loaderState.data,
  useLocation: () => ({ pathname: "/dashboard/combos/auto%2Ffast" }),
  Link: ({
    to,
    children,
    ...p
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...p}>
      {children}
    </a>
  ),
}));

describe("combos/[id] page param boundary", () => {
  it("forwards the already-decoded auto/* id from the loader to the client component", () => {
    // React Router percent-decodes route params before the loader sees them.
    const data = loader({ params: { id: "auto/fast" } });
    expect(data).toEqual({ id: "auto/fast" });
    loaderState.data = data;
    const element = ComboControlCenterPage();
    expect(element.type).toBe(ComboControlCenterClient);
    expect(element.props.comboId).toBe("auto/fast");
    const { comboId } = element.props;
    expect(comboId === "auto" || comboId.startsWith("auto/")).toBe(true);
  });

  it("keeps compound and persisted ids untouched", () => {
    expect(loader({ params: { id: "auto/coding:fast" } })).toEqual({ id: "auto/coding:fast" });
    expect(loader({ params: { id: "fecdd784-7b6b-4e59-9812-d74650d263ff" } })).toEqual({
      id: "fecdd784-7b6b-4e59-9812-d74650d263ff",
    });
  });

  it("does not decode a second layer", () => {
    expect(loader({ params: { id: "auto%2Ffast" } })).toEqual({ id: "auto%2Ffast" });
  });
});

describe("Breadcrumbs encoded segment", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the single-decoded crumb for /dashboard/combos/auto%2Ffast", () => {
    act(() => {
      root.render(<Breadcrumbs />);
    });
    expect(container.textContent).toContain("Auto/fast");
    expect(container.textContent).not.toContain("%2F");
  });
});
