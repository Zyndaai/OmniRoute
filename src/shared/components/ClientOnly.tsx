import { lazy, Suspense, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

const subscribe = () => () => {};

/**
 * Renders `children()` only in the browser, after hydration; the server and the first browser
 * render output `fallback`. For components that cannot render on the server (they touch
 * `window`, canvas, browser-only libraries).
 */
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: () => ReactNode;
  fallback?: ReactNode;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  return hydrated ? children() : fallback;
}

/**
 * A component loaded on demand and rendered only in the browser: `fallback` on the server and
 * until the chunk arrives. The replacement for `next/dynamic(load, { ssr: false })`.
 *
 * For a named export: `clientOnlyLazy(() => import("./x").then((m) => ({ default: m.X })))`.
 */
export function clientOnlyLazy<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  fallback: ReactNode = null
): ComponentType<P> {
  const Lazy = lazy(load) as unknown as ComponentType<P>;
  function ClientOnlyLazy(props: P) {
    return (
      <ClientOnly fallback={fallback}>
        {() => (
          <Suspense fallback={fallback}>
            <Lazy {...props} />
          </Suspense>
        )}
      </ClientOnly>
    );
  }
  return ClientOnlyLazy;
}
