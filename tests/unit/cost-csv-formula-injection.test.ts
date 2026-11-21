// Model, provider and key names in the cost report come from clients; a name that starts like a
// formula must open as text in a spreadsheet.
import test from "node:test";
import assert from "node:assert/strict";

import { csvCell } from "../../src/app/(dashboard)/dashboard/costs/costCsv.ts";

test("a text cell that starts like a formula gets a leading quote", () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell("+cmd"), "'+cmd");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("  =1+1"), "'  =1+1");
  assert.equal(csvCell("\tx"), "'\tx");
});

test("ordinary text and numbers are unchanged", () => {
  assert.equal(csvCell("gpt-5"), "gpt-5");
  assert.equal(csvCell("openai"), "openai");
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell(42), "42");
});

test("quotes, commas and newlines are still escaped", () => {
  assert.equal(csvCell('a "b"'), '"a ""b"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("a\nb"), '"a\nb"');
});
