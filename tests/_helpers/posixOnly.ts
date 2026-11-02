// Drop-in replacement for `node:test` in files whose tests run POSIX shell-script fakes
// (extension-less files with a `#!` line standing in for cursor-agent, devin, auggie, ...).
// Windows cannot execute those: every spawn fails, and a spawn through cmd opens the
// "Pick an app" dialog once per call. On win32 every test and suite declared through this
// module is skipped with a reason; on every other platform it is `node:test` unchanged.
import nodeTest, { describe as nodeDescribe, it as nodeIt } from "node:test";

export { after, afterEach, before, beforeEach, mock, suite } from "node:test";

const SKIP_REASON =
  process.platform === "win32"
    ? "POSIX-only: runs shell-script fakes that Windows cannot execute"
    : false;

type Runner = typeof nodeTest;

function posixOnly<T extends Runner>(runner: T): T {
  if (!SKIP_REASON) return runner;
  const wrapped = (...args: unknown[]) => {
    const name = typeof args[0] === "string" ? args[0] : undefined;
    const options = args.find((arg) => arg !== null && typeof arg === "object") ?? {};
    const fn = args.find((arg) => typeof arg === "function");
    const skipped = { ...(options as object), skip: SKIP_REASON };
    return name === undefined
      ? (runner as Runner)(skipped, fn as never)
      : (runner as Runner)(name, skipped, fn as never);
  };
  // Keep test.skip / test.only / test.todo / test.mock and friends.
  return Object.assign(wrapped, runner) as unknown as T;
}

export const test = posixOnly(nodeTest);
export const it = posixOnly(nodeIt as Runner) as typeof nodeIt;
export const describe = posixOnly(
  nodeDescribe as unknown as Runner
) as unknown as typeof nodeDescribe;
export default test;
