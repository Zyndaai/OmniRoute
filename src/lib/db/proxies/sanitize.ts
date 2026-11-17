import { decrypt, encrypt } from "@/lib/db/encryption";

/** Postgres text and jsonb reject U+0000; upstream feeds can carry one (e.g. `%00` in a node name). */
export function stripNul(value: string): string;
export function stripNul(value: string | null | undefined): string | null | undefined;
export function stripNul(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? value.replace(/\u0000/g, "") : value;
}

/** Strips U+0000 from every string (keys and values) inside a JSON-like value. */
export function stripNulDeep<T>(value: T): T {
  if (typeof value === "string") return stripNul(value) as T;
  if (Array.isArray(value)) return value.map((item) => stripNulDeep(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[stripNul(key)] = stripNulDeep(item);
    }
    return out as T;
  }
  return value;
}

/** Integer for an integer column: rounds, and maps NaN/Infinity/non-numbers to null. */
export function toIntOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/** proxy_registry.password is stored as an enc:v1 envelope; plaintext rows pass through. */
export function encryptProxyPassword(password: string): string {
  return (encrypt(stripNul(password)) as string | null | undefined) ?? "";
}

export function decryptProxyPassword<T>(password: T): T | string {
  return typeof password === "string" ? ((decrypt(password) as string | null) ?? "") : password;
}
