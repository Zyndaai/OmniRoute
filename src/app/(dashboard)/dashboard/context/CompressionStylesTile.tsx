import { useLocale, useTranslations } from "use-intl";
import Badge from "@/shared/components/Badge";
import Card from "@/shared/components/Card";

export interface CompressionStylesSummary {
  totalRuns: number;
  totalTokensSaved: number;
  runsWithStyles: number;
  bypassCount: number;
  totalOutputTokens: number;
  appliedStyleCounts: Record<string, number>;
}

export const EMPTY_STYLES_SUMMARY: CompressionStylesSummary = {
  totalRuns: 0,
  totalTokensSaved: 0,
  runsWithStyles: 0,
  bypassCount: 0,
  totalOutputTokens: 0,
  appliedStyleCounts: {},
};

/**
 * The run-telemetry summary comes from the route loader (`settings/page.tsx`); `null` = the
 * read failed, shown as an empty summary.
 */
export default function CompressionStylesTile({
  summary: loadedSummary,
}: {
  summary: CompressionStylesSummary | null;
}) {
  const t = useTranslations("settings");
  const locale = useLocale();
  const summary = loadedSummary ?? EMPTY_STYLES_SUMMARY;

  const styles = Object.entries(summary.appliedStyleCounts);

  return (
    <Card padding="sm" data-testid="compression-styles-tile">
      <p className="text-sm font-medium text-text-main">{t("compressionStylesTileTitle")}</p>
      <p className="mt-1 text-2xl font-semibold text-text-main">
        {summary.totalTokensSaved.toLocaleString(locale, { useGrouping: false })}
      </p>
      <p className="text-xs text-text-muted">
        {t("compressionStylesTileSummary", {
          tokens: summary.totalTokensSaved,
          runs: summary.runsWithStyles,
        })}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {styles.length === 0 ? (
          <span className="text-xs text-text-muted">{t("compressionStylesTileEmpty")}</span>
        ) : (
          styles.map(([id, count]) => (
            <Badge key={id} size="sm">
              {id} · {count}
            </Badge>
          ))
        )}
      </div>
    </Card>
  );
}
