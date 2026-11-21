import { Link } from "react-router";
import { useTranslations } from "use-intl";

/** Shown instead of a Radar page while the Radar feature flag is off, as a 404 would. */
export default function RadarNotFound() {
  const t = useTranslations("publicSystem");
  const tc = useTranslations("common");

  return (
    <div className="flex flex-col items-center justify-center text-center min-h-[400px] p-6">
      <div className="ci-dashboard-display text-[96px] leading-none mb-2" aria-hidden="true">
        404
      </div>
      <h1 className="ci-heading text-2xl mb-2">{t("notFound.title")}</h1>
      <p className="text-[15px] text-text-muted max-w-[400px] leading-relaxed mb-8">
        {t("notFound.description")}
      </p>
      <Link
        to="/dashboard"
        className="px-8 py-3 rounded-xl text-sm font-medium no-underline bg-primary text-accent-foreground hover:bg-primary-hover focus:outline-2 focus:outline-offset-2 focus:outline-primary"
        aria-label={t("notFound.dashboardAriaLabel")}
      >
        {tc("goToDashboard")}
      </Link>
    </div>
  );
}
