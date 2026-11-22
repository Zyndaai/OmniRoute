import { useCallback, useEffect, useMemo, useState } from "react";
import { useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { useTranslations } from "use-intl";

import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { skipSearchOnlyRevalidation } from "@/shared/utils/routeRevalidation";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { Button, Card, ConfirmModal, EmptyState, Skeleton } from "@/shared/components";
import CatalogBulkActionBar from "./CatalogBulkActionBar";
import {
  BULK_CONFIRM_COMBO_THRESHOLD,
  BULK_CONFIRM_MODEL_THRESHOLD,
  dedupeComboTargets,
  dedupeModelTargets,
  type ComboTestTarget,
  type ModelTestTarget,
} from "./catalogBulkUtils";
import CatalogTabs, { catalogPanelId, catalogTabId } from "./CatalogTabs";
import { countCatalogVisibility } from "./catalogVisibility";
import ComboCatalogFiltersComponent from "./ComboCatalogFilters";
import ComboCatalogTable from "./ComboCatalogTable";
import {
  filterCatalogCombos,
  flattenCombos,
  getComboCatalogPage,
  sortCatalogCombos,
  type ComboCatalogFilters,
  type ComboCatalogRow,
  type ComboSortDirection,
  type ComboSortField,
} from "./comboCatalogUtils";
import ModelCatalogFiltersComponent from "./ModelCatalogFilters";
import ModelCatalogTable from "./ModelCatalogTable";
import {
  extractCatalogCapabilities,
  filterCatalogModels,
  flattenCatalog,
  getCatalogPage,
  sortCatalogModels,
  type CatalogFilters,
  type CatalogModelRow,
  type CatalogSortDirection,
  type CatalogSortField,
} from "./modelCatalogUtils";
import {
  buildCatalogSearchParams,
  DEFAULT_COMBO_FILTERS,
  DEFAULT_MODEL_FILTERS,
  hasActiveComboFilters,
  hasActiveModelFilters,
  parseCatalogTab,
  parseComboFilters,
  parseModelFilters,
  restrictComboFiltersToOptions,
  restrictModelFiltersToOptions,
  type CatalogTab,
} from "./catalogUrlState";
import { useApiKeyAccessIndex } from "./useApiKeyAccessIndex";
import CatalogKeyAssignDialog from "./CatalogKeyAssignDialog";
import CatalogKeyAccessButton from "./CatalogKeyAccessButton";
import { isKeyAssignableModel, type AssignItem } from "./keyAccessAssignUtils";
import { useCatalogTestRunner } from "./useCatalogTestRunner";
import { useCatalogVisibility } from "./useCatalogVisibility";

const PAGE_SIZE = 50;

type PendingBulkRun =
  { kind: "models"; targets: ModelTestTarget[] } | { kind: "combos"; targets: ComboTestTarget[] };

type HealthState = "healthy" | "degraded" | "down";

/**
 * The tab and the filters live in the query string but only filter the rows already loaded, so
 * changing them must not re-run the three reads. Same-URL revalidation (Refresh, after a
 * visibility change) still does.
 */
export const shouldRevalidate = skipSearchOnlyRevalidation;

/**
 * The catalog (with hidden rows), the combos and the provider health matrix. Each read is
 * optional, as before: a failing catalog or combo read shows its error panel (with Retry), a
 * failing health matrix leaves the health badges out.
 */
export async function loader() {
  const [catalogBody, combosBody, matrixBody] = await Promise.all([
    apiJsonOrNull<{ catalog?: unknown }>("/api/models/catalog", { query: { includeHidden: 1 } }),
    apiJsonOrNull<{ combos?: unknown }>("/api/combos"),
    apiJsonOrNull<{ providers?: Array<{ provider: string; state: HealthState }> }>(
      "/api/providers/health-matrix"
    ),
  ]);
  const providerHealthMap: Record<string, HealthState> = {};
  for (const item of matrixBody?.providers || []) {
    if (item.provider) providerHealthMap[item.provider] = item.state;
  }
  return {
    models: flattenCatalog(catalogBody?.catalog ?? null),
    modelsError: catalogBody === null,
    combos: flattenCombos(combosBody?.combos ?? null),
    combosError: combosBody === null,
    providerHealthMap,
  };
}

function useCatalogPageState() {
  const t = useTranslations("modelCatalog");
  const revalidator = useRevalidator();
  const loaded = useLoaderData<typeof loader>();
  const models = loaded.models as CatalogModelRow[];
  const combos = loaded.combos as ComboCatalogRow[];
  const providerHealthMap = loaded.providerHealthMap;
  // True while the loader re-runs (Refresh, Retry, after a visibility change).
  const reloading = revalidator.state !== "idle";
  const modelsLoading = reloading;
  const combosLoading = reloading;
  const modelsError = loaded.modelsError && !reloading;
  const combosError = loaded.combosError && !reloading;

  // The tab and the filters live in the query string (a shareable view); changes go through
  // `setSearchParams` in `useCatalogPageActions`.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = useMemo(() => parseCatalogTab(searchParams), [searchParams]);
  const rawModelFilters = useMemo(() => parseModelFilters(searchParams), [searchParams]);
  const rawComboFilters = useMemo(() => parseComboFilters(searchParams), [searchParams]);
  const [pendingBulkRun, setPendingBulkRun] = useState<PendingBulkRun | null>(null);

  // Models State
  const [modelSortField, setModelSortField] = useState<CatalogSortField>("provider");
  const [modelSortDirection, setModelSortDirection] = useState<CatalogSortDirection>("asc");
  const [requestedModelPage, setRequestedModelPage] = useState(0);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());

  // Combos State
  const [comboSortField, setComboSortField] = useState<ComboSortField>("name");
  const [comboSortDirection, setComboSortDirection] = useState<ComboSortDirection>("asc");
  const [requestedComboPage, setRequestedComboPage] = useState(0);
  const [selectedComboIds, setSelectedComboIds] = useState<Set<string>>(new Set());

  const runner = useCatalogTestRunner();
  return {
    ...runner,
    activeTab,
    searchParams,
    setSearchParams,
    pendingBulkRun,
    setPendingBulkRun,
    models,
    modelsLoading,
    modelsError,
    modelSortField,
    setModelSortField,
    modelSortDirection,
    setModelSortDirection,
    requestedModelPage,
    setRequestedModelPage,
    selectedModelIds,
    setSelectedModelIds,
    combos,
    combosLoading,
    combosError,
    comboSortField,
    setComboSortField,
    comboSortDirection,
    setComboSortDirection,
    requestedComboPage,
    setRequestedComboPage,
    selectedComboIds,
    setSelectedComboIds,
    providerHealthMap,
    revalidator,
    rawModelFilters,
    rawComboFilters,
    t,
  };
}
/** Reload the catalog, combos and health matrix: re-run the route loader. */
function useCatalogPageLoading(state: ReturnType<typeof useCatalogPageState>) {
  const { revalidator } = state;
  const loadData = useCallback(() => revalidator.revalidate(), [revalidator]);
  const refreshAll = useCallback(() => {
    void revalidator.revalidate();
  }, [revalidator]);

  return { loadData, refreshAll };
}

function useCatalogPageOptions(state: ReturnType<typeof useCatalogPageState>) {
  const { models, combos, rawModelFilters, rawComboFilters } = state;
  // Derived filter options for models
  const providerOptions = useMemo(
    () =>
      [...new Map(models.map((m) => [m.providerId, m.provider])).entries()].sort(
        ([left], [right]) => left.localeCompare(right)
      ),
    [models]
  );
  const typeOptions = useMemo(
    () => [...new Set(models.map((m) => m.type))].sort((a, b) => a.localeCompare(b)),
    [models]
  );
  const subtypeOptions = useMemo(
    () =>
      [...new Set(models.map((m) => m.subtype).filter((s): s is string => Boolean(s)))].sort(
        (a, b) => a.localeCompare(b)
      ),
    [models]
  );
  const capabilityOptions = useMemo(() => extractCatalogCapabilities(models), [models]);

  // Derived filter options for combos
  const strategyOptions = useMemo(
    () => [...new Set(combos.map((c) => c.strategy))].sort((a, b) => a.localeCompare(b)),
    [combos]
  );

  // Free-form URL values (provider, type, …) are checked against the loaded options, but only
  // while options exist. Loading flags are not enough: a Refresh keeps the previous rows, and a
  // failed load has no options at all, so gating on them would flash an empty table or drop
  // perfectly valid filters from the URL.
  const modelOptionsKnown = models.length > 0;
  const comboOptionsKnown = combos.length > 0;
  const modelFilters = useMemo(
    () =>
      modelOptionsKnown
        ? restrictModelFiltersToOptions(rawModelFilters, {
            providerIds: providerOptions.map(([id]) => id),
            types: typeOptions,
            subtypes: subtypeOptions,
            capabilities: capabilityOptions,
          })
        : rawModelFilters,
    [
      rawModelFilters,
      modelOptionsKnown,
      providerOptions,
      typeOptions,
      subtypeOptions,
      capabilityOptions,
    ]
  );
  const comboFilters = useMemo(
    () =>
      comboOptionsKnown
        ? restrictComboFiltersToOptions(rawComboFilters, strategyOptions)
        : rawComboFilters,
    [rawComboFilters, comboOptionsKnown, strategyOptions]
  );

  return {
    providerOptions,
    typeOptions,
    subtypeOptions,
    capabilityOptions,
    strategyOptions,
    modelOptionsKnown,
    comboOptionsKnown,
    modelFilters,
    comboFilters,
  };
}

function useCatalogPageSelection(
  state: ReturnType<typeof useCatalogPageState> & {
    modelPage: ReturnType<typeof getCatalogPage<CatalogModelRow>>;
    comboPage: ReturnType<typeof getComboCatalogPage<ComboCatalogRow>>;
  }
) {
  const {
    selectedModelIds,
    setSelectedModelIds,

    selectedComboIds,
    setSelectedComboIds,
    modelPage,
    comboPage,
  } = state;
  // Selection handlers for models
  const toggleSelectModel = (id: string) => {
    setSelectedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllModelsOnPage = () => {
    const pageIds = modelPage.rows.map((r) => `${r.providerId}:${r.id}`);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedModelIds.has(id));
    setSelectedModelIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  // Selection handlers for combos
  const toggleSelectCombo = (id: string) => {
    setSelectedComboIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllCombosOnPage = () => {
    const pageIds = comboPage.rows.map((r) => r.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedComboIds.has(id));
    setSelectedComboIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  return {
    toggleSelectModel,
    toggleSelectAllModelsOnPage,
    toggleSelectCombo,
    toggleSelectAllCombosOnPage,
  };
}

function useCatalogPageActions(
  state: ReturnType<typeof useCatalogPageState>,
  options: ReturnType<typeof useCatalogPageOptions>
) {
  const {
    activeTab,
    searchParams,
    setSearchParams,
    setRequestedModelPage,
    setRequestedComboPage,
    models,
    combos,
    providerHealthMap,
    testResults,
    modelSortField,
    modelSortDirection,
    comboSortField,
    comboSortDirection,
    requestedModelPage,
    requestedComboPage,
  } = state;
  const { modelFilters, comboFilters } = options;
  // The query string follows the tab and the filters (a replace, so filtering does not fill the
  // history). The filters are the normalised ones, so a value the catalog does not know (a stale
  // bookmark) is dropped from the URL once the options are loaded; an equal URL is left alone.
  useEffect(() => {
    const next = buildCatalogSearchParams(activeTab, modelFilters, comboFilters);
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true, preventScrollReset: true });
  }, [activeTab, modelFilters, comboFilters, searchParams, setSearchParams]);

  const writeUrl = (
    tab: CatalogTab,
    nextModelFilters: CatalogFilters,
    nextComboFilters: ComboCatalogFilters
  ) => {
    setSearchParams(buildCatalogSearchParams(tab, nextModelFilters, nextComboFilters), {
      replace: true,
      preventScrollReset: true,
    });
  };

  const switchTab = (tab: CatalogTab) => {
    writeUrl(tab, modelFilters, comboFilters);
  };

  const updateModelFilters = (patch: Partial<CatalogFilters>) => {
    writeUrl(activeTab, { ...modelFilters, ...patch }, comboFilters);
    setRequestedModelPage(0);
  };

  const clearModelFilters = () => {
    writeUrl(activeTab, DEFAULT_MODEL_FILTERS, comboFilters);
    setRequestedModelPage(0);
  };

  const updateComboFilters = (patch: Partial<ComboCatalogFilters>) => {
    writeUrl(activeTab, modelFilters, { ...comboFilters, ...patch });
    setRequestedComboPage(0);
  };

  const clearComboFilters = () => {
    writeUrl(activeTab, modelFilters, DEFAULT_COMBO_FILTERS);
    setRequestedComboPage(0);
  };

  // Filtered & Sorted Models
  const visibleModels = useMemo(() => {
    const filtered = filterCatalogModels(models, modelFilters, {
      providerHealthMap,
      testResults,
    });
    return sortCatalogModels(filtered, modelSortField, modelSortDirection);
  }, [models, modelFilters, providerHealthMap, testResults, modelSortField, modelSortDirection]);
  const modelPage = getCatalogPage(visibleModels, requestedModelPage, PAGE_SIZE);

  // Filtered & Sorted Combos
  const visibleCombos = useMemo(() => {
    const filtered = filterCatalogCombos(combos, comboFilters, testResults);
    return sortCatalogCombos(filtered, comboSortField, comboSortDirection);
  }, [combos, comboFilters, testResults, comboSortField, comboSortDirection]);
  const comboPage = getComboCatalogPage(visibleCombos, requestedComboPage, PAGE_SIZE);

  const selection = useCatalogPageSelection({ ...state, modelPage, comboPage });
  return {
    ...selection,
    switchTab,
    updateModelFilters,
    clearModelFilters,
    updateComboFilters,
    clearComboFilters,
    visibleModels,
    visibleCombos,
    modelPage,
    comboPage,
  };
}
function useCatalogPageBulkActions(
  state: ReturnType<typeof useCatalogPageState>,
  actions: ReturnType<typeof useCatalogPageActions>
) {
  const {
    testBulkModels,
    testBulkCombos,
    pendingBulkRun,
    setPendingBulkRun,
    activeTab,
    models,
    combos,
    selectedModelIds,
    selectedComboIds,
  } = state;
  const { visibleModels, visibleCombos } = actions;
  // Bulk test triggers: exact duplicates are dropped before counting, and large runs are
  // confirmed first because every test spends provider quota.
  const startBulkRun = (run: PendingBulkRun) => {
    if (run.kind === "models") void testBulkModels(run.targets);
    else void testBulkCombos(run.targets);
  };

  const requestBulkRun = (run: PendingBulkRun) => {
    if (run.targets.length === 0) return;
    const threshold =
      run.kind === "models" ? BULK_CONFIRM_MODEL_THRESHOLD : BULK_CONFIRM_COMBO_THRESHOLD;
    if (run.targets.length > threshold) setPendingBulkRun(run);
    else startBulkRun(run);
  };

  const confirmPendingBulkRun = () => {
    const run = pendingBulkRun;
    setPendingBulkRun(null);
    if (run) startBulkRun(run);
  };

  const toModelTargets = (rows: CatalogModelRow[]) =>
    dedupeModelTargets(rows.map((m) => ({ providerId: m.providerId, modelId: m.id })));
  const toComboTargets = (rows: ComboCatalogRow[]) =>
    dedupeComboTargets(rows.map((c) => ({ comboName: c.name })));

  const handleTestSelected = () => {
    if (activeTab === "models") {
      const selected = models.filter((m) => selectedModelIds.has(`${m.providerId}:${m.id}`));
      requestBulkRun({ kind: "models", targets: toModelTargets(selected) });
    } else {
      const selected = combos.filter((c) => selectedComboIds.has(c.id));
      requestBulkRun({ kind: "combos", targets: toComboTargets(selected) });
    }
  };

  const handleTestAllFiltered = () => {
    if (activeTab === "models") {
      requestBulkRun({ kind: "models", targets: toModelTargets(visibleModels) });
    } else {
      requestBulkRun({ kind: "combos", targets: toComboTargets(visibleCombos) });
    }
  };

  return { confirmPendingBulkRun, handleTestSelected, handleTestAllFiltered };
}
function useCatalogPageAssignment(state: ReturnType<typeof useCatalogPageState>) {
  const keyIndex = useApiKeyAccessIndex();
  const [assignKind, setAssignKind] = useState<CatalogTab | null>(null);
  const openAssign = (kind: CatalogTab) => {
    setAssignKind(kind);
    void keyIndex.ensureLoaded();
  };
  const selectedModelRows = state.models.filter((m) =>
    state.selectedModelIds.has(`${m.providerId}:${m.id}`)
  );
  const assignItems: AssignItem[] =
    assignKind === "models"
      ? selectedModelRows
          .filter(isKeyAssignableModel)
          .map((model) => ({ id: model.id, providerId: model.providerId }))
      : state.combos
          .filter((combo) => state.selectedComboIds.has(combo.id))
          .map((combo) => ({ id: combo.name }));
  const excludedAssignCount =
    assignKind === "models" ? selectedModelRows.length - assignItems.length : 0;
  return { keyIndex, assignKind, setAssignKind, openAssign, assignItems, excludedAssignCount };
}
function CatalogAssignmentDialog({ context }: { context: CatalogPageContext }) {
  const { assignKind, assignItems, excludedAssignCount, keyIndex, setAssignKind } = context;
  return assignKind ? (
    <CatalogKeyAssignDialog
      kind={assignKind}
      items={assignItems}
      excludedCount={excludedAssignCount}
      index={keyIndex}
      onClose={() => setAssignKind(null)}
    />
  ) : null;
}
/** Hide/show controls, offered once the catalog carries visibility data (`includeHidden`). */
function useCatalogPageVisibility(
  state: ReturnType<typeof useCatalogPageState>,
  loading: ReturnType<typeof useCatalogPageLoading>,
  actions: ReturnType<typeof useCatalogPageActions>
) {
  const { models, t } = state;
  const { visibilityBusy, applyVisibility } = useCatalogVisibility(
    loading.loadData,
    t("visibilityUpdateFailed")
  );
  if (!models.some((model) => model.visibility)) return { visibilityBusy };
  const filtered = countCatalogVisibility(actions.visibleModels.filter((m) => m.visibility));
  return {
    visibilityBusy,
    visibilityCounts: countCatalogVisibility(models),
    visibilityActions: {
      hideCount: filtered.visible,
      showCount: filtered.hidden,
      busy: visibilityBusy,
      onHideFiltered: () => void applyVisibility(actions.visibleModels, true),
      onShowFiltered: () => void applyVisibility(actions.visibleModels, false),
    },
    toggleModelVisibility: (row: CatalogModelRow) =>
      void applyVisibility([row], row.hidden !== true),
  };
}
function useCatalogPageContext() {
  const state = useCatalogPageState();
  const loading = useCatalogPageLoading(state);
  const options = useCatalogPageOptions(state);
  const actions = useCatalogPageActions(state, options);
  const bulk = useCatalogPageBulkActions(state, actions);
  const assignment = useCatalogPageAssignment(state);
  const visibility = useCatalogPageVisibility(state, loading, actions);
  return {
    ...assignment,
    ...state,
    ...loading,
    ...options,
    ...actions,
    ...bulk,
    ...visibility,
    hasModelFiltersActive: hasActiveModelFilters(options.modelFilters),
    hasComboFiltersActive: hasActiveComboFilters(options.comboFilters),
    hasTestResults: Object.keys(state.testResults).length > 0,
  };
}
type CatalogPageContext = ReturnType<typeof useCatalogPageContext>;
function CatalogHeader({ context }: { context: CatalogPageContext }) {
  const { t, refreshAll, switchTab, activeTab, models, modelsLoading, combos, combosLoading } =
    context;
  const { visibilityCounts } = context;
  return (
    <>
      <div className="flex flex-col gap-2">
        <PageHeader
          compact
          title={t("title")}
          description={t("subtitle")}
          actions={
            <Button
              variant="secondary"
              icon="refresh"
              loading={modelsLoading || combosLoading}
              onClick={refreshAll}
            >
              {t("refresh")}
            </Button>
          }
        />
        {visibilityCounts && (
          <p className="text-xs text-text-muted" data-testid="catalog-visibility-counts">
            {t("visibilityCounts", visibilityCounts)}
          </p>
        )}

        <CatalogTabs
          activeTab={activeTab}
          onSelect={switchTab}
          ariaLabel={t("catalogSections")}
          labels={{
            models: `${t("modelsTab")} (${models.length})`,
            combos: `${t("combosTab")} (${combos.length})`,
          }}
        />
      </div>
    </>
  );
}

function CatalogModelsPanel({ context }: { context: CatalogPageContext }) {
  const { activeTab } = context;
  return (
    <>
      {/* Models Tab Content */}
      {activeTab === "models" && (
        <section
          role="tabpanel"
          id={catalogPanelId("models")}
          aria-labelledby={catalogTabId("models")}
          className="flex flex-col gap-4"
        >
          <Card padding="none" className="overflow-hidden">
            <CatalogModelsFilters context={context} />

            <CatalogModelsBulkActions context={context} />

            <CatalogModelsContent context={context} />
          </Card>
        </section>
      )}
    </>
  );
}

function CatalogModelsFilters({ context }: { context: CatalogPageContext }) {
  const {
    providerOptions,
    typeOptions,
    subtypeOptions,
    capabilityOptions,
    modelFilters,
    updateModelFilters,
    clearModelFilters,
    visibleModels,
    hasModelFiltersActive,
  } = context;
  return (
    <>
      <ModelCatalogFiltersComponent
        filters={modelFilters}
        onChange={updateModelFilters}
        onClear={clearModelFilters}
        providerOptions={providerOptions}
        typeOptions={typeOptions}
        subtypeOptions={subtypeOptions}
        capabilityOptions={capabilityOptions}
        hasActiveFilters={hasModelFiltersActive}
        totalCount={visibleModels.length}
      />
    </>
  );
}

function CatalogModelsBulkActions({ context }: { context: CatalogPageContext }) {
  const {
    visibleModels,
    handleTestSelected,
    handleTestAllFiltered,
    hasTestResults,
    selectedModelIds,
    running,
    progress,
    cancelTest,
    clearResults,
    visibilityActions,
  } = context;
  const { openAssign } = context;
  return (
    <>
      <CatalogBulkActionBar
        selectedCount={selectedModelIds.size}
        filteredCount={visibleModels.length}
        running={running}
        progress={progress}
        hasTestResults={hasTestResults}
        onTestSelected={handleTestSelected}
        onTestFiltered={handleTestAllFiltered}
        onCancel={cancelTest}
        onClearResults={clearResults}
        onAssign={() => openAssign("models")}
        visibilityActions={visibilityActions}
      />
    </>
  );
}

function CatalogModelsContent({ context }: { context: CatalogPageContext }) {
  const { t, refreshAll, clearModelFilters, visibleModels, models, modelsLoading, modelsError } =
    context;
  return (
    <>
      {modelsLoading && models.length === 0 ? (
        <div role="status" aria-live="polite" className="flex min-h-64 flex-col gap-2 p-4">
          {/* Skeleton rows (CSS only): the kit TableLoadingState brand loader animates on timers. */}
          <span className="ci-sr-only">{t("loading")}</span>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : modelsError && models.length === 0 ? (
        <div
          role="alert"
          className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center"
        >
          <p className="text-sm text-text-main">{t("unableToLoad")}</p>
          <p className="text-sm text-text-muted">{t("checkConnection")}</p>
          <Button variant="secondary" onClick={refreshAll}>
            {t("retry")}
          </Button>
        </div>
      ) : visibleModels.length === 0 ? (
        <EmptyState
          className="min-h-64"
          icon="search_off"
          title={models.length === 0 ? t("noModelsAvailable") : t("noModelsMatch")}
          actionLabel={models.length > 0 ? t("clearFilters") : ""}
          onAction={models.length > 0 ? clearModelFilters : null}
        />
      ) : (
        <CatalogModelsResults context={context} />
      )}
    </>
  );
}

function CatalogModelsResults({ context }: { context: CatalogPageContext }) {
  const {
    t,
    visibleModels,
    modelPage,
    toggleSelectModel,
    toggleSelectAllModelsOnPage,
    modelsLoading,
    modelsError,
    modelSortField,
    setModelSortField,
    modelSortDirection,
    setModelSortDirection,
    setRequestedModelPage,
    selectedModelIds,
    providerHealthMap,
    testResults,
    running,
    activeItemKeys,
    testSingleModel,
    toggleModelVisibility,
    visibilityBusy,
  } = context;
  const { keyIndex } = context;
  return (
    <ModelCatalogTable
      rows={modelPage.rows}
      sortField={modelSortField}
      sortDirection={modelSortDirection}
      onSort={(field) => {
        if (field === modelSortField) {
          setModelSortDirection((curr) => (curr === "asc" ? "desc" : "asc"));
        } else {
          setModelSortField(field);
          setModelSortDirection("asc");
        }
        setRequestedModelPage(0);
      }}
      page={modelPage.page + 1}
      pageCount={modelPage.pageCount}
      startIndex={modelPage.page * PAGE_SIZE}
      totalCount={visibleModels.length}
      loading={modelsLoading}
      error={modelsError}
      onPrevious={() => setRequestedModelPage((c) => Math.max(0, c - 1))}
      onNext={() => setRequestedModelPage((c) => Math.min(modelPage.pageCount - 1, c + 1))}
      labels={{
        provider: t("provider"),
        model: t("model"),
        type: t("type"),
        capabilities: t("capabilities"),
        context: t("context"),
        output: t("output"),
        flags: t("flags"),
        custom: t("custom"),
        free: t("free"),
      }}
      selectedIds={selectedModelIds}
      onToggleSelect={toggleSelectModel}
      onToggleSelectAll={toggleSelectAllModelsOnPage}
      testResults={testResults}
      activeTestingKeys={activeItemKeys}
      onTestModel={testSingleModel}
      providerHealthMap={providerHealthMap}
      bulkRunning={running}
      renderKeyAccess={(model) =>
        isKeyAssignableModel(model) ? (
          <CatalogKeyAccessButton
            kind="models"
            id={model.id}
            providerId={model.providerId}
            index={keyIndex}
          />
        ) : null
      }
      onToggleVisibility={toggleModelVisibility}
      visibilityBusy={visibilityBusy}
    />
  );
}

function CatalogCombosPanel({ context }: { context: CatalogPageContext }) {
  const { activeTab } = context;
  return (
    <>
      {/* Combos Tab Content */}
      {activeTab === "combos" && (
        <section
          role="tabpanel"
          id={catalogPanelId("combos")}
          aria-labelledby={catalogTabId("combos")}
          className="flex flex-col gap-4"
        >
          <Card padding="none" className="overflow-hidden">
            <CatalogCombosFilters context={context} />

            <CatalogCombosBulkActions context={context} />

            <CatalogCombosContent context={context} />
          </Card>
        </section>
      )}
    </>
  );
}

function CatalogCombosFilters({ context }: { context: CatalogPageContext }) {
  const {
    strategyOptions,
    comboFilters,
    updateComboFilters,
    clearComboFilters,
    visibleCombos,
    hasComboFiltersActive,
  } = context;
  return (
    <>
      <ComboCatalogFiltersComponent
        filters={comboFilters}
        onChange={updateComboFilters}
        onClear={clearComboFilters}
        strategyOptions={strategyOptions}
        hasActiveFilters={hasComboFiltersActive}
        totalCount={visibleCombos.length}
      />
    </>
  );
}

function CatalogCombosBulkActions({ context }: { context: CatalogPageContext }) {
  const {
    visibleCombos,
    handleTestSelected,
    handleTestAllFiltered,
    hasTestResults,
    selectedComboIds,
    running,
    progress,
    cancelTest,
    clearResults,
  } = context;
  const { openAssign } = context;
  return (
    <>
      <CatalogBulkActionBar
        selectedCount={selectedComboIds.size}
        filteredCount={visibleCombos.length}
        running={running}
        progress={progress}
        hasTestResults={hasTestResults}
        onTestSelected={handleTestSelected}
        onTestFiltered={handleTestAllFiltered}
        onCancel={cancelTest}
        onClearResults={clearResults}
        onAssign={() => openAssign("combos")}
      />
    </>
  );
}

function CatalogCombosContent({ context }: { context: CatalogPageContext }) {
  const { t, refreshAll, clearComboFilters, visibleCombos, combos, combosLoading, combosError } =
    context;
  return (
    <>
      {combosLoading && combos.length === 0 ? (
        <div role="status" aria-live="polite" className="flex min-h-64 flex-col gap-2 p-4">
          {/* Skeleton rows (CSS only): the kit TableLoadingState brand loader animates on timers. */}
          <span className="ci-sr-only">{t("loading")}</span>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : combosError && combos.length === 0 ? (
        <div
          role="alert"
          className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center"
        >
          <p className="text-sm text-text-main">{t("unableToLoadCombos")}</p>
          <p className="text-sm text-text-muted">{t("checkConnection")}</p>
          <Button variant="secondary" onClick={refreshAll}>
            {t("retry")}
          </Button>
        </div>
      ) : visibleCombos.length === 0 ? (
        <EmptyState
          className="min-h-64"
          icon="search_off"
          title={combos.length === 0 ? t("noCombosAvailable") : t("noCombosMatch")}
          actionLabel={combos.length > 0 ? t("clearFilters") : ""}
          onAction={combos.length > 0 ? clearComboFilters : null}
        />
      ) : (
        <CatalogCombosResults context={context} />
      )}
    </>
  );
}

function CatalogCombosResults({ context }: { context: CatalogPageContext }) {
  const {
    visibleCombos,
    comboPage,
    toggleSelectCombo,
    toggleSelectAllCombosOnPage,
    comboSortField,
    setComboSortField,
    comboSortDirection,
    setComboSortDirection,
    setRequestedComboPage,
    selectedComboIds,
    testResults,
    running,
    activeItemKeys,
    testSingleCombo,
  } = context;
  const { keyIndex } = context;
  return (
    <ComboCatalogTable
      rows={comboPage.rows}
      sortField={comboSortField}
      sortDirection={comboSortDirection}
      onSort={(field) => {
        if (field === comboSortField) {
          setComboSortDirection((curr) => (curr === "asc" ? "desc" : "asc"));
        } else {
          setComboSortField(field);
          setComboSortDirection("asc");
        }
        setRequestedComboPage(0);
      }}
      page={comboPage.page + 1}
      pageCount={comboPage.pageCount}
      startIndex={comboPage.page * PAGE_SIZE}
      totalCount={visibleCombos.length}
      selectedIds={selectedComboIds}
      onToggleSelect={toggleSelectCombo}
      onToggleSelectAll={toggleSelectAllCombosOnPage}
      testResults={testResults}
      activeTestingKeys={activeItemKeys}
      onTestCombo={testSingleCombo}
      onPrevious={() => setRequestedComboPage((c) => Math.max(0, c - 1))}
      onNext={() => setRequestedComboPage((c) => Math.min(comboPage.pageCount - 1, c + 1))}
      bulkRunning={running}
      renderKeyAccess={(id) => <CatalogKeyAccessButton kind="combos" id={id} index={keyIndex} />}
    />
  );
}

function CatalogBulkConfirmation({ context }: { context: CatalogPageContext }) {
  const { t, confirmPendingBulkRun, pendingBulkRun, setPendingBulkRun } = context;
  return (
    <>
      <ConfirmModal
        isOpen={pendingBulkRun !== null}
        onClose={() => setPendingBulkRun(null)}
        onConfirm={confirmPendingBulkRun}
        title={t("bulkConfirmTitle")}
        message={
          pendingBulkRun?.kind === "combos"
            ? t("bulkConfirmCombos", { count: pendingBulkRun.targets.length })
            : t("bulkConfirmModels", { count: pendingBulkRun?.targets.length ?? 0 })
        }
        confirmText={t("bulkConfirmStart")}
        variant="primary"
      />
    </>
  );
}
export default function ModelCatalogPage() {
  const context = useCatalogPageContext();
  return (
    <div className="flex flex-col gap-6">
      <CatalogHeader context={context} />
      <CatalogModelsPanel context={context} />
      <CatalogCombosPanel context={context} />
      <CatalogAssignmentDialog context={context} />
      <CatalogBulkConfirmation context={context} />
    </div>
  );
}
