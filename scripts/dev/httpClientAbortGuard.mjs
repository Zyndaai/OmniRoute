"use strict";

/**
 * Re-export of the shared client-abort guard so the Node-only launcher
 * (`run-server.mjs`) imports it as a sibling. The real
 * implementation lives in `src/shared/utils/httpClientAbortGuard.mjs` (importable
 * from both `.mjs` and the TypeScript servers under `src/`, tsconfig allowJs).
 *
 * @module
 */

export {
  isClientAbortError,
  isRecoverableUpstreamTimeoutError,
  shouldSwallowUncaught,
  attachRequestStreamGuards,
  installProcessCrashGuard,
} from "../../src/shared/utils/httpClientAbortGuard.mjs";
