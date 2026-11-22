/**
 * Command line for the SQLite -> PostgreSQL transfer.
 *
 *   OMNIROUTE_TRANSFER_TARGET_URL=postgres://... STORAGE_ENCRYPTION_KEY=... \
 *     node src/lib/db/backends/transfer/cli.js --source /path/storage.sqlite --receipt receipt.json
 *
 * (From a source checkout: `node --import tsx/esm src/lib/db/backends/transfer/cli.ts ...`.)
 * The target URL comes from the environment so the password never appears in a process list.
 * The target must be a new, empty database created with LC_COLLATE 'C' (TEMPLATE template0);
 * the tool migrates it. The source must not be live: stop the app, or pass a snapshot taken
 * with SQLite's backup API. Exit code 0 only when every table verified.
 */
import fs from "node:fs";

import { runTransfer } from "./transfer";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const source = arg("source");
  const receiptPath = arg("receipt") ?? "transfer-receipt.json";
  const targetUrl = process.env.OMNIROUTE_TRANSFER_TARGET_URL?.trim();
  if (!source || !targetUrl) {
    console.error(
      "usage: OMNIROUTE_TRANSFER_TARGET_URL=<postgres url> transfer --source <sqlite file> [--receipt <file>]"
    );
    return 2;
  }
  const receipt = await runTransfer({
    sqlitePath: source,
    targetUrl,
    log: (line) => console.log(line),
  });
  // The summary first: a receipt that cannot be written must not hide the result.
  for (const t of receipt.targets) {
    const skipped = Object.values(t.skipped).reduce((a, b) => a + b, 0);
    const flag =
      t.verified.mismatchedRows === 0 && t.verified.expected === t.verified.actual ? "ok " : "BAD";
    console.log(
      `${flag} ${t.table.padEnd(32)} written ${String(t.written).padStart(7)}  stored ${String(t.verified.actual).padStart(7)}` +
        (skipped ? `  skipped ${skipped}` : "") +
        (t.orphansDeleted || t.orphansNulled
          ? `  orphans -${t.orphansDeleted}/null ${t.orphansNulled}`
          : "")
    );
    for (const sample of t.mismatchSamples) console.log(`      ${sample}`);
  }
  const dropped = receipt.sources.filter((s) => s.disposition === "dropped" && s.rows > 0);
  for (const d of dropped) console.log(`dropped ${d.table}: ${d.rows} rows (${d.reason})`);
  console.log(`checks: ${JSON.stringify(receipt.checks)}`);
  console.log(`retention: ${JSON.stringify(receipt.effectiveDatabaseSettings.retention)}`);
  for (const item of receipt.review) console.log(`review: ${item}`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  if (!receipt.ok) {
    console.log(`TRANSFER HAS MISMATCHES — receipt: ${receiptPath}`);
    return 1;
  }
  if (receipt.review.length > 0) {
    // Exit 3: stored correctly, but compare these with the dry run's receipt before going on.
    console.log(
      `TRANSFER VERIFIED, ${receipt.review.length} ITEM(S) TO REVIEW — receipt: ${receiptPath}`
    );
    return 3;
  }
  console.log(`TRANSFER VERIFIED — receipt: ${receiptPath}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`transfer failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
);
