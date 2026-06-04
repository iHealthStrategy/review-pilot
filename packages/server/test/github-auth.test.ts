import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { GitHubAppTokenSource } from "../src/providers/github-auth.js";
import { FakeHttpClient, type Route } from "./fake-http-client.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function routes(expiresAt: string): Route[] {
  return [
    { method: "GET", urlIncludes: "/repos/acme/demo/installation", body: { id: 42 } },
    {
      method: "POST",
      urlIncludes: "/app/installations/42/access_tokens",
      body: { token: "ghs_installation", expires_at: expiresAt },
    },
  ];
}

function makeSource(http: FakeHttpClient, now: () => number) {
  return new GitHubAppTokenSource(
    http,
    { appId: "12345", privateKey, apiBase: "https://api.github.com" },
    now,
  );
}

test("GitHubAppTokenSource: mints an installation token via a verifiable App JWT", async () => {
  const http = new FakeHttpClient(routes(new Date(T0 + 3_600_000).toISOString()));
  const src = makeSource(http, () => T0);

  const token = await src.getToken({ fullName: "acme/demo" });
  assert.equal(token, "ghs_installation");

  // App-level requests carry a Bearer JWT with three parts.
  const jwtReq = http.requests.find((r) => r.url.includes("access_tokens"))!;
  const jwt = (jwtReq.headers?.Authorization ?? "").replace("Bearer ", "");
  const [h, p, s] = jwt.split(".");
  assert.ok(h && p && s, "JWT has header.payload.signature");

  // Signature verifies against the App public key.
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(`${h}.${p}`),
    publicKey,
    Buffer.from(s!, "base64url"),
  );
  assert.equal(ok, true);

  // Claims: issuer is the App id.
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
  assert.equal(claims.iss, "12345");
  assert.ok(claims.exp > claims.iat);
});

test("GitHubAppTokenSource: caches the token and refreshes only after expiry", async () => {
  const http = new FakeHttpClient(routes(new Date(T0 + 3_600_000).toISOString()));
  let now = T0;
  const src = makeSource(http, () => now);

  await src.getToken({ fullName: "acme/demo" });
  const afterFirst = http.requests.length; // GET installation + POST tokens
  assert.equal(afterFirst, 2);

  // Within validity → served from cache, no new network calls.
  await src.getToken({ fullName: "acme/demo" });
  assert.equal(http.requests.length, 2);

  // Past expiry (minus skew) → re-mints (installation stays cached).
  now = T0 + 3_600_000;
  await src.getToken({ fullName: "acme/demo" });
  assert.equal(http.requests.length, 3);
  assert.ok(
    http.requests.filter((r) => r.url.includes("access_tokens")).length === 2,
  );
});
