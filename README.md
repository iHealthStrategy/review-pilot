# ReviewPilot

Server-side **continuous code review** platform. ReviewPilot watches your
GitHub and GitLab repositories, and when a pull/merge request appears it
automatically syncs the **full repository** and runs a configurable AI review
engine (Cursor / Claude Code / Codex) that reviews the change **in the context
of the whole codebase** — not just the diff. Results are delivered two ways:

- a **Jenkins-like Web UI** showing monitored projects, jobs, live progress and
  the structured issue list, and
- **write-back to the PR/MR** as review comments, closing the loop.

## Status

Functional end-to-end: GitHub/GitLab providers, webhook + polling triggers,
full-repo sync, pluggable review engines (mock + Claude Code / Cursor / Codex
CLIs), dual-channel delivery (Web UI + PR comment write-back with update-in-place
dedup), a bearer-authenticated management API/UI, and `mock`/`postgres`/`mongo`
persistence — the last designed for stateless cloud deployment.

## Architecture (target)

```
GitHub / GitLab ──webhook (or polling fallback)──▶ Trigger
                                                     │ creates
                                                     ▼
                                                 ReviewJob (queue)
                                                     │
            full-repo clone ◀── Worker ──▶ ReviewEngine (mock|cursor|claude-code|codex)
                                                     │ produces
                                                     ▼
                                              Finding[] (file/line/severity/issue/suggestion)
                                                  │            │
                                          persist │            │ write-back
                                                  ▼            ▼
                                              Web UI       PR/MR comment
```

## Requirements

- Node.js >= 18.18 (uses the built-in `node --test` runner)

## Getting started

```bash
cp .env.example .env      # all defaults run in credential-free "mock" mode
npm install
npm run build
npm run lint
npm test
```

`npm run ci` runs build + lint + test in sequence.

## Configuration

All runtime behaviour is environment-driven (see `.env.example`): database
driver (`mock`/`sqlite`/`postgres`/`mongo`), default and enabled review engines,
GitHub and GitLab credentials/webhook secrets, the management-API bearer token,
and the polling interval used when webhooks are unavailable. Defaults are chosen
so the whole pipeline runs in `mock` mode with **no external credentials**,
which is also how the test suite exercises it.

### Stateless + MongoDB (cloud deployment)

The service is **stateless**: all state lives in the database and the per-job
repository clone is an ephemeral temp dir, so the container can be scaled,
restarted and redeployed freely. For a cloud deployment, use the MongoDB driver
and pass the connection string (with credentials) as an environment variable:

```bash
DB_DRIVER=mongo
MONGODB_URI=mongodb+srv://user:pass@cluster0.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=reviewpilot
API_TOKEN=<a strong secret>      # guards the management API + Web UI
```

On startup the service creates its indexes and **requeues any job left
`running`** by a crashed/redeployed container (`RECOVER_INTERRUPTED_JOBS_ON_START`,
default on — assumes a single active worker). Jobs are taken off the queue with
an atomic claim (`findOneAndUpdate`), so the design extends to competing
workers.

## HTTP surface

A single server (`packages/server/src/app.ts`) dispatches by path prefix:

- `POST /webhook/github`, `POST /webhook/gitlab` — verified PR/MR ingest (falls
  back to polling when `POLL_INTERVAL_SECONDS > 0` and no webhook is configured).
  A closed/merged PR cancels any still-pending review for it.
- `GET/POST /api/projects`, `GET /api/projects/:id`,
  `GET/POST /api/projects/:id/repos` — project & repo configuration.
- `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/findings` — review
  jobs with progress/logs and the structured findings the Web UI renders.
- `POST /api/jobs/:id/retry` — requeue a failed job (the worker drain re-runs it).
- `GET /` and other non-API paths — the static **Web UI** dashboard.

When `API_TOKEN` is set, every `/api` route except `/api/health` requires an
`Authorization: Bearer <token>` header (the Web UI prompts for and stores the
token). Webhooks are authenticated independently by their platform signatures.

## Deployment

ReviewPilot ships in two shapes that share the same review core:

- **A. Long-running service** (below) — central, multi-repo, with a dashboard
  and persistence (`mock`/`postgres`/`mongo`). Best when you want one console
  across many repos and org-wide control.
- **B. GitHub Action** (one-shot) — an ephemeral runner reviews each PR and
  exits. **No server, no database, no webhook**; the PR/checks are the store.
  Best for GitHub-centric, per-repo use. See "Deploy as a GitHub Action".

### Deploy as a GitHub Action (no server, no database)

GitHub triggers an ephemeral container per PR; ReviewPilot reviews the change
with `GITHUB_TOKEN` (auto-provided — no App/PAT/webhook) and writes a summary
comment, then everything is torn down. Add an `ANTHROPIC_API_KEY` Actions secret
and drop this into a repo as `.github/workflows/review.yml` (full example in
[`examples/github-actions/review.yml`](examples/github-actions/review.yml)):

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
permissions: { contents: read, pull-requests: write, checks: write, packages: read }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/cache@v4   # reuse project understanding across runs
        with: { path: .reviewpilot/insight.txt, key: reviewpilot-insight-${{ github.repository }}-v1 }
      - uses: iHealthStrategy/review-pilot@v1
        with:
          engine: claude-agent
          github-token: ${{ github.token }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          insight-file: .reviewpilot/insight.txt
          fail-on-severity: major   # block the PR on major/critical findings
```

The action uses a **prebuilt image on GHCR** (no per-run Docker build). Publish
it once by pushing a version tag (`git tag v1.0.0 && git push origin v1.0.0` →
the `Release action image` workflow builds `Dockerfile.action` and pushes
`ghcr.io/ihealthstrategy/review-pilot-action:{v1,latest,…}`). Set that package's
visibility to **Internal** (org-wide) so org repos can pull it with their job
token (`packages: read`); consumers then pin `iHealthStrategy/review-pilot@v1`.
To build from source instead, point `action.yml`'s `image:` back to
`Dockerfile.action`.

Besides the PR comment, the action publishes a **Check Run** (✅/❌ on the PR)
with the findings summary **and line-level annotations** — each finding that
carries a line is shown inline on the Files-changed tab (severity → notice/
warning/failure; batched to GitHub's 50-per-request limit). `fail-on-severity`
(`info|minor|major|critical`, empty = advisory only) makes the check conclude
**failure** and the job exit non-zero when a finding meets the threshold — mark
the `ReviewPilot` check as **required** in branch protection to turn it into a
real merge gate.

The action (`action.yml` + `Dockerfile.action`) runs `run-review`, which reads
the PR context from the Actions environment, uses the checkout as the workspace,
runs the engine, and upserts the PR comment. The project-understanding cache
lives in a file persisted by `actions/cache` (the Mongo cache's stateless
equivalent). Notes: it covers same-repo PRs (fork PRs don't receive secrets by
design); the runner is unattended, so use an **API key**, not a subscription.

### Subscription trial (small-scale, your own machine)

A Claude **subscription** login lives on your machine (`~/.claude` via
`claude login`) and can't be used by GitHub-hosted runners or a remote server —
but you can trial ReviewPilot on your machine with it. Two ways (both use the
`claude-code` CLI engine and leave `ANTHROPIC_API_KEY` unset → subscription;
keep it to internal/trusted repos, small scale, and switch to an API key for
anything real):

**a) One-shot, by hand (no Actions, no server).** From a checkout at the PR head:

```bash
cd /path/to/checkout
GITHUB_REPOSITORY=owner/repo \
PR_NUMBER=7 \
GITHUB_TOKEN=$(gh auth token) \
REVIEW_ENGINE=claude-code \
REVIEW_ENGINE_ARGS="-p --output-format text --dangerously-skip-permissions" \
node /opt/review-pilot/packages/server/dist/src/action/run-review.js
```

This reviews PR #7 using your logged-in `claude` and posts the comment. (Set
`PR_NUMBER` so no event file is needed; `GITHUB_WORKSPACE` defaults to the cwd.)

**b) Self-hosted runner (auto-triggered).** Run an Actions self-hosted runner on
your machine; a `runs-on: self-hosted` workflow runs `claude-code` on the host
so it uses your subscription — see
[`examples/github-actions/review-selfhosted-trial.yml`](examples/github-actions/review-selfhosted-trial.yml).

### Run the long-running service

One-command local run (credential-free mock mode):

```bash
docker compose up --build         # http://localhost:3000
```

Opt into MongoDB-backed persistence (recommended for stateless deployment):

```bash
DB_DRIVER=mongo MONGODB_URI=mongodb://reviewpilot:reviewpilot@mongo:27017 \
  docker compose --profile mongo up --build
```

Or Postgres-backed persistence:

```bash
DB_DRIVER=postgres docker compose --profile postgres up --build
```

The image installs `git` (needed to sync full repositories) and the MongoDB
driver, then starts the unified server. To connect real platforms, set
`GITHUB_TOKEN` / `GITHUB_WEBHOOK_SECRET` (and/or the GitLab equivalents) and
point your repository's webhook at `/webhook/github` or `/webhook/gitlab`.

### GitHub integration steps

1. **Auth.** Either set a PAT (`GITHUB_TOKEN`, `repo` + PR read/write scope), or
   — recommended for production — register a **GitHub App** and set
   `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (PEM). The service signs an App JWT
   and mints short-lived, per-installation tokens automatically (cached and
   refreshed); the installation is resolved per repo unless you pin
   `GITHUB_APP_INSTALLATION_ID`.
2. **Webhook.** Set `GITHUB_WEBHOOK_SECRET` and add a repo (or org) webhook
   pointing at `https://<host>/webhook/github` for the **Pull requests** event,
   using that secret. (No public endpoint? Set `POLL_INTERVAL_SECONDS>0` to use
   the polling fallback instead.)
3. **Monitor.** Add the repository in the Web UI (or `POST /api/projects` +
   `.../repos`) with its `owner/repo` full name so inbound events are matched
   and reviewed.

### Review engines (Claude Code — agentic)

Two switchable Claude Code engines give you its whole-project understanding +
planning ability, both authenticated by `ANTHROPIC_API_KEY` (or Bedrock/Vertex
env), so they're server-appropriate — the API key is just billing/auth and does
**not** reduce capability:

- **`claude-agent`** (recommended) — drives the **Claude Agent SDK**
  programmatically: runs the agent in the synced checkout (read-only tools by
  default, so untrusted PR code can't run commands), explores the repo, and
  returns findings in our strict JSON schema. Tune with `REVIEW_AGENT_MODEL` /
  `REVIEW_AGENT_MAX_TURNS`.
- **`claude-code`** — the **Claude Code CLI** run headless (`claude -p`) in the
  checkout. Command/args overridable via `REVIEW_ENGINE_COMMAND` /
  `REVIEW_ENGINE_ARGS` (e.g. to allow read tools / skip prompts in your CLI
  version). Cursor/Codex slot into the same adapter.

Both pin a strict JSON output schema with tolerant parsing, and are bounded by
`ENGINE_TIMEOUT_MS`. Set `REVIEW_ENGINE` (or per-project `defaultEngine`).

> Auth: use an **API key** (or cloud IAM) on servers — a personal Pro/Max
> subscription is for interactive local use and is not suitable for an
> unattended service.

#### Small-scale subscription trial (evaluation only)

To kick the tyres on a server using your **local Claude subscription** before
committing to an API key, you can mount your `claude login` credentials into the
container and run the **CLI** engine (which honors them). This is for a private,
small, personal trial only — it isn't licensed for production/shared use and
will hit subscription rate limits. Steps:

```bash
claude login                       # locally, with your subscription
cp -r ~/.claude ./.claude-trial    # a copy, so token refreshes don't touch your primary login
docker compose -f docker-compose.yml -f docker-compose.trial.yml up --build
```

The override sets `REVIEW_ENGINE=claude-code`, leaves `ANTHROPIC_API_KEY` empty
(so the subscription login is used), and mounts the copied credentials
read-write at `CLAUDE_CONFIG_DIR` so the CLI can refresh its token. See
`docker-compose.trial.yml` for the macOS-Keychain caveat and flag tuning. Move
to an API key (above) for anything beyond evaluation.

### Project-understanding cache

To keep reviews grounded in the **whole project** without re-exploring it on
every PR, the agent generates a per-repo architecture summary once and caches it
(`PROJECT_INSIGHT_CACHE`, refreshed after `PROJECT_INSIGHT_TTL_MS`, default 7
days). Each review is prompted with that summary plus the diff. It's a no-op for
engines that can't explore (e.g. `mock`).

### Switching behaviour by configuration

| Concern        | Env var(s)                                  | Default |
| -------------- | ------------------------------------------- | ------- |
| Persistence    | `DB_DRIVER` (`mock`/`sqlite`/`postgres`/`mongo`), `MONGODB_URI`, `MONGODB_DB`, `DATABASE_URL` | `mock` |
| Review engine  | `REVIEW_ENGINE`, `REVIEW_ENGINES_ENABLED`, `ENGINE_TIMEOUT_MS` | `mock`  |
| Git platform   | `GITHUB_*`, `GITLAB_*`                       | unset (mock) |
| Trigger        | `POLL_INTERVAL_SECONDS` (0 = webhook only)  | `0`     |
| Worker         | `RECOVER_INTERRUPTED_JOBS_ON_START`, `INLINE_COMMENTS`, `PUBLISH_CHECK_RUN`, `FAIL_ON_SEVERITY`, `ONLY_CHANGED_LINES` | `true`/`false`/—/`false` |
| Auth/UI        | `API_TOKEN`, `WEB_DIST_DIR`                  | unset (no auth) |

> Persistence: `mock` (in-memory) and `file` run with zero dependencies.
> `mongo` is live via the official `mongodb` driver (loaded lazily; installed in
> the Docker runtime image) and is the recommended stateless backend.
> `postgres` is live via the pure-JS `pg` driver. The repository contract — the
> same behavioural suite — runs against the in-memory backend, a **real Postgres
> engine** (PGlite/WASM, no daemon), and the **Mongo backend** (an in-memory
> store faithfully reproducing the driver's filter/update subset), so the driver
> is switchable without behavioural drift. A `sqlite` driver can be added on
> Node ≥ 22.5 via `node:sqlite` behind the same `SqlClient` port.

## Workspace layout

```
packages/
  server/   # API, providers, trigger, worker, review engines, persistence
  web/       # Jenkins-like Web UI dashboard (static build)
```

## Roadmap

- [x] Project skeleton & engineering baseline
- [x] Core domain model & persistence (Project/Repo/PullRequest/ReviewJob/Finding)
- [x] Git provider abstraction (GitHub + GitLab)
- [x] PR trigger: webhook receiver + polling fallback
- [x] Code sync & pluggable review engine abstraction
- [x] Job orchestration & dual-channel delivery (UI + PR comment)
- [x] Jenkins-like Web UI & configuration management
- [x] End-to-end wiring, docs & deployable image

## License

MIT
