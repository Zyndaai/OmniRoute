import type { Config } from "@react-router/dev/config";

import { normalizeBasePath } from "./scripts/build/normalizeBasePath.mjs";

export default {
  appDirectory: "src/app",
  // A subpath deploy (OMNIROUTE_BASE_PATH=/omniroute) is fixed at build time; Vite's `base`
  // in vite.config.ts carries the same value for asset URLs.
  basename: normalizeBasePath(process.env.OMNIROUTE_BASE_PATH) || "/",
  buildDirectory: process.env.OMNIROUTE_BUILD_DIR || ".build/app",
  ssr: true,
  // React Router's action origin check compares `Origin` with `request.url`, which this server
  // builds from its bound address, so it would refuse every same-origin dashboard write. The
  // request pipeline checks page writes against the trusted public origins instead
  // (src/server/origin/pageActionOrigin.ts, tests/unit/server/page-action-origin.test.ts).
  allowedActionOrigins: ["**"],
} satisfies Config;
