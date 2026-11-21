import { CLI_TARGET_MANIFEST } from "../../../bin/cli/cli-manifest.mjs";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { projectCompanionTargets } from "@/shared/utils/cliCompanion";

/** Node-backed executable manifests; read only from the cli-code page loader (server side). */
export function getCompanionTargets() {
  return projectCompanionTargets(CLI_TARGET_MANIFEST, CLI_TOOLS);
}
