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
      .active-bucket { background: #1f6feb; border-color: #1f6feb; color: #fff; }
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
      <h1>🤖 ReviewPilot — 持续代码评审</h1>
      <div class="token" id="userbar" style="display:none">
        <span class="muted" id="user-email"></span>
        <span class="status" id="user-role"></span>
        <button class="secondary" id="logout">退出登录</button>
      </div>
    </header>
    <div class="layout">
      <nav>
        <a href="#schedules" data-view="schedules">定时扫描</a>
        <a href="#dashboard" data-view="dashboard">仪表盘</a>
        <a href="#account" data-view="account">账户</a>
        <a href="#usage" data-view="usage">Token 用量</a>
        <a href="#integrations" data-view="integrations">API 与 MCP</a>
        <a href="#users" data-view="users" id="nav-users" style="display:none">用户管理</a>
      </nav>
      <main>
        <div class="view" id="view-schedules">
          <div class="view-head">
            <h2>定时扫描</h2>
            <button id="open-schedule-modal">+ 新建定时扫描</button>
          </div>
          <section id="schedules"><div data-loading>加载中…</div></section>
        </div>
        <div class="view" id="view-dashboard">
          <div class="view-head">
            <h2>评审任务</h2>
            <button id="open-task-modal">+ 新建任务</button>
          </div>
          <section id="jobs"><div data-loading>加载中…</div></section>
          <section id="detail"></section>
        </div>
        <div class="view" id="view-account">
          <div class="view-head">
            <h2>个人访问令牌</h2>
            <button id="open-token-modal">+ 新建令牌</button>
          </div>
          <section id="tokens"><div data-loading>加载中…</div></section>
        </div>
        <div class="view" id="view-usage">
          <div class="view-head">
            <h2>Token 用量</h2>
            <div id="usage-buckets">
              <button class="secondary" data-bucket="day">日</button>
              <button class="secondary" data-bucket="week">周</button>
              <button class="secondary" data-bucket="month">月</button>
            </div>
          </div>
          <section id="usage"><div data-loading>加载中…</div></section>
        </div>
        <div class="view" id="view-integrations">
          <div class="view-head"><h2>API &amp; MCP 接入说明</h2></div>
          <section id="integrations"></section>
        </div>
        <div class="view" id="view-users">
          <div class="view-head"><h2>用户管理</h2></div>
          <section id="users"><div data-loading>加载中…</div></section>
        </div>
      </main>
    </div>

    <!-- Login / register gate -->
    <div class="auth-gate" id="auth-gate">
      <div class="auth-card">
        <h2 id="auth-title">登录</h2>
        <form id="auth-form">
          <div class="field"><label>邮箱</label><input type="email" id="auth-email" autocomplete="username" required /></div>
          <div class="field"><label>密码(至少 8 位)</label><input type="password" id="auth-password" autocomplete="current-password" minlength="8" required /></div>
          <button type="submit" id="auth-submit">登录</button>
          <p class="muted result" id="auth-result"></p>
          <p class="muted"><span id="auth-switch-text">还没有账户?</span> <a href="#" id="auth-switch" style="color:#4c8bf5">注册</a></p>
        </form>
      </div>
    </div>

    <!-- New scheduled scan modal -->
    <div class="modal-overlay" id="schedule-modal" data-modal>
      <div class="modal">
        <div class="modal-head"><h2>新建定时扫描</h2><button class="close" data-close>×</button></div>
        <form id="schedule-form">
          <div class="field"><label>名称</label><input name="name" placeholder="每日评审" required /></div>
          <div class="field"><label>平台</label><select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select></div>
          <div class="field"><label>仓库(owner/repo)</label><input name="repoFullName" placeholder="owner/repo" required /></div>
          <div class="field"><label>分支(逗号分隔;留空 = 全部分支)</label><input name="branches" placeholder="main, develop" /></div>
          <div class="field"><label>执行时间(HH:MM,24 小时制)</label><input name="timeOfDay" placeholder="02:00" required /></div>
          <div class="field"><label>时区(IANA)</label><input name="timezone" value="Asia/Shanghai" /></div>
          <div class="field"><label>回溯小时数(扫描多久以前的提交;默认 24)</label><input name="lookbackHours" type="number" min="1" placeholder="24" /></div>
          <div class="field"><label>评审重点 / 备注(可选 —— 希望评审重点关注什么)</label><textarea name="reviewFocus" rows="3" placeholder="例如：重点关注并发安全、SQL 注入、接口兼容性"></textarea></div>
          <div class="field"><label>引擎(可选)</label><select name="engine"><option value="">(服务端默认)</option>${ENGINES.map((e) => `<option>${e}</option>`).join("")}</select></div>
          <div class="field"><label>飞书 Webhook URL(留空 = 用服务端默认 FEISHU_WEBHOOK_URL)</label><input name="webhookUrl" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" /></div>
          <button type="submit">创建定时扫描</button>
          <p class="muted result" id="schedule-result"></p>
        </form>
      </div>
    </div>

    <!-- New review task modal -->
    <div class="modal-overlay" id="task-modal" data-modal>
      <div class="modal">
        <div class="modal-head"><h2>新建评审任务</h2><button class="close" data-close>×</button></div>
        <form id="task-form">
          <div class="field"><label>平台</label><select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select></div>
          <div class="field"><label>仓库(owner/repo)</label><input name="repoFullName" placeholder="owner/repo" required /></div>
          <div class="field"><label>Clone URL(可选 —— 留空则由仓库推导)</label><input name="cloneUrl" placeholder="https://github.com/owner/repo.git" /></div>
          <div class="field"><label>Pull Request 编号</label><input name="prNumber" type="number" min="1" placeholder="123" required /></div>
          <div class="field"><label>引擎(可选)</label><select name="engine"><option value="">(服务端默认)</option>${ENGINES.map((e) => `<option>${e}</option>`).join("")}</select></div>
          <button type="submit">开始评审</button>
          <p class="muted result" id="task-result"></p>
        </form>
      </div>
    </div>

    <!-- New personal access token modal -->
    <div class="modal-overlay" id="token-modal" data-modal>
      <div class="modal">
        <div class="modal-head"><h2>新建个人访问令牌</h2><button class="close" data-close>×</button></div>
        <form id="token-form">
          <div class="field"><label>名称</label><input name="name" placeholder="ci / my-laptop" required /></div>
          <button type="submit">创建令牌</button>
          <p class="muted result" id="token-result"></p>
        </form>
      </div>
    </div>

    <!-- Scheduled-scan result detail modal -->
    <div class="modal-overlay" id="scan-modal" data-modal>
      <div class="modal" style="width:780px">
        <div class="modal-head"><h2 id="scan-modal-title">扫描结果</h2><button class="close" data-close>×</button></div>
        <div id="scan-modal-body"></div>
      </div>
    </div>

    <script id="mock-data" type="application/json">${JSON.stringify(MOCK)}</script>
    <script>
      const MOCK = JSON.parse(document.getElementById("mock-data").textContent);
      const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

      // --- session auth: JWT in localStorage, sent as Bearer header ---
      let me = null;
      const ROLE_LABEL = { viewer: "游客(只读)", member: "成员(可写)", admin: "管理员" };
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
        document.getElementById("auth-title").textContent = m === "login" ? "登录" : "创建账户";
        document.getElementById("auth-submit").textContent = m === "login" ? "登录" : "注册";
        document.getElementById("auth-switch-text").textContent = m === "login" ? "还没有账户?" : "已有账户?";
        document.getElementById("auth-switch").textContent = m === "login" ? "注册" : "登录";
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
          rb.textContent = ROLE_LABEL[me.role] || me.role;
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
        const valid = ["schedules", "dashboard", "account", "usage", "integrations", "users"];
        const view = valid.includes(name) ? name : "schedules";
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
        document.getElementById("view-" + view)?.classList.add("active");
        document.querySelectorAll("nav a").forEach((a) =>
          a.classList.toggle("active", a.getAttribute("data-view") === view));
        if (view === "account") renderTokens();
        if (view === "users") renderUsers();
        if (view === "integrations") renderIntegrations();
        if (view === "usage") renderUsage();
      }
      window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

      function renderJobs(jobs) {
        const rows = jobs.map((j) => {
          const pr = j.pullRequest || {};
          const findings = (j.findings || []).length;
          return \`<tr class="clickable" data-job="\${esc(j.id)}"><td>#\${esc(pr.number ?? "?")} \${esc(pr.title ?? "")}</td><td>\${esc(j.engine)}</td><td><span class="status \${esc(j.status)}">\${esc(j.status)}</span></td><td><div class="bar"><i style="width:\${Number(j.progress)||0}%"></i></div></td><td>\${findings} 个问题</td></tr>\`;
        }).join("");
        document.querySelector("#jobs").innerHTML =
          jobs.length
            ? \`<table><thead><tr><th>Pull Request</th><th>引擎</th><th>状态</th><th>进度</th><th>问题数</th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">暂无评审任务。\${canWrite() ? "点上方 <b>+ 新建任务</b>,或 POST /api/tasks。" : ""}</p>\`;
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
        const retry = (job.status === "failed" && canWrite()) ? \`<button id="retry">重试任务</button>\` : "";
        el.innerHTML =
          \`<h2>任务 \${esc(job.id)} \${retry}</h2>\` +
          \`<p class="muted">引擎 \${esc(job.engine)} · 状态 \${esc(job.status)} · 进度 \${Number(job.progress)||0}%\${job.error ? " · 错误: " + esc(job.error) : ""}</p>\` +
          \`<h3>问题(\${(job.findings||[]).length})</h3><ul>\${findings || "<li class='muted'>无</li>"}</ul>\` +
          \`<h3>日志</h3><pre>\${(job.logs||[]).map(esc).join("\\n") || "(无)"}</pre>\`;
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
        btn.disabled = true; btn.textContent = "提交中…"; out.textContent = "";
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
          const branches = (s.branches && s.branches.length) ? s.branches.join(", ") : "(全部)";
          const status = s.running
            ? '<span class="status running">⏳ 运行中</span>'
            : esc(s.lastResult || "—");
          const writeActions = canWrite() ? \`
              <button class="secondary" data-run="\${esc(s.id)}"\${s.running ? " disabled" : ""}>\${s.running ? "运行中…" : "立即运行"}</button>
              <button class="secondary" data-toggle="\${esc(s.id)}" data-enabled="\${s.enabled}">\${s.enabled ? "停用" : "启用"}</button>
              <button class="secondary" data-del="\${esc(s.id)}">删除</button>\` : "";
          return \`<tr>
            <td>\${esc(s.name)}\${s.enabled ? "" : ' <span class="muted">(已停用)</span>'}</td>
            <td><code>\${esc(s.repoFullName)}</code></td>
            <td>\${esc(branches)}</td>
            <td>\${esc(s.timeOfDay)} \${esc(s.timezone)}</td>
            <td>\${esc(s.delivery && s.delivery.type || "")}</td>
            <td class="muted">\${status}</td>
            <td>
              <button class="secondary" data-view-id="\${esc(s.id)}">查看</button>\${writeActions}
            </td>
          </tr>\`;
        }).join("");
        document.querySelector("#schedules").innerHTML =
          schedules.length
            ? \`<table><thead><tr><th>名称</th><th>仓库</th><th>分支</th><th>时间</th><th>推送</th><th>上次结果</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">暂无定时扫描。\${canWrite() ? "点上方 <b>+ 新建定时扫描</b>。" : ""}至少配置一个后,每日调度才会运行。</p>\`;
        document.querySelectorAll('#schedules [data-run]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true; b.textContent = "运行中…";
            try { await api("/api/schedules/" + b.getAttribute("data-run") + "/run", { method: "POST" }); await refresh(); }
            catch (e) { alert(e.message); b.disabled = false; b.textContent = "立即运行"; }
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
            if (!confirm("确定删除该定时扫描?")) return;
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
        btn.disabled = true; btn.textContent = "创建中…"; out.textContent = "";
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
          \`<tr><td>\${esc(t.name)}</td><td><code>\${esc(t.prefix)}…</code></td><td class="muted">\${esc(t.lastUsedAt || "从未使用")}</td><td><button class="secondary" data-revoke="\${esc(t.id)}">吊销</button></td></tr>\`
        ).join("");
        document.querySelector("#tokens").innerHTML =
          tokens.length
            ? \`<table><thead><tr><th>名称</th><th>前缀</th><th>上次使用</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">暂无令牌。创建一个即可以你的身份调用 API —— 以 <code>Authorization: Bearer rpat_…</code> 发送。</p>\`;
        document.querySelectorAll('#tokens [data-revoke]').forEach((b) => {
          b.onclick = async () => {
            if (!confirm("确定吊销该令牌?使用它的调用将立即失效。")) return;
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
          out.innerHTML = "✓ 立即复制 —— 仅显示这一次:<br/><code>" + esc(r.token) + "</code>";
          f.reset();
          renderTokens();
        } catch (e) { out.textContent = "✗ " + e.message; }
        finally { btn.disabled = false; }
      };

      // --- Token usage (per configured task; day/week/month) ---
      let usageBucket = "day";
      document.querySelectorAll('#usage-buckets [data-bucket]').forEach((b) => {
        b.onclick = () => { usageBucket = b.getAttribute("data-bucket"); renderUsage(); };
      });
      async function renderUsage() {
        document.querySelectorAll('#usage-buckets [data-bucket]').forEach((b) =>
          b.classList.toggle("active-bucket", b.getAttribute("data-bucket") === usageBucket));
        const data = await load("/api/usage?bucket=" + usageBucket, { rows: [] });
        const rows = data.rows || [];
        const fmt = (n) => Number(n || 0).toLocaleString();
        const section = (title, src) => {
          const list = rows.filter((r) => r.source === src);
          const total = list.reduce((s, r) => s + (r.totalTokens || 0), 0);
          if (!list.length) {
            return \`<h3>\${title} <span class="muted">合计 0 tokens</span></h3><p class="muted">暂无用量数据。</p>\`;
          }
          const trs = list.map((r) =>
            \`<tr><td>\${esc(r.bucket)}</td><td>\${esc(r.sourceLabel)}</td><td>\${fmt(r.inputTokens)}</td><td>\${fmt(r.outputTokens)}</td><td><b>\${fmt(r.totalTokens)}</b></td><td>\${r.runs}</td><td>\${r.estimated ? '<span class="muted">估算</span>' : "实际"}</td></tr>\`
          ).join("");
          return \`<h3>\${title} <span class="muted">合计 \${fmt(total)} tokens</span></h3>
            <table><thead><tr><th>周期</th><th>任务</th><th>输入</th><th>输出</th><th>合计</th><th>次数</th><th>类型</th></tr></thead><tbody>\${trs}</tbody></table>\`;
        };
        document.querySelector("#usage").innerHTML =
          \`<p class="muted">按\${usageBucket === "day" ? "日" : usageBucket === "week" ? "周" : "月"}统计;"估算"为按文本长度近似(引擎未上报真实用量时)。</p>\`
          + section("定时扫描 (schedules)", "schedule")
          + section("临时任务 (tasks)", "task");
      }

      // --- Integrations: API & MCP docs ---
      function renderIntegrations() {
        const o = esc(location.origin);
        document.querySelector("#integrations").innerHTML = \`
          <p class="muted">用你在 <b>Account</b> 页创建的个人访问令牌(<code>rpat_…</code>)调用 REST API 或接入 MCP。令牌继承你的角色:viewer 只读,写操作(新建任务、触发扫描)需 member+(由管理员升级)。令牌只在创建时显示一次。</p>

          <h3>REST API</h3>
          <p class="muted">Base URL <code>\${o}</code> · 认证头 <code>Authorization: Bearer rpat_…</code> · 健康检查 <code>GET /api/health</code> 免鉴权。</p>
          <pre># 触发一次 PR 评审(member+)
curl -X POST \${o}/api/tasks -H "Authorization: Bearer rpat_…" -H "Content-Type: application/json" -d '{"platform":"github","repoFullName":"owner/repo","prNumber":123}'

# 列出定时扫描 / 评审任务(任意已登录用户)
curl \${o}/api/schedules -H "Authorization: Bearer rpat_…"
curl \${o}/api/jobs      -H "Authorization: Bearer rpat_…"</pre>

          <h3>MCP(Model Context Protocol)</h3>
          <p class="muted">Streamable HTTP 端点:<code>POST \${o}/mcp</code>(JSON-RPC 2.0,用同一个 <code>rpat_…</code> 鉴权)。在支持远程 MCP 的客户端(Claude Code、Cursor 等)里配置:</p>
          <pre>{
  "mcpServers": {
    "reviewpilot": {
      "type": "http",
      "url": "\${o}/mcp",
      "headers": { "Authorization": "Bearer rpat_…" }
    }
  }
}</pre>
          <p class="muted">可用工具(按你的角色过滤):<code>whoami</code>、<code>list_schedules</code>、<code>list_jobs</code>、<code>get_job</code>(只读);<code>create_review_task</code>、<code>run_schedule</code>(member+)。</p>
        \`;
      }

      // --- Users (admin only) ---
      async function renderUsers() {
        if (!isAdmin()) { document.querySelector("#users").innerHTML = '<p class="muted">仅管理员可见。</p>'; return; }
        const users = await load("/api/users", []);
        const roleOpts = (sel) => ["viewer", "member", "admin"]
          .map((r) => \`<option value="\${r}"\${r === sel ? " selected" : ""}>\${ROLE_LABEL[r]}</option>\`).join("");
        const rows = users.map((u) =>
          \`<tr><td>\${esc(u.email)}</td><td><select data-role-for="\${esc(u.id)}">\${roleOpts(u.role)}</select></td><td class="muted">\${esc(u.createdAt)}</td></tr>\`
        ).join("");
        document.querySelector("#users").innerHTML =
          \`<table><thead><tr><th>邮箱</th><th>角色</th><th>创建时间</th></tr></thead><tbody>\${rows}</tbody></table>\`;
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
