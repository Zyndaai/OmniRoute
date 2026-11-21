import { Link } from "react-router";
import { useTranslations } from "use-intl";
import { FREE_TIER_TOS } from "@omniroute/open-sse/config/freeTierCatalog";

/** Explain the global auto policy without changing the provider connection flow. */
export default function ProviderTosNotice({ providerId }: { providerId: string }) {
  const t = useTranslations("providers");
  if (FREE_TIER_TOS[providerId] !== "avoid") return null;

  return (
    <aside className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm">
      <p className="font-medium text-text-main">{t("tosAvoidNoticeTitle")}</p>
      <p className="mt-1 text-text-muted">{t("tosAvoidNoticeDescription")}</p>
      <Link
        to="/dashboard/combos#auto-tos-policy"
        className="mt-2 inline-block text-primary underline underline-offset-2"
      >
        {t("tosAvoidNoticeAction")}
      </Link>
    </aside>
  );
}
