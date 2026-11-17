/**
 * Text-format parsers shared by `pg` (production) and PGlite (tests), so rows
 * have one shape everywhere: numbers for bigint/numeric, ISO-8601 strings for
 * timestamps (the code compares, sorts and `Date.parse`s them as strings), and
 * `YYYY-MM-DD` strings for dates (a Date would shift the day by the local zone).
 * jsonb, boolean and text use each driver's defaults (object, boolean, string).
 */
export const PG_TYPE_PARSERS: Record<number, (value: string) => unknown> = {
  // int8
  20: (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  },
  // numeric
  1700: (value) => Number(value),
  // date
  1082: (value) => value,
  // timestamp without time zone (the schema uses timestamptz; treat as UTC if one appears)
  1114: (value) => new Date(`${value.replace(" ", "T")}Z`).toISOString(),
  // timestamptz
  1184: (value) => new Date(value).toISOString(),
};
