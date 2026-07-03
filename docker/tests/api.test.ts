import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BitwardenClient, stableDeviceId } from "../src/api";

interface RecordedRequest {
  url: string;
  method: string;
  body: string;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch stub that records requests and replays canned responses. */
function mockFetch(
  handler: (
    url: string,
    init: RequestInit,
  ) => { status?: number; json?: unknown },
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const request = {
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : "",
    };
    requests.push(request);
    const result = handler(request.url, init);
    return new Response(JSON.stringify(result.json ?? {}), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

async function loggedInClient(): Promise<{
  client: BitwardenClient;
  requests: RecordedRequest[];
  respond: { status?: number; json?: unknown };
}> {
  const respond: { status?: number; json?: unknown } = {};
  const requests = mockFetch((url) => {
    if (url.endsWith("/identity/connect/token")) {
      return { json: { access_token: "token-123" } };
    }
    return respond;
  });
  const client = new BitwardenClient("https://vault.test");
  await client.loginWithApiKey("user.abc", "secret", stableDeviceId("seed"));
  return { client, requests, respond };
}

test("stableDeviceId is deterministic and UUID-shaped", () => {
  const id = stableDeviceId("bitwardensync:user@example.com");
  assert.equal(id, stableDeviceId("bitwardensync:user@example.com"));
  assert.notEqual(id, stableDeviceId("other"));
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("loginWithApiKey sends a client_credentials form with device fields", async () => {
  const { requests } = await loggedInClient();
  const form = new URLSearchParams(requests[0].body);
  assert.equal(requests[0].url, "https://vault.test/identity/connect/token");
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("scope"), "api");
  assert.equal(form.get("client_id"), "user.abc");
  assert.ok(form.get("deviceIdentifier"));
});

test("prelogin reads camelCase responses", async () => {
  mockFetch(() => ({
    json: { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 },
  }));
  const client = new BitwardenClient("https://vault.test");
  const config = await client.prelogin("a@b.c");
  assert.deepEqual(config, {
    kdf: 1,
    iterations: 3,
    memory: 64,
    parallelism: 4,
  });
});

test("prelogin reads PascalCase responses and falls back to the legacy path", async () => {
  const requests = mockFetch((url) => {
    if (url.includes("/identity/accounts/prelogin")) {
      return { status: 404 };
    }
    return { json: { Kdf: 0, KdfIterations: 600000 } };
  });
  const client = new BitwardenClient("https://vault.test");
  const config = await client.prelogin("a@b.c");
  assert.equal(config.kdf, 0);
  assert.equal(config.iterations, 600000);
  assert.equal(requests[1].url, "https://vault.test/api/accounts/prelogin");
});

test("fetchVaultSnapshot counts ciphers and folder ids in either casing", async () => {
  const { client, respond } = await loggedInClient();
  respond.json = {
    Ciphers: [{}, {}, {}],
    Folders: [{ Id: "f1" }, { Id: "f2" }],
  };
  const snapshot = await client.fetchVaultSnapshot();
  assert.equal(snapshot.cipherCount, 3);
  assert.deepEqual(snapshot.folderIds, ["f1", "f2"]);
});

test("purgeVault sends the password hash in camelCase only", async () => {
  const { client, requests } = await loggedInClient();
  await client.purgeVault("hash==");
  const purge = requests.at(-1)!;
  assert.equal(purge.url, "https://vault.test/api/ciphers/purge");
  assert.equal(purge.method, "POST");
  const body = JSON.parse(purge.body);
  assert.equal(body.masterPasswordHash, "hash==");
  // A second casing would read as a duplicate of the aliased serde field
  // on current Vaultwarden and fail with 422.
  assert.deepEqual(Object.keys(body), ["masterPasswordHash"]);
});

test("failed requests raise errors that carry the HTTP status", async () => {
  const { client, respond } = await loggedInClient();
  respond.status = 401;
  await assert.rejects(
    client.fetchVaultSnapshot(),
    (error: Error & { status?: number }) => {
      assert.match(error.message, /401/);
      assert.equal(error.status, 401);
      return true;
    },
  );
});
