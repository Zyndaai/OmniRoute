import { useState } from "react";
import { useRevalidator } from "react-router";
import { useTranslations } from "use-intl";
import { Alert } from "@omniroute/ui-kit/alert";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Icon from "@/shared/components/Icon";
import type { AuditLogEntry } from "@/lib/compliance/index";
import ActivityFeed from "./components/ActivityFeed";
import EventTypeFilter, { type EventCategory, matchesCategory } from "./components/EventTypeFilter";

export default function ActivityFeedClient({
  entries: allEntries,
  failed,
  loadedAt: referenceNowMs,
}: {
  entries: AuditLogEntry[];
  failed: boolean;
  /** When the loader read the entries: the reference time for relative timestamps. */
  loadedAt: number;
}) {
  const t = useTranslations("activity");
  const revalidator = useRevalidator();
  const loading = revalidator.state !== "idle";
  const [category, setCategory] = useState<EventCategory>("all");
  // The alert belongs to one loader result; a refresh brings a new `loadedAt` and shows it again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const error = failed && dismissedAt !== referenceNowMs ? t("fetchFailed") : null;
  const fetchEntries = () => revalidator.revalidate();

  const filtered =
    category === "all"
      ? allEntries
      : allEntries.filter((e) => {
          const action = typeof e.action === "string" ? e.action : "";
          return matchesCategory(action, category);
        });

  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={t("title")}
        description={t("description")}
        actions={
          <Button
            variant="outline"
            icon="refresh"
            loading={loading}
            onClick={() => fetchEntries()}
            aria-label={t("refreshAria")}
          >
            {loading ? t("loading") : t("refresh")}
          </Button>
        }
      />

      {/* Filter */}
      <EventTypeFilter value={category} onChange={setCategory} />

      {/* Error */}
      {error && (
        <Alert
          variant="critical"
          icon={<Icon name="error" size={16} />}
          dismissLabel={t("dismissError")}
          onDismiss={() => setDismissedAt(referenceNowMs)}
          description={error}
        />
      )}

      {/* Feed */}
      <Card padding="none" className="overflow-hidden">
        <ActivityFeed entries={filtered} referenceNowMs={referenceNowMs} />
      </Card>
    </div>
  );
}
