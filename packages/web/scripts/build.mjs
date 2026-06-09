import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the Jenkins-like Web UI. Emits a single static `dist/index.html` that
 * renders the ReviewPilot dashboard (monitored projects, configuration forms,
 * review jobs with progress, and a job detail view with findings + logs). It
 * hydrates from the server REST API at runtime (`/api/projects`, `/api/jobs`),
 * sends the configured bearer token, and falls back to embedded mock data so
 * the built artifact renders standalone with no server.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const outFile = resolve(distDir, "index.html");

// Mock data mirrors the server DTO shapes (see packages/server/src/api).
const MOCK = {
  projects: [
    {
      id: "prj_demo",
      name: "demo",
      platform: "github",
      defaultEngine: "mock",
      enabledEngines: ["mock", "claude-code"],
    },
  ],
  jobs: [
    {
      id: "job_1",
      engine: "mock",
      status: "succeeded",
      progress: 100,
      pullRequest: { number: 7, title: "Add feature", url: "#" },
      findings: [
        { filePath: "src/new.ts", line: 1, severity: "minor", title: "Reviewed src/new.ts" },
      ],
    },
  ],
};

const ENGINES = ["mock", "cursor", "claude-code", "claude-agent", "codex"];
const PLATFORMS = ["github", "gitlab"];

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ReviewPilot</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
      header { background: #161a22; padding: 12px 20px; border-bottom: 1px solid #2a2f3a; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
      h1 { font-size: 18px; margin: 0; }
      main { padding: 20px; max-width: 1100px; }
      section { margin-bottom: 28px; }
      h2 { font-size: 14px; text-transform: uppercase; color: #8b95a5; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #232833; font-size: 14px; }
      tr.clickable { cursor: pointer; }
      tr.clickable:hover { background: #161a22; }
      .status { padding: 2px 8px; border-radius: 10px; font-size: 12px; }
      .succeeded { background: #16391f; color: #6ee787; }
      .running { background: #3a3416; color: #e7d56e; }
      .failed { background: #3a1616; color: #e76e6e; }
      .pending { background: #232833; color: #8b95a5; }
      .bar { background: #232833; border-radius: 6px; height: 8px; width: 120px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: #4c8bf5; }
      form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
      input, select, button { background: #11151c; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 6px; padding: 6px 8px; font-size: 13px; }
      button { cursor: pointer; background: #1f6feb; border-color: #1f6feb; color: #fff; }
      button.secondary { background: #232833; border-color: #2a2f3a; }
      fieldset { border: 1px solid #232833; border-radius: 8px; padding: 10px 14px; }
      legend { color: #8b95a5; font-size: 12px; text-transform: uppercase; }
      .sev { font-weight: 600; }
      .sev-critical { color: #e76e6e; } .sev-major { color: #e7a16e; }
      .sev-minor { color: #e7d56e; } .sev-info { color: #8b95a5; }
      pre { background: #11151c; border: 1px solid #232833; border-radius: 6px; padding: 10px; overflow: auto; font-size: 12px; }
      #detail { margin-top: 12px; }
      .muted { color: #8b95a5; font-size: 12px; }
      .token { display: flex; gap: 6px; align-items: center; }
    </style>
  </head>
  <body>
    <header>
      <h1>🤖 ReviewPilot — continuous code review</h1>
      <div class="token">
        <span class="muted">API token</span>
        <input id="token" type="password" placeholder="bearer token (if required)" style="width:220px" />
        <button class="secondary" id="save-token">Save</button>
      </div>
    </header>
    <main id="app">
      <section id="projects"><h2>Monitored projects</h2><div data-loading>Loading…</div></section>
      <section id="repos"><h2>Monitored repositories</h2><div data-loading>Loading…</div></section>
      <section id="new-config">
        <h2>Configuration</h2>
        <fieldset>
          <legend>New project</legend>
          <form id="project-form">
            <input name="name" placeholder="name" required />
            <select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select>
            <select name="defaultEngine">${ENGINES.map((e) => `<option>${e}</option>`).join("")}</select>
            <input name="enabledEngines" placeholder="enabled engines (comma-separated)" value="mock" style="width:240px" />
            <button type="submit">Create project</button>
          </form>
        </fieldset>
        <fieldset>
          <legend>Add repository</legend>
          <form id="repo-form">
            <select name="projectId" id="repo-project"></select>
            <select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select>
            <input name="fullName" placeholder="owner/repo" required />
            <input name="remoteUrl" placeholder="https://github.com/owner/repo" required />
            <input name="cloneUrl" placeholder="https://github.com/owner/repo.git" required />
            <input name="defaultBranch" placeholder="main" value="main" />
            <button type="submit">Add repo</button>
          </form>
        </fieldset>
      </section>
      <section id="jobs"><h2>Review jobs</h2><div data-loading>Loading…</div></section>
      <section id="detail"></section>
    </main>
    <script id="mock-data" type="application/json">${JSON.stringify(MOCK)}</script>
    <script>
      const MOCK = JSON.parse(document.getElementById("mock-data").textContent);
      const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

      // --- auth: token persisted in localStorage, sent as Bearer header ---
      const tokenInput = document.getElementById("token");
      tokenInput.value = localStorage.getItem("rp_token") || "";
      document.getElementById("save-token").onclick = () => {
        localStorage.setItem("rp_token", tokenInput.value);
        refresh();
      };
      function headers(extra) {
        const h = Object.assign({}, extra || {});
        const t = localStorage.getItem("rp_token");
        if (t) h["Authorization"] = "Bearer " + t;
        return h;
      }
      async function api(path, opts) {
        const o = Object.assign({}, opts || {});
        o.headers = headers(o.headers);
        const res = await fetch(path, o);
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + path);
        return res.status === 204 ? null : res.json();
      }
      async function load(path, fallback) {
        try { return await api(path); } catch { return fallback; }
      }

      function renderProjects(projects) {
        const rows = projects.map((p) =>
          \`<tr><td>\${esc(p.name)}</td><td>\${esc(p.platform)}</td><td>\${esc(p.defaultEngine)}</td><td>\${(p.enabledEngines||[]).map(esc).join(", ")}</td></tr>\`
        ).join("");
        document.querySelector("#projects").innerHTML =
          \`<h2>Monitored projects</h2><table><thead><tr><th>Name</th><th>Platform</th><th>Default engine</th><th>Enabled</th></tr></thead><tbody>\${rows}</tbody></table>\`;
        const sel = document.getElementById("repo-project");
        if (sel) sel.innerHTML = projects.map((p) => \`<option value="\${esc(p.id)}">\${esc(p.name)}</option>\`).join("");
      }

      // Aggregate repos across all projects so a successful "Add repo" is
      // immediately visible (the form alone gave no feedback before).
      async function loadRepos(projects) {
        const byProject = {};
        for (const p of projects) byProject[p.id] = p.name;
        const lists = await Promise.all(
          projects.map((p) => load("/api/projects/" + p.id + "/repos", []))
        );
        return lists.flat().map((r) => ({ ...r, projectName: byProject[r.projectId] || r.projectId }));
      }

      function renderRepos(repos) {
        const rows = repos.map((r) =>
          \`<tr><td>\${esc(r.projectName)}</td><td>\${esc(r.platform)}</td><td><code>\${esc(r.fullName)}</code></td><td>\${esc(r.defaultBranch)}</td></tr>\`
        ).join("");
        document.querySelector("#repos").innerHTML =
          \`<h2>Monitored repositories</h2>\` +
          (repos.length
            ? \`<table><thead><tr><th>Project</th><th>Platform</th><th>Repository</th><th>Default branch</th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">No repositories registered yet. Add one below.</p>\`);
      }

      function renderJobs(jobs) {
        const rows = jobs.map((j) => {
          const pr = j.pullRequest || {};
          const findings = (j.findings || []).length;
          return \`<tr class="clickable" data-job="\${esc(j.id)}"><td>#\${esc(pr.number ?? "?")} \${esc(pr.title ?? "")}</td><td>\${esc(j.engine)}</td><td><span class="status \${esc(j.status)}">\${esc(j.status)}</span></td><td><div class="bar"><i style="width:\${Number(j.progress)||0}%"></i></div></td><td>\${findings} finding(s)</td></tr>\`;
        }).join("");
        document.querySelector("#jobs").innerHTML =
          \`<h2>Review jobs</h2><table><thead><tr><th>Pull request</th><th>Engine</th><th>Status</th><th>Progress</th><th>Findings</th></tr></thead><tbody>\${rows}</tbody></table>\`;
        document.querySelectorAll('#jobs tr[data-job]').forEach((tr) => {
          tr.onclick = () => showJob(tr.getAttribute("data-job"));
        });
      }

      async function showJob(id) {
        const job = await load("/api/jobs/" + id, null);
        const el = document.getElementById("detail");
        if (!job) { el.innerHTML = ""; return; }
        const findings = (job.findings || []).map((f) =>
          \`<li><span class="sev sev-\${esc(f.severity)}">[\${esc(f.severity)}]</span> <code>\${esc(f.filePath)}\${f.line ? ":" + esc(f.line) : ""}</code> — <b>\${esc(f.title)}</b><br/><span class="muted">\${esc(f.detail || "")}</span>\${f.suggestion ? "<br/>💡 " + esc(f.suggestion) : ""}</li>\`
        ).join("");
        const retry = job.status === "failed"
          ? \`<button id="retry">Retry job</button>\`
          : "";
        el.innerHTML =
          \`<h2>Job \${esc(job.id)} \${retry}</h2>\` +
          \`<p class="muted">engine \${esc(job.engine)} · status \${esc(job.status)} · progress \${Number(job.progress)||0}%\${job.error ? " · error: " + esc(job.error) : ""}</p>\` +
          \`<h3>Findings (\${(job.findings||[]).length})</h3><ul>\${findings || "<li class='muted'>none</li>"}</ul>\` +
          \`<h3>Logs</h3><pre>\${(job.logs||[]).map(esc).join("\\n") || "(none)"}</pre>\`;
        const rb = document.getElementById("retry");
        if (rb) rb.onclick = async () => {
          try { await api("/api/jobs/" + id + "/retry", { method: "POST" }); refresh(); }
          catch (e) { alert(e.message); }
        };
      }

      document.getElementById("project-form").onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        try {
          await api("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: f.name.value,
              platform: f.platform.value,
              defaultEngine: f.defaultEngine.value,
              enabledEngines: f.enabledEngines.value.split(",").map((s) => s.trim()).filter(Boolean),
            }),
          });
          f.reset(); refresh();
        } catch (e) { alert(e.message); }
      };

      document.getElementById("repo-form").onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        if (!f.projectId.value) { alert("Create a project first, then add a repository to it."); return; }
        // Disable the button while the request is in flight so a slow response
        // can't be double-submitted into duplicate repos.
        const btn = f.querySelector('button[type="submit"]');
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = "Adding…";
        try {
          const res = await api("/api/projects/" + f.projectId.value + "/repos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: f.platform.value,
              fullName: f.fullName.value,
              remoteUrl: f.remoteUrl.value,
              cloneUrl: f.cloneUrl.value,
              defaultBranch: f.defaultBranch.value || "main",
            }),
          });
          f.reset(); f.defaultBranch.value = "main";
          await refresh();
          btn.textContent = "✓ Added"; setTimeout(() => { btn.textContent = label; }, 1500);
        } catch (e) { alert(e.message); btn.textContent = label; }
        finally { btn.disabled = false; }
      };

      async function refresh() {
        const projects = await load("/api/projects", MOCK.projects);
        renderProjects(projects);
        renderRepos(await loadRepos(projects));
        renderJobs(await load("/api/jobs", MOCK.jobs));
      }
      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>
`;

await mkdir(distDir, { recursive: true });
await writeFile(outFile, html, "utf8");
process.stdout.write(`web: wrote ${outFile}\n`);
