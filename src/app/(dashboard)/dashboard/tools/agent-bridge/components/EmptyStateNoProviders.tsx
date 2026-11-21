import { useTranslations } from "use-intl";
import { Link } from "react-router";
import { EmptyState } from "@omniroute/ui-kit/empty-state";
import { buttonVariants } from "@omniroute/ui-kit/button";
import Icon from "@/shared/components/Icon";

/**
 * Empty state shown when no providers are configured.
 * Matches plan 11 §7.
 */
export function EmptyStateNoProviders() {
  const t = useTranslations("agentBridge");

  return (
    <EmptyState
      icon={<Icon name="dns" size={40} />}
      title={t("emptyNoProvidersTitle") || "No providers configured yet"}
      description={
        t("emptyNoProvidersBody") ||
        "To use AgentBridge, first connect at least one provider. It will be the destination where IDE requests are routed."
      }
      actions={
        <Link to="/dashboard/providers" className={buttonVariants({ variant: "default" })}>
          <Icon name="arrow_forward" size={16} />
          {t("emptyGoToProviders") || "Go to Providers"}
        </Link>
      }
    />
  );
}
