import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import type { UserRole } from "../domain/entities.js";

/**
 * OpenID Connect relying-party client for delegating authentication to an
 * external identity provider (authentik). Authentication + registration live in
 * the IdP; this app keeps only authorization (role config). Implemented with
 * node:crypto so we add NO dependency — RS256 verification uses the JWKS public
 * key via `createPublicKey({ format: "jwk" })`; HS256 is a documented fallback.
 */
export interface OidcConfig {
  /**
   * The provider issuer URL. Discovery is fetched from
   * `<issuer>/.well-known/openid-configuration`. For authentik this is
   * `https://<host>/application/o/<app-slug>/`.
   */
  issuer: string;
  clientId: string;
  /** Confidential-client secret; "" means a public client (PKCE only). */
  clientSecret: string;
  /** Space-separated scopes; must include `openid`. */
  scopes: string;
  /** ID-token claim carrying the user's group names (default "groups"). */
  groupsClaim: string;
  /** authentik group name → local role. Highest-ranked match wins. */
  groupRoleMap: Record<string, UserRole>;
  /** When true, re-sync the role from groups on every login (IdP authoritative). */
  syncRoles: boolean;
  /** Role when no group matches the map. */
  defaultRole: UserRole;
  /** Optional management REST API base (e.g. `https://<host>/api/v3`). */
  apiUrl: string;
  /** Bearer token for the REST API groups fallback. */
  apiToken: string;
}

/** True when OIDC is configured enough to drive login. */
export function oidcEnabled(c: OidcConfig | null | undefined): c is OidcConfig {
  return !!c && !!c.issuer && !!c.clientId;
}

type FetchFn = typeof fetch;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  use?: string;
  [k: string]: unknown;
}

/** The identity resolved from a verified ID token (or REST fallback). */
export interface OidcIdentity {
  /** Stable subject — the identity key (never email, which can change). */
  sub: string;
  email: string;
  name: string;
  preferredUsername: string;
  groups: string[];
}

const RANK: Record<UserRole, number> = { viewer: 1, member: 2, admin: 3 };

/** A URL-safe random token for `state` / PKCE `code_verifier` / `nonce`. */
export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class OidcClient {
  private discovery: Discovery | null = null;
  private jwks: { keys: Jwk[] } | null = null;

  constructor(
    private readonly cfg: OidcConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async getDiscovery(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.cfg.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    this.discovery = (await res.json()) as Discovery;
    return this.discovery;
  }

  /** Build the authorization-endpoint redirect URL (authorization code + PKCE). */
  async authorizeUrl(opts: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string> {
    const d = await this.getDiscovery();
    const p = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: opts.redirectUri,
      scope: this.cfg.scopes,
      state: opts.state,
      nonce: opts.nonce,
      code_challenge: opts.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${d.authorization_endpoint}?${p.toString()}`;
  }

  /** Exchange an authorization code for tokens and resolve the verified identity. */
  async exchangeCode(opts: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
    now?: number;
  }): Promise<OidcIdentity> {
    const d = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: this.cfg.clientId,
      code_verifier: opts.codeVerifier,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    // Confidential client → HTTP Basic auth; public client → none (PKCE proves it).
    if (this.cfg.clientSecret) {
      const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    }
    const res = await this.fetchFn(d.token_endpoint, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`OIDC token exchange failed: HTTP ${res.status}`);
    const tok = (await res.json()) as { id_token?: string };
    if (!tok.id_token) throw new Error("OIDC token response missing id_token");
    const claims = await this.verifyIdToken(tok.id_token, opts.nonce, opts.now);
    const identity = this.claimsToIdentity(claims);
    // The `groups` claim is the per-request source of truth, but authentik's
    // default profile mapping historically omits it; fall back to the REST API.
    if (!identity.groups.length && this.cfg.apiUrl && this.cfg.apiToken) {
      identity.groups = await this.fetchGroupsViaApi(identity).catch(() => []);
    }
    return identity;
  }

  /** Verify an ID token's signature + standard claims and return its payload. */
  async verifyIdToken(
    idToken: string,
    nonce: string,
    now: number = Date.now(),
  ): Promise<Record<string, unknown>> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("malformed id_token");
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
      alg: string;
      kid?: string;
    };
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    const signed = `${h}.${p}`;
    const sig = Buffer.from(s, "base64url");

    if (header.alg === "RS256") {
      const key = await this.publicKeyFor(header.kid);
      if (!cryptoVerify("RSA-SHA256", Buffer.from(signed), key, sig)) {
        throw new Error("id_token signature invalid");
      }
    } else if (header.alg === "HS256") {
      // Symmetric fallback (provider has no signing key); HMAC with the secret.
      if (!this.cfg.clientSecret) throw new Error("id_token uses HS256 but no client secret is set");
      const expected = createHmac("sha256", this.cfg.clientSecret).update(signed).digest();
      if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) {
        throw new Error("id_token signature invalid");
      }
    } else {
      throw new Error(`unsupported id_token alg: ${header.alg}`);
    }

    const d = await this.getDiscovery();
    if (payload.iss !== d.issuer) throw new Error("id_token issuer mismatch");
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.cfg.clientId) : aud === this.cfg.clientId;
    if (!audOk) throw new Error("id_token audience mismatch");
    if (typeof payload.exp !== "number" || Math.floor(now / 1000) >= payload.exp) {
      throw new Error("id_token expired");
    }
    if (nonce && payload.nonce !== nonce) throw new Error("id_token nonce mismatch");
    return payload;
  }

  private async publicKeyFor(kid?: string) {
    if (!this.jwks) {
      const d = await this.getDiscovery();
      const res = await this.fetchFn(d.jwks_uri);
      if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
      this.jwks = (await res.json()) as { keys: Jwk[] };
    }
    const keys = this.jwks.keys ?? [];
    const jwk = (kid ? keys.find((k) => k.kid === kid) : keys[0]) ?? keys[0];
    if (!jwk) throw new Error("no usable JWKS key");
    return createPublicKey(
      { key: jwk, format: "jwk" } as unknown as Parameters<typeof createPublicKey>[0],
    );
  }

  private claimsToIdentity(c: Record<string, unknown>): OidcIdentity {
    const raw = c[this.cfg.groupsClaim];
    const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === "string") : [];
    return {
      sub: typeof c.sub === "string" ? c.sub : "",
      email: typeof c.email === "string" ? c.email.toLowerCase() : "",
      name: typeof c.name === "string" ? c.name : "",
      preferredUsername: typeof c.preferred_username === "string" ? c.preferred_username : "",
      groups,
    };
  }

  /** Read the user's groups from the management REST API (fallback path). */
  private async fetchGroupsViaApi(id: OidcIdentity): Promise<string[]> {
    const base = this.cfg.apiUrl.replace(/\/+$/, "");
    const q = id.preferredUsername
      ? `username=${encodeURIComponent(id.preferredUsername)}`
      : `email=${encodeURIComponent(id.email)}`;
    const res = await this.fetchFn(`${base}/core/users/?${q}`, {
      headers: { Authorization: `Bearer ${this.cfg.apiToken}`, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{ groups_obj?: Array<{ name?: string }> }>;
    };
    const u = data.results?.[0];
    return (u?.groups_obj ?? []).map((g) => g.name ?? "").filter(Boolean);
  }

  /** Map authentik groups to a local role (highest rank wins; else default). */
  roleForGroups(groups: readonly string[]): UserRole {
    let best: UserRole = this.cfg.defaultRole;
    for (const g of groups) {
      const r = this.cfg.groupRoleMap[g];
      if (r && RANK[r] > RANK[best]) best = r;
    }
    return best;
  }

  /** Provider logout URL, or null when the provider exposes none. */
  async endSessionUrl(postLogoutRedirect: string): Promise<string | null> {
    const d = await this.getDiscovery();
    if (!d.end_session_endpoint) return null;
    const p = new URLSearchParams({
      post_logout_redirect_uri: postLogoutRedirect,
      client_id: this.cfg.clientId,
    });
    return `${d.end_session_endpoint}?${p.toString()}`;
  }
}

/** Parse a "group:role,group2:role2" string into a validated map. */
export function parseGroupRoleMap(raw: string): Record<string, UserRole> {
  const out: Record<string, UserRole> = {};
  for (const pair of raw.split(",")) {
    const [g, r] = pair.split(":").map((x) => x.trim());
    if (g && (r === "viewer" || r === "member" || r === "admin")) out[g] = r;
  }
  return out;
}
