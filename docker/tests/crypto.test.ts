import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KDF_ARGON2ID,
  KDF_PBKDF2_SHA256,
  computeMasterPasswordHash,
  deriveMasterKey,
  normalizeEmail,
} from "../src/crypto";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
});

test("PBKDF2 master key and hash match the reference vector", async () => {
  const password = "hunter2!Correct-Horse";
  const masterKey = await deriveMasterKey(password, " USER@example.com ", {
    kdf: KDF_PBKDF2_SHA256,
    iterations: 100_000,
  });
  assert.equal(
    masterKey.toString("hex"),
    "fc36fb7be21f5b985745cb3c5c71831e6c01171994de8440ed0c79910681cd9e",
  );
  assert.equal(
    computeMasterPasswordHash(masterKey, password),
    "EBn6S/n+lwancMw7tcNMMDVx1T46IaFgTf0Z6a1f260=",
  );
});

test("hash direction is masterKey-then-password, not the reverse", async () => {
  const password = "pw";
  const masterKey = await deriveMasterKey(password, "a@b.c", {
    kdf: KDF_PBKDF2_SHA256,
    iterations: 5_000,
  });
  const swapped = await deriveMasterKey(
    masterKey.toString("latin1"),
    password,
    {
      kdf: KDF_PBKDF2_SHA256,
      iterations: 1,
    },
  );
  assert.notEqual(
    computeMasterPasswordHash(masterKey, password),
    swapped.toString("base64"),
  );
});

test("Argon2id derivation is deterministic and 32 bytes long", async () => {
  const config = {
    kdf: KDF_ARGON2ID,
    iterations: 3,
    memory: 16,
    parallelism: 2,
  };
  const first = await deriveMasterKey("pw", "a@b.c", config);
  const second = await deriveMasterKey("pw", "a@b.c", config);
  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, await deriveMasterKey("other", "a@b.c", config));
});

test("unknown KDF types are rejected", async () => {
  await assert.rejects(
    deriveMasterKey("pw", "a@b.c", { kdf: 9, iterations: 1 }),
    /Unsupported KDF type/,
  );
});
