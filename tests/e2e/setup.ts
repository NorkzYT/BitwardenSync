/**
 * E2E helper: registers a throwaway account on a local Vaultwarden and
 * prints its API-key credentials as JSON on stdout.
 *
 * Usage: tsx tests/e2e/setup.ts <host> <email> <password>
 *
 * The registration payload needs a full Bitwarden key set: a protected
 * symmetric user key and an RSA key pair, both wrapped as EncString
 * values ("2.<iv>|<data>|<mac>", AES-256-CBC with HMAC-SHA256).
 */

import {
  createCipheriv,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  KDF_PBKDF2_SHA256,
  computeMasterPasswordHash,
  deriveMasterKey,
} from "../../docker/src/crypto";

const KDF_ITERATIONS = 600_000;

/** Single-block HKDF-Expand (SHA-256), as used to stretch the master key. */
function hkdfExpand(prk: Buffer, info: string): Buffer {
  return createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([1])]))
    .digest();
}

/** Wrap plaintext as an EncString: AES-256-CBC + HMAC-SHA256 over iv|ct. */
function encString(plain: Buffer, encKey: Buffer, macKey: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", encKey, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac("sha256", macKey)
    .update(Buffer.concat([iv, data]))
    .digest();
  return `2.${iv.toString("base64")}|${data.toString("base64")}|${mac.toString("base64")}`;
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  const response = await fetch(url, { method: "POST", headers, body });
  if (!response.ok) {
    throw new Error(
      `POST ${url} -> ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

async function main(): Promise<void> {
  const [host, email, password] = process.argv.slice(2);
  if (!host || !email || !password) {
    throw new Error("Usage: setup.ts <host> <email> <password>");
  }

  const masterKey = await deriveMasterKey(password, email, {
    kdf: KDF_PBKDF2_SHA256,
    iterations: KDF_ITERATIONS,
  });
  const masterPasswordHash = computeMasterPasswordHash(masterKey, password);

  // Build the account key set.
  const stretchedEncKey = hkdfExpand(masterKey, "enc");
  const stretchedMacKey = hkdfExpand(masterKey, "mac");
  const userKey = randomBytes(64);
  const protectedUserKey = encString(userKey, stretchedEncKey, stretchedMacKey);

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const encryptedPrivateKey = encString(
    privateKey.export({ type: "pkcs8", format: "der" }) as Buffer,
    userKey.subarray(0, 32),
    userKey.subarray(32),
  );

  const registerBody = JSON.stringify({
    email,
    name: "e2e",
    masterPasswordHash,
    masterPasswordHint: null,
    key: protectedUserKey,
    kdf: KDF_PBKDF2_SHA256,
    kdfIterations: KDF_ITERATIONS,
    keys: {
      publicKey: (
        publicKey.export({ type: "spki", format: "der" }) as Buffer
      ).toString("base64"),
      encryptedPrivateKey,
    },
  });
  const jsonHeaders = { "Content-Type": "application/json" };

  // Registration paths vary across Vaultwarden versions; try each in turn.
  const registerPaths = [
    "/identity/accounts/register",
    "/api/accounts/register",
    "/identity/accounts/register/finish",
  ];
  let registered = false;
  const failures: string[] = [];
  for (const path of registerPaths) {
    try {
      await post(`${host}${path}`, registerBody, jsonHeaders);
      registered = true;
      break;
    } catch (error) {
      failures.push(String(error));
    }
  }
  if (!registered) {
    throw new Error(`Registration failed:\n${failures.join("\n")}`);
  }

  // Log in with the password grant to reach the API-key endpoint.
  const tokenResponse = await post(
    `${host}/identity/connect/token`,
    new URLSearchParams({
      grant_type: "password",
      username: email,
      password: masterPasswordHash,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "9",
      deviceIdentifier: randomUUID(),
      deviceName: "bitwardensync-e2e",
    }).toString(),
    {
      "Content-Type": "application/x-www-form-urlencoded",
      "Auth-Email": Buffer.from(email).toString("base64url"),
    },
  );
  const { access_token } = (await tokenResponse.json()) as {
    access_token: string;
  };

  const profileResponse = await fetch(`${host}/api/accounts/profile`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const profile = (await profileResponse.json()) as { id: string };

  // camelCase only: newer servers alias the PascalCase name onto the same
  // field, thus sending both casings reads as a duplicate field (422).
  const apiKeyResponse = await post(
    `${host}/api/accounts/api-key`,
    JSON.stringify({ masterPasswordHash }),
    { ...jsonHeaders, Authorization: `Bearer ${access_token}` },
  );
  const apiKey = (await apiKeyResponse.json()) as Record<string, unknown>;

  process.stdout.write(
    JSON.stringify({
      clientId: `user.${profile.id}`,
      clientSecret: apiKey.apiKey ?? apiKey.ApiKey,
    }) + "\n",
  );
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
