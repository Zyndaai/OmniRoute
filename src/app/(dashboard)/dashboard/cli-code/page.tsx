import { useLoaderData } from "react-router";
import { getMachineId } from "@/shared/utils/machine";
import { apiJsonOrNull, apiRead } from "@/server/routing/dashboardApi.server";
import CliCodePageClient from "./CliCodePageClient";
import { profileSyncFromFlags } from "./components/CliProfileAutoSyncToggles";
import { getCompanionTargets } from "@/lib/cli-helper/companionTargets.server";

// The tool statuses probe local binaries (`/api/cli-tools/...`), so they stay a client read
// behind the card skeletons. Both reads below are optional: a failed provider read means "no
// active providers" and a failed flags read shows "HTTP <status>" in the toggles card, as before.
export async function loader() {
  const [machineId, providers, flags] = await Promise.all([
    getMachineId(),
    apiJsonOrNull<{ connections?: Array<{ isActive?: boolean }> }>("/api/providers"),
    apiRead<{ flags?: unknown }>("/api/settings/feature-flags"),
  ]);
  const hasActiveProviders = (providers?.connections ?? []).some((c) => c.isActive !== false);
  const profileSync = flags.ok
    ? { ...profileSyncFromFlags(flags.data), error: null }
    : { codex: false, claude: false, error: `HTTP ${flags.status}` };
  return { machineId, companionTargets: getCompanionTargets(), hasActiveProviders, profileSync };
}

export default function CliCodePage() {
  const { machineId, companionTargets, hasActiveProviders, profileSync } =
    useLoaderData<typeof loader>();
  return (
    <CliCodePageClient
      machineId={machineId}
      companionTargets={companionTargets}
      hasActiveProviders={hasActiveProviders}
      profileSync={profileSync}
    />
  );
}
