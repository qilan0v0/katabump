// === KV Cookie Admin — Cloudflare Worker ===
// 管理所有保活脚本写入 KV 的登录 cookie
// 部署: npx wrangler deploy
// Secret: npx wrangler secret put KV_ADMIN_PASS

const PROJECT_PREFIXES = [
  { label: 'Katabump', prefix: 'katabump_cookie_' },
  { label: 'Zampto', prefix: 'zampto_cookie_' },
  { label: 'Vortexa', prefix: 'vortexa_cookie_' },
  { label: 'Weirdhost', prefix: 'weirdhost_cookie_' },
  { label: 'FreeMCHost', prefix: 'freemchost_cookie_' },
];

// 从 key 中提取邮箱部分
function extractEmail(key) {
  for (const p of PROJECT_PREFIXES) {
    if (key.startsWith(p.prefix)) return key.slice(p.prefix.length);
  }
  return key;
}

// 从 key 中提取项目名
function extractProject(key) {
  for (const p of PROJECT_PREFIXES) {
    if (key.startsWith(p.prefix)) return p.label;
  }
  return 'Unknown';
}

// 计算 cookie 数组中最早的过期时间
function getEarliestExpiry(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  let earliest = Infinity;
  for (const c of cookies) {
    const exp = c.expires || c.expirationDate;
    if (typeof exp === 'number' && exp > 0 && exp < earliest) earliest = exp;
  }
  return earliest === Infinity ? null : new Date(earliest * 1000);
}

// 格式化时间
function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function htmlEscape(s) {
  if (typeof s !== 'string') return String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// === HTML 管理界面 (SPA) ===
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KV Cookie Admin</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0d1117; color:#e6edf3; min-height:100vh; }
.container { max-width:1200px; margin:0 auto; padding:20px; }
h1 { font-size:22px; font-weight:600; margin-bottom:4px; }
.sub { color:#8b949e; font-size:13px; margin-bottom:20px; }
/* Login */
.login-box { max-width:360px; margin:120px auto; text-align:center; }
.login-box h1 { margin-bottom:16px; }
.login-box input { width:100%; padding:10px 14px; border:1px solid #30363d; border-radius:6px; background:#161b22; color:#e6edf3; font-size:14px; outline:none; }
.login-box input:focus { border-color:#58a6ff; }
.login-box .err { color:#f85149; font-size:13px; margin-top:8px; display:none; }
/* Filters */
.tabs { display:flex; gap:4px; margin-bottom:16px; flex-wrap:wrap; }
.tab { padding:6px 14px; border-radius:20px; font-size:13px; cursor:pointer; border:1px solid #30363d; background:transparent; color:#8b949e; transition:.15s; }
.tab:hover { border-color:#58a6ff; color:#e6edf3; }
.tab.active { background:#1f6feb; border-color:#1f6feb; color:#fff; }
/* Search */
.search-row { display:flex; gap:8px; margin-bottom:16px; align-items:center; }
.search-row input { flex:1; padding:8px 12px; border:1px solid #30363d; border-radius:6px; background:#161b22; color:#e6edf3; font-size:13px; outline:none; }
.search-row input:focus { border-color:#58a6ff; }
.search-row .count { font-size:12px; color:#8b949e; white-space:nowrap; }
/* Table */
table { width:100%; border-collapse:collapse; font-size:13px; }
th { text-align:left; padding:10px 12px; border-bottom:1px solid #30363d; color:#8b949e; font-weight:500; font-size:12px; white-space:nowrap; user-select:none; cursor:pointer; }
th:hover { color:#e6edf3; }
td { padding:10px 12px; border-bottom:1px solid #21262d; vertical-align:middle; }
tr:hover td { background:#161b22; }
tr.expanded td { background:#0d1117; }
.key-cell { font-family:monospace; font-size:12px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.proj-badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:500; }
.proj-katabump { background:#1f6feb22; color:#58a6ff; }
.proj-zampto { background:#d2a8ff22; color:#d2a8ff; }
.proj-vortexa { background:#3fb95022; color:#3fb950; }
.proj-weirdhost { background:#f0883e22; color:#f0883e; }
.proj-freemchost { background:#f778ba22; color:#f778ba; }
.proj-unknown { background:#30363d44; color:#8b949e; }
.email-cell { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.num-badge { display:inline-block; min-width:22px; text-align:center; padding:1px 6px; border-radius:8px; font-size:11px; background:#30363d; color:#e6edf3; }
.expiry-cell { font-size:12px; color:#8b949e; white-space:nowrap; }
.updated-cell { font-size:12px; color:#8b949e; white-space:nowrap; }
.actions-cell { white-space:nowrap; }
.btn-del { padding:4px 10px; border-radius:4px; border:1px solid #f8514944; background:transparent; color:#f85149; font-size:11px; cursor:pointer; transition:.15s; }
.btn-del:hover { background:#f8514911; border-color:#f85149; }
.btn-del-all { padding:4px 12px; border-radius:4px; border:1px solid #f8514944; background:#f8514911; color:#f85149; font-size:11px; cursor:pointer; transition:.15s; }
.btn-del-all:hover { background:#f8514922; }
/* Detail row */
.detail-row td { padding:0; }
.detail-inner { padding:12px 16px 16px 60px; background:#0d1117; border-bottom:1px solid #30363d; }
.detail-inner pre { font-size:11px; line-height:1.5; background:#161b22; padding:12px; border-radius:6px; overflow-x:auto; max-height:400px; }
.detail-inner .meta { font-size:12px; color:#8b949e; margin-bottom:8px; }
/* Loading / Empty */
.loading { text-align:center; padding:60px 0; color:#8b949e; }
.empty { text-align:center; padding:60px 0; color:#8b949e; }
.empty svg { width:48px; height:48px; margin-bottom:12px; opacity:.3; }
/* Toast */
.toast { position:fixed; bottom:20px; right:20px; padding:10px 20px; border-radius:6px; font-size:13px; z-index:999; opacity:0; transform:translateY(10px); transition:.3s; }
.toast.show { opacity:1; transform:translateY(0); }
.toast.ok { background:#3fb95022; border:1px solid #3fb95044; color:#3fb950; }
.toast.err { background:#f8514922; border:1px solid #f8514944; color:#f85149; }
/* Confirm modal */
.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:100; display:flex; align-items:center; justify-content:center; }
.modal-box { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:24px; max-width:440px; width:90%; }
.modal-box h3 { margin-bottom:8px; }
.modal-box p { font-size:13px; color:#8b949e; margin-bottom:16px; }
.modal-actions { display:flex; gap:8px; justify-content:flex-end; }
.modal-actions button { padding:8px 16px; border-radius:6px; font-size:13px; cursor:pointer; border:1px solid #30363d; }
.modal-actions .cancel { background:transparent; color:#e6edf3; }
.modal-actions .confirm { background:#f85149; color:#fff; border-color:#f85149; }
@media(max-width:640px) {
  .container { padding:12px; }
  td,th { padding:8px; }
  .key-cell { max-width:120px; }
  .email-cell { max-width:100px; }
}
</style>
</head>
<body>
<div id="app">
  <div class="login-box" id="loginBox">
    <h1>🔐 KV Cookie Admin</h1>
    <input type="password" id="passInput" placeholder="Enter admin password" autofocus>
    <div class="err" id="loginErr">Invalid password</div>
  </div>
  <div id="mainPanel" style="display:none">
    <div class="container">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div><h1>☁️ KV Cookie Admin</h1><div class="sub">管理保活脚本写入 KV 的登录 cookie</div></div>
        <button class="btn-del-all" onclick="doRefresh()" style="border-color:#30363d;color:#8b949e;">⟳ Refresh</button>
      </div>
      <div class="tabs" id="tabs"></div>
      <div class="search-row">
        <input type="text" id="searchInput" placeholder="Search by key or email..." oninput="renderTable()">
        <span class="count" id="countLabel">0 entries</span>
      </div>
      <div id="tableWrap"></div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const PASS = new URLSearchParams(location.search).get('pass') || '';
let DATA = []; // { key, project, email, cookies, meta }
let activeTab = 'All';
let expandedKey = null;

// Auto-login if pass in URL
if (PASS) sessionStorage.setItem('kv_admin_pass', PASS);

document.getElementById('passInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

async function doLogin() {
  const p = document.getElementById('passInput').value || sessionStorage.getItem('kv_admin_pass');
  const ok = await api('/api/auth', { pass: p });
  if (ok.ok) {
    sessionStorage.setItem('kv_admin_pass', p);
    document.getElementById('loginBox').style.display = 'none';
    document.getElementById('mainPanel').style.display = 'block';
    loadData();
  } else {
    document.getElementById('loginErr').style.display = 'block';
  }
}

// Try sessionStorage pass on load
(async function() {
  const saved = sessionStorage.getItem('kv_admin_pass');
  if (saved) {
    document.getElementById('passInput').value = saved;
    await doLogin();
  }
  if (location.search.includes('pass=')) {
    document.getElementById('passInput').value = PASS;
    await doLogin();
  }
})();

async function api(path, body) {
  const pass = sessionStorage.getItem('kv_admin_pass');
  try {
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type':'application/json', 'X-Admin-Pass': pass || '' },
      body: JSON.stringify(body || {}),
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch(e) { return { ok:false, error: text }; }
  } catch(e) { return { ok:false, error: e.message }; }
}

function toast(msg, type='ok') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3000);
}

async function loadData() {
  document.getElementById('tableWrap').innerHTML = '<div class="loading">Loading...</div>';
  const r = await api('/api/list', {});
  if (!r.ok) { document.getElementById('tableWrap').innerHTML = '<div class="empty">Failed to load: ' + htmlEscape(r.error||'') + '</div>'; return; }
  DATA = (r.entries || []).map(e => {
    let cookies = [];
    try { cookies = JSON.parse(e.value || '[]'); } catch(_) {}
    if (!Array.isArray(cookies)) cookies = [];
    const earliest = getEarliestExpiry(cookies);
    return {
      key: e.key, project: e.project, email: e.email,
      cookies, count: cookies.length,
      earliestExpiry: earliest ? earliest.getTime() : null,
      updated: e.metadata && e.metadata.updated ? new Date(e.metadata.updated).getTime() : null,
    };
  });
  buildTabs();
  renderTable();
}

function getEarliestExpiry(cks) {
  let earliest = null;
  for (const c of cks) {
    const exp = c.expires || c.expirationDate;
    if (typeof exp === 'number' && exp > 0) {
      const d = new Date(exp * 1000);
      if (!earliest || d < earliest) earliest = d;
    }
  }
  return earliest;
}

function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
}

function htmlEscape(s) {
  if (typeof s !== 'string') s = String(s);
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildTabs() {
  const projects = {};
  for (const d of DATA) { projects[d.project] = (projects[d.project]||0) + 1; }
  const tabs = document.getElementById('tabs');
  let html = '<button class="tab' + (activeTab==='All'?' active':'') + '" onclick="switchTab(\'All\')">All (' + DATA.length + ')</button>';
  for (const [proj, count] of Object.entries(projects).sort()) {
    html += '<button class="tab' + (activeTab===proj?' active':'') + '" onclick="switchTab(\''+proj+'\')">' + htmlEscape(proj) + ' (' + count + ')</button>';
  }
  tabs.innerHTML = html;
}

function switchTab(tab) {
  activeTab = tab;
  expandedKey = null;
  buildTabs();
  renderTable();
}

function renderTable() {
  const q = document.getElementById('searchInput').value.toLowerCase().trim();
  let filtered = DATA.filter(d => {
    if (activeTab !== 'All' && d.project !== activeTab) return false;
    if (q && !d.key.toLowerCase().includes(q) && !d.email.toLowerCase().includes(q)) return false;
    return true;
  });
  filtered.sort((a,b) => a.key.localeCompare(b.key));
  document.getElementById('countLabel').textContent = filtered.length + ' entries';

  if (filtered.length === 0) {
    document.getElementById('tableWrap').innerHTML = '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12h6"/><path d="M12 9v6"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg><div>No entries found</div></div>';
    return;
  }

  let html = '<table><thead><tr><th>Key</th><th>Project</th><th>Email</th><th>Cookies</th><th>Earliest Expiry</th><th>Updated</th><th>Actions</th></tr></thead><tbody>';
  let projBadgeClass = (proj) => {
    const map = {'Katabump':'proj-katabump','Zampto':'proj-zampto','Vortexa':'proj-vortexa','Weirdhost':'proj-weirdhost','FreeMCHost':'proj-freemchost'};
    return map[proj] || 'proj-unknown';
  };
  for (const d of filtered) {
    const expanded = expandedKey === d.key;
    html += '<tr class="' + (expanded?'expanded':'') + '" onclick="toggleExpand(\'' + htmlEscape(d.key) + '\')">';
    html += '<td class="key-cell" title="' + htmlEscape(d.key) + '">' + htmlEscape(d.key) + '</td>';
    html += '<td><span class="proj-badge ' + projBadgeClass(d.project) + '">' + htmlEscape(d.project) + '</span></td>';
    html += '<td class="email-cell" title="' + htmlEscape(d.email) + '">' + htmlEscape(d.email) + '</td>';
    html += '<td><span class="num-badge">' + d.count + '</span></td>';
    html += '<td class="expiry-cell">' + (d.earliestExpiry ? fmtDate(d.earliestExpiry) : '-') + '</td>';
    html += '<td class="updated-cell">' + (d.updated ? fmtDate(d.updated) : '-') + '</td>';
    html += '<td class="actions-cell"><button class="btn-del" onclick="event.stopPropagation();confirmDelete(\'' + htmlEscape(d.key) + '\')">Delete</button></td>';
    html += '</tr>';
    if (expanded) {
      html += '<tr class="detail-row"><td colspan="7"><div class="detail-inner">';
      html += '<div class="meta">Key: ' + htmlEscape(d.key) + ' &middot; ' + d.count + ' cookies &middot; Expires: ' + (d.earliestExpiry ? fmtDate(d.earliestExpiry) : '-') + '</div>';
      html += '<pre>' + htmlEscape(JSON.stringify(d.cookies, null, 2)) + '</pre>';
      html += '</div></td></tr>';
    }
  }
  html += '</tbody></table>';
  document.getElementById('tableWrap').innerHTML = html;
}

function toggleExpand(key) {
  expandedKey = expandedKey === key ? null : key;
  renderTable();
}

async function confirmDelete(key) {
  const box = document.createElement('div');
  box.className = 'modal-overlay';
  box.innerHTML = '<div class="modal-box"><h3>Delete cookie entry?</h3><p>Key: <strong>' + htmlEscape(key) + '</strong><br>This will remove the saved login cookie. The next renewal will need a fresh login.</p><div class="modal-actions"><button class="cancel" onclick="this.closest(\\'.modal-overlay\\').remove()">Cancel</button><button class="confirm" onclick="this.closest(\\'.modal-overlay\\').remove();doDelete(\\'' + htmlEscape(key) + '\\')">Delete</button></div></div>';
  document.body.appendChild(box);
}

async function doDelete(key) {
  const r = await api('/api/delete', { key });
  if (r.ok) { toast('Deleted: ' + key); await loadData(); }
  else toast('Delete failed: ' + (r.error||'unknown'), 'err');
}

async function doRefresh() { await loadData(); toast('Refreshed'); }
</script>
</body>
</html>`;

// === Worker 路由 ===
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // 密码（从 header 或 query 读取）
    function getPass(req, u) {
      return req.headers.get('X-Admin-Pass') || u.searchParams.get('pass') || '';
    }

    const ADMIN_PASS = env.KV_ADMIN_PASS || '';

    // POST /api/auth — 验证密码
    if (url.pathname === '/api/auth' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const pass = body.pass || '';
      console.log(`[auth] ADMIN_PASS set: ${!!ADMIN_PASS}, received pass length: ${pass.length}, match: ${pass === ADMIN_PASS}`);
      if (!ADMIN_PASS || pass === ADMIN_PASS) {
        return json({ ok: true });
      }
      return json({ ok: false, error: 'invalid password' }, 401);
    }

    // 其余 API 需要密码验证
    if (url.pathname.startsWith('/api/')) {
      const pass = getPass(request, url);
      if (ADMIN_PASS && pass !== ADMIN_PASS) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
    }

    // POST /api/list — 列出所有 cookie 条目
    if (url.pathname === '/api/list' && method === 'POST') {
      const prefix = '_cookie_';
      // Workers KV list 不支持通配符，只能列出所有 key 再筛选
      let cursor = undefined;
      const entries = [];
      do {
        const listOpts = { cursor };
        const page = await env.COOKIE_KV.list(listOpts);
        for (const key of page.keys) {
          if (key.name.includes(prefix)) {
            // 读取 value
            const value = await env.COOKIE_KV.get(key.name);
            if (value !== null) {
              entries.push({
                key: key.name,
                value,
                project: extractProject(key.name),
                email: extractEmail(key.name),
                metadata: key.metadata || null,
              });
            }
          }
        }
        cursor = page.cursor;
      } while (cursor);
      entries.sort((a, b) => a.key.localeCompare(b.key));
      return json({ ok: true, entries });
    }

    // POST /api/get — 获取单个 key 的 value
    if (url.pathname === '/api/get' && method === 'POST') {
      const body = await request.json();
      const key = body.key;
      if (!key) return json({ ok: false, error: 'missing key' });
      const value = await env.COOKIE_KV.get(key);
      // 读 metadata
      const meta = (await env.COOKIE_KV.getWithMetadata(key)).metadata || null;
      return json({ ok: true, key, value, metadata: meta });
    }

    // POST /api/delete — 删除单个 key
    if (url.pathname === '/api/delete' && method === 'POST') {
      const body = await request.json();
      const key = body.key;
      if (!key) return json({ ok: false, error: 'missing key' });
      await env.COOKIE_KV.delete(key);
      return json({ ok: true, key, deleted: true });
    }

    // GET / — 返回 HTML 界面
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(HTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    return new Response('Not Found', { status: 404 });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json;charset=utf-8' },
  });
}