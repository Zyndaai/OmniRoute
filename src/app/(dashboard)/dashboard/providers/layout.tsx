import { Outlet, useRevalidator, useRouteError } from "react-router";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/components";

type ProviderMessageTranslator = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

function providerText(
  t: ProviderMessageTranslator,
  key: string,
  fallback: string,
  values?: Record<string, unknown>
): string {
  if (typeof t.has === "function" && t.has(key)) return t(key, values);
  if (values) {
    return Object.entries(values).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      fallback
    );
  }
  return fallback;
}

export default function ProvidersLayout() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError() as (Error & { digest?: string }) | undefined;
  const { revalidate } = useRevalidator();
  const t = useTranslations("providers");

  return (
    <div
      className="flex flex-col items-center justify-center min-h-[400px]"
      role="alert"
      aria-live="assertive"
    >
      <div className="text-center space-y-4">
        <h2 className="text-xl font-semibold text-error">
          {providerText(t, "pageLoadErrorTitle", "Failed to load providers")}
        </h2>
        <p className="text-text-muted max-w-md">
          {providerText(
            t,
            "pageLoadErrorDescription",
            "We could not load provider data right now. Check your connection and try again."
          )}
        </p>
        {error?.digest && (
          <p className="text-xs text-text-muted font-mono">
            {providerText(t, "pageLoadErrorId", "Error ID: {id}", { id: error.digest })}
          </p>
        )}
        {process.env.NODE_ENV === "development" && error?.message && (
          <p className="text-xs text-error font-mono">{error.message}</p>
        )}
        <Button onClick={() => revalidate()}>
          {providerText(t, "pageLoadErrorRetry", "Try Again")}
        </Button>
      </div>
    </div>
  );
}
