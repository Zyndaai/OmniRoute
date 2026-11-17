import { db, toMs, ts } from "../../src/lib/db/pg.ts";

const MAX_SIGNATURES = 1000;
const MAX_PERSISTED_SIGNATURES = 2_000;
const MEMORY_TTL_MS = 1000 * 60 * 60;
const PERSISTED_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export type SignatureCacheMode = "enabled" | "bypass" | "bypass-strict";

type Entry = {
  signature: string;
  expiresAt: number;
};

const signatures = new Map<string, Entry>();
let signatureCacheMode: SignatureCacheMode = "enabled";
let persistedPruneCounter = 0;
const MAX_LOGGED_ERRORS = 50;
const loggedPersistenceErrors = new Set<string>();

function warnPersistenceError(operation: string, error: unknown) {
  if (process.env.NODE_ENV === "test") return;
  if (loggedPersistenceErrors.has(operation)) return;
  if (loggedPersistenceErrors.size >= MAX_LOGGED_ERRORS) {
    const first = loggedPersistenceErrors.values().next().value;
    if (first !== undefined) loggedPersistenceErrors.delete(first);
  }
  loggedPersistenceErrors.add(operation);
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[signature-cache] persisted ${operation} failed: ${message}`);
}

export function buildGeminiThoughtSignatureKey(namespace: unknown, toolCallId: unknown): unknown {
  if (
    typeof namespace === "string" &&
    namespace.length > 0 &&
    typeof toolCallId === "string" &&
    toolCallId.length > 0
  ) {
    return `${namespace}:${toolCallId}`;
  }
  return toolCallId;
}

/**
 * Model family that produced (or will consume) a thought signature. Each backend only
 * accepts its own signatures: a Claude signature replayed to Gemini (or the reverse)
 * is rejected with 400 "Corrupted thought signature" (#4136 — Antigravity serves both
 * families on one connection). Unknown models return null and keep the legacy key.
 */
export function getThoughtSignatureModelFamily(model: unknown): "claude" | "gemini" | null {
  if (typeof model !== "string" || model.length === 0) return null;
  const normalized = model.toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("gemini")) return "gemini";
  return null;
}

/**
 * Scope a signature namespace (connection id) by model family, so a lookup from a
 * different family is a cache miss instead of replaying a foreign signature (#4136).
 */
export function scopeGeminiThoughtSignatureNamespace<T extends string | null | undefined>(
  namespace: T,
  model: unknown
): T | string {
  if (typeof namespace !== "string" || namespace.length === 0) return namespace;
  const family = getThoughtSignatureModelFamily(model);
  return family ? `${namespace}:${family}` : namespace;
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, value] of signatures.entries()) {
    if (value.expiresAt <= now) {
      signatures.delete(key);
    }
  }

  while (signatures.size > MAX_SIGNATURES) {
    const oldestKey = signatures.keys().next().value;
    if (!oldestKey) break;
    signatures.delete(oldestKey);
  }
}

/** Postgres text rejects U+0000, and upstream signatures are untrusted input. */
function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
}

async function maybePrunePersistedSignatures() {
  persistedPruneCounter += 1;
  if (persistedPruneCounter % 100 !== 0) return;

  const executor = db();
  await executor.execute("DELETE FROM gemini_thought_signatures WHERE expires_at <= now()");
  await executor.execute(
    `DELETE FROM gemini_thought_signatures WHERE signature_key IN (
       SELECT signature_key FROM gemini_thought_signatures
        ORDER BY created_at DESC OFFSET $1)`,
    [MAX_PERSISTED_SIGNATURES]
  );
}

export async function storeGeminiThoughtSignature(toolCallId: unknown, signature: unknown) {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  if (typeof signature !== "string" || !signature) return;

  const now = Date.now();
  pruneExpired();
  signatures.set(toolCallId, {
    signature,
    expiresAt: now + MEMORY_TTL_MS,
  });

  try {
    await db().execute(
      `INSERT INTO gemini_thought_signatures (signature_key, signature, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (signature_key) DO UPDATE
         SET signature = EXCLUDED.signature, created_at = EXCLUDED.created_at,
             expires_at = EXCLUDED.expires_at`,
      [
        stripNul(toolCallId),
        stripNul(signature),
        ts(now),
        ts(now + PERSISTED_TTL_MS),
      ]
    );
    await maybePrunePersistedSignatures();
  } catch (error) {
    warnPersistenceError("store", error);
  }
}

export async function getGeminiThoughtSignature(toolCallId: unknown) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;

  pruneExpired();
  const entry = signatures.get(toolCallId);
  if (entry) return entry.signature;

  try {
    const row = await db().queryOne<{ signature: string; expires_at: string }>(
      "SELECT signature, expires_at FROM gemini_thought_signatures WHERE signature_key = $1",
      [stripNul(toolCallId)]
    );

    if (row) {
      const now = Date.now();
      if (!row.signature || (toMs(row.expires_at) ?? 0) <= now) {
        await db().execute(
          "DELETE FROM gemini_thought_signatures WHERE signature_key = $1 AND expires_at <= now()",
          [stripNul(toolCallId)]
        );
        return null;
      }

      signatures.set(toolCallId, {
        signature: row.signature,
        expiresAt: now + MEMORY_TTL_MS,
      });

      return row.signature;
    }
  } catch (error) {
    warnPersistenceError("read", error);
  }

  return null;
}

export function normalizeSignatureCacheMode(value: unknown): SignatureCacheMode {
  return value === "bypass" || value === "bypass-strict" ? value : "enabled";
}

export function setGeminiThoughtSignatureMode(mode: unknown) {
  signatureCacheMode = normalizeSignatureCacheMode(mode);
}

export function getGeminiThoughtSignatureMode(): SignatureCacheMode {
  return signatureCacheMode;
}

function decodeSignature(signature: string): Buffer | null {
  if (!signature || (signature[0] !== "R" && signature[0] !== "E")) return null;

  const payload = signature.slice(1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return null;
  }

  try {
    const decoded = Buffer.from(payload, "base64");
    if (decoded.length === 0) return null;

    const canonical = decoded.toString("base64").replace(/=+$/g, "");
    if (canonical !== payload.replace(/=+$/g, "")) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function readVarint(
  buffer: Buffer,
  startOffset: number
): { nextOffset: number; value: number } | null {
  let offset = startOffset;
  let result = 0;
  let shift = 0;

  while (offset < buffer.length && shift < 35) {
    const byte = buffer[offset];
    result |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { nextOffset: offset, value: result };
    }

    shift += 7;
  }

  return null;
}

export function isValidBasicGeminiThoughtSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  const decoded = decodeSignature(signature);
  return Boolean(decoded && decoded[0] === 0x12);
}

export function isValidFullGeminiThoughtSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  const decoded = decodeSignature(signature);
  if (!decoded || decoded[0] !== 0x12) return false;

  const outerLength = readVarint(decoded, 1);
  if (!outerLength) return false;

  const outerEnd = outerLength.nextOffset + outerLength.value;
  if (outerEnd !== decoded.length) return false;

  const inner = decoded.subarray(outerLength.nextOffset, outerEnd);
  if (inner.length === 0 || inner[0] !== 0x0a) return false;

  const innerLength = readVarint(inner, 1);
  if (!innerLength) return false;

  return innerLength.nextOffset + innerLength.value === inner.length;
}

export async function resolveGeminiThoughtSignature(
  toolCallId: unknown,
  clientSignature?: unknown
): Promise<string | null> {
  const persisted = await getGeminiThoughtSignature(toolCallId);
  if (typeof clientSignature !== "string" || clientSignature.length === 0) {
    return persisted;
  }

  if (signatureCacheMode === "enabled") {
    return persisted;
  }

  const isValid =
    signatureCacheMode === "bypass-strict"
      ? isValidFullGeminiThoughtSignature(clientSignature)
      : isValidBasicGeminiThoughtSignature(clientSignature);

  if (isValid) {
    return clientSignature;
  }

  console.warn(
    `[signature-cache] ${signatureCacheMode}: invalid client thought signature, falling back`
  );
  return persisted;
}

export async function clearGeminiThoughtSignatures() {
  signatures.clear();
  signatureCacheMode = "enabled";
  try {
    await db().execute("DELETE FROM gemini_thought_signatures");
  } catch (error) {
    warnPersistenceError("clear", error);
  }
}

export function clearGeminiThoughtSignatureMemoryForTests() {
  signatures.clear();
}

export function getGeminiThoughtSignatureMemorySizeForTests() {
  pruneExpired();
  return signatures.size;
}
