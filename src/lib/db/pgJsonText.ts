/**
 * Helpers for the writers that still hand this layer pre-serialised JSON text
 * (a2a tasks, skill executions, batch checkpoints). Postgres rejects U+0000 in
 * jsonb, so strip it before binding; text that is not JSON becomes a JSON string.
 */

/** Removes U+0000 characters from a string. */
export function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
}

/** jsonb parameter from JSON text. Non-JSON text is stored as a JSON string (J-raw). */
export function jsonTextParam(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  // The escaped form is what JSON.stringify emits for a NUL inside a string.
  const cleaned = stripLoneSurrogateEscapes(
    stripNul(text).replace(/(?<!\\)((?:\\\\)*)\\u0000/g, "$1")
  );
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    return stripLoneSurrogateEscapes(JSON.stringify(cleaned));
  }
}

/**
 * JSON.stringify writes a lone UTF-16 surrogate as `\udXXX`, which jsonb rejects.
 * Replace each unpaired one with U+FFFD; valid high+low escape pairs stay.
 */
function stripLoneSurrogateEscapes(json: string): string {
  if (!/\\u[dD][89a-fA-F]/.test(json)) return json;
  return json.replace(
    /\\(?:u([dD][89a-fA-F][0-9a-fA-F]{2})(?:\\u([dD][c-fC-F][0-9a-fA-F]{2}))?|[\s\S])/g,
    (match, first: string | undefined, second: string | undefined) => {
      if (!first) return match;
      const isHigh = /^[dD][89abAB]/.test(first);
      if (isHigh && second) return match;
      return second ? "\\ufffd\\ufffd" : "\\ufffd";
    }
  );
}

/** jsonb parameter from a value, with U+0000 removed from every string. */
export function jsonValueParam(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return jsonTextParam(JSON.stringify(value));
}

/** Parsed jsonb value back to the JSON text the legacy `*_json` consumers expect. */
export function jsonToText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
