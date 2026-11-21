import type { MetaDescriptor } from "react-router";

type MatchWithMeta = { meta?: MetaDescriptor[] } | undefined;

/** The identity of a descriptor for replacement: a title, or a `name`/`property` meta tag. */
function descriptorKey(descriptor: MetaDescriptor): string | null {
  const record = descriptor as Record<string, unknown>;
  if ("title" in record) return "title";
  if (typeof record.name === "string") return `name:${record.name}`;
  if (typeof record.property === "string") return `property:${record.property}`;
  return null;
}

/**
 * A route's `meta` array replaces its parents' entirely. This returns `own` plus every entry the
 * parent routes' meta produced that `own` does not replace (same title, `name` or `property`),
 * so a page that sets only a title and description keeps, for example, the docs layout's
 * `robots` tag.
 */
export function pageMeta(
  matches: readonly MatchWithMeta[],
  own: MetaDescriptor[]
): MetaDescriptor[] {
  const replaced = new Set(own.map(descriptorKey).filter((key): key is string => key !== null));
  const all = matches.flatMap((match) => match?.meta ?? []);
  // A deeper route's entry wins over the same entry from a shallower one.
  const lastIndex = new Map<string, number>();
  all.forEach((descriptor, index) => {
    const key = descriptorKey(descriptor);
    if (key !== null) lastIndex.set(key, index);
  });
  const inherited = all.filter((descriptor, index) => {
    const key = descriptorKey(descriptor);
    return key === null || (!replaced.has(key) && lastIndex.get(key) === index);
  });
  return [...inherited, ...own];
}
