import assert from "node:assert/strict";
import { test } from "node:test";
import { BitwardenClient } from "../src/api";
import { SyncConfig } from "../src/config";
import { KDF_PBKDF2_SHA256 } from "../src/crypto";
import { purgeVault } from "../src/purge";

const CONFIG: SyncConfig = {
  host: "https://vault.test",
  email: "a@b.c",
  password: "pw",
  clientId: "user.abc",
  clientSecret: "shh",
};

/**
 * A scripted client double: `cipherCounts` is the sequence of counts the
 * server reports on each snapshot fetch.
 */
function stubClient(cipherCounts: number[], folderIds: string[] = []) {
  const calls = { purge: 0, deletedFolders: [] as string[] };
  let fetchIndex = 0;
  const client = {
    prelogin: async () => ({ kdf: KDF_PBKDF2_SHA256, iterations: 1000 }),
    fetchVaultSnapshot: async () => ({
      cipherCount:
        cipherCounts[Math.min(fetchIndex++, cipherCounts.length - 1)],
      folderIds,
    }),
    purgeVault: async () => {
      calls.purge += 1;
    },
    deleteFolder: async (id: string) => {
      calls.deletedFolders.push(id);
    },
  };
  return { client: client as unknown as BitwardenClient, calls };
}

test("purgeVault verifies the vault is empty after one purge", async () => {
  const { client, calls } = stubClient([10, 0]);
  await purgeVault(client, CONFIG);
  assert.equal(calls.purge, 1);
});

test("purgeVault retries and then fails loudly when items survive", async () => {
  const { client, calls } = stubClient([10, 4, 4, 4]);
  await assert.rejects(purgeVault(client, CONFIG), /still reports 4 items/);
  assert.equal(calls.purge, 3);
});

test("purgeVault skips purging an already-empty vault", async () => {
  const { client, calls } = stubClient([0]);
  await purgeVault(client, CONFIG);
  assert.equal(calls.purge, 0);
});

test("purgeVault removes folders the server purge left behind", async () => {
  const { client, calls } = stubClient([2, 0], ["f1", "f2"]);
  await purgeVault(client, CONFIG);
  assert.deepEqual(calls.deletedFolders, ["f1", "f2"]);
});
