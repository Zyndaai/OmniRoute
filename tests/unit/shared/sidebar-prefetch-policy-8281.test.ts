import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SIDEBAR = "src/shared/components/Sidebar.tsx";
const HOME_PAGE = "src/app/(dashboard)/dashboard/HomePageClient.tsx";

// #8281: the dashboard's links must never trigger speculative route requests
// on first paint. React Router's `<Link>` does not prefetch unless it is given
// a `prefetch` prop, so the guard is that no link opts in.
test("#8281: the sidebar links never opt into route prefetch", async () => {
  const source = await readFile(SIDEBAR, "utf8");

  const internalLink = source.match(/<Link\s+[\s\S]*?to=\{item\.href\}[\s\S]*?>/);
  assert.ok(internalLink, "expected the sidebar's internal navigation Link");
  assert.doesNotMatch(internalLink[0], /prefetch=/);

  const logoLink = source.match(/<Link\s+to="\/home"[\s\S]*?>/);
  assert.ok(logoLink, "expected the sidebar logo home Link");
  assert.doesNotMatch(logoLink[0], /prefetch=/);
});

test("#8281: the /home quick-start links never opt into route prefetch", async () => {
  const source = await readFile(HOME_PAGE, "utf8");

  const links = source.match(/<Link[\s\S]*?>/g) ?? [];
  const internal = links.filter((link) => /to="\/(docs|dashboard\/)/.test(link));
  assert.ok(internal.length >= 5, `expected the quick-start links, found ${internal.length}`);

  for (const link of internal) {
    assert.doesNotMatch(link, /prefetch=/, `internal Link opts into prefetch: ${link}`);
  }
});
