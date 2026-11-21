import { redirect } from "react-router";

const LEGACY_TAB_ROUTES: Record<string, string> = {
  advanced: "/dashboard/settings/advanced",
  ai: "/dashboard/settings/ai",
  appearance: "/dashboard/settings/appearance",
  featureFlags: "/dashboard/settings/feature-flags",
  "feature-flags": "/dashboard/settings/feature-flags",
  cache: "/dashboard/settings/cache",
  general: "/dashboard/settings/general",
  modalityBridge: "/dashboard/settings/modality-bridge",
  "modality-bridge": "/dashboard/settings/modality-bridge",
  resilience: "/dashboard/settings/resilience",
  routing: "/dashboard/settings/routing",
  security: "/dashboard/settings/security",
  sidebar: "/dashboard/settings/sidebar",
};

function resolveSettingsRoute(value: string | null): string {
  return value
    ? LEGACY_TAB_ROUTES[value] || "/dashboard/settings/general"
    : "/dashboard/settings/general";
}

export function loader({ request }: { request: Request }) {
  throw redirect(resolveSettingsRoute(new URL(request.url).searchParams.get("tab")), 307);
}

export default function SettingsPage() {
  return null;
}
