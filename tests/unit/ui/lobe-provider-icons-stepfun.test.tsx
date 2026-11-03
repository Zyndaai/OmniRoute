import { beforeAll, describe, expect, it } from "vitest";

// The initial dynamic import of the icons registry (@lobehub/icons, hundreds of
// modules) is slow in a cold vitest run, and under a full parallel run it passed
// 30s. Pay it once in beforeAll with its own budget so the test only times the
// resolution it actually checks (see agent-card.test.tsx for the same overhead).
let getLobeProviderIcon: typeof import("@/shared/components/lobeProviderIcons").getLobeProviderIcon;

beforeAll(async () => {
  ({ getLobeProviderIcon } = await import("@/shared/components/lobeProviderIcons"));
}, 180_000);

describe("lobeProviderIcons Stepfun fallback", () => {
  it("loads the icon registry and resolves the color slot to the Mono component", () => {
    const monoIcon = getLobeProviderIcon("stepfun", "mono");
    const colorIcon = getLobeProviderIcon("stepfun", "color");

    expect(monoIcon).not.toBeNull();
    expect(colorIcon).toBe(monoIcon);
  });
});
