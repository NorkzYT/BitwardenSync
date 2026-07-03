/**
 * Environment configuration for the vault tool.
 * Fails fast with a clear message that lists every missing variable.
 */

export interface SyncConfig {
  /** Base URL of the Bitwarden/Vaultwarden server, without a trailing slash. */
  host: string;
  email: string;
  password: string;
  clientId: string;
  clientSecret: string;
}

const REQUIRED_VARS = [
  "BITWARDEN_SYNC_HOST",
  "BITWARDEN_SYNC_BW_EMAIL_ADDRESS",
  "BITWARDEN_SYNC_BW_PASSWORD",
  "BITWARDEN_SYNC_BW_CLIENTID",
  "BITWARDEN_SYNC_BW_CLIENTSECRET",
] as const;

/** Strip trailing slashes so URL joins stay predictable. */
export function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const missing = REQUIRED_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return {
    host: normalizeHost(env.BITWARDEN_SYNC_HOST as string),
    email: (env.BITWARDEN_SYNC_BW_EMAIL_ADDRESS as string).trim(),
    password: env.BITWARDEN_SYNC_BW_PASSWORD as string,
    clientId: (env.BITWARDEN_SYNC_BW_CLIENTID as string).trim(),
    clientSecret: (env.BITWARDEN_SYNC_BW_CLIENTSECRET as string).trim(),
  };
}
