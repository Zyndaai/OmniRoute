import { isCommonChatGptWebRetiredProviderId } from "@/shared/constants/chatgptWebRetirement";
import { isMicrosoftDesignerWebRetiredProviderId } from "@/shared/constants/designerWebRetirement";

type JsonRecord = Record<string, unknown>;

interface RetiredTombstone {
  errorCode: string | null;
  lastError: string;
  lastErrorType: string;
  lastErrorSource: string;
  /** The Designer trigger kept an existing lastErrorAt; the others restamped it. */
  keepLastErrorAt: boolean;
}

// The SQLite retire triggers (migrations 164, 165, 167, 168/171) turned rows of retired
// providers into tombstones on every insert and update. PostgreSQL has no triggers, so
// the write path applies the same values. JS trim()/toLowerCase() covers the same
// whitespace set the triggers matched.
const FELO_WEB_RETIRED_IDS = new Set(["felo-web", "felo"]);
const QWEN_WEB_RETIRED_IDS = new Set(["qwen-web", "qw"]);

const FELO: RetiredTombstone = {
  errorCode: "PROVIDER_REMOVED",
  lastError: "Provider integration retired from OmniRoute v3.8.50",
  lastErrorType: "provider_removed",
  lastErrorSource: "migration:retire-felo-web",
  keepLastErrorAt: false,
};
const QWEN: RetiredTombstone = {
  errorCode: "PROVIDER_REMOVED",
  lastError: "Provider integration retired from OmniRoute v3.8.51",
  lastErrorType: "provider_removed",
  lastErrorSource: "migration:retire-qwen-web",
  keepLastErrorAt: false,
};
const CHATGPT_WEB: RetiredTombstone = {
  errorCode: "PROVIDER_REMOVED",
  lastError: "Provider integration retired from OmniRoute v3.8.51",
  lastErrorType: "provider_removed",
  lastErrorSource: "migration:retire-chatgpt-web",
  keepLastErrorAt: false,
};
const MICROSOFT_DESIGNER: RetiredTombstone = {
  errorCode: null, // not touched by migration 164: the existing value is kept
  lastError: "Provider retired from OmniRoute runtime.",
  lastErrorType: "provider_retired",
  lastErrorSource: "migration:retire-microsoft-designer-web",
  keepLastErrorAt: true,
};

function tombstoneFor(provider: unknown): RetiredTombstone | null {
  if (typeof provider !== "string") return null;
  const id = provider.trim().toLowerCase();
  if (FELO_WEB_RETIRED_IDS.has(id)) return FELO;
  if (QWEN_WEB_RETIRED_IDS.has(id)) return QWEN;
  if (isCommonChatGptWebRetiredProviderId(id)) return CHATGPT_WEB;
  if (isMicrosoftDesignerWebRetiredProviderId(id)) return MICROSOFT_DESIGNER;
  return null;
}

// Migrations 165 and 168 (BEFORE UPDATE OF provider triggers): once a row belongs to one of
// these id groups, it may only be renamed within the group.
const IDENTITY_PRESERVED_GROUPS: ReadonlySet<string>[] = [
  FELO_WEB_RETIRED_IDS,
  new Set(["chatgpt-web", "cgpt-web"]),
];

export function assertRetiredProviderIdentityPreserved(
  oldProvider: unknown,
  newProvider: unknown
): void {
  const norm = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");
  const from = norm(oldProvider);
  const to = norm(newProvider);
  for (const group of IDENTITY_PRESERVED_GROUPS) {
    if (group.has(from) && !group.has(to)) {
      throw new Error("Retired provider connection identity cannot be changed");
    }
  }
}

/**
 * Returns the connection record to persist: unchanged for an active provider, and for a
 * retired one forced to the durable tombstone (inactive, unavailable, retirement error).
 */
export function applyRetiredProviderTombstone(conn: JsonRecord): JsonRecord {
  const tombstone = tombstoneFor(conn.provider);
  if (!tombstone) return conn;
  const alreadyStamped =
    conn.lastErrorAt !== null && conn.lastErrorAt !== undefined && conn.lastErrorAt !== "";
  const out: JsonRecord = {
    ...conn,
    isActive: false,
    testStatus: "unavailable",
    lastError: tombstone.lastError,
    lastErrorType: tombstone.lastErrorType,
    lastErrorSource: tombstone.lastErrorSource,
  };
  if (tombstone.errorCode) out.errorCode = tombstone.errorCode;
  const alreadyNormalized =
    conn.isActive === false &&
    conn.testStatus === "unavailable" &&
    conn.lastError === tombstone.lastError &&
    conn.lastErrorType === tombstone.lastErrorType &&
    conn.lastErrorSource === tombstone.lastErrorSource &&
    (!tombstone.errorCode || conn.errorCode === tombstone.errorCode);
  if (!(alreadyStamped && (tombstone.keepLastErrorAt || alreadyNormalized))) {
    out.lastErrorAt = new Date().toISOString();
  }
  return out;
}
