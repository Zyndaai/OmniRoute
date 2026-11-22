import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "use-intl";
import { useLoaderData, useRevalidator } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { Alert } from "@omniroute/ui-kit/alert";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import Icon from "@/shared/components/Icon";
import Button from "@/shared/components/Button";
import BatchListTab from "./BatchListTab";
import type { FileRecord } from "@/lib/db/files";
import type { BatchRecord } from "@/lib/db/batches";
import { mapBatchApiToRecord, mapFileApiToRecord } from "./batch-utils";
import BatchConceptCard from "./components/BatchConceptCard";
import NewBatchWizard from "./components/NewBatchWizard";

// ── Batch-capable providers (D16) ─────────────────────────────────────────────

const BATCH_SUPPORTED = ["openai", "anthropic", "gemini"];
const MODEL_DEFAULTS: Record<string, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
  anthropic: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
};
const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

// ── Component ─────────────────────────────────────────────────────────────────

interface BatchPageData {
  batches: BatchRecord[];
  files: FileRecord[];
  batchesTotal: number;
  hasMore: boolean;
  lastId: string | null;
  providers: Array<{ id: string; name: string; models: string[] }>;
}

/**
 * First page of batches and files, and the batch-capable providers (D16: /api/providers
 * intersected with BATCH_SUPPORTED, hardcoded list when none is connected or the read fails).
 * Every read is optional, as before: a failing one leaves its list empty.
 */
export async function loader(): Promise<BatchPageData> {
  const [batchesBody, filesBody, providersBody] = await Promise.all([
    apiJsonOrNull<{ data?: unknown[]; has_more?: boolean; last_id?: string; total_count?: number }>(
      "/api/v1/batches",
      { query: { limit: 20 } }
    ),
    apiJsonOrNull<{ data?: unknown[] }>("/api/v1/files", { query: { limit: 20 } }),
    apiJsonOrNull<{ connections?: Array<{ provider: string }> }>("/api/providers"),
  ]);
  const connected = new Set(
    (providersBody?.connections ?? [])
      .filter((c) => BATCH_SUPPORTED.includes(c.provider))
      .map((c) => c.provider)
  );
  const providerIds = connected.size > 0 ? Array.from(connected) : BATCH_SUPPORTED;
  return {
    batches: (batchesBody?.data || []).map(mapBatchApiToRecord),
    files: (filesBody?.data || []).map(mapFileApiToRecord),
    batchesTotal: batchesBody?.total_count || 0,
    hasMore: Boolean(batchesBody?.has_more),
    lastId: batchesBody?.last_id || null,
    providers: providerIds.map((id) => ({
      id,
      name: PROVIDER_NAMES[id] ?? id,
      models: MODEL_DEFAULTS[id] ?? [],
    })),
  };
}

export default function BatchPage() {
  const t = useTranslations("common");
  const revalidator = useRevalidator();
  const loaded = useLoaderData<typeof loader>();
  const providers = loaded.providers;
  // Background polling and "load more" grow these lists locally; every new loader result
  // (refresh button, batch created) replaces them.
  const [batches, setBatches] = useState<BatchRecord[]>(loaded.batches);
  const [files, setFiles] = useState<FileRecord[]>(loaded.files);
  const [batchesTotal, setBatchesTotal] = useState(loaded.batchesTotal);
  const [batchesHasMore, setBatchesHasMore] = useState(loaded.hasMore);
  const [batchesLastId, setBatchesLastId] = useState<string | null>(loaded.lastId);
  const [shownLoaded, setShownLoaded] = useState(loaded);
  if (loaded !== shownLoaded) {
    setShownLoaded(loaded);
    setBatches(loaded.batches);
    setFiles(loaded.files);
    setBatchesTotal(loaded.batchesTotal);
    setBatchesHasMore(loaded.hasMore);
    setBatchesLastId(loaded.lastId);
  }
  const loading = revalidator.state !== "idle";
  const [loadingMore, setLoadingMore] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [createdBanner, setCreatedBanner] = useState<string | null>(null);

  // Auto-dismiss "batch created" banner after 5s (A-6)
  useEffect(() => {
    if (!createdBanner) return;
    const id = setTimeout(() => setCreatedBanner(null), 5000);
    return () => clearTimeout(id);
  }, [createdBanner]);

  const bottomRefBatches = useRef<HTMLDivElement>(null);
  const refreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isFetchingRef = useRef(false);
  const fetchDataRef = useRef<typeof fetchData | null>(null);

  // Background refresh (merge into the lists) and "load more" (append). The first page and the
  // manual refresh come from the route loader.
  const fetchData = useCallback(
    async (isBackground = true, opts: { appendBatches?: boolean; limit?: number } = {}) => {
      if (isFetchingRef.current) return;
      if (opts.appendBatches) setLoadingMore(true);
      isFetchingRef.current = true;
      const limit = opts.limit ?? 20;
      try {
        const batchUrl =
          `/api/v1/batches?limit=${limit}` +
          (opts.appendBatches && batchesLastId ? `&after=${batchesLastId}` : "");
        const filesUrl = `/api/v1/files?limit=${limit}`;

        const [batchesRes, filesRes] = await Promise.all([fetch(batchUrl), fetch(filesUrl)]);

        if (batchesRes.ok) {
          const data = await batchesRes.json();
          const mapped = (data.data || []).map(mapBatchApiToRecord);

          if (opts.appendBatches) {
            setBatches((prev) => [...prev, ...mapped]);
            setBatchesHasMore(Boolean(data.has_more));
            setBatchesLastId(data.last_id || null);
          } else if (isBackground) {
            // Background refresh: merge new items, preserve pagination state
            setBatches((prev) => {
              const batchMap = new Map(prev.map((b) => [b.id, b]));
              for (const m of mapped) {
                batchMap.set(m.id, m);
              }
              return Array.from(batchMap.values()).sort(
                (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id) // teknik sıralama: ASCII kasıtlı
              );
            });
          } else {
            setBatches(mapped);
            setBatchesHasMore(Boolean(data.has_more));
            setBatchesLastId(data.last_id || null);
          }
          setBatchesTotal(data.total_count || 0);
        }

        if (filesRes.ok) {
          const data = await filesRes.json();
          const mapped = (data.data || []).map(mapFileApiToRecord);
          if (isBackground) {
            setFiles((prev) => {
              const fileMap = new Map(prev.map((f) => [f.id, f]));
              for (const m of mapped) {
                fileMap.set(m.id, m);
              }
              return Array.from(fileMap.values()).sort(
                (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id) // teknik sıralama: ASCII kasıtlı
              );
            });
          } else {
            setFiles(mapped);
          }
        }
      } catch (error) {
        console.error("[BatchPage] fetchData threw", error);
      } finally {
        isFetchingRef.current = false;
        if (opts.appendBatches) setLoadingMore(false);
      }
    },
    [batchesLastId]
  );

  // Keep fetchData ref in sync
  useEffect(() => {
    fetchDataRef.current = fetchData;
  }, [fetchData]);

  // Track loadingMore in a ref for use in observer callback
  const loadingMoreRef = useRef(loadingMore);
  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);

  // 30s polling (D10). Pauses when tab is hidden.
  useEffect(() => {
    const scheduleRefresh = () => {
      refreshTimeoutRef.current = setTimeout(async () => {
        if (!document.hidden) {
          await fetchDataRef.current?.(true);
        }
        scheduleRefresh();
      }, 30_000);
    };

    // Schedule background refreshes
    scheduleRefresh();

    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, []);

  // Pause/resume polling on visibility change (D10)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (refreshTimeoutRef.current) {
          clearTimeout(refreshTimeoutRef.current);
          refreshTimeoutRef.current = null;
        }
      } else if (!refreshTimeoutRef.current) {
        // Resume polling
        const scheduleRefresh = () => {
          refreshTimeoutRef.current = setTimeout(async () => {
            if (!document.hidden) {
              await fetchDataRef.current?.(true);
            }
            scheduleRefresh();
          }, 30_000);
        };
        scheduleRefresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // IntersectionObserver for infinite scroll on batches
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && batchesHasMore && !loadingMoreRef.current) {
          fetchDataRef.current?.(true, { appendBatches: true });
        }
      },
      { threshold: 0.1 }
    );

    if (bottomRefBatches.current) {
      observer.observe(bottomRefBatches.current);
    }

    return () => observer.disconnect();
  }, [batchesHasMore]);

  const batchesCount = batches.length;

  return (
    <div className="flex flex-col gap-6">
      {/* Stable outcome-oriented header (replaces the collapsible card as primary orientation) */}
      <div className="flex flex-col gap-4">
        <PageHeader
          compact
          title={t("batchConceptTitle")}
          description={t("batchHeaderSubtitle")}
          actions={
            <Button icon="add" onClick={() => setShowWizard(true)}>
              {t("batchListNewButton")}
            </Button>
          }
        />

        {/* Three-step strip */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 rounded-lg bg-surface border border-border px-3 py-2">
            <span className="font-medium text-sm text-text-main">{t("batchStep1")}</span>
            <span className="text-xs text-text-muted hidden sm:inline">{t("batchStep1Desc")}</span>
          </div>
          <Icon name="chevron_right" className="text-text-muted" />
          <div className="flex items-center gap-1.5 rounded-lg bg-surface border border-border px-3 py-2">
            <span className="font-medium text-sm text-text-main">{t("batchStep2")}</span>
            <span className="text-xs text-text-muted hidden sm:inline">{t("batchStep2Desc")}</span>
          </div>
          <Icon name="chevron_right" className="text-text-muted" />
          <div className="flex items-center gap-1.5 rounded-lg bg-surface border border-border px-3 py-2">
            <span className="font-medium text-sm text-text-main">{t("batchStep3")}</span>
            <span className="text-xs text-text-muted hidden sm:inline">{t("batchStep3Desc")}</span>
          </div>
        </div>
      </div>

      {/* Deeper explanation (optional, collapsible) */}
      <BatchConceptCard />

      {/* "Batch created" success banner (A-6) — auto-dismiss 5s */}
      {createdBanner && (
        <Alert
          variant="success"
          icon={<Icon name="check_circle" size={16} />}
          title={t("batchListBatchCreated", { id: createdBanner })}
          dismissLabel={t("batchListBatchCreatedDismiss")}
          onDismiss={() => setCreatedBanner(null)}
        />
      )}

      {/* Toolbar: auto-refresh indicator + Refresh + New batch */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <span className="text-xs text-text-muted flex items-center gap-1">
          <Icon name="sync" size={14} className={loading ? "animate-spin" : "animate-pulse"} />
          {t("batchListAutoRefresh")}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            icon="refresh"
            onClick={() => void revalidator.revalidate()}
            disabled={loading}
          >
            {loading ? t("batchListRefreshing") : t("batchListRefresh")}
          </Button>
          <Button icon="add" onClick={() => setShowWizard(true)}>
            {t("batchListNewButton")}
          </Button>
        </div>
      </div>

      {/* Batch list + infinite scroll sentinel */}
      <div className="flex flex-col gap-6">
        <BatchListTab
          batches={batches}
          files={files}
          batchesTotal={batchesTotal}
          loading={loading}
          onRefresh={() => void revalidator.revalidate()}
        />
        {loadingMore && batchesCount > 0 && (
          <div className="text-center text-sm">{t("batchPageLoadingMore")}</div>
        )}
        <div ref={bottomRefBatches} className="h-10" />
      </div>

      {/* New batch wizard */}
      {showWizard && (
        <NewBatchWizard
          onClose={() => setShowWizard(false)}
          onCreated={(id) => {
            setShowWizard(false);
            setCreatedBanner(id);
            void revalidator.revalidate();
          }}
          availableProviders={providers}
        />
      )}
    </div>
  );
}
