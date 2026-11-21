import { useEffect, useState } from "react";
import { useLocation, type SetURLSearchParams } from "react-router";
import { providerFiltersToSearchParams, readProviderFiltersFromUrl } from "../providerPageUtils";
import {
  readProviderDisplayModePreference,
  type ProviderDisplayMode,
} from "../providerPageStorage";

const WRITTEN_BY_FILTERS = "providerFiltersWrite";

interface UseProviderUrlFiltersArgs {
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  providerDisplayMode: ProviderDisplayMode;
  setProviderDisplayMode: (mode: ProviderDisplayMode) => void;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  modelSearchQuery: string;
  setModelSearchQuery: (value: string) => void;
  activeCategory: string | null;
  setActiveCategory: (value: string | null) => void;
  showFreeOnly: boolean;
  setShowFreeOnly: (value: boolean) => void;
  activeServiceKind: string | null;
  setActiveServiceKind: (value: string | null) => void;
}

/**
 * useProviderUrlFilters — two-way sync between the providers dashboard filter
 * state and the URL query string, so a filtered/searched view is bookmarkable
 * and shareable.
 *
 * Hydration guard: the filter→URL sync effect must not write the URL before
 * the initial URL→state read has applied, or a bookmarked view would be
 * transiently clobbered by the default state on the first paint.
 *
 * Returns `displayModePreferenceReady`, which the caller also gates other
 * display-mode-dependent effects on.
 */
export function useProviderUrlFilters({
  searchParams,
  setSearchParams,
  providerDisplayMode,
  setProviderDisplayMode,
  searchQuery,
  setSearchQuery,
  modelSearchQuery,
  setModelSearchQuery,
  activeCategory,
  setActiveCategory,
  showFreeOnly,
  setShowFreeOnly,
  activeServiceKind,
  setActiveServiceKind,
}: UseProviderUrlFiltersArgs): { displayModePreferenceReady: boolean } {
  // Snapshot of the stored display-mode preference, read once via a lazy
  // initializer (localStorage must not be read during render). After the first
  // hydration the URL always carries the mode, so the fallback is mount-only.
  const [storedDisplayModePreference] = useState<ProviderDisplayMode>(() =>
    readProviderDisplayModePreference()
  );
  const [hydratedFromParams, setHydratedFromParams] = useState<URLSearchParams | null>(null);
  // Locations this hook writes carry WRITTEN_BY_FILTERS in their history state, so the
  // router handing back our own write is not mistaken for a new input.
  const location = useLocation();
  const ownWrite =
    (location.state as { [WRITTEN_BY_FILTERS]?: boolean } | null)?.[WRITTEN_BY_FILTERS] === true;

  // URL → state hydration as a render-phase adjustment guarded by the
  // previously hydrated params object (react.dev "adjusting state when a prop
  // changes") — replaces the two synchronous setState effects keyed on
  // searchParams, and removes the transient default-state first paint. The
  // first pass and any location this hook did not write (a link, Back/Forward)
  // are read; the router handing back our own write is skipped, because the
  // URL omits defaults (display mode "all") that hydration would turn into the
  // stored preference.
  if (hydratedFromParams !== searchParams) {
    setHydratedFromParams(searchParams);
    if (hydratedFromParams === null || !ownWrite) {
      const urlFilters = readProviderFiltersFromUrl(searchParams);
      setProviderDisplayMode(urlFilters.displayMode ?? storedDisplayModePreference);
      setSearchQuery(urlFilters.searchQuery ?? "");
      setModelSearchQuery(urlFilters.modelSearchQuery ?? "");
      setActiveCategory(urlFilters.category ?? null);
      setShowFreeOnly(urlFilters.showFreeOnly ?? false);
      setActiveServiceKind(urlFilters.mediaKind ?? null);
    }
  }
  const displayModePreferenceReady = hydratedFromParams !== null;
  const filtersHydrated = displayModePreferenceReady;

  useEffect(() => {
    if (!filtersHydrated || !displayModePreferenceReady) return;
    const next = providerFiltersToSearchParams(searchParams, {
      searchQuery,
      modelSearchQuery,
      displayMode: providerDisplayMode,
      category: activeCategory,
      showFreeOnly,
      mediaKind: activeServiceKind,
    });
    if (!next) return;
    setSearchParams(next, {
      replace: true,
      preventScrollReset: true,
      state: { [WRITTEN_BY_FILTERS]: true },
    });
  }, [
    filtersHydrated,
    displayModePreferenceReady,
    searchParams,
    setSearchParams,
    searchQuery,
    modelSearchQuery,
    providerDisplayMode,
    activeCategory,
    showFreeOnly,
    activeServiceKind,
  ]);

  return { displayModePreferenceReady };
}
