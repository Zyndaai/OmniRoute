/**
 * Antigravity GOOGLE_ONE_AI credit balance persistence.
 *
 * Stores last-known credit balances in `config_entries` so they survive
 * server restarts. The in-memory `creditBalanceCache` in the executor is the
 * primary source at runtime; this module provides the fallback read/write layer.
 */

import { isCloud } from "./core";
import { getConfigEntries, getConfigValue, setConfigValue } from "./configEntries";

interface CreditBalanceEntry {
  balance: number;
  updatedAt: string;
}

const NAMESPACE = "antigravityCreditBalance";

function readBalance(value: unknown): number | null {
  const entry = value as CreditBalanceEntry | null;
  return entry && typeof entry === "object" && typeof entry.balance === "number"
    ? entry.balance
    : null;
}

/**
 * Read the persisted credit balance for an accountId.
 * Returns the balance number, or null if not found.
 */
export async function getPersistedCreditBalance(accountId: string): Promise<number | null> {
  if (isCloud) return null;
  return readBalance(await getConfigValue(NAMESPACE, accountId));
}

/**
 * Read all persisted credit balances.
 * Returns a Map of accountId → balance.
 */
export async function getAllPersistedCreditBalances(): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (isCloud) return result;
  for (const row of await getConfigEntries(NAMESPACE)) {
    const balance = readBalance(row.value);
    if (balance !== null) result.set(row.key, balance);
  }
  return result;
}

/**
 * Persist a credit balance for an accountId.
 */
export async function persistCreditBalance(accountId: string, balance: number): Promise<void> {
  if (isCloud) return;
  const entry: CreditBalanceEntry = {
    balance,
    updatedAt: new Date().toISOString(),
  };
  await setConfigValue(NAMESPACE, accountId, entry);
}
