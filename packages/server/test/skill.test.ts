import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startAppServer } from "../src/app.js";
import { FINDING_SCHEMA_FIELDS } from "../src/review/prompt.js";
import type { Platform } from "../src/domain/entities.js";
import { MemoryRepository } from "../src/persistence/memory-repository.js";
import { TaskService } from "../src/trigger/trigger-service.js";
import {
  SKILL_NAME,
  SKILL_PLATFORMS,
  buildInstallScript,
  buildOrchestratorSkill,
  buildReviewSkill,
  normalizeProjectKey,
} from "../src/skill/review-skill.js";
import type { ReviewRuleset } from "../src/domain/entities.js";
import { fixedClock, seqIdGen } from "./repository-contract.js";
import { SpyProvider } from "./spy-provider.js";

test("buildReviewSkill: valid frontmatter + shared finding schema (no drift)", () => {
  const md = buildReviewSkill();
  assert.match(md, /^---\nname: reviewpilot-review\n/);
  assert.match(md, /description:/);
  // The finding schema is the SAME one the service prompt uses.
  assert.ok(md.includes(FINDING_SCHEMA_FIELDS), "embeds the shared finding schema");
  assert.match(md, /working/);
  assert.match(md, /code-review-graph/); // structural context step
});

test("buildOrchestratorSkill: bakes baseUrl + fetches a named user's public rulesets on demand", () => {
  const md = buildOrchestratorSkill("https://review.example.com/");
  assert.match(md, /^---\nname: reviewpilot-review\n/);
  // Base URL baked in (trailing slash trimmed) and used to call the public API.
  assert.ok(md.includes("https://review.example.com"));
  assert.ok(!md.includes("review.example.com//"), "trailing slash trimmed");
  assert.match(md, /\/api\/u\/\$HANDLE\/rulesets/); // public discovery endpoint
  assert.match(md, /帮我 review/); // recognises the "让 X 帮我 review" trigger
  assert.match(md, /globs/); // documents local selector matching
  assert.ok(md.includes(FINDING_SCHEMA_FIELDS), "shares the finding schema");
});

test("buildOrchestratorSkill: with no baseUrl falls back to REVIEWPILOT_URL env var", () => {
  const md = buildOrchestratorSkill("");
  assert.match(md, /REVIEWPILOT_URL/);
});

test("buildOrchestratorSkill: derives a per-project key and auto-grows candidate rules", () => {
  const md = buildOrchestratorSkill("https://review.example.com");
  assert.match(md, /git remote get-url origin/); // project identification
  assert.match(md, /\/api\/u\/\$HANDLE\/rulesets\?project=\$PROJECT/); // project-scoped fetch
  assert.match(md, /\/api\/rulesets\/candidates/); // auto-grow submit
  assert.match(md, /REVIEWPILOT_TOKEN/); // PAT for the write
  assert.match(md, /take effect immediately|disable it later/i); // candidates apply now, opt-out later
  // Submit uses the SAME normalized $PROJECT key as the fetch (not raw $REMOTE),
  // so auto-grown rules match next time and no-remote repos don't 400.
  assert.match(md, /\\"project\\":\\"\$PROJECT\\"/);
  assert.doesNotMatch(md, /\\"project\\":\\"\$REMOTE\\"/);
});

test("skills: emit a confirmation banner as the first output line", () => {
  for (const md of [buildOrchestratorSkill("https://x.example.com"), buildReviewSkill()]) {
    assert.match(md, /Confirmation banner \(ALWAYS print this first\)/);
    assert.match(md, /🤖 ReviewPilot ▸ scope=/);
    assert.match(md, /threshold=<must-fix/);
  }
});

test("buildOrchestratorSkill: bakes a token in when provided (no manual setup)", () => {
  const withTok = buildOrchestratorSkill("https://x.example.com", "rpat_abc123");
  assert.match(withTok, /TOKEN="rpat_abc123"/); // baked literal
  assert.match(withTok, /already baked in/i);
  assert.doesNotMatch(withTok, /TOKEN="\$\{REVIEWPILOT_TOKEN/); // not the env fallback
  // Without a token, falls back to the env var.
  const noTok = buildOrchestratorSkill("https://x.example.com");
  assert.match(noTok, /TOKEN="\$\{REVIEWPILOT_TOKEN:-\}"/);
  assert.match(noTok, /REVIEWPILOT_TOKEN/);
});

test("GET /skill/install.sh bakes the caller's bearer token into the skill", () =>
  withApp(async (base) => {
    const res = await fetch(`${base}/skill/install.sh`, {
      headers: { authorization: "Bearer rpat_installtoken" },
    });
    assert.equal(res.status, 200);
    const sh = await res.text();
    assert.match(sh, /TOKEN="rpat_installtoken"/); // token baked into the SKILL.md
    // Anonymous install stays generic (env-var fallback, no baked token).
    const anon = await (await fetch(`${base}/skill/install.sh`)).text();
    assert.doesNotMatch(anon, /rpat_installtoken/);
    assert.match(anon, /TOKEN="\$\{REVIEWPILOT_TOKEN:-\}"/);
  }));

test("skills: default the review output to Chinese", () => {
  for (const md of [buildOrchestratorSkill("https://x.example.com"), buildReviewSkill()]) {
    assert.match(md, /in \*\*中文 \(Chinese\)\*\* by default/);
  }
});

test("skills: pre-authorize their own commands via allowed-tools frontmatter", () => {
  for (const md of [buildOrchestratorSkill("https://x.example.com"), buildReviewSkill()]) {
    // allowed-tools must sit in the YAML frontmatter (before the first body `#`).
    const frontmatter = md.slice(0, md.indexOf("\n# "));
    assert.match(frontmatter, /^allowed-tools: /m);
    assert.match(frontmatter, /Bash\(git diff \*\)/);
    assert.match(frontmatter, /Bash\(curl \*\)/);
    assert.match(frontmatter, /Bash\(find \*\)/); // read-only search pre-authorized
    assert.match(frontmatter, /Bash\(grep \*\)/);
    assert.match(frontmatter, /\bEdit\b/);
    assert.match(frontmatter, /\bWrite\b/);
  }
});

test("skills: severity calibration + default must-fix reporting threshold, NL-adjustable", () => {
  for (const md of [buildOrchestratorSkill("https://x.example.com"), buildReviewSkill()]) {
    // Severity rated by impact × reachability, low-confidence → info, no inflation.
    assert.match(md, /impact × (how )?reach/i);
    assert.match(md, /never inflate severity/i);
    assert.match(md, /low confidence/i);
    assert.match(md, /design decision/i);
    // Default threshold = must-fix (major + critical); NL widening documented.
    assert.match(md, /By DEFAULT report only \*\*must-fix\*\*/);
    assert.match(md, /major and critical/);
    assert.match(md, /显示全部|everything|nitpicks/);
    // Suppression must be transparent (state how many were hidden).
    assert.match(md, /suppress/i);
  }
});

test("skills: one-shot fix is aggregate → confirm once → batch-apply (no commit)", () => {
  for (const md of [buildOrchestratorSkill("https://x.example.com"), buildReviewSkill()]) {
    assert.match(md, /One-shot fix/);
    assert.match(md, /Aggregate/);
    assert.match(md, /Ask once/);
    assert.match(md, /Batch when large/); // handles many issues
    assert.match(md, /Do NOT commit/); // leaves the working tree for review
  }
});

test("buildOrchestratorSkill: reports findings + both timings, and stamps the clock", () => {
  const md = buildOrchestratorSkill("https://x.example.com", "rpat_t");
  // Step 0 starts the clock and step 10 reports it.
  assert.match(md, /## 0\. Start the clock/);
  assert.match(md, /date \+%s/);
  assert.match(md, /T_START/);
  assert.match(md, /T_WAIT/);
  // Shell state does not survive between commands, so the skill must be told
  // to hold the stamps in its own reasoning rather than in a shell variable.
  assert.match(md, /fresh shell|in your own reasoning/i);
  // Rather than a guessed duration, report none.
  assert.match(md, /report no timing at all/i);
  // The upload carries findings and both durations.
  assert.match(md, /\\"durationMs\\":\$DURATION_MS/);
  assert.match(md, /\\"activeMs\\":\$ACTIVE_MS/);
  assert.match(md, /\\"findings\\":\$FINDINGS_JSON/);
  // `date` must be pre-authorized or every stamp prompts on Claude Code.
  assert.match(md.slice(0, md.indexOf("\n# ")), /Bash\(date \*\)/);
});

test("buildOrchestratorSkill: is explicit that findings — but never code — are uploaded", () => {
  const md = buildOrchestratorSkill("https://x.example.com", "rpat_t");
  assert.match(md, /What leaves the machine/);
  // The promise that remains: metadata about problems, never the source.
  assert.match(md, /does \*\*NOT\*\* upload source code/);
  assert.match(md, /no diff hunks, no code snippets/);
  assert.match(md, /paraphrase it/i); // don't smuggle code in via `detail`
});

test("normalizeProjectKey: stable cross-form key", () => {
  assert.equal(normalizeProjectKey("git@github.com:acme/App.git"), "github.com/acme/app");
  assert.equal(normalizeProjectKey("https://github.com/acme/app"), "github.com/acme/app");
  assert.equal(normalizeProjectKey("https://user:tok@gitlab.com/g/sub/repo.git/"), "gitlab.com/g/sub/repo");
  assert.equal(normalizeProjectKey("ssh://git@host:22/x/y.git"), "host:22/x/y");
  assert.equal(normalizeProjectKey(""), "");
});

test("buildReviewSkill: structured rules become conditional rule lines with selectors", () => {
  const ruleset: ReviewRuleset = {
    id: "r1",
    ownerId: "u1",
    ownerEmail: "u1@x.com",
    ownerHandle: "alice",
    project: "github.com/alice/backend",
    projectLabel: "alice/backend",
    name: "Backend",
    slug: "backend",
    description: "",
    visibility: "public",
    language: "中文",
    focus: "",
    instructions: "",
    rules: [
      { title: "SQL safety", instruction: "check injection", globs: ["**/*.sql"], languages: [], topics: ["security"] },
      { title: "Always", instruction: "no console.log", globs: [], languages: [], topics: [] },
    ],
    createdAt: "",
    updatedAt: "",
  };
  const md = buildReviewSkill(ruleset);
  assert.match(md, /Conditional rules/);
  assert.match(md, /\*\*SQL safety\*\*.*when:.*paths.*\*\*\/\*\.sql/);
  assert.match(md, /\*\*Always\*\*.*always/);
  assert.match(md, /Write the findings in 中文/);
});

test("buildInstallScript: best-effort registers the code-review-graph MCP (guarded, skippable)", () => {
  const sh = buildInstallScript(buildOrchestratorSkill("https://x.example.com"));
  assert.match(sh, /claude mcp add -s user code-review-graph -- uvx code-review-graph serve/);
  assert.match(sh, /command -v claude/); // only when claude is present
  assert.match(sh, /command -v uvx/);    // and uvx is present
  assert.match(sh, /REVIEWPILOT_NO_GRAPH/); // opt-out
  assert.match(sh, /claude mcp list .* grep -q "code-review-graph"/); // idempotent
  // Interactive uv install offer: prompt read from /dev/tty (works under curl|sh),
  // installs via the official script, skippable.
  assert.match(sh, /read ans < \/dev\/tty/);
  assert.match(sh, /astral\.sh\/uv\/install\.sh/);
});

test("buildInstallScript: writes the skill into ~/.claude/skills via a heredoc", () => {
  const sh = buildInstallScript(buildReviewSkill());
  assert.match(sh, /\$HOME\/\.claude\/skills\/reviewpilot-review/);
  assert.match(sh, /<<'REVIEWPILOT_SKILL_EOF'/);
  assert.match(sh, /^REVIEWPILOT_SKILL_EOF$/m); // closing delimiter on its own line
  assert.ok(sh.includes("name: " + SKILL_NAME));
});

test("skills: every host build shares the identical review kernel", () => {
  const [claude, codex, cursor] = SKILL_PLATFORMS.map((p) =>
    buildOrchestratorSkill("https://x.example.com", "rpat_t", p));
  for (const md of [claude, codex, cursor]) {
    // Same dimensions, schema, banner, threshold and auto-grow flow everywhere —
    // only the host-specific frontmatter/notes may differ.
    assert.ok(md!.includes(FINDING_SCHEMA_FIELDS));
    assert.match(md!, /🤖 ReviewPilot ▸ scope=/);
    assert.match(md!, /By DEFAULT report only \*\*must-fix\*\*/);
    assert.match(md!, /\/api\/rulesets\/candidates/);
    assert.match(md!, /^name: reviewpilot-review$/m);
    assert.match(md!, /^description: >-$/m);
  }
  // allowed-tools is a Claude Code field; Codex/Cursor gate commands themselves,
  // so emitting it there would be dead frontmatter.
  assert.match(claude!.slice(0, claude!.indexOf("\n# ")), /^allowed-tools: /m);
  for (const md of [codex, cursor]) {
    assert.doesNotMatch(md!.slice(0, md!.indexOf("\n# ")), /allowed-tools/);
  }
  assert.match(codex!, /_Host: Codex\./);
  assert.match(cursor!, /_Host: Cursor\./);
});

test("buildInstallScript: installs into each host's skills dir + registers its MCP", () => {
  const md = buildOrchestratorSkill("https://x.example.com");
  const claude = buildInstallScript(md, SKILL_NAME, "claude");
  assert.match(claude, /DIR="\$HOME\/\.claude\/skills\/reviewpilot-review"/);
  assert.match(claude, /claude mcp add -s user code-review-graph/);

  // Codex reads both the original ~/.codex/skills and the shared ~/.agents/skills.
  const codex = buildInstallScript(md, SKILL_NAME, "codex");
  assert.match(codex, /DIR="\$HOME\/\.codex\/skills\/reviewpilot-review"/);
  assert.match(codex, /ALT="\$HOME\/\.agents\/skills\/reviewpilot-review"/);
  assert.match(codex, /codex mcp add code-review-graph -- uvx code-review-graph serve/);
  assert.match(codex, /! command -v codex >\/dev\/null/); // skip when Codex absent

  // Cursor has no `mcp add` CLI: write ~/.cursor/mcp.json, but never clobber one.
  const cursor = buildInstallScript(md, SKILL_NAME, "cursor");
  assert.match(cursor, /DIR="\$HOME\/\.cursor\/skills\/reviewpilot-review"/);
  assert.match(cursor, /CFG="\$HOME\/\.cursor\/mcp\.json"/);
  assert.match(cursor, /already exists — not rewriting it/);

  // Shared safety net: the opt-out and the uv offer survive on every host.
  for (const sh of [claude, codex, cursor]) {
    assert.match(sh, /REVIEWPILOT_NO_GRAPH/);
    assert.match(sh, /astral\.sh\/uv\/install\.sh/);
    // Closing hints are single-quoted so nothing (e.g. `$reviewpilot-review`,
    // an apostrophe in "user's") is re-parsed by the shell.
    assert.doesNotMatch(sh, /echo '[^']*'[a-z]/);
  }
  assert.match(codex, /\$reviewpilot-review/); // Codex's explicit-invocation hint
});

test("GET /skill/<platform>/install.sh serves that host's build; bare path stays Claude", () =>
  withApp(async (base) => {
    for (const [platform, dir] of [
      ["claude", "\\.claude/skills"],
      ["codex", "\\.codex/skills"],
      ["cursor", "\\.cursor/skills"],
    ] as const) {
      const res = await fetch(`${base}/skill/${platform}/install.sh`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /shellscript/);
      assert.match(await res.text(), new RegExp(dir));
      const md = await fetch(`${base}/skill/${platform}/SKILL.md`);
      assert.equal(md.status, 200);
      assert.match(md.headers.get("content-type") ?? "", /markdown/);
      assert.match(await md.text(), /name: reviewpilot-review/);
    }
    // Back-compat: the un-prefixed paths still serve the Claude Code build.
    assert.match(await (await fetch(`${base}/skill/install.sh`)).text(), /\.claude\/skills/);
    assert.match(await (await fetch(`${base}/skill/SKILL.md`)).text(), /allowed-tools:/);
    // The token is baked into every host build, not just Claude's.
    const codexSh = await (await fetch(`${base}/skill/codex/install.sh`, {
      headers: { authorization: "Bearer rpat_hostbake" },
    })).text();
    assert.match(codexSh, /TOKEN="rpat_hostbake"/);
  }));

async function withApp(run: (base: string) => Promise<void>): Promise<void> {
  const repo = new MemoryRepository({ clock: fixedClock(), idGen: seqIdGen() });
  await repo.init();
  const taskService = new TaskService({
    repo,
    providerFor: (_p: Platform) => new SpyProvider(),
    defaultEngine: "mock",
    enabledEngines: ["mock"],
  });
  // Auth ON — the skill artifacts must still be reachable without a credential.
  const server = startAppServer({ repo, taskService, sessionSecret: "secret" }, 0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    server.close();
  }
}

test("GET /skill/install.sh is public (no auth) and returns a shell installer", () =>
  withApp(async (base) => {
    const res = await fetch(`${base}/skill/install.sh`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /shellscript/);
    const body = await res.text();
    assert.match(body, /mkdir -p/);
    assert.match(body, /reviewpilot-review/);
  }));

test("GET /skill/<name>/SKILL.md serves the raw skill", () =>
  withApp(async (base) => {
    const res = await fetch(`${base}/skill/${SKILL_NAME}/SKILL.md`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /markdown/);
    assert.match(await res.text(), /name: reviewpilot-review/);
  }));
