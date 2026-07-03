/**
 * Bitwarden master-key and master-password-hash derivation.
 *
 * The server never sees the master password. Clients prove knowledge of it
 * by sending PBKDF2(masterKey, password, 1 iteration) encoded as base64.
 * The master key itself comes from the account KDF settings, which the
 * prelogin endpoint reports (PBKDF2-SHA256 or Argon2id).
 */

import { createHash, pbkdf2Sync } from "node:crypto";
import { argon2id } from "hash-wasm";

export const KDF_PBKDF2_SHA256 = 0;
export const KDF_ARGON2ID = 1;

/** Bitwarden defaults for Argon2id when prelogin omits a value. */
const ARGON2_DEFAULT_MEMORY_MIB = 64;
const ARGON2_DEFAULT_PARALLELISM = 4;

export interface KdfConfig {
  kdf: number;
  iterations: number;
  /** Argon2id memory cost in MiB. */
  memory?: number | null;
  parallelism?: number | null;
}

/** Bitwarden salts the master key with the lowercased, trimmed email. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function deriveMasterKey(
  password: string,
  email: string,
  config: KdfConfig,
): Promise<Buffer> {
  const salt = normalizeEmail(email);

  if (config.kdf === KDF_PBKDF2_SHA256) {
    return pbkdf2Sync(password, salt, config.iterations, 32, "sha256");
  }

  if (config.kdf === KDF_ARGON2ID) {
    // Argon2id uses SHA-256 of the email as its salt, per the Bitwarden clients.
    const argonSalt = createHash("sha256").update(salt).digest();
    const key = await argon2id({
      password,
      salt: argonSalt,
      iterations: config.iterations,
      memorySize: (config.memory ?? ARGON2_DEFAULT_MEMORY_MIB) * 1024,
      parallelism: config.parallelism ?? ARGON2_DEFAULT_PARALLELISM,
      hashLength: 32,
      outputType: "binary",
    });
    return Buffer.from(key);
  }

  throw new Error(`Unsupported KDF type: ${config.kdf}`);
}

/**
 * The authentication hash sent to the server.
 * One PBKDF2 round keyed on the master key, salted with the password.
 */
export function computeMasterPasswordHash(
  masterKey: Buffer,
  password: string,
): string {
  return pbkdf2Sync(masterKey, password, 1, 32, "sha256").toString("base64");
}
