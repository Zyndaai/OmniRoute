// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CompatibleNodeCard from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/CompatibleNodeCard";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => navigate,
}));

vi.mock("@/shared/components", async () => ({
  // KEA-7886: form adapters (Button/Input/Checkbox/Select/FilterPills) as DOM-faithful stubs
  ...(await import("../../helpers/sharedComponentStubs")).formStubs,
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("use-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/shared/components/ProviderIcon", () => ({
  default: () => null,
}));

function renderCard(container: HTMLDivElement) {
  const root = createRoot(container);
  return root;
}

describe("CompatibleNodeCard provider deletion (#12298)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    navigate.mockClear();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = renderCard(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // The confirm is an in-app dialog (the translation mock renders keys as text).
  async function clickDelete(answer: "confirmAction" | "cancel" = "confirmAction") {
    await act(async () => {
      root.render(
        <CompatibleNodeCard
          providerId="custom-node"
          providerNode={{ baseUrl: "https://example.test/v1", apiType: "openai" }}
          isCcCompatible={false}
          isAnthropicCompatible={false}
          isAnthropicProtocolCompatible={false}
          gateConnectionFlow={(callback) => callback()}
          openApiKeyAddFlow={vi.fn()}
          onOpenEditNodeModal={vi.fn()}
          t={(key) => key}
        />
      );
    });

    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "delete"
    );
    expect(deleteButton).toBeDefined();

    await act(async () => {
      deleteButton?.click();
    });

    const answerButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === answer
    );
    expect(answerButton, "expected the in-app confirm dialog").toBeDefined();

    await act(async () => {
      answerButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    return deleteButton;
  }

  it("navigates back to the providers list after a successful delete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response));

    await clickDelete();

    expect(fetch).toHaveBeenCalledWith("/api/provider-nodes/custom-node", {
      method: "DELETE",
    });
    expect(navigate).toHaveBeenCalledWith("/dashboard/providers");
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("does not navigate when the user cancels the confirm dialog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response));

    await clickDelete("cancel");

    expect(fetch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate when the DELETE response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false } as Response));

    await clickDelete();

    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate when the DELETE request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await clickDelete();

    expect(navigate).not.toHaveBeenCalled();
  });
});
