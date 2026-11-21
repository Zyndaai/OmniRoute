import { Outlet, useRevalidator, useRouteError } from "react-router";
import Button from "@/shared/components/Button";

export default function MitmProxyLayout() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError() as (Error & { digest?: string }) | undefined;
  const { revalidate } = useRevalidator();

  return (
    <div
      className="flex flex-col items-center justify-center min-h-[400px]"
      role="alert"
      aria-live="assertive"
    >
      <div className="text-center space-y-4">
        <h2 className="text-xl font-semibold text-error">Failed to load MITM proxy</h2>
        <p className="text-text-muted max-w-md">
          We could not load MITM proxy data right now. Check your connection and try again.
        </p>
        {error?.digest && (
          <p className="text-xs text-text-muted font-mono">Error ID: {error.digest}</p>
        )}
        {process.env.NODE_ENV === "development" && error?.message && (
          <p className="text-xs text-error font-mono">{error.message}</p>
        )}
        <Button variant="primary" onClick={() => revalidate()}>
          Try Again
        </Button>
      </div>
    </div>
  );
}
