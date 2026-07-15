# Enforcing local review before merge (ReviewPilot attestations)

Force every change through a local ReviewPilot review before it can merge —
without letting GitHub call your ReviewPilot server, and without letting
developers forge or bypass the check.

## How it works (the trust chain)

```
 Developer machine                 ReviewPilot server            GitHub
 ─────────────────                 ──────────────────            ──────
 1. commit change
 2. run the skill (local review)
 3. POST counts + tree sha  ─────► 4. decide verdict (policy)
                                      sign with PRIVATE key
    ◄───────────────────────────────  return token
 5. git commit --amend
    --trailer Reviewed-Token
 6. git push ──────────────────────────────────────────────────► PR
                                                                  7. verify-attestation
                                                                     action verifies
                                                                     with PUBLIC key
                                                                     (offline) → check
                                                                  8. ruleset requires
                                                                     the check → merge
                                                                     blocked unless pass
```

- The **private key** never leaves the server → developers can't forge a token.
- The token binds the commit's **tree** (code snapshot) → a review can't be
  reused after the code changes.
- CI verifies with the **public key only** → GitHub never calls your server.
- A **required status check** in a ruleset → the gate can't be skipped.

## Setup

### 1. The signing key is baked into the image

The Docker build generates a fresh Ed25519 key pair and compiles the private key
into the image (`attest/signing-key.ts`), so issuance works out of the box — no
key to generate or configure. The build log prints the public key, and it is also
served at `GET /api/attest/pubkey`.

For production, override the baked-in key by injecting your own via a secret:

```sh
ATTEST_SIGNING_KEY="$(cat attest.key)"   # optional override; PEM (\n-escaped ok)
# ATTEST_KEY_ID=rp-2026                  # optional, for rotation
# ATTEST_TTL_MS=86400000                 # token lifetime (default 24h)
# ATTEST_POLICY_STORE_FILE=./.reviewpilot/attest-policy.json  # non-mongo drivers
```

> ⚠️ A baked-in key can be extracted by anyone who can pull the image, who could
> then forge `pass` attestations. Fine for internal testing; for real enforcement,
> inject the key from a secret (the override above) and don't distribute the image.

### 2. Enforcement policy: seeded in code, managed from the Web UI

There is no `ATTEST_ENFORCE` env var. The seed (`warn` / `major`) is baked into
the code and only applies on the very first run; thereafter the live policy is
managed from the Web UI (admin only) via `PUT /api/attest/policy`, with **no
server restart and no repo/CI change** — the next attestation reflects it
immediately.

- `off` — always sign `pass` (advisory only)
- `warn` — always sign `pass`; findings surface but never block
- `block` — sign `fail` when a finding at/above the threshold exists → blocks merge

**API contract** (what the Web UI settings page calls; the front-end lives in the
web package):

```
GET  /api/attest/policy        # any authenticated user — view current policy
  → { enforce, blockSeverity, updatedAt, updatedBy }

PUT  /api/attest/policy        # ADMIN only — change it
  body: { enforce?: "off"|"warn"|"block", blockSeverity?: "info"|"minor"|"major"|"critical" }
  → the updated policy (same shape)
```

The policy persists in `ATTEST_POLICY_STORE_FILE` (or the DB on the `mongo`
driver), so it survives restarts.

### 3. Give CI the public key

Fetch the public key from the running server and put it in a repo (or org)
**secret** `REVIEWPILOT_ATTEST_PUBLIC_KEY`:

```sh
curl -s https://review.example.com/api/attest/pubkey | jq -r .publicKey
```

This is the only thing CI needs; it never talks to the server afterwards.

### 4. Add the verify workflow

Copy [`examples/github-actions/verify-attestation.yml`](../examples/github-actions/verify-attestation.yml)
to `.github/workflows/`. It checks out with `fetch-depth: 0` and runs the
`verify-attestation` action. The job is named **`attestation`** — that string is
the status-check context the ruleset requires, so keep them in sync.

### 5. Make the check required (and unbypassable)

Import the ruleset:

```sh
# per repo
gh api --method POST /repos/OWNER/REPO/rulesets \
  --input examples/github-rulesets/require-attestation.repo.json
# or org-wide
gh api --method POST /orgs/ORG/rulesets \
  --input examples/github-rulesets/require-attestation.org.json
```

This blocks direct pushes to the default branch, requires a PR, and requires the
`attestation` status check to pass. `bypass_actors: []` means **no one** (not
even admins) can bypass it — remove that line only if you deliberately want a
break-glass actor.

## The trust root: keep the verifier out of developers' hands

⚠️ **This is the step people miss, and it defeats everything if skipped.**

For `pull_request` events, GitHub runs the workflow definition **from the PR
branch**. So if the verify workflow lives only in the repo, a developer can open
a PR that edits `.github/workflows/verify-attestation.yml` to always pass — and
that neutered workflow runs on their own PR. The signature is irrelevant if the
check that reads it can be edited away.

Close this with **one** of:

- **Org-level enforcement (strongest).** Configure the workflow centrally so it
  runs regardless of repo contents:
  - GitHub Enterprise Cloud: Organization → Settings → Actions → **Required
    workflows**, pointing at a workflow file in your org's `.github` repo; or
  - a **ruleset `workflows` rule** that requires a specific workflow file (hosted
    in a repo developers can't write to) to pass.
  Either way the enforced definition is not the PR's copy, so editing the repo's
  workflow can't disable the gate.

- **Protect the workflow path (if you can't use org enforcement).** Add a
  CODEOWNERS entry so any change to the workflow needs a trusted reviewer, and
  the ruleset already requires code-owner review:

  ```
  # .github/CODEOWNERS
  /.github/workflows/   @your-org/platform-admins
  /.github/CODEOWNERS   @your-org/platform-admins
  ```

  This doesn't stop the edited workflow from running on that PR, but it stops the
  PR from **merging** without an admin's approval — so the weakened gate never
  reaches the default branch. Org enforcement is still preferable.

## Rolling it out

1. **Advisory first.** Set the policy to `warn` in the Web UI and `require:
   "false"` on the action. The check reports but never blocks — teams learn the
   flow (`review → amend → push`).
2. **Turn on the gate.** Flip the action to `require: "true"` (default) so a
   missing/invalid attestation fails the check.
3. **Enforce fixes.** Set the policy to `block` in the Web UI so unresolved
   must-fix findings produce a `fail` verdict that blocks the merge. (No restart
   — it takes effect on the next attestation.)

## Key rotation

1. Generate a new key pair; set `ATTEST_KEY_ID` to a new value and
   `ATTEST_SIGNING_KEY` to the new private key on the server.
2. During overlap, give CI **both** public keys via `public-keys` (JSON kid→PEM)
   instead of `public-key`:
   ```yaml
   with:
     public-keys: ${{ secrets.REVIEWPILOT_ATTEST_PUBLIC_KEYS }}
   # secret value: {"rp-old":"-----BEGIN PUBLIC KEY-----\n...","rp-new":"...\n..."}
   ```
   The verifier picks the key matching the token's `kid`.
3. Once all live tokens use the new key (after `ATTEST_TTL_MS`), drop the old one.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Check stuck **pending**, merge blocked forever | The required context name doesn't match the job name. Both must be `attestation` (or update the ruleset). |
| `cannot resolve the tree for <sha>` | The workflow didn't check out with `fetch-depth: 0`. |
| `tree-mismatch` | Code changed after the review (or after the amend). Re-run the skill on the final commit and re-amend. |
| `no-token` | The commit has no `Reviewed-Token` trailer — the developer skipped the attestation step. |
| `expired` | Token older than `ATTEST_TTL_MS`. Re-run the review. |
| `bad-signature` | Wrong public key in CI, key rotated without overlap, or a tampered token. |
| `verdict-fail` | Under a `block` policy, must-fix findings remain. Fix them and re-run. |
| `503` from `/api/attest` | `ATTEST_SIGNING_KEY` isn't set on the server. |
