// A text cell that starts with = + - @ (after any spaces) or with a tab or carriage return runs as
// a formula in a spreadsheet. Model and key names come from clients, so a leading quote makes them
// text. Values passed as numbers are never changed.
const CSV_FORMULA_START = /^(?:[\t\r]|\s*[=+\-@])/;

/** One CSV cell: quoted when it holds a quote, comma or newline; never a spreadsheet formula. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && CSV_FORMULA_START.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
