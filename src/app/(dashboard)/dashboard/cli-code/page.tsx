import { useLoaderData } from "react-router";
import { getMachineId } from "@/shared/utils/machine";
import CliCodePageClient from "./CliCodePageClient";
import { getCompanionTargets } from "@/lib/cli-helper/companionTargets.server";

export async function loader() {
  return { machineId: await getMachineId(), companionTargets: getCompanionTargets() };
}

export default function CliCodePage() {
  const { machineId, companionTargets } = useLoaderData<typeof loader>();
  return <CliCodePageClient machineId={machineId} companionTargets={companionTargets} />;
}
