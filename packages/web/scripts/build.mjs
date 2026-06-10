import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the task-driven Web UI. Emits a single static `dist/index.html` with a
 * left sidebar switching two views:
 *   - Dashboard: the review tasks (jobs) list + a detail panel (findings/logs)
 *   - New task:  a manual form that POSTs a self-contained review task
 * It hydrates from the server REST API at runtime (`/api/jobs`, `/api/tasks`),
 * sends the configured bearer token, and falls back to embedded mock data so
 * the built artifact renders standalone with no server.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist");
const outFile = resolve(distDir, "index.html");

// Mock data mirrors the server DTO shapes (see packages/server/src/api).
const MOCK = {
  jobs: [
    {
      id: "job_1",
      engine: "claude-code",
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
      .layout { display: flex; min-height: calc(100vh - 49px); }
      nav { width: 160px; background: #11151c; border-right: 1px solid #2a2f3a; padding: 14px 0; flex-shrink: 0; }
      nav a { display: block; padding: 10px 20px; color: #8b95a5; text-decoration: none; font-size: 14px; border-left: 3px solid transparent; }
      nav a:hover { background: #161a22; color: #e6e6e6; }
      nav a.active { color: #fff; border-left-color: #1f6feb; background: #161a22; }
      main { padding: 20px; flex: 1; max-width: 1100px; }
      .view { display: none; }
      .view.active { display: block; }
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
      fieldset { border: 1px solid #232833; border-radius: 8px; padding: 14px; max-width: 520px; }
      fieldset form { flex-direction: column; align-items: stretch; }
      fieldset label { font-size: 12px; color: #8b95a5; display: block; margin-bottom: 2px; }
      fieldset .field { margin-bottom: 10px; }
      fieldset input, fieldset select { width: 100%; box-sizing: border-box; }
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
    <div class="layout">
      <nav>
        <a href="#dashboard" data-view="dashboard">Dashboard</a>
        <a href="#new" data-view="new">New task</a>
        <a href="#schedules" data-view="schedules">Scheduled scans</a>
      </nav>
      <main>
        <div class="view" id="view-dashboard">
          <section id="jobs"><h2>Review tasks</h2><div data-loading>Loading…</div></section>
          <section id="detail"></section>
        </div>
        <div class="view" id="view-schedules">
          <section id="schedules"><h2>Scheduled scans</h2><div data-loading>Loading…</div></section>
          <section>
            <h2>New scheduled scan</h2>
            <fieldset>
              <legend>Daily scan → Feishu</legend>
              <form id="schedule-form">
                <div class="field">
                  <label>Name</label>
                  <input name="name" placeholder="nightly review" required />
                </div>
                <div class="field">
                  <label>Platform</label>
                  <select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select>
                </div>
                <div class="field">
                  <label>Repository (owner/repo)</label>
                  <input name="repoFullName" placeholder="owner/repo" required />
                </div>
                <div class="field">
                  <label>Branches (comma-separated; blank = all branches)</label>
                  <input name="branches" placeholder="main, develop" />
                </div>
                <div class="field">
                  <label>Time of day (HH:MM, 24h)</label>
                  <input name="timeOfDay" placeholder="02:00" required />
                </div>
                <div class="field">
                  <label>Timezone (IANA)</label>
                  <input name="timezone" value="Asia/Shanghai" />
                </div>
                <div class="field">
                  <label>Engine (optional)</label>
                  <select name="engine"><option value="">(server default)</option>${ENGINES.map((e) => `<option>${e}</option>`).join("")}</select>
                </div>
                <div class="field">
                  <label>Feishu webhook URL</label>
                  <input name="webhookUrl" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" required />
                </div>
                <button type="submit">Create schedule</button>
              </form>
              <p class="muted" id="schedule-result"></p>
            </fieldset>
          </section>
        </div>
        <div class="view" id="view-new">
          <section>
            <h2>New review task</h2>
            <fieldset>
              <legend>Review a pull request</legend>
              <form id="task-form">
                <div class="field">
                  <label>Platform</label>
                  <select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select>
                </div>
                <div class="field">
                  <label>Repository (owner/repo)</label>
                  <input name="repoFullName" placeholder="owner/repo" required />
                </div>
                <div class="field">
                  <label>Clone URL (optional — derived from repo when blank)</label>
                  <input name="cloneUrl" placeholder="https://github.com/owner/repo.git" />
                </div>
                <div class="field">
                  <label>Pull request number</label>
                  <input name="prNumber" type="number" min="1" placeholder="123" required />
                </div>
                <div class="field">
                  <label>Engine (optional)</label>
                  <select name="engine"><option value="">(server default)</option>${ENGINES.map((e) => `<option>${e}</option>`).join("")}</select>
                </div>
                <button type="submit">Start review</button>
              </form>
              <p class="muted" id="task-result"></p>
            </fieldset>
          </section>
        </div>
      </main>
    </div>
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
        if (!res.ok) {
          let detail = "";
          try { detail = (await res.json()).error || ""; } catch {}
          throw new Error("HTTP " + res.status + (detail ? ": " + detail : "") + " for " + path);
        }
        return res.status === 204 ? null : res.json();
      }
      async function load(path, fallback) {
        try { return await api(path); } catch { return fallback; }
      }

      // --- view routing (sidebar + hash) ---
      function showView(name) {
        const view = ["new", "schedules"].includes(name) ? name : "dashboard";
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
        document.getElementById("view-" + view)?.classList.add("active");
        document.querySelectorAll("nav a").forEach((a) =>
          a.classList.toggle("active", a.getAttribute("data-view") === view));
      }
      window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

      function renderJobs(jobs) {
        const rows = jobs.map((j) => {
          const pr = j.pullRequest || {};
          const findings = (j.findings || []).length;
          return \`<tr class="clickable" data-job="\${esc(j.id)}"><td>#\${esc(pr.number ?? "?")} \${esc(pr.title ?? "")}</td><td>\${esc(j.engine)}</td><td><span class="status \${esc(j.status)}">\${esc(j.status)}</span></td><td><div class="bar"><i style="width:\${Number(j.progress)||0}%"></i></div></td><td>\${findings} finding(s)</td></tr>\`;
        }).join("");
        document.querySelector("#jobs").innerHTML =
          \`<h2>Review tasks</h2>\` +
          (jobs.length
            ? \`<table><thead><tr><th>Pull request</th><th>Engine</th><th>Status</th><th>Progress</th><th>Findings</th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">No review tasks yet. Create one from <a href="#new" style="color:#4c8bf5">New task</a> or via POST /api/tasks.</p>\`);
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
          \`<h2>Task \${esc(job.id)} \${retry}</h2>\` +
          \`<p class="muted">engine \${esc(job.engine)} · status \${esc(job.status)} · progress \${Number(job.progress)||0}%\${job.error ? " · error: " + esc(job.error) : ""}</p>\` +
          \`<h3>Findings (\${(job.findings||[]).length})</h3><ul>\${findings || "<li class='muted'>none</li>"}</ul>\` +
          \`<h3>Logs</h3><pre>\${(job.logs||[]).map(esc).join("\\n") || "(none)"}</pre>\`;
        const rb = document.getElementById("retry");
        if (rb) rb.onclick = async () => {
          try { await api("/api/jobs/" + id + "/retry", { method: "POST" }); refresh(); }
          catch (e) { alert(e.message); }
        };
      }

      document.getElementById("task-form").onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const out = document.getElementById("task-result");
        const btn = f.querySelector('button[type="submit"]');
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = "Starting…"; out.textContent = "";
        try {
          const payload = {
            platform: f.platform.value,
            repoFullName: f.repoFullName.value,
            prNumber: Number(f.prNumber.value),
          };
          if (f.cloneUrl.value) payload.cloneUrl = f.cloneUrl.value;
          if (f.engine.value) payload.engine = f.engine.value;
          const res = await api("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          out.textContent = "✓ Task " + res.taskId + " (" + res.status + "). Switching to Dashboard…";
          f.reset();
          await refresh();
          setTimeout(() => { location.hash = "#dashboard"; }, 800);
        } catch (e) { out.textContent = "✗ " + e.message; }
        finally { btn.disabled = false; btn.textContent = label; }
      };

      function renderSchedules(schedules) {
        const rows = schedules.map((s) => {
          const branches = (s.branches && s.branches.length) ? s.branches.join(", ") : "(all)";
          return \`<tr>
            <td>\${esc(s.name)}\${s.enabled ? "" : ' <span class="muted">(disabled)</span>'}</td>
            <td><code>\${esc(s.repoFullName)}</code></td>
            <td>\${esc(branches)}</td>
            <td>\${esc(s.timeOfDay)} \${esc(s.timezone)}</td>
            <td>\${esc(s.delivery && s.delivery.type || "")}</td>
            <td class="muted">\${esc(s.lastResult || "—")}</td>
            <td>
              <button class="secondary" data-run="\${esc(s.id)}">Run now</button>
              <button class="secondary" data-toggle="\${esc(s.id)}" data-enabled="\${s.enabled}">\${s.enabled ? "Disable" : "Enable"}</button>
              <button class="secondary" data-del="\${esc(s.id)}">Delete</button>
            </td>
          </tr>\`;
        }).join("");
        document.querySelector("#schedules").innerHTML =
          \`<h2>Scheduled scans</h2>\` +
          (schedules.length
            ? \`<table><thead><tr><th>Name</th><th>Repository</th><th>Branches</th><th>Time</th><th>Deliver</th><th>Last result</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">No scheduled scans. The daily scheduler runs only when at least one is configured.</p>\`);
        document.querySelectorAll('#schedules [data-run]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true; b.textContent = "Running…";
            try { await api("/api/schedules/" + b.getAttribute("data-run") + "/run", { method: "POST" }); await refresh(); }
            catch (e) { alert(e.message); b.disabled = false; b.textContent = "Run now"; }
          };
        });
        document.querySelectorAll('#schedules [data-toggle]').forEach((b) => {
          b.onclick = async () => {
            try {
              await api("/api/schedules/" + b.getAttribute("data-toggle"), {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled: b.getAttribute("data-enabled") !== "true" }),
              });
              await refresh();
            } catch (e) { alert(e.message); }
          };
        });
        document.querySelectorAll('#schedules [data-del]').forEach((b) => {
          b.onclick = async () => {
            if (!confirm("Delete this schedule?")) return;
            try { await api("/api/schedules/" + b.getAttribute("data-del"), { method: "DELETE" }); await refresh(); }
            catch (e) { alert(e.message); }
          };
        });
      }

      document.getElementById("schedule-form").onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const out = document.getElementById("schedule-result");
        const btn = f.querySelector('button[type="submit"]');
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = "Creating…"; out.textContent = "";
        try {
          const payload = {
            name: f.name.value,
            platform: f.platform.value,
            repoFullName: f.repoFullName.value,
            branches: f.branches.value.split(",").map((s) => s.trim()).filter(Boolean),
            timeOfDay: f.timeOfDay.value,
            timezone: f.timezone.value || "UTC",
            delivery: { type: "feishu", webhookUrl: f.webhookUrl.value },
          };
          if (f.engine.value) payload.engine = f.engine.value;
          await api("/api/schedules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          out.textContent = "✓ Schedule created.";
          f.reset(); f.timezone.value = "Asia/Shanghai";
          await refresh();
        } catch (e) { out.textContent = "✗ " + e.message; }
        finally { btn.disabled = false; btn.textContent = label; }
      };

      async function refresh() {
        renderJobs(await load("/api/jobs", MOCK.jobs));
        renderSchedules(await load("/api/schedules", []));
      }

      showView(location.hash.slice(1));
      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>
`;

await mkdir(distDir, { recursive: true });
await writeFile(outFile, html, "utf8");
process.stdout.write(`web: wrote ${outFile}\n`);
