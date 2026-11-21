import { useLoaderData } from "react-router";

import { getMachineId } from "@/shared/utils/machine";
import { loadHomeSettings } from "./loadHomeSettings";
import HomePageClient from "../dashboard/HomePageClient";
import BootstrapBanner from "../dashboard/BootstrapBanner";
import FirstRunReadinessCard from "../dashboard/FirstRunReadinessCard";
import UnpricedUsageBanner from "../dashboard/UnpricedUsageBanner";

export async function loader() {
  // Settings failures degrade to defaults here (display-only) — see loadHomeSettings (#14060).
  const [settings, machineId] = await Promise.all([loadHomeSettings(), getMachineId()]);
  return {
    setupComplete: Boolean(settings.setupComplete),
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
