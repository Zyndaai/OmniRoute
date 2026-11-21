import type { ProviderCardHandle } from "./components/ProviderCard";

const HIGHLIGHT_STORAGE_KEY = "omniroute.providers.lastOpened";

/**
 * Called before navigating to a provider detail page. Remembers the provider id against the
 * list page's history entry (the router's `location.key`, which Back restores) so the list can
 * scroll to it on back-navigation. Session storage rather than `history.state`, which belongs
 * to the router.
 */
export function recordProviderNavigation(locationKey: string, id: string) {
  try {
    window.sessionStorage.setItem(
      HIGHLIGHT_STORAGE_KEY,
      JSON.stringify({ locationKey, providerId: id })
    );
  } catch {
    // Storage unavailable (private mode, quota): the highlight is a convenience.
  }
}

/** The provider recorded for this history entry by `recordProviderNavigation`, if any. */
export function readRecordedProvider(locationKey: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(HIGHLIGHT_STORAGE_KEY);
    if (!raw) return null;
    const recorded = JSON.parse(raw) as { locationKey?: unknown; providerId?: unknown };
    return recorded.locationKey === locationKey && typeof recorded.providerId === "string"
      ? recorded.providerId
      : null;
  } catch {
    return null;
  }
}

/**
 * Ref callback for ProviderCard. When the rendered card's provider id
 * matches the highlighted id, scrolls it into view and triggers the
 * highlight animation. Always clears the highlighted id afterward so
 * subsequent re-renders don't re-scroll.
 */
export function resolveHighlightedCard(
  handle: ProviderCardHandle | null,
  highlightedProviderId: string | null,
  onAfterHighlight: () => void
) {
  if (handle?.getProviderId() === highlightedProviderId) {
    handle.scrollIntoView({ behavior: "auto", block: "center" });
    handle.highlight();
  }
  onAfterHighlight();
}
