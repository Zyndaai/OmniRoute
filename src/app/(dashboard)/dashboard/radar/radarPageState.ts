export type PageState = "flag_off" | "optin_pending" | "empty" | "populated";

/** Determine the page state from the fetch result. */
export function resolveRadarPageState(
  flagOn: boolean,
  optedIn: boolean,
  hasEntries: boolean
): PageState {
  if (!flagOn) return "flag_off";
  if (!optedIn) return "optin_pending";
  if (!hasEntries) return "empty";
  return "populated";
}
