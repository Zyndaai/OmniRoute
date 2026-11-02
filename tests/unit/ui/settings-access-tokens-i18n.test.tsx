import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AccessTokensTab from "@/app/(dashboard)/dashboard/settings/components/AccessTokensTab";
import ar from "@/i18n/messages/ar.json";
// The shared Select renders the kit (Radix) Select for `options` since KEA-7886: no DOM
// <select>/<option>; the helpers read the menu items (data-value) and the controlled value.
import { chooseKitSelectValue } from "../../helpers/kitSelect";

const token = {
  id: "demo/read",
  name: "Laptop",
  scope: "read",
  tokenPrefix: "omni_demo",
  createdAt: "2026-01-02T03:04:00Z",
  lastUsedAt: "2026-01-03T04:05:00Z",
  expiresAt: "2027-01-02T03:04:00Z",
  revokedAt: null,
};
// Exercise the real catalog and formatter, not the global key-only test mock.
vi.unmock("next-intl");

// The kit Table measures itself with ResizeObserver (persistent scrollbar); jsdom lacks it.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const s = ar.settings;
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const fetchMock = vi.fn<typeof fetch>();
function mount() {
  return render(
    <NextIntlClientProvider
      locale="ar"
      timeZone="UTC"
      messages={{ settings: ar.settings, common: ar.common }}
      onError={(error) => {
        throw error;
      }}
    >
      <AccessTokensTab />
    </NextIntlClientProvider>
  );
}
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply({ tokens: [token] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("access-token settings with real Arabic catalogs", () => {
  it("translates the table, scope badges and status, and formats dates in the UI locale", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        tokens: [
          token,
          { ...token, id: "write", name: "Writer", scope: "write" },
          {
            ...token,
            id: "admin",
            name: "Admin machine",
            scope: "admin",
            revokedAt: "2026-01-04T00:00:00Z",
            lastUsedAt: null,
            expiresAt: null,
          },
        ],
      })
    );
    mount();
    const table = await screen.findByRole("table");
    expect(screen.getByRole("heading", { name: s.accessTokensTitle })).toBeTruthy();
    for (const label of [
      s.accessTokensColScope,
      s.accessTokensColLastUsed,
      s.accessTokensColExpires,
      s.accessTokensScopeReadLabel,
      s.accessTokensScopeWriteLabel,
      s.accessTokensScopeAdminLabel,
      s.accessTokensStatusRevoked,
    ])
      expect(within(table).getByText(label)).toBeTruthy();
    const expected = new Intl.DateTimeFormat("ar", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(token.lastUsedAt));
    expect(within(table).getAllByText(expected)).toHaveLength(2);
    expect(within(table).getAllByText("—")).toHaveLength(2);
    expect(within(table).queryByText("read")).toBeNull();
  });

  it("keeps malformed dates from breaking the translated token table", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ tokens: [{ ...token, lastUsedAt: "not-a-date", expiresAt: "invalid" }] })
    );
    mount();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Laptop")).toBeTruthy();
    expect(within(table).getAllByText("—")).toHaveLength(2);
  });

  it("creates, copies and dismisses a token without translating its secret or scope payload", async () => {
    mount();
    await screen.findByRole("table");
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    fireEvent.change(screen.getByPlaceholderText(s.accessTokensNamePlaceholder), {
      target: { value: "  Remote laptop  " },
    });
    chooseKitSelectValue(screen.getByRole("combobox"), "admin");
    fireEvent.change(screen.getByPlaceholderText(s.accessTokensExpiresPlaceholder), {
      target: { value: "7" },
    });
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    fireEvent.click(screen.getByRole("button", { name: s.accessTokensCreate }));
    expect(screen.getByRole("button", { name: s.accessTokensCreating })).toHaveProperty(
      "disabled",
      true
    );
    const call = fetchMock.mock.calls.at(-1);
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: "Remote laptop",
      scope: "admin",
      expiresInDays: 7,
    });
    resolve(reply({ token: "omni_disposable_test_secret" }));
    await screen.findByText(s.accessTokensCopyNow);
    expect(screen.getByText("omni_disposable_test_secret")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.accessTokensCopy }));
    await screen.findByRole("button", { name: s.accessTokensCopied });
    expect(copy).toHaveBeenCalledWith("omni_disposable_test_secret");
    fireEvent.click(screen.getByRole("button", { name: s.accessTokensDismiss }));
    expect(screen.queryByText("omni_disposable_test_secret")).toBeNull();
    // The opener ("Create") is disabled again after the name is cleared, so focus goes back
    // to the name field rather than falling to <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByPlaceholderText(s.accessTokensNamePlaceholder)
      )
    );
  });

  it("uses a localized create failure instead of surfacing English transport errors", async () => {
    mount();
    await screen.findByRole("table");
    fireEvent.change(screen.getByPlaceholderText(s.accessTokensNamePlaceholder), {
      target: { value: "demo" },
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: s.accessTokensCreate }));
    await screen.findByText(s.accessTokensCreateError);
    expect(screen.queryByText("Failed to fetch")).toBeNull();
  });

  it.each([
    [
      { error: { message: "expiresInDays must not exceed 3650" } },
      "expiresInDays must not exceed 3650",
    ],
    [{ error: "Permission denied by policy" }, "Permission denied by policy"],
    [{ error: {} }, "HTTP 400"],
  ])(
    "retains server diagnostics with a localized create error prefix (%j)",
    async (body, detail) => {
      mount();
      await screen.findByRole("table");
      fireEvent.change(screen.getByPlaceholderText(s.accessTokensNamePlaceholder), {
        target: { value: "demo" },
      });
      fetchMock.mockResolvedValueOnce(reply(body, 400));
      fireEvent.click(screen.getByRole("button", { name: s.accessTokensCreate }));
      await screen.findByText(`${s.accessTokensCreateError} ${detail}`);
    }
  );

  it("localizes revoke confirmation, cancel and errors, retaining the encoded token id", async () => {
    mount();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: s.accessTokensRevoke }));
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(s.accessTokensRevokeTitle)).toBeTruthy();
    expect(within(dialog).getByText(s.accessTokensRevokeConfirm)).toBeTruthy();
    // In Arabic the cancel and revoke buttons share one label; the cancel button comes first.
    fireEvent.click(within(dialog).getAllByRole("button", { name: ar.common.cancel })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: s.accessTokensRevoke }));
    dialog = screen.getByRole("dialog");
    fetchMock.mockResolvedValueOnce(reply({}, 500));
    fireEvent.click(within(dialog).getAllByRole("button", { name: s.accessTokensRevoke }).at(-1)!);
    await screen.findByText(s.accessTokensRevokeError);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/cli/tokens/demo%2Fread", { method: "DELETE" });
  });

  it("reloads the localized status after successful revocation", async () => {
    mount();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: s.accessTokensRevoke }));
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    fetchMock.mockResolvedValueOnce(
      reply({ tokens: [{ ...token, revokedAt: "2026-01-04T00:00:00Z" }] })
    );
    fireEvent.click(
      within(screen.getByRole("dialog"))
        .getAllByRole("button", { name: s.accessTokensRevoke })
        .at(-1)!
    );
    await screen.findByText(s.accessTokensStatusRevoked);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: s.accessTokensRevoke })).toBeNull()
    );
  });

  it("translates empty and failed-load states", async () => {
    fetchMock.mockResolvedValueOnce(reply({ tokens: [] }));
    const view = mount();
    await screen.findByText(s.accessTokensEmpty);
    view.unmount();
    fetchMock.mockResolvedValueOnce(reply({}, 503));
    mount();
    await screen.findByText(s.accessTokensLoadError);
  });
});
