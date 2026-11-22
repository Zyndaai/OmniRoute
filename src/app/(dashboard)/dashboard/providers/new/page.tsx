import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { skipSearchOnlyRevalidation } from "@/shared/utils/routeRevalidation";
import ProviderOnboardingWizard from "../components/onboarding/ProviderOnboardingWizard";

// The loader reads nothing from the query string.
export const shouldRevalidate = skipSearchOnlyRevalidation;

// Optional read: a failed provider-nodes call leaves the Claude Code-compatible option hidden,
// as the wizard's own client fetch did.
export async function loader() {
  const nodes = await apiJsonOrNull<{ ccCompatibleProviderEnabled?: boolean }>(
    "/api/provider-nodes"
  );
  return { ccCompatibleProviderEnabled: nodes?.ccCompatibleProviderEnabled === true };
}

// "Add Provider" / onboarding route. The buttons in providers/page.tsx and the
// dashboard widgets navigate here (#5427). This used to be a redirect stub that
// bounced back to /dashboard/providers, so the wizard silently never opened and
// the fully-built ProviderOnboardingWizard stayed orphaned. Render it directly —
// auth is enforced centrally by the (dashboard) DashboardLayout, same as the
// sibling [id] and index routes, so no per-page guard is needed here.
export default function NewProviderPage() {
  const { ccCompatibleProviderEnabled } = useLoaderData<typeof loader>();
  return (
    <ProviderOnboardingWizard initialCcCompatibleProviderEnabled={ccCompatibleProviderEnabled} />
  );
}
