import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Alias } from "vite";

import { shouldStubBetterSqlite3 } from "./scripts/build/better-sqlite3-stub-flag.mjs";
import { createDevWatchIgnore } from "./scripts/build/dev-watch-ignore.mjs";
import { shouldStubMitmManager } from "./scripts/build/mitm-stub-flag.mjs";
import { normalizeBasePath } from "./scripts/build/normalizeBasePath.mjs";
import * as docsConfig from "./source.config.ts";

type Env = Record<string, string | undefined>;

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Every `process.env.NEXT_PUBLIC_*` name the app reads. Operators set them at build time. */
const PUBLIC_ENV_NAMES = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_CLOUD_URL",
  "NEXT_PUBLIC_CLOUDFLARE_RELAY_DEFAULT_PROJECT",
  "NEXT_PUBLIC_CLOUDFLARE_RELAY_ENABLED",
  "NEXT_PUBLIC_DENO_RELAY_DEFAULT_PROJECT",
  "NEXT_PUBLIC_DENO_RELAY_ENABLED",
  "NEXT_PUBLIC_ENABLE_SOCKS5_PROXY",
  "NEXT_PUBLIC_LIVE_WS_PUBLIC_URL",
  "NEXT_PUBLIC_OMNIROUTE_E2E_MODE",
  "NEXT_PUBLIC_PORT",
  "NEXT_PUBLIC_VERCEL_RELAY_DEFAULT_PROJECT",
  "NEXT_PUBLIC_VERCEL_RELAY_ENABLED",
];

const literal = (value: string | undefined) =>
  value === undefined ? "undefined" : JSON.stringify(value);

/** Values derived by the build itself; they win over the environment. */
function derivedPublicEnv(env: Env, basePath: string): Record<string, string> {
  return {
    NEXT_PUBLIC_OMNIROUTE_BASE_PATH: basePath,
    // Names the PWA service-worker generation. `scripts/build/build.mjs` sets
    // OMNIROUTE_SW_BUILD_ID so the same id lands in this bundle and in the built `sw.js`.
    NEXT_PUBLIC_SW_BUILD_ID: env.OMNIROUTE_SW_BUILD_ID || env.SOURCE_VERSION || `${Date.now()}`,
  };
}

/**
 * Browser bundle: every public name is replaced, an unset one by `undefined` (the browser has no
 * `process`). `OMNIROUTE_BASE_PATH` is read as a fallback by `getDeployBasePath()`.
 */
function browserDefine(env: Env, derived: Record<string, string>): Record<string, string> {
  const define: Record<string, string> = {};
  for (const name of PUBLIC_ENV_NAMES) define[`process.env.${name}`] = literal(env[name]);
  for (const [name, value] of Object.entries(derived)) {
    define[`process.env.${name}`] = literal(value);
  }
  define["process.env.OMNIROUTE_BASE_PATH"] = literal(derived.NEXT_PUBLIC_OMNIROUTE_BASE_PATH);
  return define;
}

/** Server bundle: only names set at build time are inlined; the rest stay runtime reads. */
function serverDefine(env: Env, derived: Record<string, string>): Record<string, string> {
  const define: Record<string, string> = {};
  for (const name of PUBLIC_ENV_NAMES) {
    if (env[name] !== undefined) define[`process.env.${name}`] = literal(env[name]);
  }
  for (const [name, value] of Object.entries(derived)) {
    define[`process.env.${name}`] = literal(value);
  }
  // Build-time switch for the page framing policy (src/server/http/securityHeaders.ts); the
  // Docker image sets it only in the builder stage, so it must not be read at runtime.
  define["process.env.DASHBOARD_ALLOW_EMBED"] = literal(env.DASHBOARD_ALLOW_EMBED);
  return define;
}

/** Build-time module substitutions, each behind its own switch. */
function moduleStubs(env: Env): Alias[] {
  const stub = (specifier: string, file: string): Alias => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
    replacement: fromRoot(file),
  });
  const aliases: Alias[] = [];
  // Containers that cannot run the MITM stack (the Docker image sets OMNIROUTE_MITM_STUB=1).
  if (shouldStubMitmManager(env)) {
    aliases.push(stub("@/mitm/manager", "./src/mitm/manager.stub.ts"));
  }
  // Only for a build host where loading the native addon aborts; the result cannot open a DB.
  if (shouldStubBetterSqlite3(env)) {
    aliases.push(stub("better-sqlite3", "./src/lib/db/better-sqlite3.stub.js"));
  }
  // `omniroute-secure`: four privileged optional modules are compiled out.
  if (env.OMNIROUTE_BUILD_PROFILE === "minimal") {
    aliases.push(
      stub("@/mitm/cert/install", "./src/mitm/cert/install.stub.ts"),
      stub("@/lib/zed-oauth/keychain-reader", "./src/lib/zed-oauth/keychain-reader.stub.ts"),
      stub("@/lib/cloudSync", "./src/lib/cloudSync.stub.ts"),
      stub(
        "@/lib/services/installers/ninerouter",
        "./src/lib/services/installers/ninerouter.stub.ts"
      )
    );
  }
  return aliases;
}

export default defineConfig(({ mode }) => {
  // The shell environment wins over `.env*` files. React Router's plugin loads those files too,
  // but only after this config has been evaluated, so they are read here as well.
  const env: Env = loadEnv(mode, ROOT, "");
  const basePath = normalizeBasePath(env.OMNIROUTE_BASE_PATH);
  const derived = derivedPublicEnv(env, basePath);

  return {
    base: `${basePath}/`,
    build: {
      // The Monaco editor (~2.6 MB) and the locale catalogs (~1.1 MB) are lazy chunks by design.
      chunkSizeWarningLimit: 3000,
      rolldownOptions: {
        // The per-plugin timing report is profiling output, not a problem with the build.
        checks: { bundlerTimings: false },
      },
    },
    environments: {
      client: {
        define: browserDefine(env, derived),
      },
      ssr: {
        define: serverDefine(env, derived),
        build: {
          rollupOptions: {
            // The server bundle starts at our Express app, so boot code and route
            // handlers share one module graph (one copy of every module).
            input: "./src/server/app.ts",
          },
        },
      },
    },
    plugins: [tailwindcss(), mdx(docsConfig), reactRouter()],
    optimizeDeps: {
      // The dev dependency scan misses these, so the first page load found them late, re-bundled
      // and answered its own module requests with 504 "Outdated Optimize Dep".
      include: [
        "clsx",
        "lucide-react",
        "tailwind-merge",
        "use-intl",
        "zustand",
        "zustand/middleware",
      ],
    },
    server: {
      // Only the app's own folders: watching the whole root stalled `npm run dev` past Vite's
      // 60 s module-load timeout. Root files (this config, .env) are not watched: restart
      // `npm run dev` after editing them (scripts/build/dev-watch-ignore.mjs).
      watch: { ignored: [createDevWatchIgnore(ROOT)] },
    },
    resolve: {
      alias: moduleStubs(env),
      tsconfigPaths: true,
    },
  };
});
