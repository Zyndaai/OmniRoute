import { Link, useSearchParams } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import ReasoningRoutingRules from "@/shared/components/ReasoningRoutingRules";

export default function RoutingPageClient() {
  const t = useTranslations("reasoningRouting.editor");
  const [searchParams] = useSearchParams();
  return (
    <div className="min-w-0 w-full space-y-6 pb-10">
      <PageHeader
        compact
        breadcrumbs={
          <Link to="/dashboard/api-manager" className="text-sm text-primary hover:underline">
            ← {t("backToKeys")}
          </Link>
        }
        title={t("pageTitle")}
        description={t("pageDescription")}
      />
      <ReasoningRoutingRules
        key={searchParams.get("apiKeyId") || "all"}
        initialApiKeyId={searchParams.get("apiKeyId") || ""}
      />
    </div>
  );
}
