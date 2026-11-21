/**
 * Which files the Vite dev server's watcher skips.
 *
 * Vite's watcher (chokidar) opens one native watch per file, synchronously; on Windows that is
 * about 4 ms each. Watching the whole repository root (~19,500 files with tests/, .build/ and
 * _artifacts/) froze the event loop for over a minute at startup, past Vite's 60 s module-load
 * timeout, so `npm run dev` never came up. Only the folders below hold code or content the app
 * loads.
 *
 * Files directly at the root (vite.config.ts, .env) are not watched either. An edit there made
 * Vite restart itself in place, which closes the module runner while the background jobs `boot()`
 * started keep running against it ("Vite module runner has been closed" on every sweep), and
 * `boot()` never runs again. After such an edit, restart `npm run dev` instead.
 */
export const DEV_WATCHED_FOLDERS = new Set([
  "src",
  "open-sse",
  "packages",
  "docs",
  "public",
  "skills",
  ".source",
]);

/**
 * Builds the chokidar `ignored` matcher for a repository root: true for root files, for anything
 * under the root outside the watched folders, and for test folders inside them. A top-level folder
 * is told apart from a root file by the `stats` chokidar passes. Paths outside the root are left
 * to Vite's own defaults.
 *
 * @param {string} root absolute path of the repository root
 * @returns {(file: string, stats?: { isDirectory(): boolean }) => boolean}
 */
export function createDevWatchIgnore(root) {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  return (file, stats) => {
    const normalized = file.replace(/\\/g, "/");
    if (!normalized.startsWith(`${normalizedRoot}/`)) return false;
    const segments = normalized.slice(normalizedRoot.length + 1).split("/");
    if (segments.length === 1) {
      // Without stats the entry is unknown; keep it, since ignoring a watched folder would
      // silently turn off hot reload.
      if (!stats) return false;
      return !(stats.isDirectory() && DEV_WATCHED_FOLDERS.has(segments[0]));
    }
    return !DEV_WATCHED_FOLDERS.has(segments[0]) || segments.includes("__tests__");
  };
}
