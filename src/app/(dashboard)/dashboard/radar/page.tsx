import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "use-intl";
import { buttonVariants } from "@omniroute/ui-kit/button";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { Tabs, TabsList, TabsTrigger } from "@omniroute/ui-kit/tabs";
import { Link, useLoaderData, useRevalidator } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { radarRead } from "./radarApi.server";
import Icon from "@/shared/components/Icon";
import { Card } from "@/shared/components";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import { shouldAutoSyncOnOpen } from "@/lib/radar/autoSync";
import { isValidSupporterKeyFormat } from "@/lib/radar/supporterKey";
import RadarNotFound from "./RadarNotFound";
import { resolveRadarPageState } from "./radarPageState";
import { RadarAccessExplainer } from "./RadarAccessExplainer";
import {
  RadarCatalogTable,
  type RadarLocalModelState,
  type RadarMergedEntry,
} from "./RadarCatalogTable";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RadarMeta {
  version: string;
  tier: string;
  fetchedAt: string;
}

/** D28 — referral links / free credits. Client-side mirror of RadarReferral. */
interface RadarReferralItem {
  provider: string;
  url: string;
  kind: "fixo" | "campanha";
  validUntil: string | null;
  requiredAction: string | null;
  isDefault: boolean;
}

interface RadarReferralsState {
  fixed: RadarReferralItem[];
  campaigns: RadarReferralItem[];
  tier: string | null;
}

type RadarTabId = "catalog" | "referrals";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Relative time string (e.g., "3h ago", "2d ago"). */
function relativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

interface RadarSettingsPayload {
  optIn?: boolean;
  hasSupporterKey?: boolean;
  supporterKeyMasked?: string | null;
  contributorClaimUrl?: string;
  supporterPlansUrl?: string;
}

const EMPTY_ENTRIES: RadarMergedEntry[] = [];
const EMPTY_REFERRALS: RadarReferralsState = { fixed: [], campaigns: [], tier: null };

/**
 * Settings decide the page state (404 = Radar flag off). When opted in, the catalog, the
 * referral links and the local model edits are read too. Required: the settings read; a failing
 * catalog shows its error message, referrals and local edits fall back to empty (best-effort).
 */
export async function loader() {
  const settingsRead = await radarRead<RadarSettingsPayload>("/api/radar/settings");
  const base = {
    featureAvailable: true,
    // null = settings unreadable (old page showed the activation screen then).
    optIn: null as boolean | null,
    hasSupporterKey: false,
    supporterKeyMasked: null as string | null,
    // F4/T7 — outbound links relayed by the settings route (src/lib/radar/links.ts); never
    // hardcoded in the page.
    contributorClaimUrl: null as string | null,
    supporterPlansUrl: null as string | null,
    entries: EMPTY_ENTRIES,
    meta: null as RadarMeta | null,
    catalogError: "",
    referrals: EMPTY_REFERRALS,
    localStates: [] as RadarLocalModelState[],
  };
  if (settingsRead.status === 404) return { ...base, featureAvailable: false };
  const settings = settingsRead.body;
  if (!settings) return base;

  const optIn = settings.optIn === true;
  const result = {
    ...base,
    optIn,
    hasSupporterKey: settings.hasSupporterKey === true,
    supporterKeyMasked:
      typeof settings.supporterKeyMasked === "string" ? settings.supporterKeyMasked : null,
    contributorClaimUrl:
      typeof settings.contributorClaimUrl === "string" ? settings.contributorClaimUrl : null,
    supporterPlansUrl:
      typeof settings.supporterPlansUrl === "string" ? settings.supporterPlansUrl : null,
  };
  if (!optIn) return result;

  const [catalogRead, referrals, localState] = await Promise.all([
    radarRead<{ entries?: RadarMergedEntry[]; meta?: RadarMeta | null }>("/api/radar/catalog"),
    apiJsonOrNull<Partial<RadarReferralsState>>("/api/radar/referrals"),
    apiJsonOrNull<{ states?: RadarLocalModelState[] }>("/api/radar/local-model-state"),
  ]);
  if (catalogRead.status === 404) return { ...result, featureAvailable: false };
  return {
    ...result,
    entries: catalogRead.body?.entries || EMPTY_ENTRIES,
    meta: catalogRead.body?.meta || null,
    catalogError: catalogRead.body ? "" : `HTTP ${catalogRead.status}`,
    referrals: referrals
      ? {
          fixed: Array.isArray(referrals.fixed) ? referrals.fixed : [],
          campaigns: Array.isArray(referrals.campaigns) ? referrals.campaigns : [],
          tier: referrals.tier ?? null,
        }
      : EMPTY_REFERRALS,
    localStates: Array.isArray(localState?.states) ? localState.states : [],
  };
}

export default function RadarPage() {
  const t = useTranslations("radarPage");
  const revalidator = useRevalidator();
  const {
    featureAvailable,
    optIn,
    hasSupporterKey,
    supporterKeyMasked,
    contributorClaimUrl,
    supporterPlansUrl,
    entries,
    meta,
    catalogError,
    referrals,
    localStates,
  } = useLoaderData<typeof loader>();
  const [actionError, setError] = useState("");
  const error = actionError || catalogError;
  const [activating, setActivating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState<RadarTabId>("catalog");

  // Paste-key activation — the primary path on the activation screen: paste
  // an already-obtained supporter key (`omr_` + 40 hex) to activate opt-in
  // AND the supporter tier in a single POST. `hasSupporterKey`/
  // `supporterKeyMasked` mirror GET /api/radar/settings so a key set out of
  // band (e.g. a direct curl call before this UI existed) shows the masked
  // form instead of an empty input — the raw key is never displayed.
  const [keyInput, setKeyInput] = useState("");
  const [keySubmitting, setKeySubmitting] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);

  const refreshCatalogSilently = useCallback(async () => {
    await revalidator.revalidate();
  }, [revalidator]);

  // Sync (defined before handleActivate which depends on it)
  const handleSync = useCallback(async () => {
    setSyncing(true);
    setError("");
    try {
      const res = await fetch("/api/radar/sync", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status === "updated" || data.status === "stale") {
        await revalidator.revalidate();
      } else if (data.status === "error" || data.status === "too_large") {
        // "too_large" reuses the generic sync-failed copy — the feed exceeded the
        // client-side size cap (10MB), which is operationally the same as any
        // other sync failure from the operator's point of view.
        setError(data.reason || t("syncFailed"));
      } else if (data.status === "disabled") {
        setError(t("flagDisabled"));
      } else if (data.status === "opt_out") {
        await revalidator.revalidate();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("syncFailed"));
    } finally {
      setSyncing(false);
    }
  }, [t, revalidator]);

  // Auto-sync on open: when the operator is already opted in and the cached
  // feed is stale (or absent), refresh it automatically once per mount so the
  // page always shows current data without requiring the manual Sync button
  // (spec: dados atualizados a cada abrir da página). The ref guards against
  // re-firing when `meta` updates after the sync itself.
  const autoSyncFiredRef = useRef(false);
  useEffect(() => {
    if (syncing || optIn !== true || autoSyncFiredRef.current) return;
    if (!shouldAutoSyncOnOpen(meta?.fetchedAt ?? null, Date.now())) return;
    autoSyncFiredRef.current = true;
    void (async () => {
      await handleSync();
    })();
  }, [syncing, optIn, meta, handleSync]);

  // Activate opt-in
  const handleActivate = useCallback(async () => {
    setActivating(true);
    try {
      const res = await fetch("/api/radar/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optIn: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await revalidator.revalidate();
      // After activation, trigger a sync
      await handleSync();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("activationFailed"));
    } finally {
      setActivating(false);
    }
  }, [t, handleSync, revalidator]);

  // Activate with a pasted supporter key — the primary path on this screen.
  // Submitting a key both sets it AND opts in, in a single POST (pasting a
  // key unlocks the activation screen). Client-side format validation is a
  // UX nicety only — the server (Zod) always revalidates.
  const handleSubmitKey = useCallback(async () => {
    setError("");
    const trimmed = keyInput.trim();
    if (!isValidSupporterKeyFormat(trimmed)) {
      setError(t("keyInvalidFormatError"));
      return;
    }
    setKeySubmitting(true);
    try {
      const res = await fetch("/api/radar/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optIn: true, supporterKey: trimmed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await revalidator.revalidate();
      setKeyInput("");
      setShowKeyForm(false);
      // After activation, trigger a sync so the live tier catalog loads.
      await handleSync();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("activationFailed"));
    } finally {
      setKeySubmitting(false);
    }
  }, [keyInput, t, handleSync, revalidator]);

  // Feature availability and privacy opt-in are independent states. A successful
  // settings response with `optIn: false` means "show activation", not "flag off".
  const pageState = resolveRadarPageState(featureAvailable, optIn === true, meta !== null);

  // Flag off — render not-found
  if (!featureAvailable) {
    return <RadarNotFound />;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        compact
        title={t("title")}
        description={t("subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {(pageState === "empty" || pageState === "populated") && (
              <Link
                to="/dashboard/radar/intel"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {t("intel")}
              </Link>
            )}
            {(pageState === "empty" || pageState === "populated") && (
              <Link
                to="/dashboard/radar/offers"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {t("offers")}
              </Link>
            )}
            {(pageState === "empty" || pageState === "populated") && (
              <Link
                to="/dashboard/radar/combos"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {t("guidedCombos")}
              </Link>
            )}
            {pageState === "populated" && (
              <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
                {syncing ? t("syncing") : t("syncNow")}
              </Button>
            )}
          </div>
        }
      />

      {/* Feed freshness header */}
      {meta && (
        <div className="flex items-center gap-4 text-sm text-text-muted">
          <span>
            {t("feedVersion")}: <span className="font-mono">{meta.version}</span>
          </span>
          <span>
            {t("feedTier")}:{" "}
            <span className={meta.tier === "live" ? "text-success" : "text-warning"}>
              {meta.tier === "live" ? t("tierLive") : t("tierCommunity")}
            </span>
          </span>
          {/* Relative to the clock: differs between the server render and hydration. */}
          <span suppressHydrationWarning>
            {t("feedFetched")}: {relativeTime(meta.fetchedAt)}
          </span>
        </div>
      )}

      {error && <div className="p-3 rounded-lg bg-error/10 text-error text-sm">{error}</div>}

      {
        <>
          {/* Opt-in pending */}
          {pageState === "optin_pending" && (
            <Card>
              <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 py-8 text-center">
                <Icon name="radar" size={36} className="text-primary" />
                <h2 className="text-xl font-semibold">{t("activateTitle")}</h2>
                <p className="max-w-2xl text-text-muted">{t("activateDescription")}</p>

                <RadarAccessExplainer />

                {/* F4/T7 — ways to obtain a supporter key. These conditions
                    intentionally precede both activation actions (D32). */}
                {contributorClaimUrl && supporterPlansUrl && (
                  <div className="flex w-full flex-col gap-3 rounded-xl border border-border p-4">
                    <p className="text-sm font-medium">{t("claimSectionTitle")}</p>
                    <div className="flex w-full flex-col gap-3 sm:flex-row">
                      <a
                        href={contributorClaimUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonVariants({ variant: "outline", className: "flex-1" })}
                      >
                        {t("contributorButton")}
                      </a>
                      <a
                        href={supporterPlansUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonVariants({ variant: "outline", className: "flex-1" })}
                      >
                        {t("supporterButton")}
                      </a>
                    </div>
                    <p className="text-left text-xs text-text-muted">{t("contributorHint")}</p>
                    <p className="text-left text-xs text-text-muted">{t("supporterHint")}</p>
                  </div>
                )}

                {/* Paste-key activation — primary path: pasting an already-obtained
                    supporter key both sets it AND opts in (unlocks this screen).
                    The raw key is NEVER displayed — once set, only the masked
                    form (supporterKeyMasked) is shown, with a "change key" escape
                    hatch to paste a new one. */}
                <div className="w-full flex flex-col gap-3 text-left">
                  <p className="text-sm font-medium">{t("keySectionTitle")}</p>
                  {hasSupporterKey && !showKeyForm ? (
                    <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border">
                      <span className="font-mono text-sm text-text-muted">
                        {supporterKeyMasked}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowKeyForm(true)}
                        className="shrink-0 text-primary"
                      >
                        {t("changeKeyButton")}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Input
                        type="text"
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        placeholder="omr_..."
                        aria-label={t("keySectionTitle")}
                        className="flex-1"
                        inputClassName="font-mono"
                      />
                      <Button
                        onClick={handleSubmitKey}
                        disabled={keySubmitting || keyInput.trim().length === 0}
                        className="shrink-0"
                      >
                        {keySubmitting ? t("activating") : t("activateWithKeyButton")}
                      </Button>
                    </div>
                  )}
                </div>

                <div className="w-full h-px bg-border" />

                <Button size="lg" onClick={handleActivate} disabled={activating}>
                  {activating ? t("activating") : t("activateButton")}
                </Button>
              </div>
            </Card>
          )}

          {/* D28 — tab bar. Only shown once opted in (empty/populated) — the
              activation gate above is a single full-screen step, not a tab. */}
          {(pageState === "empty" || pageState === "populated") && (
            <Tabs
              variant="underline"
              value={activeTab}
              onValueChange={(next) => setActiveTab(next as typeof activeTab)}
            >
              <TabsList aria-label={t("catalogTab")}>
                {/* The panels below are rendered by the page itself (no TabsContent). */}
                <TabsTrigger value="catalog" aria-controls={undefined}>
                  {t("catalogTab")}
                </TabsTrigger>
                <TabsTrigger value="referrals" aria-controls={undefined}>
                  {t("freeCreditsTab")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          {/* Free credits tab (D28 — referral links) */}
          {(pageState === "empty" || pageState === "populated") && activeTab === "referrals" && (
            <div className="flex flex-col gap-6">
              <p className="text-sm text-text-muted">{t("freeCreditsSubtitle")}</p>

              {referrals.fixed.length === 0 ? (
                <Card>
                  <p className="text-text-muted text-center py-6">{t("fixedLinksEmpty")}</p>
                </Card>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {referrals.fixed.map((referral) => (
                    <Card key={`${referral.provider}:fixed`} padding="sm">
                      <div className="flex flex-col gap-2">
                        <span className="font-medium">{referral.provider}</span>
                        {referral.requiredAction && (
                          <p className="text-xs text-text-muted">
                            {t("requiredActionLabel")} {referral.requiredAction}
                          </p>
                        )}
                        <a
                          href={referral.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline w-fit"
                        >
                          {t("claimButton")}
                          <Icon name="open_in_new" size={14} />
                        </a>
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              <div>
                <h3 className="text-lg font-semibold mb-3">{t("campaignsTitle")}</h3>
                {referrals.campaigns.length === 0 ? (
                  <Card>
                    <p className="text-text-muted text-center py-6">
                      {referrals.tier === "community"
                        ? t("campaignsUpsellCommunity")
                        : t("campaignsEmpty")}
                    </p>
                  </Card>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {referrals.campaigns.map((referral, idx) => (
                      <Card key={`${referral.provider}:campaign:${idx}`} padding="sm">
                        <div className="flex flex-col gap-2">
                          <span className="font-medium">{referral.provider}</span>
                          {referral.requiredAction && (
                            <p className="text-xs text-text-muted">
                              {t("requiredActionLabel")} {referral.requiredAction}
                            </p>
                          )}
                          {referral.validUntil && (
                            <p className="text-xs text-warning">
                              {t("campaignsValidUntil", {
                                date: new Date(referral.validUntil).toLocaleDateString(),
                              })}
                            </p>
                          )}
                          <a
                            href={referral.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline w-fit"
                          >
                            {t("claimButton")}
                            <Icon name="open_in_new" size={14} />
                          </a>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Empty cache — opted in but no data yet */}
          {pageState === "empty" && activeTab === "catalog" && (
            <Card>
              <div className="flex flex-col items-center gap-4 py-12 text-center">
                <p className="text-text-muted">{t("emptyState")}</p>
                <Button size="lg" onClick={handleSync} disabled={syncing}>
                  {syncing ? t("syncing") : t("syncCta")}
                </Button>
              </div>
            </Card>
          )}

          {/* Populated catalog table */}
          {pageState === "populated" && activeTab === "catalog" && (
            <RadarCatalogTable
              entries={entries}
              localStates={localStates}
              refreshCatalog={refreshCatalogSilently}
              onError={setError}
            />
          )}
        </>
      }
    </div>
  );
}
