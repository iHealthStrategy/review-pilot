import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the task-driven Web UI. Emits a single static `dist/index.html` with a
 * login/register gate, then a left sidebar switching views:
 *   - Scheduled scans (default): the daily-scan schedules list; "+ New scheduled
 *     scan" opens a modal form.
 *   - Dashboard: the review tasks (jobs) list + detail.
 *   - Account: the signed-in user's personal access tokens (for API/automation).
 *   - Users (admins only): list users and change their role.
 * It hydrates from the server REST API at runtime, authenticating with a session
 * token obtained at login (sent as `Authorization: Bearer <jwt>`). Write actions
 * are hidden for read-only (viewer) accounts.
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
      .view-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      .view-head h2 { margin: 0; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #232833; font-size: 14px; }
      tr.clickable { cursor: pointer; }
      tr.clickable:hover { background: #161a22; }
      .status { padding: 2px 8px; border-radius: 10px; font-size: 12px; }
      .succeeded { background: #16391f; color: #6ee787; }
      .running { background: #3a3416; color: #e7d56e; }
      .failed { background: #3a1616; color: #e76e6e; }
      .pending { background: #232833; color: #8b95a5; }
      .role-admin { background: #3a2a16; color: #e7a16e; }
      .role-member { background: #16391f; color: #6ee787; }
      .role-viewer { background: #232833; color: #8b95a5; }
      .bar { background: #232833; border-radius: 6px; height: 8px; width: 120px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: #4c8bf5; }
      input, select, button, textarea { background: #11151c; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 6px; padding: 6px 8px; font-size: 13px; font-family: inherit; }
      button { cursor: pointer; background: #1f6feb; border-color: #1f6feb; color: #fff; }
      button.secondary { background: #232833; border-color: #2a2f3a; }
      .sev { font-weight: 600; }
      .sev-critical { color: #e76e6e; } .sev-major { color: #e7a16e; }
      .sev-minor { color: #e7d56e; } .sev-info { color: #8b95a5; }
      pre { background: #11151c; border: 1px solid #232833; border-radius: 6px; padding: 10px; overflow: auto; font-size: 12px; }
      code { word-break: break-all; }
      #detail { margin-top: 12px; }
      .muted { color: #8b95a5; font-size: 12px; }
      .token { display: flex; gap: 10px; align-items: center; }
      /* Modal dialog */
      .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: flex-start; justify-content: center; z-index: 100; overflow-y: auto; padding: 40px 16px; box-sizing: border-box; }
      .modal-overlay.open { display: flex; }
      .modal { background: #161a22; border: 1px solid #2a2f3a; border-radius: 10px; padding: 18px 20px; width: 560px; max-width: 100%; }
      .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .modal-head h2 { margin: 0; }
      .modal .close { background: transparent; border: none; color: #8b95a5; font-size: 20px; cursor: pointer; padding: 0 6px; }
      .modal form { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
      .modal label { font-size: 12px; color: #8b95a5; display: block; margin-bottom: 2px; }
      .modal .field { margin-bottom: 10px; }
      .modal input, .modal select, .modal textarea { width: 100%; box-sizing: border-box; }
      .modal .result { margin: 8px 0 0; }
      /* Auth gate */
      .auth-gate { position: fixed; inset: 0; background: #0f1115; display: none; align-items: center; justify-content: center; z-index: 200; }
      .auth-gate.open { display: flex; }
      .auth-card { width: 360px; background: #161a22; border: 1px solid #2a2f3a; border-radius: 10px; padding: 24px; }
      .auth-card h2 { text-transform: none; color: #e6e6e6; font-size: 20px; margin: 0 0 16px; }
      .auth-card .field { margin-bottom: 12px; }
      .auth-card label { font-size: 12px; color: #8b95a5; display: block; margin-bottom: 4px; }
      .auth-card input { width: 100%; box-sizing: border-box; }
      .auth-card button { width: 100%; margin-top: 4px; }
    </style>
  </head>
  <body>
    <header>
      <h1>🤖 ReviewPilot — continuous code review</h1>
      <div class="token" id="userbar" style="display:none">
        <span class="muted" id="user-email"></span>
        <span class="status" id="user-role"></span>
        <button class="secondary" id="logout">Logout</button>
      </div>
    </header>
    <div class="layout">
      <nav>
        <a href="#schedules" data-view="schedules">Scheduled scans</a>
        <a href="#dashboard" data-view="dashboard">Dashboard</a>
        <a href="#account" data-view="account">Account</a>
        <a href="#users" data-view="users" id="nav-users" style="display:none">Users</a>
      </nav>
      <main>
        <div class="view" id="view-schedules">
          <div class="view-head">
            <h2>Scheduled scans</h2>
            <button id="open-schedule-modal">+ New scheduled scan</button>
          </div>
          <section id="schedules"><div data-loading>Loading…</div></section>
        </div>
        <div class="view" id="view-dashboard">
          <div class="view-head">
            <h2>Review tasks</h2>
            <button id="open-task-modal">+ New task</button>
          </div>
          <section id="jobs"><div data-loading>Loading…</div></section>
          <section id="detail"></section>
        </div>
        <div class="view" id="view-account">
          <div class="view-head">
            <h2>Personal access tokens</h2>
            <button id="open-token-modal">+ New token</button>
          </div>
          <section id="tokens"><div data-loading>Loading…</div></section>
        </div>
        <div class="view" id="view-users">
          <div class="view-head"><h2>Users</h2></div>
          <section id="users"><div data-loading>Loading…</div></section>
        </div>
      </main>
    </div>

    <!-- Login / register gate -->
    <div class="auth-gate" id="auth-gate">
      <div class="auth-card">
        <h2 id="auth-title">Sign in</h2>
        <form id="auth-form">
          <div class="field"><label>Email</label><input type="email" id="auth-email" autocomplete="username" required /></div>
          <div class="field"><label>Password (min 8 chars)</label><input type="password" id="auth-password" autocomplete="current-password" minlength="8" required /></div>
          <button type="submit" id="auth-submit">Sign in</button>
          <p class="muted result" id="auth-result"></p>
          <p class="muted"><span id="auth-switch-text">No account?</span> <a href="#" id="auth-switch" style="color:#4c8bf5">Register</a></p>
        </form>
      </div>
    </div>

    <!-- New scheduled scan modal -->
    <div class="modal-overlay" id="schedule-modal" data-modal>
      <div class="modal">
        <div class="modal-head"><h2>New scheduled scan</h2><button class="close" data-close>×</button></div>
        <form id="schedule-form">
          <div class="field"><label>Name</label><input name="name" placeholder="nightly review" required /></div>
          <div class="field"><label>Platform</label><select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select></div>
          <div class="field"><label>Repository (owner/repo)</label><input name="repoFullName" placeholder="owner/repo" required /></div>
          <div class="field"><label>Branches (comma-separated; blank = all branches)</label><input name="branches" placeholder="main, develop" /></div>
          <div class="field"><label>Time of day (HH:MM, 24h)</label><input name="timeOfDay" placeholder="02:00" required /></div>
          <div class="field"><label>Timezone (IANA)</label><input name="timezone" value="Asia/Shanghai" /></div>
          <div class="field"><label>Lookback hours (how far back to scan commits; default 24)</label><input name="lookbackHours" type="number" min="1" placeholder="24" /></div>
          <div class="field"><label>Review focus / 备注 (optional — what the review should emphasise)</label><textarea name="reviewFocus" rows="3" placeholder="例如：重点关注并发安全、SQL 注入、接口兼容性"></textarea></div>
          <div class="field"><label>Engine (optional)</label><select name="engine"><option value="">(server default)</option>${ENGINES.map((e) => `<option>${e}</option>`).join("")}</select></div>
          <div class="field"><label>Feishu webhook URL (blank = use server default FEISHU_WEBHOOK_URL)</label><input name="webhookUrl" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" /></div>
          <button type="submit">Create schedule</button>
          <p class="muted result" id="schedule-result"></p>
        </form>
      </div>
    </div>

    <!-- New review task modal -->
    <div class="modal-overlay" id="task-modal" data-modal>
      <div class="modal">
        <div class="modal-head"><h2>New review task</h2><button class="close" data-close>×</button></div>
        <form id="task-form">
          <div class="field"><label>Platform</label><select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select></div>
          <div class="field"><label>Repository (owner/repo)</label><input name="repoFullName" placeholder="owner/repo" required /></div>
          <div class="field"><label>Clone URL (optional — derived from repo when blank)</label><input name="cloneUrl" placeholder="https://github.com/owner/repo.git" /></div>
          <div class="field"><label>Pull request number</label><input name="prNumber" type="number" min="1" placeholder="123" required /></div>
          <div class="field"><label>Engine (optional)</label><select name="engine"><option value="">(server default)</option>${ENGINES.map((e) => `<option>${e}</option>`).join("")}</select></div>
          <button type="submit">Start review</button>
          <p class="muted result" id="task-result"></p>
        </form>
      </div>
    </div>

    <!-- New personal access token modal -->
    <div class="modal-overlay" id="token-modal" data-modal>
      <div class="modal">
        <div class="modal-head"><h2>New personal access token</h2><button class="close" data-close>×</button></div>
        <form id="token-form">
          <div class="field"><label>Name</label><input name="name" placeholder="ci / my-laptop" required /></div>
          <button type="submit">Create token</button>
          <p class="muted result" id="token-result"></p>
        </form>
      </div>
    </div>

    <!-- Scheduled-scan result detail modal -->
    <div class="modal-overlay" id="scan-modal" data-modal>
      <div class="modal" style="width:780px">
        <div class="modal-head"><h2 id="scan-modal-title">Scan result</h2><button class="close" data-close>×</button></div>
        <div id="scan-modal-body"></div>
      </div>
    </div>

    <script id="mock-data" type="application/json">${JSON.stringify(MOCK)}</script>
    <script>
      const MOCK = JSON.parse(document.getElementById("mock-data").textContent);
      const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

      // --- session auth: JWT in localStorage, sent as Bearer header ---
      let me = null;
      function token() { return localStorage.getItem("rp_session") || ""; }
      function setToken(t) { if (t) localStorage.setItem("rp_session", t); else localStorage.removeItem("rp_session"); }
      function canWrite() { return me && (me.role === "member" || me.role === "admin"); }
      function isAdmin() { return me && me.role === "admin"; }
      function headers(extra) {
        const h = Object.assign({}, extra || {});
        const t = token();
        if (t) h["Authorization"] = "Bearer " + t;
        return h;
      }
      async function api(path, opts) {
        const o = Object.assign({}, opts || {});
        o.headers = headers(o.headers);
        const res = await fetch(path, o);
        if (res.status === 401) { setToken(""); me = null; applyMe(); showAuth(); throw new Error("unauthorized"); }
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

      // --- auth gate (login / register) ---
      const gate = document.getElementById("auth-gate");
      let authMode = "login";
      function showAuth() { gate.classList.add("open"); }
      function hideAuth() { gate.classList.remove("open"); }
      function setAuthMode(m) {
        authMode = m;
        document.getElementById("auth-title").textContent = m === "login" ? "Sign in" : "Create account";
        document.getElementById("auth-submit").textContent = m === "login" ? "Sign in" : "Register";
        document.getElementById("auth-switch-text").textContent = m === "login" ? "No account?" : "Have an account?";
        document.getElementById("auth-switch").textContent = m === "login" ? "Register" : "Sign in";
        document.getElementById("auth-result").textContent = "";
      }
      document.getElementById("auth-switch").onclick = (e) => {
        e.preventDefault();
        setAuthMode(authMode === "login" ? "register" : "login");
      };
      document.getElementById("auth-form").onsubmit = async (e) => {
        e.preventDefault();
        const email = document.getElementById("auth-email").value.trim();
        const password = document.getElementById("auth-password").value;
        const out = document.getElementById("auth-result");
        out.textContent = "";
        try {
          const res = await fetch("/api/auth/" + (authMode === "login" ? "login" : "register"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
          setToken(data.token);
          me = data.user;
          hideAuth();
          applyMe();
          showView(location.hash.slice(1));
          refresh();
        } catch (err) { out.textContent = "✗ " + err.message; }
      };
      document.getElementById("logout").onclick = () => {
        setToken(""); me = null; applyMe(); showAuth();
      };

      // Reflect the signed-in user: header badge, admin-only nav, write controls.
      function applyMe() {
        const bar = document.getElementById("userbar");
        if (me) {
          bar.style.display = "";
          document.getElementById("user-email").textContent = me.email;
          const rb = document.getElementById("user-role");
          rb.textContent = me.role;
          rb.className = "status role-" + me.role;
          document.getElementById("nav-users").style.display = isAdmin() ? "" : "none";
          document.getElementById("open-schedule-modal").style.display = canWrite() ? "" : "none";
          document.getElementById("open-task-modal").style.display = canWrite() ? "" : "none";
        } else {
          bar.style.display = "none";
        }
      }

      // --- modal helpers ---
      function openModal(id) { document.getElementById(id).classList.add("open"); }
      function closeModal(id) { document.getElementById(id).classList.remove("open"); }
      document.getElementById("open-schedule-modal").onclick = () => openModal("schedule-modal");
      document.getElementById("open-task-modal").onclick = () => openModal("task-modal");
      document.getElementById("open-token-modal").onclick = () => {
        document.getElementById("token-result").textContent = "";
        openModal("token-modal");
      };
      document.querySelectorAll("[data-modal]").forEach((ov) => {
        ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.remove("open"); });
        ov.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => ov.classList.remove("open")));
      });

      // --- view routing (sidebar + hash) ---
      function showView(name) {
        const valid = ["schedules", "dashboard", "account", "users"];
        const view = valid.includes(name) ? name : "schedules";
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
        document.getElementById("view-" + view)?.classList.add("active");
        document.querySelectorAll("nav a").forEach((a) =>
          a.classList.toggle("active", a.getAttribute("data-view") === view));
        if (view === "account") renderTokens();
        if (view === "users") renderUsers();
      }
      window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

      function renderJobs(jobs) {
        const rows = jobs.map((j) => {
          const pr = j.pullRequest || {};
          const findings = (j.findings || []).length;
          return \`<tr class="clickable" data-job="\${esc(j.id)}"><td>#\${esc(pr.number ?? "?")} \${esc(pr.title ?? "")}</td><td>\${esc(j.engine)}</td><td><span class="status \${esc(j.status)}">\${esc(j.status)}</span></td><td><div class="bar"><i style="width:\${Number(j.progress)||0}%"></i></div></td><td>\${findings} finding(s)</td></tr>\`;
        }).join("");
        document.querySelector("#jobs").innerHTML =
          jobs.length
            ? \`<table><thead><tr><th>Pull request</th><th>Engine</th><th>Status</th><th>Progress</th><th>Findings</th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">No review tasks yet.\${canWrite() ? " Use <b>+ New task</b> above, or POST /api/tasks." : ""}</p>\`;
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
        const retry = (job.status === "failed" && canWrite()) ? \`<button id="retry">Retry job</button>\` : "";
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
          await api("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          f.reset();
          closeModal("task-modal");
          await refresh();
        } catch (e) { out.textContent = "✗ " + e.message; }
        finally { btn.disabled = false; btn.textContent = label; }
      };

      function renderSchedules(schedules) {
        const rows = schedules.map((s) => {
          const branches = (s.branches && s.branches.length) ? s.branches.join(", ") : "(all)";
          const status = s.running
            ? '<span class="status running">⏳ running</span>'
            : esc(s.lastResult || "—");
          const writeActions = canWrite() ? \`
              <button class="secondary" data-run="\${esc(s.id)}"\${s.running ? " disabled" : ""}>\${s.running ? "Running…" : "Run now"}</button>
              <button class="secondary" data-toggle="\${esc(s.id)}" data-enabled="\${s.enabled}">\${s.enabled ? "Disable" : "Enable"}</button>
              <button class="secondary" data-del="\${esc(s.id)}">Delete</button>\` : "";
          return \`<tr>
            <td>\${esc(s.name)}\${s.enabled ? "" : ' <span class="muted">(disabled)</span>'}</td>
            <td><code>\${esc(s.repoFullName)}</code></td>
            <td>\${esc(branches)}</td>
            <td>\${esc(s.timeOfDay)} \${esc(s.timezone)}</td>
            <td>\${esc(s.delivery && s.delivery.type || "")}</td>
            <td class="muted">\${status}</td>
            <td>
              <button class="secondary" data-view-id="\${esc(s.id)}">View</button>\${writeActions}
            </td>
          </tr>\`;
        }).join("");
        document.querySelector("#schedules").innerHTML =
          schedules.length
            ? \`<table><thead><tr><th>Name</th><th>Repository</th><th>Branches</th><th>Time</th><th>Deliver</th><th>Last result</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">No scheduled scans.\${canWrite() ? " Use <b>+ New scheduled scan</b> above." : ""} The daily scheduler runs only when at least one is configured.</p>\`;
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
        document.querySelectorAll('#schedules [data-view-id]').forEach((b) => {
          b.onclick = () => showScanDetail(b.getAttribute("data-view-id"));
        });
      }

      async function showScanDetail(id) {
        const s = await load("/api/schedules/" + id, null);
        const body = document.getElementById("scan-modal-body");
        document.getElementById("scan-modal-title").textContent =
          "Scan result · " + (s ? s.name : id);
        if (!s || !s.lastScan) {
          body.innerHTML = '<p class="muted">尚无扫描结果（还没成功跑过一次）。</p>';
          openModal("scan-modal");
          return;
        }
        const r = s.lastScan;
        const head = \`<p class="muted">\${esc(r.repoFullName)} · \${esc(r.date)} · 共 \${r.totalFindings} 个问题，\${r.branches.length} 个分支</p>\`;
        const sections = (r.branches || []).map((b) => {
          if (b.error) {
            return \`<h3>\${esc(b.branch)} <span class="muted">(\${b.commitCount} commits)</span> — <span class="sev sev-major">⚠️ 评审失败</span></h3><pre>\${esc(b.error)}</pre>\`;
          }
          const items = (b.findings || []).map((f) =>
            \`<li><span class="sev sev-\${esc(f.severity)}">[\${esc(f.severity)}]</span> <code>\${esc(f.filePath)}\${f.line ? ":" + esc(f.line) : ""}</code> — <b>\${esc(f.title)}</b><br/><span class="muted">\${esc(f.detail || "")}</span>\${f.suggestion ? "<br/>💡 " + esc(f.suggestion) : ""}</li>\`
          ).join("");
          return \`<h3>\${esc(b.branch)} <span class="muted">(\${b.commitCount} commits)</span> — \${(b.findings||[]).length} 个问题</h3><ul>\${items || "<li class='muted'>无</li>"}</ul>\`;
        }).join("");
        body.innerHTML = head + (sections || '<p class="muted">今日无改动。</p>');
        openModal("scan-modal");
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
          if (f.lookbackHours.value) payload.lookbackHours = Number(f.lookbackHours.value);
          if (f.reviewFocus.value.trim()) payload.reviewFocus = f.reviewFocus.value.trim();
          if (f.engine.value) payload.engine = f.engine.value;
          await api("/api/schedules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          f.reset(); f.timezone.value = "Asia/Shanghai";
          closeModal("schedule-modal");
          await refresh();
        } catch (e) { out.textContent = "✗ " + e.message; }
        finally { btn.disabled = false; btn.textContent = label; }
      };

      // --- Account: personal access tokens ---
      async function renderTokens() {
        const tokens = await load("/api/tokens", []);
        const rows = tokens.map((t) =>
          \`<tr><td>\${esc(t.name)}</td><td><code>\${esc(t.prefix)}…</code></td><td class="muted">\${esc(t.lastUsedAt || "never used")}</td><td><button class="secondary" data-revoke="\${esc(t.id)}">Revoke</button></td></tr>\`
        ).join("");
        document.querySelector("#tokens").innerHTML =
          tokens.length
            ? \`<table><thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">No tokens yet. Create one to call the API as yourself — send it as <code>Authorization: Bearer rpat_…</code>.</p>\`;
        document.querySelectorAll('#tokens [data-revoke]').forEach((b) => {
          b.onclick = async () => {
            if (!confirm("Revoke this token? Anything using it will stop working.")) return;
            try { await api("/api/tokens/" + b.getAttribute("data-revoke"), { method: "DELETE" }); renderTokens(); }
            catch (e) { alert(e.message); }
          };
        });
      }

      document.getElementById("token-form").onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const out = document.getElementById("token-result");
        const btn = f.querySelector('button[type="submit"]');
        btn.disabled = true; out.textContent = "";
        try {
          const r = await api("/api/tokens", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: f.name.value }),
          });
          out.innerHTML = "✓ Copy now — shown only once:<br/><code>" + esc(r.token) + "</code>";
          f.reset();
          renderTokens();
        } catch (e) { out.textContent = "✗ " + e.message; }
        finally { btn.disabled = false; }
      };

      // --- Users (admin only) ---
      async function renderUsers() {
        if (!isAdmin()) { document.querySelector("#users").innerHTML = '<p class="muted">Admins only.</p>'; return; }
        const users = await load("/api/users", []);
        const roleOpts = (sel) => ["viewer", "member", "admin"]
          .map((r) => \`<option value="\${r}"\${r === sel ? " selected" : ""}>\${r}</option>\`).join("");
        const rows = users.map((u) =>
          \`<tr><td>\${esc(u.email)}</td><td><select data-role-for="\${esc(u.id)}">\${roleOpts(u.role)}</select></td><td class="muted">\${esc(u.createdAt)}</td></tr>\`
        ).join("");
        document.querySelector("#users").innerHTML =
          \`<table><thead><tr><th>Email</th><th>Role</th><th>Created</th></tr></thead><tbody>\${rows}</tbody></table>\`;
        document.querySelectorAll('#users [data-role-for]').forEach((sel) => {
          sel.onchange = async () => {
            try {
              await api("/api/users/" + sel.getAttribute("data-role-for") + "/role", {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: sel.value }),
              });
            } catch (e) { alert(e.message); renderUsers(); }
          };
        });
      }

      async function refresh() {
        if (!me) return;
        renderSchedules(await load("/api/schedules", []));
        renderJobs(await load("/api/jobs", MOCK.jobs));
      }

      async function init() {
        setAuthMode("login");
        if (token()) {
          try { me = (await api("/api/auth/me")).user; } catch { me = null; }
        }
        applyMe();
        if (me) {
          hideAuth();
          showView(location.hash.slice(1));
          refresh();
        } else {
          showAuth();
        }
      }
      init();
      setInterval(() => { if (me) refresh(); }, 5000);
    </script>
  </body>
</html>
`;

await mkdir(distDir, { recursive: true });
await writeFile(outFile, html, "utf8");
process.stdout.write(`web: wrote ${outFile}\n`);
