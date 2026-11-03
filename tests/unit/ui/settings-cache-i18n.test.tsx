import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider, createFormatter, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CacheSettingsTab from "@/app/(dashboard)/dashboard/settings/components/CacheSettingsTab";
import ar from "@/i18n/messages/ar.json";
// The shared Select renders the kit (Radix) Select for `options` since KEA-7886: no DOM
// <select>/<option>; the helpers read the menu items (data-value) and the controlled value.
import { kitSelectOptions } from "../../helpers/kitSelect";

const model = {
  id: "openai/text-embedding-3-small",
  rawId: "text-embedding-3-small",
  name: "text-embedding-3-small",
  dimensions: 1536,
  maxTokens: 8191,
  supportedInputTypes: ["text", "image"],
};
const config = {
  modelCatalogCacheTtlMs: 1500,
  semanticCacheEnabled: true,
  semanticCacheVectorEnabled: false,
  semanticCacheEmbeddingProvider: "openai",
  semanticCacheEmbeddingModel: model.rawId,
  semanticCacheEmbeddingDimension: 1536,
  embeddingOptions: [{ id: "openai", name: "OpenAI", hasConnection: true, models: [model] }],
};
// Exercise the real catalog and formatter, not the global key-only test mock.
vi.unmock("next-intl");

const s = ar.settings;
// ICU-parameterised strings are expected through the real formatter, so digit shaping and
// plural rules stay whatever next-intl produces for Arabic.
const tr = createTranslator({
  locale: "ar",
  messages: { settings: ar.settings, common: ar.common },
  namespace: "settings",
});
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
      <CacheSettingsTab />
    </NextIntlClientProvider>
  );
}

async function loaded() {
  const view = mount();
  await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveProperty("disabled", false));
  return view;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply(config));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cache settings with real Arabic catalogs", () => {
  it("localizes headings, metadata, accessible controls, Redis and advanced overrides", async () => {
    await loaded();
    expect(screen.getByText(s.semanticCacheTitle)).toBeTruthy();
    expect(screen.getByRole("switch", { name: s.semanticCacheVectorEnable })).toHaveProperty(
      "ariaChecked",
      "false"
    );
    const providerOptions = kitSelectOptions(document.getElementById("sem-provider")!);
    expect(
      providerOptions.find(
        (option) => option.label === tr("semanticCacheConfiguredProvider", { name: "OpenAI" })
      )?.value
    ).toBe("openai");
    const modelOptions = kitSelectOptions(document.getElementById("sem-model")!);
    expect(
      modelOptions.find(
        (option) =>
          option.label ===
          tr("semanticCacheModelDimensions", { name: model.name, count: model.dimensions })
      )?.value
    ).toBe(model.rawId);
    expect(
      screen.getByText(tr("semanticCacheConfiguredConnection", { url: s.semanticCacheDefaultUrl }))
    ).toBeTruthy();
    expect(
      screen.getByText(tr("semanticCacheDimensions", { count: model.dimensions }))
    ).toBeTruthy();
    expect(screen.getByText(tr("semanticCacheMaxTokens", { count: model.maxTokens }))).toBeTruthy();
    expect(
      screen.getByText(
        tr("semanticCacheInputTypes", {
          types: createFormatter({ locale: "ar" }).list([
            s.semanticCacheInputText,
            s.semanticCacheInputImage,
          ]),
        })
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: s.semanticCacheRedis }));
    expect(screen.getByLabelText(s.semanticCacheRedisPrefix)).toHaveProperty(
      "value",
      "omniroute:semcache:"
    );
    expect(screen.getByLabelText(s.semanticCacheRedisUrl)).toHaveProperty(
      "placeholder",
      "redis://127.0.0.1:6379"
    );
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheShowAdvanced }));
    expect(screen.getByLabelText(s.semanticCacheApiKey)).toHaveProperty(
      "placeholder",
      s.semanticCacheApiKeyPlaceholder
    );
    expect(
      screen
        .getByRole("button", { name: s.semanticCacheHideAdvanced })
        .getAttribute("aria-expanded")
    ).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: s.semanticCacheEnable }));
    expect(screen.getByText(s.semanticCacheDisabled)).toBeTruthy();
  });

  it("renders translated TTL validation and saves the unchanged numeric API payload", async () => {
    await loaded();
    const ttl = screen.getByLabelText(ar.settings.modelCatalogCacheTtlLabel);
    fireEvent.change(ttl, { target: { value: "" } });
    expect(screen.getByText(s.modelCatalogTtlRequired)).toBeTruthy();
    const save = screen.getByRole("button", { name: ar.settings.modelCatalogCacheTtlSave });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(ttl, { target: { value: "50" } });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(ttl, { target: { value: "5000" } });
    fetchMock.mockResolvedValueOnce(reply({ modelCatalogCacheTtlMs: 5000 }));
    fireEvent.click(save);
    await screen.findByText(ar.settings.cacheConfigSaveSuccess);
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ modelCatalogCacheTtlMs: 5000 });
  });

  it("localizes saving feedback without translating provider/model/backend wire values", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("tab", { name: s.semanticCacheRedis }));
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheSave }));
    expect(screen.getByRole("button", { name: s.semanticCacheSaving })).toHaveProperty(
      "disabled",
      true
    );
    resolve(reply({ ok: true }));
    await screen.findByText(s.semanticCacheSaveSuccess);
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body).toMatchObject({
      semanticCacheBackend: "redis",
      semanticCacheEmbeddingProvider: "openai",
      semanticCacheEmbeddingModel: model.rawId,
      semanticCacheEmbeddingDimension: 1536,
      semanticCacheVectorEnabled: false,
      semanticCacheRedisPrefix: "omniroute:semcache:",
      semanticCacheTTL: 1800000,
    });
    fetchMock.mockResolvedValueOnce(reply({}, 500));
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheSave }));
    await screen.findByText(s.semanticCacheSaveFailed);
  });

  it.each([undefined, "https://example.com/v1"])(
    "formats complete embedding success messages (endpoint %s)",
    async (url) => {
      await loaded();
      fetchMock.mockResolvedValueOnce(
        reply({ ok: true, dimensions: 1536, latencyMs: 25, resolvedBaseUrl: url })
      );
      fireEvent.click(screen.getByRole("button", { name: s.semanticCacheTest }));
      await screen.findByText(s.semanticCacheConnectionVerified);
      expect(
        screen.getByText(
          url
            ? tr("semanticCacheTestSuccessVia", { dimensions: 1536, latency: 25, url })
            : tr("semanticCacheTestSuccess", { dimensions: 1536, latency: 25 })
        )
      ).toBeTruthy();
      expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
        provider: "openai",
        model: model.rawId,
        dimensions: 1536,
      });
    }
  );

  it("localizes connection errors and missing diagnostics", async () => {
    await loaded();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheTest }));
    await screen.findByText(s.semanticCacheConnectionError);
    expect(screen.queryByText("Failed to fetch")).toBeNull();
    fetchMock.mockResolvedValueOnce(reply({ ok: false }, 400));
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheTest }));
    await screen.findByText(s.semanticCacheUnknownError);
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: "upstream-diagnostic-code" }));
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheTest }));
    await screen.findByText("upstream-diagnostic-code");
  });

  it("localizes purge success and failure while retaining DELETE semantics", async () => {
    await loaded();
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheClear }));
    await screen.findByText(s.semanticCacheClearSuccess);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/cache", { method: "DELETE" });
    fetchMock.mockResolvedValueOnce(reply({}, 500));
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheClear }));
    await screen.findByText(`${s.semanticCacheClearFailed} HTTP 500`);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: s.semanticCacheClear }));
    await screen.findByText(s.semanticCacheClearFailed);
  });

  it("localizes initial load failure", async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 503));
    mount();
    await screen.findByText(ar.settings.cacheConfigLoadFailed);
  });
});
