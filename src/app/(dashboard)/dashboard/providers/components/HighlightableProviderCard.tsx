import { useCallback, useState } from "react";
import type { ComponentProps } from "react";
import { useLocation } from "react-router";
import ProviderCard from "./ProviderCard";
import type { ProviderCardHandle } from "./ProviderCard";
import {
  readRecordedProvider,
  recordProviderNavigation,
  resolveHighlightedCard,
} from "../providerPageHighlightUtils";

type ProviderCardProps = ComponentProps<typeof ProviderCard>;

/**
 * ProviderCard wrapper that owns the back-navigation highlight concern
 * (#8349): records the clicked provider id against the list's history entry
 * before navigating, and on return scrolls the matching card into view and
 * highlights it. Each card instance keeps its own copy of the highlighted
 * id; only the card whose provider id matches reacts, so the instances
 * never interfere with each other.
 */
export default function HighlightableProviderCard(props: ProviderCardProps) {
  const { key: locationKey } = useLocation();
  const [highlightedProviderId, setHighlightedProviderId] = useState<string | null>(() =>
    readRecordedProvider(locationKey)
  );

  const handleCardClick = useCallback(
    (id: string) => {
      recordProviderNavigation(locationKey, id);
    },
    [locationKey]
  );

  const highlightedCardRef = useCallback(
    (handle: ProviderCardHandle | null) => {
      resolveHighlightedCard(handle, highlightedProviderId, () => setHighlightedProviderId(null));
    },
    [highlightedProviderId]
  );

  return <ProviderCard {...props} onCardClick={handleCardClick} ref={highlightedCardRef} />;
}
