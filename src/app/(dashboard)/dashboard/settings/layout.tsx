import { Outlet, useRevalidator, useRouteError } from "react-router";
import { useTranslations } from "use-intl";
import Button from "@/shared/components/Button";

export default function SettingsLayout() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError() as (Error & { digest?: string }) | undefined;
  const { revalidate } = useRevalidator();
  const t = useTranslations("settings");

  return (
    <div
      className="flex flex-col items-center justify-center min-h-[400px]"
      role="alert"
      aria-live="assertive"
    >
      <div className="text-center space-y-4">
        <h2 className="text-xl font-semibold text-error">{t("errorPage.title")}</h2>
        <p className="text-text-muted max-w-md">{t("errorPage.description")}</p>
        {error?.digest && (
          <p className="text-xs text-text-muted font-mono">
            {t("errorPage.errorId", { id: error.digest })}
          </p>
        )}
        {process.env.NODE_ENV === "development" && error?.message && (
          <p className="text-xs text-error font-mono">{error.message}</p>
        )}
        <Button variant="primary" icon="refresh" onClick={() => revalidate()}>
          {t("errorPage.retry")}
        </Button>
      </div>
    </div>
  );
}
