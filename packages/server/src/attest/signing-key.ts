/**
 * Build-time embedded Ed25519 signing key (PKCS#8 PEM).
 *
 * This placeholder is EMPTY in source control. The Docker build generates a
 * fresh key pair and rewrites this file with the private key BEFORE `tsc`, so
 * the key is compiled INTO the image — no runtime file read, no env var to set.
 * The matching public key is available at runtime via `GET /api/attest/pubkey`
 * (fetch it from the running server to configure CI).
 *
 * The `ATTEST_SIGNING_KEY` env var still overrides this when set, so a
 * production deploy can inject the key from a secret instead of baking it in.
 * When both are empty, attestation is disabled (endpoints answer 503).
 *
 * SECURITY: a key baked into the image can be extracted by anyone who can pull
 * the image, who could then forge `pass` attestations. That is fine for internal
 * testing; for production prefer injecting the key via a secret (env override).
 */
export const EMBEDDED_SIGNING_KEY = "";
