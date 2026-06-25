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
      /* ── Design tokens ─────────────────────────────────────────── */
      :root {
        --bg: #0a0d13;
        --bg-grad: radial-gradient(1200px 600px at 80% -10%, #16203a 0%, rgba(10,13,19,0) 55%), #0a0d13;
        --surface: #121724;
        --surface-2: #161c2b;
        --surface-3: #1c2435;
        --border: #232b3c;
        --border-strong: #2f3a52;
        --text: #e8ebf2;
        --text-dim: #97a1b4;
        --muted: #6c7689;
        --accent: #4c8bf5;
        --accent-2: #6aa3ff;
        --accent-strong: #1f6feb;
        --accent-soft: rgba(76,139,245,0.14);
        --green: #6ee787; --green-bg: rgba(110,231,135,0.12);
        --amber: #e7b06e; --amber-bg: rgba(231,176,110,0.13);
        --red: #f0857d; --red-bg: rgba(240,133,125,0.13);
        --yellow: #e7d56e;
        --r-sm: 7px; --r: 10px; --r-lg: 14px;
        --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.6);
        --shadow-lg: 0 24px 60px -20px rgba(0,0,0,.7);
        --ring: 0 0 0 3px var(--accent-soft);
      }
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: var(--bg-grad); background-attachment: fixed; color: var(--text); -webkit-font-smoothing: antialiased; line-height: 1.5; }
      ::selection { background: var(--accent-soft); }
      a { color: var(--accent-2); }
      /* slim scrollbars */
      * { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
      ::-webkit-scrollbar-thumb:hover { background: #3a445c; }

      /* ── Header ────────────────────────────────────────────────── */
      header { position: sticky; top: 0; z-index: 50; background: rgba(15,19,29,.72); backdrop-filter: saturate(140%) blur(12px); -webkit-backdrop-filter: saturate(140%) blur(12px); padding: 13px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 16px; }
      h1 { font-size: 16px; font-weight: 650; margin: 0; letter-spacing: .2px; display: flex; align-items: center; gap: 9px; }
      h1 .brand-badge { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, var(--accent-2), var(--accent-strong)); display: inline-flex; align-items: center; justify-content: center; font-size: 15px; box-shadow: 0 4px 12px -2px rgba(31,111,235,.5); }
      h1 .brand-sub { color: var(--text-dim); font-weight: 400; font-size: 13px; }

      /* ── Layout / sidebar ──────────────────────────────────────── */
      .layout { display: flex; min-height: calc(100vh - 53px); }
      nav { width: 210px; background: linear-gradient(180deg, var(--surface) 0%, rgba(18,23,36,.5) 100%); border-right: 1px solid var(--border); padding: 16px 12px; flex-shrink: 0; }
      .nav-group { font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); padding: 14px 12px 6px; font-weight: 600; }
      .nav-group:first-child { padding-top: 2px; }
      nav a { display: flex; align-items: center; gap: 10px; padding: 9px 12px; margin: 1px 0; color: var(--text-dim); text-decoration: none; font-size: 13.5px; font-weight: 500; border-radius: var(--r-sm); transition: background .15s, color .15s, transform .05s; }
      nav a::before { font-size: 15px; width: 18px; text-align: center; opacity: .92; }
      nav a[data-view="tasks"]::before { content: "🗂️"; }
      nav a[data-view="rulesets"]::before { content: "📐"; }
      nav a[data-view="account"]::before { content: "🔑"; }
      nav a[data-view="usage"]::before { content: "📈"; }
      nav a[data-view="users"]::before { content: "👥"; }
      nav a:hover { background: var(--surface-2); color: var(--text); }
      nav a:active { transform: translateY(1px); }
      nav a.active { color: #fff; background: linear-gradient(90deg, var(--accent-soft), rgba(76,139,245,.04)); box-shadow: inset 2px 0 0 var(--accent); }
      main { padding: 26px 30px; flex: 1; max-width: 1160px; width: 100%; }

      /* ── Views / sections / headings ───────────────────────────── */
      .view { display: none; animation: fade .22s ease; }
      .view.active { display: block; }
      @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      section { margin-bottom: 30px; }
      h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-dim); font-weight: 650; }
      h3 { font-size: 14px; font-weight: 620; margin: 22px 0 10px; color: var(--text); }
      .view-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
      .view-head h2 { margin: 0; font-size: 17px; text-transform: none; letter-spacing: 0; color: var(--text); font-weight: 650; }
      .sub-head { display: flex; align-items: center; justify-content: space-between; margin: 22px 0 12px; }
      .sub-head h3 { margin: 0; }

      /* ── Tables ────────────────────────────────────────────────── */
      table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; box-shadow: var(--shadow); }
      thead th { background: var(--surface-2); }
      th { text-align: left; padding: 10px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); font-weight: 600; border-bottom: 1px solid var(--border); }
      td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 13.5px; vertical-align: middle; }
      tbody tr:last-child td { border-bottom: none; }
      tbody tr { transition: background .12s; }
      tbody tr:hover { background: var(--surface-2); }
      tr.clickable { cursor: pointer; }

      /* ── Badges: status / role / severity ──────────────────────── */
      .status { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; line-height: 1.4; border: 1px solid transparent; }
      .succeeded { background: var(--green-bg); color: var(--green); border-color: rgba(110,231,135,.25); }
      .running { background: var(--amber-bg); color: var(--amber); border-color: rgba(231,176,110,.25); }
      .failed { background: var(--red-bg); color: var(--red); border-color: rgba(240,133,125,.25); }
      .pending { background: var(--surface-3); color: var(--text-dim); border-color: var(--border-strong); }
      .role-admin { background: var(--amber-bg); color: var(--amber); }
      .role-member { background: var(--green-bg); color: var(--green); }
      .role-viewer { background: var(--surface-3); color: var(--text-dim); }
      .active-bucket { background: linear-gradient(135deg, var(--accent-2), var(--accent-strong)) !important; border-color: var(--accent-strong) !important; color: #fff !important; }

      /* ── Progress bar ──────────────────────────────────────────── */
      .bar { background: var(--surface-3); border-radius: 999px; height: 7px; width: 120px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border-radius: 999px; transition: width .4s ease; }

      /* ── Form controls ─────────────────────────────────────────── */
      input, select, button, textarea { background: var(--surface-2); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 8px 11px; font-size: 13px; font-family: inherit; outline: none; transition: border-color .15s, box-shadow .15s, background .15s; }
      input::placeholder, textarea::placeholder { color: var(--muted); }
      input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: var(--ring); }
      button { cursor: pointer; background: linear-gradient(135deg, var(--accent-2), var(--accent-strong)); border: 1px solid var(--accent-strong); color: #fff; font-weight: 600; box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 6px 16px -8px rgba(31,111,235,.6); }
      button:hover { filter: brightness(1.07); transform: translateY(-1px); }
      button:active { transform: translateY(0); filter: brightness(.97); }
      button:focus-visible { box-shadow: var(--ring); }
      button.secondary { background: var(--surface-3); border-color: var(--border-strong); color: var(--text); box-shadow: none; font-weight: 500; }
      button.secondary:hover { background: var(--surface-2); border-color: var(--accent); color: #fff; filter: none; }
      button:disabled { opacity: .55; cursor: not-allowed; transform: none; filter: none; }

      /* ── Code / severity / misc ────────────────────────────────── */
      .sev { font-weight: 600; }
      .sev-critical { color: var(--red); } .sev-major { color: var(--amber); }
      .sev-minor { color: var(--yellow); } .sev-info { color: var(--text-dim); }
      pre { background: #0c1019; border: 1px solid var(--border); border-radius: var(--r-sm); padding: 12px 14px; overflow: auto; font-size: 12px; line-height: 1.55; font-family: "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace; }
      code { word-break: break-all; font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: .92em; background: var(--surface-3); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
      pre code { background: none; border: none; padding: 0; }
      #detail { margin-top: 16px; }
      .muted { color: var(--text-dim); font-size: 12.5px; }
      .token { display: flex; gap: 12px; align-items: center; }
      #user-handle { color: var(--accent-2); font-weight: 500; }

      /* ── Modal dialog ──────────────────────────────────────────── */
      .modal-overlay { position: fixed; inset: 0; background: rgba(5,8,14,.62); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); display: none; align-items: flex-start; justify-content: center; z-index: 100; overflow-y: auto; padding: 56px 16px; box-sizing: border-box; }
      .modal-overlay.open { display: flex; }
      .modal { background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: 22px 24px; width: 640px; max-width: 100%; box-shadow: var(--shadow-lg); animation: pop .2s ease; }
      @keyframes pop { from { opacity: 0; transform: translateY(-10px) scale(.985); } to { opacity: 1; transform: none; } }
      .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
      .modal-head h2 { margin: 0; font-size: 17px; text-transform: none; letter-spacing: 0; color: var(--text); font-weight: 650; }
      .modal .close { background: transparent; border: none; color: var(--text-dim); font-size: 22px; line-height: 1; cursor: pointer; padding: 2px 8px; border-radius: 6px; box-shadow: none; }
      .modal .close:hover { background: var(--surface-3); color: var(--text); transform: none; filter: none; }
      .modal form { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
      .modal label { font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 5px; font-weight: 500; }
      .modal .field { margin-bottom: 14px; }
      .modal input, .modal select, .modal textarea { width: 100%; box-sizing: border-box; }
      .modal .result { margin: 10px 0 0; }
      .modal form > button[type="submit"] { margin-top: 4px; padding: 10px; }

      /* ── Structured conditional-rule editor ────────────────────── */
      .rule-row { border: 1px solid var(--border-strong); border-radius: var(--r); padding: 12px; margin-bottom: 10px; background: var(--surface-2); }
      .rule-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 7px; }
      .rule-grid2 { display: flex; gap: 8px; align-items: flex-start; }
      .rule-grid2 textarea { flex: 1; }
      .rule-grid2 button { white-space: nowrap; }
      .rule-head { min-height: 0; margin-bottom: 8px; }
      .rule-head:empty { display: none; }
      .rule-pending { border-color: var(--amber); background: var(--amber-bg); }
      .badge-pending { display: inline-block; font-size: 11px; font-weight: 600; color: var(--amber); background: var(--amber-bg); border: 1px solid rgba(231,176,110,.35); border-radius: 999px; padding: 2px 9px; margin-right: 8px; }
      .row-has-pending td { background: var(--amber-bg); }

      /* ── Info card (orchestrator install) ──────────────────────── */
      .card { border: 1px solid var(--border); border-radius: var(--r-lg); padding: 18px 20px; margin-bottom: 18px; background: linear-gradient(180deg, var(--surface-2), var(--surface)); box-shadow: var(--shadow); }
      .card h3 { margin: 14px 0 6px; font-size: 13.5px; }
      .card h3:first-child { margin-top: 0; }
      .card pre { margin: 6px 0; }
      /* One-click copy on command blocks */
      .codeblock { position: relative; }
      .codeblock > pre { padding-right: 64px; }
      .codeblock > .copy { position: absolute; top: 8px; right: 8px; padding: 3px 10px; font-size: 11px; font-weight: 600; background: var(--surface-3); border: 1px solid var(--border-strong); color: var(--text-dim); border-radius: 6px; box-shadow: none; }
      .codeblock > .copy:hover { background: var(--surface-2); color: #fff; border-color: var(--accent); filter: none; transform: none; }
      .codeblock > .copy.copied { color: var(--green); border-color: rgba(110,231,135,.4); }

      /* ── Auth gate ─────────────────────────────────────────────── */
      .auth-gate { position: fixed; inset: 0; background: var(--bg-grad); display: none; align-items: center; justify-content: center; z-index: 200; padding: 20px; }
      .auth-gate.open { display: flex; }
      .auth-card { width: 380px; max-width: 100%; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: 30px 28px; box-shadow: var(--shadow-lg); }
      .auth-card .auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; font-size: 15px; font-weight: 650; }
      .auth-card .auth-brand .brand-badge { width: 30px; height: 30px; border-radius: 9px; background: linear-gradient(135deg, var(--accent-2), var(--accent-strong)); display: inline-flex; align-items: center; justify-content: center; font-size: 17px; box-shadow: 0 4px 12px -2px rgba(31,111,235,.5); }
      .auth-card h2 { text-transform: none; color: var(--text); font-size: 21px; font-weight: 680; margin: 14px 0 18px; letter-spacing: 0; }
      .auth-card .field { margin-bottom: 14px; }
      .auth-card label { font-size: 12px; color: var(--text-dim); display: block; margin-bottom: 5px; font-weight: 500; }
      .auth-card input { width: 100%; box-sizing: border-box; padding: 9px 11px; }
      .auth-card button { width: 100%; margin-top: 6px; padding: 10px; }
    </style>
  </head>
  <body>
    <header>
      <h1><span class="brand-badge">🤖</span>ReviewPilot <span class="brand-sub">持续代码评审</span></h1>
      <div class="token" id="userbar" style="display:none">
        <span class="muted" id="user-email"></span>
        <span class="muted" id="user-handle" title="你的公开用户名(handle)"></span>
        <span class="status" id="user-role"></span>
        <button class="secondary" id="logout">退出登录</button>
      </div>
    </header>
    <div class="layout">
      <nav>
        <div class="nav-group">工作区</div>
        <a href="#tasks" data-view="tasks">任务</a>
        <a href="#rulesets" data-view="rulesets">评审规则集</a>
        <div class="nav-group">账户与接入</div>
        <a href="#account" data-view="account">API Key</a>
        <a href="#usage" data-view="usage">Token 用量</a>
        <a href="#users" data-view="users" id="nav-users" style="display:none">用户管理</a>
      </nav>
      <main>
        <div class="view" id="view-tasks">
          <div class="view-head"><h2>任务</h2></div>
          <div class="sub-head">
            <h3>定时任务</h3>
            <button id="open-schedule-modal">+ 新建定时扫描</button>
          </div>
          <section id="schedules"><div data-loading>加载中…</div></section>
          <div class="sub-head">
            <h3>一次性任务</h3>
            <button id="open-task-modal">+ 新建任务</button>
          </div>
          <section id="jobs"><div data-loading>加载中…</div></section>
          <section id="detail"></section>
        </div>
        <div class="view" id="view-account">
          <div class="view-head">
            <h2>API Key</h2>
            <button id="open-token-modal">+ 新建令牌</button>
          </div>
          <section id="tokens"><div data-loading>加载中…</div></section>
          <h3>API 与 MCP 接入说明</h3>
          <section id="integrations"></section>
        </div>
        <div class="view" id="view-rulesets">
          <div class="view-head">
            <h2>评审规则集</h2>
            <button id="open-ruleset-modal">+ 新建规则集</button>
          </div>
          <section id="rulesets"><div data-loading>加载中…</div></section>
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
        <div class="view" id="view-users">
          <div class="view-head"><h2>用户管理</h2></div>
          <section id="users"><div data-loading>加载中…</div></section>
        </div>
      </main>
    </div>

    <!-- Login / register gate -->
    <div class="auth-gate" id="auth-gate">
      <div class="auth-card">
        <div class="auth-brand"><span class="brand-badge">🤖</span>ReviewPilot</div>
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

    <!-- Create / edit review ruleset modal -->
    <div class="modal-overlay" id="ruleset-modal" data-modal>
      <div class="modal">
        <div class="modal-head"><h2 id="ruleset-modal-title">新建规则集</h2><button class="close" data-close>×</button></div>
        <form id="ruleset-form">
          <input type="hidden" name="id" />
          <input type="hidden" name="project" />
          <div class="field"><label>名称</label><input name="name" placeholder="我的严格规则" required /></div>
          <div class="field"><label>项目(git 仓库地址或 host/owner/repo,留空 = 适用所有项目)</label><input name="projectLabel" placeholder="github.com/acme/app" /></div>
          <div class="field"><label>描述</label><input name="description" placeholder="一句话说明这套规则" /></div>
          <div class="field"><label>可见性</label><select name="visibility"><option value="private">私有(仅自己,安装需令牌)</option><option value="public">公开(社区可见可安装)</option></select></div>
          <div class="field"><label>评审语言(留空 = 跟随使用者)</label><input name="language" placeholder="中文" /></div>
          <div class="field"><label>评审重点</label><input name="focus" placeholder="例如:并发安全、SQL 注入、接口兼容性" /></div>
          <div class="field"><label>通用规则 / 始终生效(markdown,逐条写)</label><textarea name="instructions" rows="5" placeholder="- 禁止提交 console.log&#10;- DB 写操作必须有索引佐证&#10;- 公共 API 变更需向后兼容"></textarea></div>
          <div class="field">
            <label>按需规则(仅当改动命中选择器时加载)</label>
            <p class="muted" style="margin:.2rem 0 .4rem">选择器留空 = 始终生效。匹配在本地完成,代码不会上传。多个值用逗号分隔。</p>
            <div id="rs-rules"></div>
            <button type="button" id="rs-add-rule" class="secondary">+ 添加规则</button>
          </div>
          <button type="submit">保存</button>
          <p class="muted result" id="ruleset-result"></p>
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
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

      // Wrap every <pre> under \`root\` with a one-click "复制" button (idempotent).
      function addCopyButtons(root) {
        if (!root) return;
        root.querySelectorAll("pre").forEach((pre) => {
          if (pre.parentElement && pre.parentElement.classList.contains("codeblock")) return;
          const wrap = document.createElement("div");
          wrap.className = "codeblock";
          pre.parentNode.insertBefore(wrap, pre);
          wrap.appendChild(pre);
          const btn = document.createElement("button");
          btn.type = "button"; btn.className = "copy"; btn.textContent = "复制";
          btn.onclick = async () => {
            const text = pre.innerText;
            try { await navigator.clipboard.writeText(text); }
            catch {
              const r = document.createRange(); r.selectNodeContents(pre);
              const s = getSelection(); s.removeAllRanges(); s.addRange(r);
              try { document.execCommand("copy"); } catch {}
              s.removeAllRanges();
            }
            btn.textContent = "已复制"; btn.classList.add("copied");
            setTimeout(() => { btn.textContent = "复制"; btn.classList.remove("copied"); }, 1500);
          };
          wrap.appendChild(btn);
        });
      }

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
          showView(location.hash.slice(1) || localStorage.getItem("rp_view") || "tasks");
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
          document.getElementById("user-handle").textContent = me.handle ? "@" + me.handle : "";
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
        // The hash is the source of truth so refresh restores the page. Form:
        //   "<view>" or "<view>/<sub>" (tasks/<jobId> keeps an open job detail).
        // Merged views keep old hashes working via aliases:
        //   schedules/dashboard → tasks · integrations → account
        const [rawView, sub] = String(name || "").split("/");
        const alias = { schedules: "tasks", dashboard: "tasks", integrations: "account" };
        const mapped = alias[rawView] || rawView;
        const valid = ["tasks", "account", "rulesets", "usage", "users"];
        const view = valid.includes(mapped) ? mapped : "tasks";
        localStorage.setItem("rp_view", view); // fallback for a bare URL (no hash)
        document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
        document.getElementById("view-" + view)?.classList.add("active");
        document.querySelectorAll("nav a").forEach((a) =>
          a.classList.toggle("active", a.getAttribute("data-view") === view));
        if (view === "account") { renderTokens(); renderIntegrations(); }
        if (view === "users") renderUsers();
        if (view === "usage") renderUsage();
        if (view === "rulesets") renderRulesets();
        if (view === "tasks") {
          if (sub) showJob(sub);                       // restore the open job detail
          else { const d = document.getElementById("detail"); if (d) d.innerHTML = ""; }
        }
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
          // Drive the hash so an open job detail is restored on refresh.
          tr.onclick = () => { location.hash = "tasks/" + tr.getAttribute("data-job"); };
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
        // The env-configured admin has no DB row, so it can't mint DB tokens —
        // it authenticates via the server's ADMIN_TOKEN env var instead.
        if (me && me.id === "usr_env_admin") {
          document.querySelector("#tokens").innerHTML =
            \`<div class="card"><h3>内置管理员(环境配置)</h3>
             <p class="muted">当前是环境变量配置的管理员账户,<b>不在数据库中</b>,因此无法在此创建个人令牌。请用服务端设置的环境变量 <code>ADMIN_TOKEN</code> 作为令牌——它在 API / MCP / skill 自动沉淀里等同于一个 admin PAT。</p>
             <p class="muted">本地 skill 安装(把 <code>&lt;ADMIN_TOKEN&gt;</code> 换成你配置的值):</p>
             <pre>curl -fsSL -H "Authorization: Bearer &lt;ADMIN_TOKEN&gt;" \${esc(location.origin)}/skill/install.sh | sh</pre>
             <p class="muted">若服务端未设置 <code>ADMIN_TOKEN</code>,请在部署环境加上后重启;或改用一个普通注册账户来测试。</p></div>\`;
          addCopyButtons(document.querySelector("#tokens"));
          return;
        }
        const tokens = await load("/api/tokens", []);
        const rows = tokens.map((t) =>
          \`<tr><td>\${esc(t.name)}</td><td><code>\${esc(t.prefix)}…</code></td><td class="muted">\${esc(t.lastUsedAt || "从未使用")}</td><td><button class="secondary" data-revoke="\${esc(t.id)}">吊销</button></td></tr>\`
        ).join("");
        document.querySelector("#tokens").innerHTML =
          tokens.length
            ? \`<table><thead><tr><th>名称</th><th>前缀</th><th>上次使用</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`
            : \`<p class="muted">暂无 API Key。点上方「<b>+ 新建令牌</b>」创建一个 —— 即可以你的身份调用 API(<code>Authorization: Bearer rpat_…</code>),创建成功后还会给出一条<b>已配置好该 token 的本地 Skill 安装命令</b>,装好即用。</p>\`;
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
          const installCmd = 'curl -fsSL -H "Authorization: Bearer ' + r.token + '" ' + location.origin + '/skill/install.sh | sh';
          out.innerHTML =
            "✓ 令牌仅显示这一次,立即复制:<br/><code>" + esc(r.token) + "</code>"
            + "<br/><br/><b>一键安装已配置好的本地 Skill</b>(已内置此 token,装好即用、无需再配置):"
            + "<pre>" + esc(installCmd) + "</pre>";
          addCopyButtons(out);
          f.reset();
          renderTokens();
        } catch (e) { out.textContent = "✗ " + e.message; }
        finally { btn.disabled = false; }
      };

      // --- Review rulesets (community) ---
      // A structured "conditional rule" editor: each row carries an instruction
      // plus selectors (globs / languages / topics). Empty selectors = always on.
      const csv = (a) => (Array.isArray(a) ? a : []).join(", ");
      const parseCsv = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
      function addRuleRow(rule) {
        const r = rule || { title: "", instruction: "", globs: [], languages: [], topics: [], pending: false };
        const row = document.createElement("div");
        row.className = "rule-row" + (r.pending ? " rule-pending" : "");
        row.dataset.pending = r.pending ? "1" : "0";
        // Pending (auto-extracted) candidates get a badge + a 采纳 toggle.
        const badge = r.pending
          ? '<span class="badge-pending">候选 · 待采纳</span> <button type="button" class="secondary" data-adopt-rule>采纳</button>'
          : "";
        row.innerHTML =
          \`<div class="rule-head">\${badge}</div>
           <div class="rule-grid">
             <input data-rk="title" placeholder="规则标题(如:SQL 注入)" value="\${esc(r.title || "")}" />
             <input data-rk="globs" placeholder="路径 globs,如 src/db/**, **/*.sql" value="\${esc(csv(r.globs))}" />
             <input data-rk="languages" placeholder="语言,如 ts, sql" value="\${esc(csv(r.languages))}" />
             <input data-rk="topics" placeholder="主题,如 security, performance" value="\${esc(csv(r.topics))}" />
           </div>
           <div class="rule-grid2">
             <textarea data-rk="instruction" rows="2" placeholder="规则正文(命中时应用)">\${esc(r.instruction || "")}</textarea>
             <button type="button" class="secondary" data-rm-rule>移除</button>
           </div>\`;
        row.querySelector("[data-rm-rule]").onclick = () => row.remove();
        const adopt = row.querySelector("[data-adopt-rule]");
        if (adopt) adopt.onclick = () => {
          row.dataset.pending = "0";
          row.classList.remove("rule-pending");
          row.querySelector(".rule-head").innerHTML = "";
        };
        document.getElementById("rs-rules").appendChild(row);
      }
      function collectRules() {
        const rules = [];
        document.querySelectorAll("#rs-rules .rule-row").forEach((row) => {
          const get = (k) => row.querySelector('[data-rk="' + k + '"]').value;
          const instruction = get("instruction").trim();
          if (!instruction) return; // skip empty rows
          rules.push({
            title: get("title").trim() || "Rule",
            instruction,
            globs: parseCsv(get("globs")),
            languages: parseCsv(get("languages")),
            topics: parseCsv(get("topics")),
            pending: row.dataset.pending === "1",
          });
        });
        return rules;
      }
      function openRulesetModal(rs) {
        const f = document.getElementById("ruleset-form");
        f.reset();
        document.getElementById("ruleset-result").textContent = "";
        document.getElementById("rs-rules").innerHTML = "";
        document.getElementById("ruleset-modal-title").textContent = rs ? "编辑规则集" : "新建规则集";
        f.id.value = rs ? rs.id : "";
        f.project.value = rs ? (rs.project || "") : "";
        if (rs) {
          f.name.value = rs.name; f.description.value = rs.description || "";
          f.projectLabel.value = rs.projectLabel || rs.project || "";
          f.visibility.value = rs.visibility; f.language.value = rs.language || "";
          f.focus.value = rs.focus || ""; f.instructions.value = rs.instructions || "";
          (rs.rules || []).forEach(addRuleRow);
        }
        openModal("ruleset-modal");
      }
      document.getElementById("open-ruleset-modal").onclick = () => openRulesetModal(null);
      document.getElementById("rs-add-rule").onclick = () => addRuleRow(null);

      document.getElementById("ruleset-form").onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const out = document.getElementById("ruleset-result");
        const btn = f.querySelector('button[type="submit"]');
        btn.disabled = true; out.textContent = "";
        const id = f.id.value;
        const payload = {
          name: f.name.value, description: f.description.value,
          visibility: f.visibility.value, language: f.language.value,
          focus: f.focus.value, instructions: f.instructions.value,
          projectLabel: f.projectLabel.value,
          rules: collectRules(),
        };
        // Project key is set at creation only (immutable afterwards); the server
        // normalizes whatever the user typed into the canonical key.
        if (!id) payload.project = f.projectLabel.value;
        try {
          await api(id ? "/api/rulesets/" + id : "/api/rulesets", {
            method: id ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          closeModal("ruleset-modal");
          renderRulesets();
        } catch (e) { out.textContent = "✗ " + e.message; }
        finally { btn.disabled = false; }
      };

      async function renderRulesets() {
        const o = location.origin;
        const mine = await load("/api/rulesets", []);
        const pub = await load("/api/rulesets?scope=public", []);
        const myHandle = (me && me.handle) || "";
        const cmd = (r) => r.visibility === "public"
          ? \`curl -fsSL \${o}/skill/ruleset/\${r.id}/install.sh | sh\`
          : \`curl -fsSL -H "Authorization: Bearer rpat_…" \${o}/skill/ruleset/\${r.id}/install.sh | sh\`;
        const ruleCount = (r) => (r.rules ? r.rules.length : 0);
        const pendingCount = (r) => (r.rules ? r.rules.filter((x) => x.pending).length : 0);

        const mineRows = mine.map((r) => {
          const pend = pendingCount(r);
          const pendTag = pend ? \` <span class="badge-pending">\${pend} 候选待采纳</span>\` : "";
          return \`<tr\${pend ? ' class="row-has-pending"' : ""}>
          <td>\${esc(r.name)}</td>
          <td class="muted">\${esc(r.projectLabel || r.project || "所有项目")}</td>
          <td>\${r.visibility === "public" ? "公开" : "私有"}</td>
          <td class="muted">\${ruleCount(r)} 条规则\${pendTag}</td>
          <td><code>\${esc(cmd(r))}</code></td>
          <td><button class="secondary" data-edit-rs="\${esc(r.id)}">编辑</button> <button class="secondary" data-del-rs="\${esc(r.id)}">删除</button></td>
        </tr>\`;
        }).join("");
        const pubRows = pub.map((r) => \`<tr>
          <td>\${esc(r.name)}</td>
          <td class="muted">\${esc(r.ownerHandle || r.ownerEmail)}</td>
          <td class="muted">\${esc(r.projectLabel || r.project || "所有项目")}</td>
          <td class="muted">\${esc(r.description || "")}</td>
          <td>\${r.ownerHandle ? \`<code>让 \${esc(r.ownerHandle)} 帮我 review 我的改动</code>\` : '<span class="muted">—</span>'}</td>
          <td><button class="secondary" data-fork-rs="\${esc(r.id)}">Fork 到我的</button></td>
        </tr>\`).join("");

        // The orchestrator skill: install once, then call anyone's public rules by handle.
        const orchestrator =
          \`<div class="card">
             <h3>① 安装编排型 skill(只需一次)</h3>
             <p class="muted">装一个本地 skill,之后就能让任意用户的公开规则集来 review 你的改动 —— 规则<strong>按项目</strong>管理、按改动文件<strong>本地按需</strong>加载,代码不外传。<strong>推荐去「API Key」页新建令牌</strong>,创建后会给出一条<strong>已内置 token</strong> 的安装命令,装好即可自动沉淀规则、无需手动配置。通用(不带 token)命令:</p>
             <pre><code>curl -fsSL \${o}/skill/install.sh | sh</code></pre>
             <h3>② 在 Claude Code 里直接说</h3>
             <pre><code>让 \${esc(myHandle || "<用户名>")} 帮我 review 我的改动</code></pre>
             <p class="muted">你的用户名(handle):<code>\${esc(myHandle || "(登录后可见)")}</code> —— 把它告诉别人,他们就能用你的公开规则集来 review。</p>
             <h3>③ 自动沉淀规则</h3>
             <p class="muted">用上面「已内置 token」的安装命令装好后即自动开启:每次 review 会把发现的关键点作为<strong>候选规则</strong>提交到当前项目的规则集,你在此页确认采纳后才会生效。</p>
           </div>\`;

        document.querySelector("#rulesets").innerHTML =
          orchestrator
          + \`<p class="muted">规则<strong>按项目</strong>独立管理。每个规则集含「通用规则(始终生效)」+「按需规则(命中改动文件的选择器时才加载)」。带「候选待采纳」的规则由 skill 自动提交,需在编辑里点「采纳」后才生效或对外公开。</p>
             <h3>我的规则集</h3>\`
          + (mine.length
              ? \`<table><thead><tr><th>名称</th><th>项目</th><th>可见性</th><th>规则</th><th>单独安装命令</th><th></th></tr></thead><tbody>\${mineRows}</tbody></table>\`
              : \`<p class="muted">还没有规则集,点上方「+ 新建规则集」创建。</p>\`)
          + \`<h3>社区规则集</h3>\`
          + (pub.length
              ? \`<table><thead><tr><th>名称</th><th>作者</th><th>项目</th><th>描述</th><th>一句话调用</th><th></th></tr></thead><tbody>\${pubRows}</tbody></table>\`
              : \`<p class="muted">社区暂无公开规则集。</p>\`);

        const byId = {};
        mine.forEach((r) => (byId[r.id] = r));
        document.querySelectorAll('#rulesets [data-edit-rs]').forEach((b) =>
          (b.onclick = () => openRulesetModal(byId[b.getAttribute("data-edit-rs")])));
        document.querySelectorAll('#rulesets [data-del-rs]').forEach((b) =>
          (b.onclick = async () => {
            if (!confirm("确定删除该规则集?")) return;
            try { await api("/api/rulesets/" + b.getAttribute("data-del-rs"), { method: "DELETE" }); renderRulesets(); }
            catch (e) { alert(e.message); }
          }));
        document.querySelectorAll('#rulesets [data-fork-rs]').forEach((b) =>
          (b.onclick = async () => {
            try { await api("/api/rulesets/" + b.getAttribute("data-fork-rs") + "/fork", { method: "POST" }); renderRulesets(); }
            catch (e) { alert(e.message); }
          }));
        addCopyButtons(document.querySelector("#rulesets"));
      }

      // --- Token usage (per configured task; day/week/month) ---
      let usageBucket = localStorage.getItem("rp_bucket") || "day";
      document.querySelectorAll('#usage-buckets [data-bucket]').forEach((b) => {
        b.onclick = () => {
          usageBucket = b.getAttribute("data-bucket");
          localStorage.setItem("rp_bucket", usageBucket); // survive refresh
          renderUsage();
        };
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
          <p class="muted">用上方创建的个人访问令牌(<code>rpat_…</code>)调用 REST API 或接入 MCP。令牌继承你的角色:viewer 只读,写操作(新建任务、触发扫描)需 member+(由管理员升级)。令牌只在创建时显示一次。</p>

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

          <h3>本地评审 Skill(Claude Code)</h3>
          <p class="muted">在你本机的 Claude Code 里装一个本地评审 skill —— 与本服务<b>同一评审内核</b>,但完全在本地运行(由你本地的 Claude Code 执行,代码不出本机)。</p>
          <p class="muted"><b>推荐:已配置好 token 的安装命令</b> —— 在上方「<b>+ 新建令牌</b>」创建一个 API Key,创建成功后会直接给出一条<strong>已内置该 token</strong> 的安装命令,复制运行即可,无需再手动配置。</p>
          <p class="muted">不需要自动沉淀规则的话,也可用这条不带 token 的通用命令安装:</p>
          <pre>curl -fsSL \${o}/skill/install.sh | sh</pre>
          <p class="muted">安装后在 Claude Code 里说「评审一下我的改动」即可:自动按工作区改动 / 分支差异 / 全项目评审;若本机装了 code-review-graph,会带上风险排序与测试缺口。也可直接查看 <code>\${o}/skill/reviewpilot-review/SKILL.md</code>。</p>
          <p class="muted">这是<b>编排型</b> skill:还可以说「让 &lt;用户名&gt; 帮我 review 我的改动」—— 它会拉取该用户的公开规则集,并按改动文件<b>本地按需</b>加载相关规则(代码不出本机)。规则集的创建与发现见左侧「评审规则集」。</p>
        \`;
        addCopyButtons(document.querySelector("#integrations"));
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
          showView(location.hash.slice(1) || localStorage.getItem("rp_view") || "tasks");
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
