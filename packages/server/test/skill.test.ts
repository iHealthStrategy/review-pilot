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
  assert.match(md, /pending/i); // candidates land pending
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

test("skills: pre-authorize their own commands via allowed-tools frontmatter", () => {
  for (const md of [buildOrchestratorSkill("https://x.example.com"), buildReviewSkill()]) {
    // allowed-tools must sit in the YAML frontmatter (before the first body `#`).
    const frontmatter = md.slice(0, md.indexOf("\n# "));
    assert.match(frontmatter, /^allowed-tools: /m);
    assert.match(frontmatter, /Bash\(git diff \*\)/);
    assert.match(frontmatter, /Bash\(curl \*\)/);
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

test("buildInstallScript: writes the skill into ~/.claude/skills via a heredoc", () => {
  const sh = buildInstallScript(buildReviewSkill());
  assert.match(sh, /\$HOME\/\.claude\/skills\/reviewpilot-review/);
  assert.match(sh, /<<'REVIEWPILOT_SKILL_EOF'/);
  assert.match(sh, /^REVIEWPILOT_SKILL_EOF$/m); // closing delimiter on its own line
  assert.ok(sh.includes("name: " + SKILL_NAME));
});

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
