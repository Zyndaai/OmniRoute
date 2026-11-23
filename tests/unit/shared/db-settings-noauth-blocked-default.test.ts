import test from "node:test";
import assert from "node:assert/strict";

// Keyless (no-auth) providers start blocked: on an aggregator their public endpoints
// flooded /v1/models with hundreds of models nobody connected. Operators opt back in
// per provider, and a saved blockedProviders value always wins over the default.

// The shared test setup opts into upstream's all-enabled default; this file tests the
// production default, so drop that opt-in.
const savedNoAuthDefault = process.env.OMNIROUTE_NOAUTH_PROVIDERS_DEFAULT;
delete process.env.OMNIROUTE_NOAUTH_PROVIDERS_DEFAULT;

const settings = await import("../../../src/lib/db/settings.ts");
const { NOAUTH_PROVIDERS } = await import("../../../src/shared/constants/providers.ts");
const { isNoAuthProviderBlocked } = await import("../../../src/shared/utils/noAuthProviders.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

test.after(() => {
  if (savedNoAuthDefault === undefined) delete process.env.OMNIROUTE_NOAUTH_PROVIDERS_DEFAULT;
  else process.env.OMNIROUTE_NOAUTH_PROVIDERS_DEFAULT = savedNoAuthDefault;
});

test("a fresh install blocks every keyless provider", async () => {
  await resetTestDb();
  const { blockedProviders } = await settings.getSettings();
  const noAuth = Object.values(NOAUTH_PROVIDERS) as Array<{ id: string; alias?: string }>;
  assert.ok(noAuth.length > 0);
  for (const provider of noAuth) {
    assert.equal(
      isNoAuthProviderBlocked(blockedProviders, provider.id, provider.alias),
      true,
      `${provider.id} must start blocked`
    );
  }
});

test("re-enabling one keyless provider persists and leaves the rest blocked", async () => {
  await resetTestDb();
  const [first, ...rest] = settings.NOAUTH_PROVIDER_IDS;
  await settings.updateSettings({ blockedProviders: rest });
  const { blockedProviders } = await settings.getSettings();
  assert.deepEqual(blockedProviders, rest);
  assert.equal((blockedProviders as string[]).includes(first), false);
});

test("an explicitly saved empty list unblocks everything", async () => {
  await resetTestDb();
  await settings.updateSettings({ blockedProviders: [] });
  assert.deepEqual((await settings.getSettings()).blockedProviders, []);
});

test("the default is a fresh copy, so mutating one read cannot leak into the next", async () => {
  await resetTestDb();
  const first = (await settings.getSettings()).blockedProviders as string[];
  first.length = 0;
  const second = (await settings.getSettings()).blockedProviders as string[];
  assert.equal(second.length, settings.NOAUTH_PROVIDER_IDS.length);
});

test("OMNIROUTE_NOAUTH_PROVIDERS_DEFAULT=enabled restores upstream's all-enabled default", async () => {
  await resetTestDb();
  process.env.OMNIROUTE_NOAUTH_PROVIDERS_DEFAULT = "enabled";
  try {
    assert.deepEqual((await settings.getSettings()).blockedProviders, []);
  } finally {
    delete process.env.OMNIROUTE_NOAUTH_PROVIDERS_DEFAULT;
  }
});
