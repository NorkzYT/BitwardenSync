/**
 * Command-line entry point for the vault tool.
 *
 *   cli.js purge   Purge the vault and verify it is empty. Exits non-zero
 *                  when the server still reports items, thus the caller can
 *                  trust a zero exit code before importing.
 *   cli.js count   Print the number of vault items to stdout.
 */

import { loadConfig } from "./config";
import { logError } from "./log";
import { createClient, purgeVault } from "./purge";

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadConfig();
  const client = await createClient(config);

  switch (command) {
    case "purge":
      await purgeVault(client, config);
      return;
    case "count": {
      const snapshot = await client.fetchVaultSnapshot();
      process.stdout.write(`${snapshot.cipherCount}\n`);
      return;
    }
    default:
      throw new Error(
        `Unknown command '${command ?? ""}'. Use purge or count.`,
      );
  }
}

main().catch((error: unknown) => {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
