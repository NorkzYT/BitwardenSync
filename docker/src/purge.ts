/**
 * Verified vault purge.
 *
 * The old Puppeteer approach typed blind keystrokes into the web vault and
 * reported success no matter what happened. When the purge silently failed,
 * the next import stacked every credential on top of the old ones and the
 * vault filled with duplicates. This module purges through the REST API and
 * refuses to report success until the server confirms the vault is empty.
 */

import { BitwardenClient, stableDeviceId } from "./api";
import { SyncConfig } from "./config";
import { computeMasterPasswordHash, deriveMasterKey } from "./crypto";
import { log } from "./log";

const MAX_PURGE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createClient(
  config: SyncConfig,
): Promise<BitwardenClient> {
  const client = new BitwardenClient(config.host);
  log(`Logging into ${config.host} with the account API key.`);
  await client.loginWithApiKey(
    config.clientId,
    config.clientSecret,
    stableDeviceId(`bitwardensync:${config.email}`),
  );
  return client;
}

/**
 * Purge the personal vault and verify the result.
 * Throws when the server still reports items after every attempt,
 * thus a zero exit code always means an empty vault.
 */
export async function purgeVault(
  client: BitwardenClient,
  config: SyncConfig,
): Promise<void> {
  log("Fetching account KDF settings.");
  const kdfConfig = await client.prelogin(config.email);
  log(`KDF type ${kdfConfig.kdf}, ${kdfConfig.iterations} iterations.`);

  const masterKey = await deriveMasterKey(
    config.password,
    config.email,
    kdfConfig,
  );
  const passwordHash = computeMasterPasswordHash(masterKey, config.password);

  const before = await client.fetchVaultSnapshot();
  log(
    `Vault holds ${before.cipherCount} items and ${before.folderIds.length} folders before the purge.`,
  );

  let snapshot = before;
  if (before.cipherCount > 0) {
    for (let attempt = 1; attempt <= MAX_PURGE_ATTEMPTS; attempt++) {
      log(`Purging the vault (attempt ${attempt}/${MAX_PURGE_ATTEMPTS}).`);
      await client.purgeVault(passwordHash);

      snapshot = await client.fetchVaultSnapshot();
      if (snapshot.cipherCount === 0) {
        break;
      }
      log(
        `Server still reports ${snapshot.cipherCount} items after the purge.`,
      );
      if (attempt < MAX_PURGE_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
    if (snapshot.cipherCount > 0) {
      throw new Error(
        `Purge failed: the server still reports ${snapshot.cipherCount} items after ${MAX_PURGE_ATTEMPTS} attempts.`,
      );
    }
  }

  // Vaultwarden's purge removes folders too; the official server keeps them.
  // Delete any leftovers so folders do not pile up across imports.
  for (const folderId of snapshot.folderIds) {
    await client.deleteFolder(folderId);
  }
  if (snapshot.folderIds.length > 0) {
    log(`Deleted ${snapshot.folderIds.length} leftover folders.`);
  }

  log("Verified: the vault is empty.");
}
