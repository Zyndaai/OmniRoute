import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectChromeExecutable } from "../../open-sse/executors/chatgpt-web-codex.ts";

// #18850: Chrome in the default Windows install locations must be found without CHROME_PATH.
// The fixtures are the only candidates that can exist on a Windows host, so equality is exact
// there; other platforms may find a system Chrome first and only assert that one is found.

function install(base: string): string {
  const exe = path.join(base, "Google", "Chrome", "Application", "chrome.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "");
  return exe;
}

test("detectChromeExecutable finds Chrome under the Windows default install roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chrome-win-"));
  const keys = [
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "LOCALAPPDATA",
    "CHATGPT_WEB_CODEX_CHROME_PATH",
    "CHROME_PATH",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.CHATGPT_WEB_CODEX_CHROME_PATH;
    delete process.env.CHROME_PATH;
    for (const [key, dir] of [
      ["PROGRAMFILES", "pf"],
      ["PROGRAMFILES(X86)", "pf86"],
      ["LOCALAPPDATA", "local"],
    ] as const) {
      process.env.PROGRAMFILES = path.join(root, "pf");
      process.env["PROGRAMFILES(X86)"] = path.join(root, "pf86");
      process.env.LOCALAPPDATA = path.join(root, "local");
      const exe = install(path.join(root, dir));
      const found = detectChromeExecutable();
      assert.ok(found, `${key} fixture must yield a Chrome path`);
      if (process.platform === "win32") assert.equal(found, exe);
      fs.rmSync(exe);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
