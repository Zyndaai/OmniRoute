import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLoaderData, useRevalidator } from "react-router";
import { radarRead } from "../radarApi.server";
import RadarNotFound from "../RadarNotFound";
import { useLocale, useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { buttonVariants } from "@omniroute/ui-kit/button";

import Icon from "@/shared/components/Icon";
import {
  filterActiveRadarOffers,
  localizeRadarOfferText,
  type RadarOffer,
  type RadarOfferBenefit,
} from "@/lib/radar/offersFeedSchema";
import { Card } from "@/shared/components";
import Button from "@/shared/components/Button";

interface OffersMeta {
  version: string;
  tier: "live";
  fetchedAt: string;
}

interface SettingsPayload {
  hasSupporterKey?: boolean;
  contributorClaimUrl?: string;
  supporterPlansUrl?: string;
}

const NO_OFFERS: RadarOffer[] = [];

/**
 * Required read: the settings (404 = Radar flag off, other errors show `loadFailed`). With a
 * supporter key the cached offers are read too; the sync with the feed stays a client call.
 */
export async function loader() {
  const settingsRead = await radarRead<SettingsPayload>("/api/radar/settings");
  const flagOff = settingsRead.status === 404;
  const settings = settingsRead.body;
  const hasSupporterKey = settings?.hasSupporterKey === true;
  const offersRead = hasSupporterKey
    ? await radarRead<{ offers?: RadarOffer[]; meta?: OffersMeta | null }>("/api/radar/offers")
    : null;
  return {
    flagOff: flagOff || offersRead?.status === 404,
    loadFailed: (!flagOff && !settings) || (offersRead !== null && !offersRead.body),
    hasSupporterKey,
    contributorClaimUrl:
      typeof settings?.contributorClaimUrl === "string" ? settings.contributorClaimUrl : null,
    supporterPlansUrl:
      typeof settings?.supporterPlansUrl === "string" ? settings.supporterPlansUrl : null,
    offers: Array.isArray(offersRead?.body?.offers) ? offersRead.body.offers : NO_OFFERS,
    meta: offersRead?.body?.meta ?? null,
  };
}

export default function RadarOffersPage() {
  const t = useTranslations("radarOffersPage");
  const locale = useLocale();
  const revalidator = useRevalidator();
  const {
    flagOff,
    loadFailed,
    hasSupporterKey: loadedHasKey,
    contributorClaimUrl,
    supporterPlansUrl,
    offers,
    meta,
  } = useLoaderData<typeof loader>();
  const [syncNoKey, setSyncNoKey] = useState(false);
  const hasSupporterKey = loadedHasKey && !syncNoKey;
  const [refreshing, setRefreshing] = useState(false);
  const [syncError, setError] = useState("");
  const error = syncError || (loadFailed ? t("loadFailed") : "");

  const syncAndLoad = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/api/radar/offers/sync", { method: "POST" });
      if (response.status === 404) {
        await revalidator.revalidate();
        return;
      }
      if (!response.ok) throw new Error("offers_sync_failed");
      const status = (await response.json()) as { status?: string; reason?: string };
      if (status.status === "no_key") {
        setSyncNoKey(true);
        return;
      }
      if (
        status.status === "error" ||
        status.status === "invalid_signature" ||
        status.status === "invalid_schema" ||
        status.status === "wrong_tier" ||
        status.status === "too_large"
      ) {
        setError(t("loadFailed"));
      }
      // Preserve availability: even when refresh fails, render the last
      // verified local cache rather than clearing it.
      await revalidator.revalidate();
    } catch {
      setError(t("loadFailed"));
      await revalidator.revalidate();
    } finally {
      setRefreshing(false);
    }
  }, [revalidator, t]);

  // Sync with the feed once when the page opens with a supporter key.
  const syncedOnOpenRef = useRef(false);
  useEffect(() => {
    if (!loadedHasKey || flagOff || syncedOnOpenRef.current) return;
    syncedOnOpenRef.current = true;
    void syncAndLoad();
  }, [loadedHasKey, flagOff, syncAndLoad]);

  const activeOffers = useMemo(() => filterActiveRadarOffers(offers, new Date()), [offers]);

  const formatBenefit = useCallback(
    (benefit: RadarOfferBenefit): string => {
      if (benefit.kind === "percent_off") {
        return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
          benefit.basisPoints / 100
        )}%`;
      }
      if (benefit.kind === "credit") {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: benefit.currency,
        }).format(benefit.amountMinor / 100);
      }
      return t("trialDays", { days: benefit.days });
    },
    [locale, t]
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
        actions={
          hasSupporterKey ? (
            <Button variant="outline" onClick={() => void syncAndLoad()} disabled={refreshing}>
              {refreshing ? t("refreshing") : t("refresh")}
            </Button>
          ) : undefined
        }
      />

      {error && <div className="p-3 rounded-lg bg-error/10 text-error text-sm">{error}</div>}

      {!hasSupporterKey ? (
        <Card>
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <Icon name="redeem" size={36} className="text-primary" />
            <h2 className="text-xl font-semibold">{t("keyRequiredTitle")}</h2>
            <p className="max-w-xl text-text-muted">{t("keyRequiredDescription")}</p>
            <div className="flex flex-col sm:flex-row gap-3">
              {contributorClaimUrl && (
                <a
                  href={contributorClaimUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ variant: "outline" })}
                >
                  {t("contributorButton")}
                </a>
              )}
              {supporterPlansUrl && (
                <a
                  href={supporterPlansUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants()}
                >
                  {t("supporterButton")}
                </a>
              )}
            </div>
          </div>
        </Card>
      ) : activeOffers.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-text-muted">{t("empty")}</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {activeOffers.map((offer) => (
            <Card key={`${offer.provider}:${offer.id}`}>
              <div className="flex h-full flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-text-muted">
                      {offer.provider}
                    </p>
                    <h2 className="text-lg font-semibold">
                      {localizeRadarOfferText(offer.title, locale)}
                    </h2>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${
                      offer.partner ? "bg-primary/15 text-primary" : "bg-success/15 text-success"
                    }`}
                  >
                    {offer.partner ? t("partnerBadge") : t("officialBadge")}
                  </span>
                </div>

                <p className="text-2xl font-bold text-primary">{formatBenefit(offer.benefit)}</p>
                <p className="text-sm text-text-muted">
                  {localizeRadarOfferText(offer.description, locale)}
                </p>
                <div className="text-sm">
                  <span className="font-medium">{t("conditionsLabel")}</span>{" "}
                  <span className="text-text-muted">
                    {localizeRadarOfferText(offer.conditions, locale)}
                  </span>
                </div>
                {/* Dates format in the viewer's time zone: may differ from the server render. */}
                <p className="text-xs text-text-muted" suppressHydrationWarning>
                  {offer.validUntil
                    ? t("validUntil", {
                        date: new Date(offer.validUntil).toLocaleDateString(locale),
                      })
                    : t("noExpiry")}
                </p>
                <a
                  href={offer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-auto inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {t("openOffer")}
                  <Icon name="open_in_new" size={14} />
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}

      {meta && (
        <p className="text-xs text-text-muted" suppressHydrationWarning>
          {meta.version} · {new Date(meta.fetchedAt).toLocaleString(locale)}
        </p>
      )}
    </div>
  );
}
