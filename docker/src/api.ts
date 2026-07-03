/**
 * Minimal Bitwarden/Vaultwarden REST client.
 * Covers only what the sync tool needs: prelogin, API-key login,
 * vault inspection, purge, and folder deletion.
 *
 * Response and request field casing differs between server versions
 * (camelCase on current servers, PascalCase on older Vaultwarden),
 * thus every read checks both and the purge body sends both.
 */

import { createHash } from "node:crypto";
import { KdfConfig } from "./crypto";

/** Bitwarden DeviceType for a Linux CLI client. */
const DEVICE_TYPE_LINUX_CLI = "25";

export class BitwardenApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BitwardenApiError";
  }
}

export interface VaultSnapshot {
  cipherCount: number;
  folderIds: string[];
}

/** Read a field that may arrive camelCase or PascalCase. */
function field<T>(obj: Record<string, unknown>, name: string): T | undefined {
  const pascal = name.charAt(0).toUpperCase() + name.slice(1);
  return (obj[name] ?? obj[pascal]) as T | undefined;
}

/**
 * A stable, RFC-4122-shaped device identifier derived from a seed.
 * Reusing one identifier keeps the server from piling up device records
 * on every container restart.
 */
export function stableDeviceId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export class BitwardenClient {
  private accessToken: string | null = null;

  constructor(private readonly baseUrl: string) {}

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new BitwardenApiError(
        `${init.method ?? "GET"} ${path} failed with status ${response.status}: ${body.slice(0, 500)}`,
        response.status,
      );
    }
    return response;
  }

  private authHeaders(
    extra: Record<string, string> = {},
  ): Record<string, string> {
    if (!this.accessToken) {
      throw new BitwardenApiError("Not logged in. Call loginWithApiKey first.");
    }
    return { Authorization: `Bearer ${this.accessToken}`, ...extra };
  }

  /** Fetch the account KDF settings needed to derive the master key. */
  async prelogin(email: string): Promise<KdfConfig> {
    const body = JSON.stringify({ email });
    const headers = { "Content-Type": "application/json" };

    let response: Response;
    try {
      response = await this.request("/identity/accounts/prelogin", {
        method: "POST",
        headers,
        body,
      });
    } catch (error) {
      // Older servers only expose the legacy path.
      if (error instanceof BitwardenApiError && error.status === 404) {
        response = await this.request("/api/accounts/prelogin", {
          method: "POST",
          headers,
          body,
        });
      } else {
        throw error;
      }
    }

    const data = (await response.json()) as Record<string, unknown>;
    const kdf = field<number>(data, "kdf");
    const iterations = field<number>(data, "kdfIterations");
    if (kdf === undefined || iterations === undefined) {
      throw new BitwardenApiError("Prelogin response is missing KDF settings.");
    }
    return {
      kdf,
      iterations,
      memory: field<number | null>(data, "kdfMemory") ?? null,
      parallelism: field<number | null>(data, "kdfParallelism") ?? null,
    };
  }

  /**
   * OAuth2 client_credentials login with a user API key.
   * This path skips two-factor prompts, thus no OTP secret is needed.
   */
  async loginWithApiKey(
    clientId: string,
    clientSecret: string,
    deviceId: string,
  ): Promise<void> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "api",
      client_id: clientId,
      client_secret: clientSecret,
      deviceType: DEVICE_TYPE_LINUX_CLI,
      deviceIdentifier: deviceId,
      deviceName: "bitwardensync",
    });
    const response = await this.request("/identity/connect/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = (await response.json()) as Record<string, unknown>;
    const token = field<string>(data, "access_token");
    if (!token) {
      throw new BitwardenApiError("Token response has no access_token.");
    }
    this.accessToken = token;
  }

  /** Count ciphers and collect personal folder ids from a full sync. */
  async fetchVaultSnapshot(): Promise<VaultSnapshot> {
    const response = await this.request("/api/sync?excludeDomains=true", {
      headers: this.authHeaders(),
    });
    const data = (await response.json()) as Record<string, unknown>;
    const ciphers = field<unknown[]>(data, "ciphers") ?? [];
    const folders = field<Record<string, unknown>[]>(data, "folders") ?? [];
    return {
      cipherCount: ciphers.length,
      folderIds: folders
        .map((folder) => field<string>(folder, "id"))
        .filter((id): id is string => Boolean(id)),
    };
  }

  /**
   * Permanently delete every personal vault item.
   * The server demands proof of the master password.
   *
   * Send the hash in camelCase only. Current Vaultwarden declares
   * `#[serde(alias = "MasterPasswordHash")]` on this field, thus a body
   * with both casings counts as a duplicate field and fails with 422.
   */
  async purgeVault(masterPasswordHash: string): Promise<void> {
    await this.request("/api/ciphers/purge", {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ masterPasswordHash }),
    });
  }

  /** Remove a folder left behind by servers whose purge keeps folders. */
  async deleteFolder(folderId: string): Promise<void> {
    await this.request(`/api/folders/${folderId}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
  }
}
