# ReviewPilot

Server-side **continuous code review** platform. ReviewPilot is **task-driven**:
a caller (a GitHub Action, CI, or another service) POSTs a self-contained review
task to `POST /api/tasks`, and the service syncs the **full repository** and runs
a configurable AI review engine (Cursor / Claude Code / Codex) that reviews the
change **in the context of the whole codebase** — not just the diff. A task is
one of two shapes:

- **PR mode** (`prNumber`) — reviews a pull/merge request. Persisted as a job,
  shown in the dashboard, and **written back to the PR** as a summary comment +
  Check Run. Results also queryable over the API.
- **Branch-diff mode** (`headBranch` + `baseBranch`) — reviews the diff between
  two branches with no PR. Headless: runs in the background and delivers the
  result **only via a callback** (machine-to-machine); not shown in the dashboard.

Besides on-demand tasks, the service can run **scheduled daily scans**: at a
configured time it reviews the day's changes on a repo's branches and pushes a
digest to Feishu. Configure these in the Web UI ("Scheduled scans") or over
`/api/schedules`; with no schedule configured, the scheduler does not run.

## Status

Functional end-to-end: GitHub/GitLab providers, a self-contained task API,
full-repo sync, pluggable review engines (mock + Claude Code / Cursor / Codex
CLIs), result delivery on three channels (Web UI, PR comment + Check Run
write-back with update-in-place dedup, and a JSON callback), a
bearer-authenticated management API/UI, and `mock`/`postgres`/`mongo`
persistence — the last designed for stateless cloud deployment.

## Architecture

```
GitHub Action / CI / other service ──POST /api/tasks──▶ TaskService
                                                          │
                          ┌───────────────────────────────┴───────────────────────────┐
                          │ prNumber → PR mode                  headBranch+baseBranch → branch mode
                          ▼                                     ▼
                     ReviewJob (queue, persisted)         ephemeral background review
                          │                                     │
   full-repo clone ◀── Worker ──▶ ReviewEngine          clone + `git diff base...head` ──▶ ReviewEngine
                          │  (mock|cursor|claude-code|claude-agent|codex)                   │
                          ▼ produces                                                        ▼ produces
                     Finding[] (file/line/severity/issue/suggestion)                   Finding[]
                       │          │                                                         │
               persist │          │ write-back                                             │ callback
                       ▼          ▼                                                         ▼
                   Web UI    PR/MR comment + Check Run                            POST JSON to caller
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
GitHub and GitLab credentials, and the management-API bearer token. Defaults are
chosen so the whole pipeline runs in `mock` mode with **no external
credentials**, which is also how the test suite exercises it.

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

- `POST /api/tasks` — the single ingress for reviews. A self-contained task; no
  repo has to be pre-registered. Body:

  ```jsonc
  {
    "platform": "github",                 // github | gitlab
    "repoFullName": "owner/repo",
    "cloneUrl": "https://github.com/owner/repo.git",  // optional; derived when omitted
    "engine": "claude-code",              // optional; falls back to the server default

    // PR mode — review a pull/merge request:
    "prNumber": 123,

    // …OR branch-diff mode — review head vs base (no PR), result via callback:
    "headBranch": "feature/x",
    "baseBranch": "main",
    "callback": { "url": "https://caller/hook", "headers": { "Authorization": "Bearer …" } }
  }
  ```

  PR mode returns `202 {taskId, jobId, status}` (the worker drains it). Branch
  mode returns `202 {taskId, status:"accepted"}` and runs in the background,
  POSTing the result to `callback.url` when done (see "Result callback").
- `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/findings` — review
  jobs (PR mode) with progress/logs and the structured findings the Web UI renders.
- `POST /api/jobs/:id/retry` — requeue a failed job (the worker drain re-runs it).
- `GET/POST /api/schedules`, `GET/PUT/DELETE /api/schedules/:id`,
  `POST /api/schedules/:id/run` — scheduled daily scans (see below).
- `GET /api/health` — open liveness probe.
- `GET /` and other non-API paths — the static **Web UI** dashboard.

When `API_TOKEN` is set, every `/api` route except `/api/health` requires an
`Authorization: Bearer <token>` header (the Web UI prompts for and stores the
token). **Set a strong `API_TOKEN` for any internet-exposed deployment** — it is
the only thing guarding the task ingress.

### Result callback (branch-diff mode)

When a branch-mode task finishes, the service POSTs a JSON body to `callback.url`
with the caller-supplied headers:

```jsonc
{
  "taskId": "task_…",
  "status": "completed",                 // or "failed"
  "conclusion": "success" | "neutral",   // completed only
  "findings": [ { "filePath", "line", "severity", "title", "detail", "suggestion", "category" } ],
  "error": "…"                            // failed only
}
```

Delivery is best-effort (a single POST); the caller owns its own retries/timeout.

### Scheduled daily scans

Configure a repo to be reviewed automatically every day and pushed to Feishu —
no PR or external trigger needed. Manage these in the Web UI ("Scheduled scans")
or over the API:

```jsonc
POST /api/schedules
{
  "name": "nightly",
  "platform": "github",
  "repoFullName": "owner/repo",
  "cloneUrl": "https://github.com/owner/repo.git",   // optional; derived when omitted
  "branches": ["main", "develop"],                    // empty/omitted = all remote branches
  "timeOfDay": "02:00",                               // 24h, in `timezone`
  "timezone": "Asia/Shanghai",                        // IANA tz
  "lookbackHours": 24,                                // rolling window to scan (default 24)
  "engine": "claude-code",                            // optional; server default otherwise
  "delivery": { "type": "feishu", "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/…" }
}
```

At `timeOfDay` (in `timezone`) the scheduler reviews, **per branch**, the
aggregate diff of that branch's commits from the **last `lookbackHours`** (a
rolling window, default 24h — NOT "since midnight", so a run shortly after
midnight still covers the previous day), and pushes one Feishu card summarising
the findings. `POST /api/schedules/:id/run` triggers a run immediately (for
testing). Disable a schedule with `PUT {"enabled": false}`.

`delivery.webhookUrl` is optional — leave it empty to use the deploy-wide
`FEISHU_WEBHOOK_URL` env var as the default push target (configure the
destination once at deploy time; a per-schedule URL still overrides it).

The in-process scheduler runs **only while at least one enabled schedule
exists** — with none configured, no timer is started. Schedule configs are kept
in a lightweight store independent of the review database: the `mongo` DB driver
stores them in a `schedules` collection (survives stateless redeploys); other
drivers use a JSON file (`SCHEDULE_STORE_FILE`, default
`./.reviewpilot/schedules.json` — put it on a volume to persist). Email delivery
is a planned addition; Feishu is supported today.

## Deployment

ReviewPilot ships in three shapes that share the same review core:

- **A. Long-running service** (below) — central, multi-repo, with a dashboard
  and persistence (`mock`/`postgres`/`mongo`). Reviews are fed to it over
  `POST /api/tasks`. Best when you want one console across many repos and
  org-wide control.
- **B. GitHub Action** (one-shot) — an ephemeral runner reviews each PR and
  exits. **No server, no database**; the PR/checks are the store. Best for
  GitHub-centric, per-repo use. See "Deploy as a GitHub Action".
- **C. Service action** (`service/action.yml`) — a thin GitHub Action that POSTs
  the PR to a **self-hosted service (A)** and waits for the result. Use it to
  drive the central service from each repo's CI. See "Drive the service from
  GitHub Actions".

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
driver, then starts the unified server. On networks where the Alpine CDN or npm
registry is slow/unreachable, build with mirror args:
`docker build --build-arg ALPINE_MIRROR=mirrors.aliyun.com --build-arg NPM_REGISTRY=https://registry.npmmirror.com .` To connect real platforms, set
`GITHUB_TOKEN` (and/or the GitLab equivalents) so the service can read PRs and
write back comments/checks, then feed it reviews over `POST /api/tasks` (see
"Drive the service from GitHub Actions" for the turnkey path).

### GitHub integration steps

1. **Auth.** Either set a PAT (`GITHUB_TOKEN`, `repo` + PR read/write scope), or
   — recommended for production — register a **GitHub App** and set
   `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (PEM). The service signs an App JWT
   and mints short-lived, per-installation tokens automatically (cached and
   refreshed); the installation is resolved per repo unless you pin
   `GITHUB_APP_INSTALLATION_ID`.
2. **Expose + protect.** Put the service behind HTTPS and set a strong
   `API_TOKEN`; callers pass it as `Authorization: Bearer <token>`.
3. **Send tasks.** POST each PR to `https://<host>/api/tasks` (see HTTP surface).
   No per-repo registration is needed — the task is self-contained. The simplest
   path is the **service action** below.

### Drive the service from GitHub Actions

`service/action.yml` is a thin composite action that health-checks the service,
POSTs the current PR to `POST /api/tasks`, and polls `GET /api/jobs/:id` until
the review finishes — exposing `findings` / `conclusion` as step outputs. Add
the service URL + token as repo secrets and drop this into `.github/workflows/`:

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
permissions: { contents: read, pull-requests: write }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: iHealthStrategy/review-pilot/service@v1
        with:
          service-url: ${{ secrets.REVIEWPILOT_URL }}    # https://<host>
          api-token: ${{ secrets.REVIEWPILOT_TOKEN }}    # matches the service API_TOKEN
          github-token: ${{ github.token }}
```

The service does the actual review (and PR write-back) with its own
`GITHUB_TOKEN`; the workflow just triggers it and waits. For non-PR /
machine-to-machine use, POST a **branch-diff** task with a `callback` instead
(no Action needed).

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
>
> Relay/gateway: to route through an Anthropic-API-compatible proxy, set
> `ANTHROPIC_BASE_URL` (and `ANTHROPIC_AUTH_TOKEN` if it uses Bearer auth) — in
> the Action via the `anthropic-base-url` / `anthropic-auth-token` inputs, in the
> service via env. The relay must proxy the **full** Anthropic API (the agentic
> engines use more than `/v1/messages`), not just a chat shim.

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
| Worker         | `RECOVER_INTERRUPTED_JOBS_ON_START`, `INLINE_COMMENTS`, `PUBLISH_CHECK_RUN`, `FAIL_ON_SEVERITY`, `ONLY_CHANGED_LINES` | `true`/`false`/—/`false` |
| Scheduled scans| `SCHEDULE_STORE_FILE` (non-mongo drivers; mongo uses a `schedules` collection) | `./.reviewpilot/schedules.json` |
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
  server/   # task API, providers, review engines (PR + branch), worker, persistence
  web/       # task-driven Web UI dashboard (static build)
```

## Roadmap

- [x] Project skeleton & engineering baseline
- [x] Core domain model & persistence (Project/Repo/PullRequest/ReviewJob/Finding)
- [x] Git provider abstraction (GitHub + GitLab)
- [x] Self-contained task API (`POST /api/tasks`): PR mode + branch-diff mode
- [x] Code sync & pluggable review engine abstraction
- [x] Job orchestration & triple-channel delivery (UI + PR comment + callback)
- [x] Task-driven Web UI dashboard
- [x] End-to-end wiring, docs & deployable image

## License

MIT
