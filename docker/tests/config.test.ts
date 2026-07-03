import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, normalizeHost } from "../src/config";

const VALID_ENV = {
  BITWARDEN_SYNC_HOST: "https://vault.example.com/",
  BITWARDEN_SYNC_BW_EMAIL_ADDRESS: " user@example.com ",
  BITWARDEN_SYNC_BW_PASSWORD: "secret",
  BITWARDEN_SYNC_BW_CLIENTID: "user.abc",
  BITWARDEN_SYNC_BW_CLIENTSECRET: "shh",
};

test("loadConfig reads and normalizes every field", () => {
  const config = loadConfig({ ...VALID_ENV });
  assert.equal(config.host, "https://vault.example.com");
  assert.equal(config.email, "user@example.com");
  assert.equal(config.password, "secret");
  assert.equal(config.clientId, "user.abc");
  assert.equal(config.clientSecret, "shh");
});

test("loadConfig names every missing variable", () => {
  const env = { ...VALID_ENV };
  delete (env as Record<string, string>).BITWARDEN_SYNC_HOST;
  (env as Record<string, string>).BITWARDEN_SYNC_BW_CLIENTID = "  ";
  assert.throws(
    () => loadConfig(env),
    /BITWARDEN_SYNC_HOST.*BITWARDEN_SYNC_BW_CLIENTID/,
  );
});

test("normalizeHost strips trailing slashes only", () => {
  assert.equal(normalizeHost("https://a.b//"), "https://a.b");
  assert.equal(normalizeHost(" https://a.b/vault "), "https://a.b/vault");
});
