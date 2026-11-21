import type { Config } from "@react-router/dev/config";

import { normalizeBasePath } from "./scripts/build/normalizeBasePath.mjs";

export default {
  appDirectory: "src/app",
  // A subpath deploy (OMNIROUTE_BASE_PATH=/omniroute) is fixed at build time; Vite's `base`
  // in vite.config.ts carries the same value for asset URLs.
  basename: normalizeBasePath(process.env.OMNIROUTE_BASE_PATH) || "/",
  buildDirectory: process.env.OMNIROUTE_BUILD_DIR || ".build/app",
  ssr: true,
} satisfies Config;
