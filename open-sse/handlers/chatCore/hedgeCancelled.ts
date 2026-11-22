/**
 * Recognise a rejection caused by a combo hedge cancellation (a sibling target won the race).
 *
 * Upstream keeps this next to the abort reasons (`services/combo/comboAbortReasons.ts`); it lives
 * here because that file belongs to the combo module. The reason travels as the abort reason
 * error itself (native `fetch` rejects with `signal.reason`), as a raw string (`abort(reason)`
 * with a string), or nested in a wrapper's `.cause` chain (executors and proxy layers re-wrap
 * rejections). A bare DOMException abort and every other failure shape return false.
 */
import { COMBO_HEDGE_CANCELLED_REASON } from "../../services/combo/comboAbortReasons.ts";

export function isHedgeCancelledReasonError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current === "string") return current === COMBO_HEDGE_CANCELLED_REASON;
    if (typeof current !== "object") return false;
    let message: string;
    try {
      const value = (current as { message?: unknown }).message;
      message = typeof value === "string" ? value : "";
    } catch {
      return false;
    }
    if (message === COMBO_HEDGE_CANCELLED_REASON) return true;
    try {
      current = (current as { cause?: unknown }).cause;
    } catch {
      return false;
    }
  }
  return false;
}
