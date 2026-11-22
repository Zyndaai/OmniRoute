import type { ShouldRevalidateFunctionArgs } from "react-router";

/**
 * `shouldRevalidate` for a dashboard page whose query string only holds view state (a tab, a
 * filter, an open panel) that the loaded data does not depend on: changing it does not re-run
 * the loader. Any other navigation and a same-URL `revalidator.revalidate()` behave as usual.
 *
 *   export const shouldRevalidate = skipSearchOnlyRevalidation;
 */
export function skipSearchOnlyRevalidation({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: Pick<ShouldRevalidateFunctionArgs, "currentUrl" | "nextUrl" | "defaultShouldRevalidate">) {
  if (currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) {
    return false;
  }
  return defaultShouldRevalidate;
}
