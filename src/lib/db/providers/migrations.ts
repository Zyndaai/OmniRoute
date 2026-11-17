/**
 * db/providers/migrations — Connection-level migration utilities and GHE Copilot host discovery.
 *
 * Split from provider.ts to keep the main CRUD file under the size ratchet.
 */

import { db } from "../pg";
import { rowToCamel } from "../caseMapping";
import {
  encrypt,
  isEncryptionEnabled,
  looksEncrypted,
  migrateLegacyEncryptedString,
} from "../encryption";
import { invalidateDbCache } from "../readCache";
import { parseProviderSpecificData } from "../webSessionDedup";
import { jsonValueParam } from "../pgJsonText";
import { mapProviderSpecificDataSecrets } from "./providerSpecificDataSecrets";

// ──────────────── provider_specific_data secret sweep ────────────────

const sweeps = new WeakMap<object, Promise<number>>();

/**
 * One pass per database backend, run by the providers module on its first read: rows
 * whose declared secret fields (PROVIDER_SPECIFIC_SECRET_FIELDS) still hold plaintext —
 * written before those fields were encrypted, or by an older importer — are rewritten
 * with the fields enveloped. Idempotent: enveloped values are never re-wrapped, and a row
 * with no plaintext secret is left untouched. Skipped entirely when
 * STORAGE_ENCRYPTION_KEY is unset, like encryptConnectionFields. Same lazy, in-module
 * style as the api_keys backfill (../apiKeys/secretAtRest.ts) — no numbered migration.
 * Concurrent first reads share the one pass, so none of them sees a half-swept table.
 */
export function ensureProviderSpecificDataSecretsEncrypted(): Promise<number> {
  if (!isEncryptionEnabled()) return Promise.resolve(0);
  const backend = db();
  let sweep = sweeps.get(backend);
  if (!sweep) {
    sweep = sweepProviderSpecificDataSecrets();
    sweeps.set(backend, sweep);
  }
  return sweep;
}

async function sweepProviderSpecificDataSecrets(): Promise<number> {
  let rewritten = 0;
  try {
    rewritten = await db().transaction(async (tx) => {
      const rows = await tx.query<{ id: string; provider_specific_data: unknown }>(
        `SELECT id, provider_specific_data FROM provider_connections
          WHERE provider_specific_data IS NOT NULL FOR UPDATE`
      );
      let count = 0;
      for (const row of rows) {
        const psd = parseProviderSpecificData(row.provider_specific_data);
        const next = mapProviderSpecificDataSecrets(psd, (value) =>
          looksEncrypted(value) ? value : encrypt(value)
        );
        if (next === psd) continue;
        await tx.execute(
          "UPDATE provider_connections SET provider_specific_data = $1, updated_at = now() WHERE id = $2",
          [jsonValueParam(next), row.id]
        );
        count++;
      }
      return count;
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DB] provider_specific_data secret sweep failed: ${message}`);
    return 0;
  }
  if (rewritten > 0) {
    invalidateDbCache("connections");
    console.log(`[DB] Encrypted provider_specific_data secrets on ${rewritten} connection(s).`);
  }
  return rewritten;
}

// ──────────────── Auto Migration ────────────────

/**
 * Scans all connections and re-encrypts any fields using the old dynamic salt
 * so they use the new canonical static salt.
 */
export async function autoMigrateLegacyEncryptedConnections(): Promise<number> {
  const rows = await db().query("SELECT * FROM provider_connections");
  let migratedCount = 0;

  for (const row of rows) {
    const camelRow = rowToCamel(row);
    if (!camelRow) continue;

    let updatedRow = false;

    const encryptedFields = ["apiKey", "idToken", "accessToken", "refreshToken"];
    for (const field of encryptedFields) {
      if (typeof camelRow[field] === "string") {
        const { updated, value } = migrateLegacyEncryptedString(camelRow[field] as string);
        if (updated) {
          camelRow[field] = value;
          updatedRow = true;
        }
      }
    }

    if (updatedRow) {
      // The values are already re-encrypted: write them directly instead of going
      // through the encrypting row writer, which would encrypt the ciphertext again.
      await db().execute(
        `UPDATE provider_connections
            SET api_key = $1, id_token = $2, access_token = $3, refresh_token = $4, updated_at = now()
          WHERE id = $5`,
        [
          camelRow.apiKey ?? null,
          camelRow.idToken ?? null,
          camelRow.accessToken ?? null,
          camelRow.refreshToken ?? null,
          camelRow.id,
        ]
      );
      migratedCount++;
    }
  }

  if (migratedCount > 0) {
    invalidateDbCache("connections");
    console.log(`[DB] Auto-migrated ${migratedCount} connection(s) to new static-salt encryption.`);
  }

  return migratedCount;
}

// ──────────────── GHE Copilot ────────────────

export async function getGheCopilotHosts(): Promise<string[]> {
  const hosts = new Set<string>();
  try {
    const rows = await db().query<{ provider_specific_data: unknown }>(
      "SELECT provider_specific_data FROM provider_connections WHERE provider = 'ghe-copilot' AND is_active"
    );
    for (const row of rows) {
      const psd = parseProviderSpecificData(row.provider_specific_data);
      if (!psd) continue;
      const urls = [psd.gheUrl, psd.copilotApiUrl, psd.copilotProxyUrl];
      for (const urlStr of urls) {
        if (typeof urlStr === "string" && urlStr.trim()) {
          try {
            const url = new URL(urlStr);
            if (url.hostname) {
              hosts.add(url.hostname.toLowerCase());
            }
          } catch {
            // Ignore invalid URLs
          }
        }
      }
    }
  } catch (err) {
    console.error("[DB] getGheCopilotHosts: failed to read GHE Copilot connections", err);
  }
  return [...hosts];
}
