import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { Link, useLoaderData } from "react-router";
import RadarNotFound from "../RadarNotFound";
import { radarRead } from "../radarApi.server";

import type { ComboBuilderOptionsPayload } from "@/lib/combos/builderOptions";
import type { MergedEntry } from "@/lib/radar/applyFeed";
import {
  buildRadarComboSuggestions,
  type RadarComboSuggestion,
} from "@/lib/radar/comboSuggestions";
import { Card } from "@/shared/components";
import Button from "@/shared/components/Button";

interface RadarCatalogPayload {
  entries?: MergedEntry[];
  meta?: unknown;
}

function comboNames(payload: ComboBuilderOptionsPayload): Set<string> {
  return new Set(payload.comboRefs.map((combo) => combo.name));
}

const NO_ENTRIES: MergedEntry[] = [];
const NO_PROVIDERS: ComboBuilderOptionsPayload["providers"] = [];

/**
 * Both reads are required: 404 on the catalog = Radar flag off; any other failure (or an
 * unexpected shape) shows `loadFailed`, as before.
 */
export async function loader() {
  const [catalogRead, optionsRead] = await Promise.all([
    radarRead<RadarCatalogPayload>("/api/radar/catalog"),
    radarRead<ComboBuilderOptionsPayload>("/api/combos/builder/options"),
  ]);
  const catalog = catalogRead.body;
  const options = optionsRead.body;
  if (
    catalogRead.status === 404 ||
    !catalog ||
    !options ||
    !Array.isArray(catalog.entries) ||
    !Array.isArray(options.providers)
  ) {
    return {
      flagOff: catalogRead.status === 404,
      loadFailed: catalogRead.status !== 404,
      entries: NO_ENTRIES,
      providers: NO_PROVIDERS,
      existingNames: [] as string[],
      hasCatalog: false,
    };
  }
  return {
    flagOff: false,
    loadFailed: false,
    entries: catalog.entries,
    providers: options.providers,
    existingNames: [...comboNames(options)],
    hasCatalog: catalog.meta != null,
  };
}

export default function RadarCombosPage() {
  const t = useTranslations("radarCombosPage");
  const {
    flagOff,
    loadFailed,
    entries: loadedEntries,
    providers: loadedProviders,
    existingNames: loadedNames,
    hasCatalog,
  } = useLoaderData<typeof loader>();
  const entries = loadedEntries as MergedEntry[];
  const providers = loadedProviders as ComboBuilderOptionsPayload["providers"];
  // Names grow when a combo is created here; the copy restarts from every new loader result.
  const [existingNames, setExistingNames] = useState<Set<string>>(() => new Set(loadedNames));
  const [shownLoadedNames, setShownLoadedNames] = useState(loadedNames);
  if (loadedNames !== shownLoadedNames) {
    setShownLoadedNames(loadedNames);
    setExistingNames(new Set(loadedNames));
  }
  const [createdNames, setCreatedNames] = useState<Set<string>>(new Set());
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [actionError, setError] = useState("");
  const error = actionError || (loadFailed ? t("loadFailed") : "");

  const suggestions = useMemo(
    () => buildRadarComboSuggestions({ entries, providers, existingComboNames: existingNames }),
    [entries, providers, existingNames]
  );

  const refreshExistingName = useCallback(async (name: string): Promise<boolean> => {
    try {
      const response = await fetch("/api/combos/builder/options");
      if (!response.ok) return false;
      const options = (await response.json()) as ComboBuilderOptionsPayload;
      if (!Array.isArray(options.comboRefs)) return false;
      const names = comboNames(options);
      if (![...names].some((candidate) => candidate.toLowerCase() === name.toLowerCase())) {
        return false;
      }
      setExistingNames(names);
      return true;
    } catch {
      return false;
    }
  }, []);

  const createSuggestion = useCallback(
    async (suggestion: RadarComboSuggestion) => {
      setCreatingName(suggestion.name);
      setError("");
      try {
        const response = await fetch("/api/combos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(suggestion.payload),
        });
        if (!response.ok) {
          if (response.status === 400 && (await refreshExistingName(suggestion.name))) return;
          throw new Error("create_failed");
        }
        setExistingNames((current) => new Set([...current, suggestion.name]));
        setCreatedNames((current) => new Set([...current, suggestion.name]));
      } catch {
        setError(t("createFailed"));
      } finally {
        setCreatingName(null);
      }
    },
    [refreshExistingName, t]
  );

  if (flagOff) return <RadarNotFound />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        compact
        breadcrumbs={
          <Link
            to="/dashboard/radar"
            className="text-sm text-text-muted hover:text-text-main transition-colors"
          >
            ← {t("backToRadar")}
          </Link>
        }
        title={t("title")}
        description={t("subtitle")}
      />

      {error && <div className="p-3 rounded-lg bg-error/10 text-error text-sm">{error}</div>}

      {!hasCatalog ? (
        <Card>
          <p className="text-center text-text-muted py-8">{t("catalogRequired")}</p>
        </Card>
      ) : suggestions.length === 0 ? (
        <Card>
          <p className="text-center text-text-muted py-8">{t("noSuggestions")}</p>
        </Card>
      ) : (
        <div className="grid gap-4">
          {suggestions.map((suggestion) => {
            const creating = creatingName === suggestion.name;
            const created = createdNames.has(suggestion.name);
            return (
              <Card key={suggestion.familyId}>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs uppercase tracking-wide text-text-muted">
                      {t("familyLabel")}
                    </span>
                    <h2 className="text-lg font-semibold font-mono">{suggestion.familyId}</h2>
                    <p className="text-sm text-text-muted">{t("strategyReason")}</p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">{t("modelsLabel")}</span>
                    {suggestion.models.map((model) => (
                      <div
                        key={`${model.providerId}:${model.modelId}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                      >
                        <span className="font-medium">{model.providerName}</span>
                        <span className="font-mono text-sm text-text-muted">
                          {model.qualifiedModel}
                        </span>
                      </div>
                    ))}
                  </div>

                  <Button
                    onClick={() => void createSuggestion(suggestion)}
                    disabled={creating || suggestion.alreadyExists}
                    className="self-start"
                  >
                    {created
                      ? t("created")
                      : suggestion.alreadyExists
                        ? t("alreadyCreated")
                        : creating
                          ? t("generating")
                          : t("generateButton")}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
