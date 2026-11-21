import { test } from "node:test";
import assert from "node:assert/strict";
import { runBoot } from "../../src/server/boot";

// Regression guard for #10171: on native Windows/WSL2 boots, the reported
// symptom is a bare HTTP 500 on every DB-touching route with `app.log`
// staying completely empty, even though the CLI prints "OmniRoute is
// running!". ensureDbReadyForBoot() (#7773/#7828) already guarantees a
// non-empty [STARTUP] Fatal: log line for ONE specific failure class
// (database driver init), but nothing previously guaranteed a fatal throw
// ANYWHERE during boot (including a throw before ensureDbReadyForBoot is even
// reached) produces a diagnostic line. This test proves runBoot() catches any
// such throw at the outermost boundary and unconditionally logs a
// `[STARTUP] Fatal:` line to stdout before rethrowing, so app.log is never
// silently empty on a failed boot.

function captureConsoleError(): { captured: string[]; restore: () => void } {
  const originalError = console.error;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    captured,
    restore: () => {
      console.error = originalError;
    },
  };
}

test("#10171: any boot throw is logged with a non-empty [STARTUP] Fatal: line before rethrow", async () => {
  const { captured, restore } = captureConsoleError();

  // Simulates a module-load-time failure reaching the boot boundary BEFORE
  // ensureDbReadyForBoot's own #7773 guard is reached — the class of failure
  // the reporter's empty app.log suggests on native Windows/WSL2.
  const bootFailureMessage = "Cannot find native binding for platform=win32-x64";
  const fakeRegisterNodejs = async () => {
    throw new Error(bootFailureMessage);
  };

  try {
    await assert.rejects(
      () => runBoot(fakeRegisterNodejs),
      (err: Error) => err.message === bootFailureMessage
    );

    const fatalLine = captured.find(
      (line) => line.includes("[STARTUP] Fatal:") && line.includes(bootFailureMessage)
    );
    assert.ok(
      fatalLine,
      "Expected a non-empty '[STARTUP] Fatal:' console.error line containing the boot " +
        "failure before it propagates, so app.log is never silently empty on a failed " +
        "boot (#10171). None was logged."
    );
  } finally {
    restore();
  }
});

test("#10171: a non-Error throw during boot is still logged and rethrown as a real Error", async () => {
  const { captured, restore } = captureConsoleError();

  // Mirrors real-world non-Error throws (e.g. sql.js's bare `throw "Database closed"`,
  // #6560) reaching this outermost boundary before normalization.
  const fakeRegisterNodejs = async () => {
    throw "raw string boot failure";
  };

  try {
    await assert.rejects(
      () => runBoot(fakeRegisterNodejs),
      (err: unknown) => {
        assert.ok(err instanceof Error, "runBoot() must rethrow a real Error instance");
        assert.equal(err.message, "raw string boot failure");
        return true;
      }
    );

    const fatalLine = captured.find(
      (line) => line.includes("[STARTUP] Fatal:") && line.includes("raw string boot failure")
    );
    assert.ok(fatalLine, "Expected a non-empty '[STARTUP] Fatal:' line for a non-Error throw too.");
  } finally {
    restore();
  }
});

test("runBoot() does not log anything on a clean successful boot", async () => {
  const { captured, restore } = captureConsoleError();
  const fakeRegisterNodejs = async () => {};

  try {
    await assert.doesNotReject(runBoot(fakeRegisterNodejs));
    assert.equal(captured.length, 0, "a successful boot must not emit any fatal startup log lines");
  } finally {
    restore();
  }
});
