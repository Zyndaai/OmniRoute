import { useLoaderData } from "react-router";

import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { getMachineId } from "@/shared/utils/machine";
import HomePageClient from "../dashboard/HomePageClient";
import BootstrapBanner from "../dashboard/BootstrapBanner";
import FirstRunReadinessCard from "../dashboard/FirstRunReadinessCard";
import UnpricedUsageBanner from "../dashboard/UnpricedUsageBanner";

export async function loader() {
  // Display-only read: an unreadable settings table degrades to "setup not complete" instead
  // of failing the whole Home render (#14060). The failure stays in the API route; auth callers
  // of getSettings() still fail closed.
  const [settings, machineId] = await Promise.all([
    apiJsonOrNull<{ setupComplete?: unknown }>("/api/settings"),
    getMachineId(),
  ]);
  return {
    setupComplete: Boolean(settings?.setupComplete),
    machineId,
    isBootstrapped: process.env.OMNIROUTE_BOOTSTRAPPED === "true",
  };
}

export default function HomePage() {
  const { setupComplete, machineId, isBootstrapped } = useLoaderData<typeof loader>();
  return (
    <>
      {isBootstrapped && <BootstrapBanner />}
      <FirstRunReadinessCard setupComplete={setupComplete} />
      <UnpricedUsageBanner />
      <HomePageClient machineId={machineId} />
    </>
  );
}
