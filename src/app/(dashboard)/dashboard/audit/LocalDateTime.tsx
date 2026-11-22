import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * A timestamp in the viewer's locale and timezone. The server cannot know either, so it renders
 * nothing and the client fills it in (no hydration mismatch for server-rendered tables).
 */
export default function LocalDateTime({ value }: { value: string | number | Date }) {
  const text = useSyncExternalStore(
    noopSubscribe,
    () => {
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    },
    () => ""
  );
  return <>{text}</>;
}
