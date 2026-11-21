#!/usr/bin/env node
/**
 * The base path (reverse-proxy subpath) is compiled into the build: the router's `basename`
 * and every asset URL. The image records the value it was built with in
 * `.build/app/BASE_PATH`; this prints one warning when the container is started with a
 * different OMNIROUTE_BASE_PATH, since that value cannot take effect without a rebuild.
 *
 * Reads the value from the environment itself (Hard Rule #13: never interpolated into a
 * shell command). Never fails the start.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeBasePath } from "../build/normalizeBasePath.mjs";

const buildDir = process.env.OMNIROUTE_BUILD_DIR || join(process.cwd(), ".build", "app");

let built;
try {
  built = normalizeBasePath(readFileSync(join(buildDir, "BASE_PATH"), "utf8"));
} catch {
  process.exit(0);
}

const requested = normalizeBasePath(process.env.OMNIROUTE_BASE_PATH);
if (requested !== built) {
  console.warn(
    `WARNING: OMNIROUTE_BASE_PATH is "${requested || "/"}" but this image was built for ` +
      `"${built || "/"}". The base path is fixed at build time: rebuild the image with ` +
      `--build-arg OMNIROUTE_BASE_PATH=${requested || '""'}.`
  );
}
