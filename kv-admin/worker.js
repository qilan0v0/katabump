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

function extractEmail(key) {
  for (const p of PROJECT_PREFIXES) {
    if (key.startsWith(p.prefix)) return key.slice(p.prefix.length);
  }
  return key;
}

function extractProject(key) {
  for (const p of PROJECT_PREFIXES) {
    if (key.startsWith(p.prefix)) return p.label;
  }
  return 'Unknown';
}

function getEarliestExpiry(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  let earliest = Infinity;
  for (const c of cookies) {
    const exp = c.expires || c.expirationDate;
    if (typeof exp === 'number' && exp > 0 && exp < earliest) earliest = exp;
  }
  return earliest === Infinity ? null : new Date(earliest * 1000);
}

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function htmlEscape(s) {
  if (typeof s !== 'string') s = String(s);
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// === HTML 管理界面 (SPA) ===
// 注意：所有 onclick 使用 data-action 事件委托，不用内联 onclick 属性
const HTML = '<!DOCTYPE html>' +
'<html lang="zh-CN">' +
'<head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1.0">' +
'<title>KV Cookie Admin</title>' +
'<style>' +
'*{margin:0;padding:0;box-sizing:border-box}' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#e6edf3}' +
'.container{max-width:1200px;margin:0 auto;padding:20px}' +
'h1{font-size:22px;font-weight:600;margin-bottom:4px}' +
'.sub{color:#8b949e;font-size:13px;margin-bottom:20px}' +
'.login-box{max-width:360px;margin:120px auto;text-align:center}' +
'.login-box input{width:100%;padding:10px 14px;border:1px solid #30363d;border-radius:6px;background:#161b22;color:#e6edf3;font-size:14px;outline:none}' +
'.login-box input:focus{border-color:#58a6ff}' +
'.login-box .err{color:#f85149;font-size:13px;margin-top:8px;display:none}' +
'.login-btn{width:100%;margin-top:12px;padding:10px 14px;border:1px solid #1f6feb;border-radius:6px;background:#1f6feb;color:#fff;font-size:14px;cursor:pointer}' +
'.login-btn:hover{background:#388bfd}' +
'.tabs{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}' +
'.tab{padding:6px 14px;border-radius:20px;font-size:13px;cursor:pointer;border:1px solid #30363d;background:transparent;color:#8b949e}' +
'.tab:hover{border-color:#58a6ff;color:#e6edf3}' +
'.tab.active{background:#1f6feb;border-color:#1f6feb;color:#fff}' +
'.search-row{display:flex;gap:8px;margin-bottom:16px;align-items:center}' +
'.search-row input{flex:1;padding:8px 12px;border:1px solid #30363d;border-radius:6px;background:#161b22;color:#e6edf3;font-size:13px;outline:none}' +
'.search-row input:focus{border-color:#58a6ff}' +
'.search-row .count{font-size:12px;color:#8b949e;white-space:nowrap}' +
'table{width:100%;border-collapse:collapse;font-size:13px}' +
'th{text-align:left;padding:10px 12px;border-bottom:1px solid #30363d;color:#8b949e;font-weight:500;font-size:12px;white-space:nowrap}' +
'td{padding:10px 12px;border-bottom:1px solid #21262d;vertical-align:middle}' +
'tr:hover td{background:#161b22}' +
'tr.expanded td{background:#0d1117}' +
'.key-cell{font-family:monospace;font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.proj-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}' +
'.proj-katabump{background:#1f6feb22;color:#58a6ff}' +
'.proj-zampto{background:#d2a8ff22;color:#d2a8ff}' +
'.proj-vortexa{background:#3fb95022;color:#3fb950}' +
'.proj-weirdhost{background:#f0883e22;color:#f0883e}' +
'.proj-freemchost{background:#f778ba22;color:#f778ba}' +
'.proj-unknown{background:#30363d44;color:#8b949e}' +
'.email-cell{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.num-badge{display:inline-block;min-width:22px;text-align:center;padding:1px 6px;border-radius:8px;font-size:11px;background:#30363d;color:#e6edf3}' +
'.expiry-cell{font-size:12px;color:#8b949e;white-space:nowrap}' +
'.updated-cell{font-size:12px;color:#8b949e;white-space:nowrap}' +
'.btn-del{padding:4px 10px;border-radius:4px;border:1px solid #f8514944;background:transparent;color:#f85149;font-size:11px;cursor:pointer}' +
'.btn-del:hover{background:#f8514911;border-color:#f85149}' +
'.detail-row td{padding:0}' +
'.detail-inner{padding:12px 16px 16px 60px;background:#0d1117;border-bottom:1px solid #30363d}' +
'.detail-inner pre{font-size:11px;line-height:1.5;background:#161b22;padding:12px;border-radius:6px;overflow-x:auto;max-height:400px}' +
'.detail-inner .meta{font-size:12px;color:#8b949e;margin-bottom:8px}' +
'.loading{text-align:center;padding:60px 0;color:#8b949e}' +
'.empty{text-align:center;padding:60px 0;color:#8b949e}' +
'.toast{position:fixed;bottom:20px;right:20px;padding:10px 20px;border-radius:6px;font-size:13px;z-index:999;opacity:0;transform:translateY(10px);transition:.3s}' +
'.toast.show{opacity:1;transform:translateY(0)}' +
'.toast.ok{background:#3fb95022;border:1px solid #3fb95044;color:#3fb950}' +
'.toast.err{background:#f8514922;border:1px solid #f8514944;color:#f85149}' +
'.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;display:flex;align-items:center;justify-content:center}' +
'.modal-box{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;max-width:440px;width:90%}' +
'.modal-box h3{margin-bottom:8px}' +
'.modal-box p{font-size:13px;color:#8b949e;margin-bottom:16px}' +
'.modal-actions{display:flex;gap:8px;justify-content:flex-end}' +
'.modal-actions button{padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid #30363d}' +
'.modal-actions .cancel{background:transparent;color:#e6edf3}' +
'.modal-actions .confirm{background:#f85149;color:#fff;border-color:#f85149}' +
'</style>' +
'</head>' +
'<body>' +
'<div id="app">' +
'  <div class="login-box" id="loginBox">' +
'    <h1>KV Cookie Admin</h1>' +
'    <input type="password" id="passInput" placeholder="Enter admin password" autofocus>' +
'    <button id="loginBtn" class="login-btn">Sign In</button>' +
'    <div class="err" id="loginErr">Invalid password</div>' +
'  </div>' +
'  <div id="mainPanel" style="display:none">' +
'    <div class="container">' +
'      <div style="display:flex;justify-content:space-between;align-items:center">' +
'        <div><h1>KV Cookie Admin</h1><div class="sub">Manage KV-stored login cookies</div></div>' +
'        <button class="btn-del" data-action="refresh" style="color:#8b949e;border-color:#30363d">Refresh</button>' +
'      </div>' +
'      <div class="tabs" id="tabs"></div>' +
'      <div class="search-row">' +
'        <input type="text" id="searchInput" placeholder="Search by key or email...">' +
'        <span class="count" id="countLabel">0 entries</span>' +
'      </div>' +
'      <div id="tableWrap"></div>' +
'    </div>' +
'  </div>' +
'</div>' +
'<div class="toast" id="toast"></div>' +
'<script>' +
'const PASS=(new URLSearchParams(location.search)).get("pass")||"";' +
'let DATA=[];' +
'let activeTab="All";' +
'let expandedKey=null;' +
'if(PASS) sessionStorage.setItem("kv_admin_pass",PASS);' +
'window.addEventListener("error",function(e){console.error("[ERR]",e.message)});' +
'console.log("[app] loaded");' +
'document.getElementById("passInput").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin()});' +
'document.getElementById("loginBtn").addEventListener("click",doLogin);' +
'document.addEventListener("click",function(e){' +
'  var t=e.target.closest("[data-action]");' +
'  if(!t)return;' +
'  var a=t.dataset.action;' +
'  if(a==="switchTab")switchTab(t.dataset.tab);' +
'  else if(a==="toggleExpand")toggleExpand(t.dataset.key);' +
'  else if(a==="deleteKey"){e.stopPropagation();confirmDelete(t.dataset.key)}' +
'  else if(a==="closeModal"){t.closest(".modal-overlay").remove()}' +
'  else if(a==="confirmDelete"){t.closest(".modal-overlay").remove();doDelete(t.dataset.key)}' +
'  else if(a==="refresh")doRefresh()' +
'});' +
'async function doLogin(){' +
'  var p=document.getElementById("passInput").value||sessionStorage.getItem("kv_admin_pass");' +
'  console.log("[login] len:",p?p.length:0);' +
'  if(!p){document.getElementById("loginErr").style.display="block";return}' +
'  try{' +
'    var r=await api("/api/auth",{pass:p});' +
'    if(r.ok){' +
'      sessionStorage.setItem("kv_admin_pass",p);' +
'      document.getElementById("loginBox").style.display="none";' +
'      document.getElementById("mainPanel").style.display="block";' +
'      loadData()' +
'    }else document.getElementById("loginErr").style.display="block"' +
'  }catch(e){console.error(e);document.getElementById("loginErr").textContent="Error: "+e.message;document.getElementById("loginErr").style.display="block"}' +
'}' +
'(async function(){' +
'  var s=sessionStorage.getItem("kv_admin_pass");' +
'  if(s){document.getElementById("passInput").value=s;await doLogin()}' +
'  if(location.search.includes("pass=")){document.getElementById("passInput").value=PASS;await doLogin()}' +
'})();' +
'async function api(path,body){' +
'  var pass=sessionStorage.getItem("kv_admin_pass");' +
'  try{' +
'    var r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-Admin-Pass":pass||""},body:JSON.stringify(body||{})});' +
'    var t=await r.text();' +
'    try{return JSON.parse(t)}catch(e){return{ok:false,error:t}}' +
'  }catch(e){return{ok:false,error:e.message}}' +
'}' +
'function toast(msg,type){' +
'  type=type||"ok";' +
'  var t=document.getElementById("toast");' +
'  t.textContent=msg;t.className="toast "+type+" show";' +
'  setTimeout(function(){t.classList.remove("show")},3000)' +
'}' +
'async function loadData(){' +
'  document.getElementById("tableWrap").innerHTML="<div class=\\"loading\\">Loading...</div>";' +
'  var r=await api("/api/list",{});' +
'  if(!r.ok){document.getElementById("tableWrap").innerHTML="<div class=\\"empty\\">Failed to load</div>";return}' +
'  DATA=(r.entries||[]).map(function(e){' +
'    var ck=[];try{ck=JSON.parse(e.value||"[]")}catch(_){}' +
'    if(!Array.isArray(ck))ck=[];' +
'    var ee=getEarliestExpiry2(ck);' +
'    return{key:e.key,project:e.project,email:e.email,cookies:ck,count:ck.length,earliestExpiry:ee?ee.getTime():null,updated:e.metadata&&e.metadata.updated?new Date(e.metadata.updated).getTime():null}' +
'  });' +
'  buildTabs();renderTable()' +
'}' +
'function getEarliestExpiry2(cks){' +
'  var e=null;' +
'  for(var i=0;i<cks.length;i++){' +
'    var x=cks[i].expires||cks[i].expirationDate;' +
'    if(typeof x==="number"&&x>0){var d=new Date(x*1000);if(!e||d<e)e=d}' +
'  }' +
'  return e' +
'}' +
'function fmtDate2(ts){' +
'  if(!ts)return"-";' +
'  var d=new Date(ts);' +
'  return d.toLocaleDateString("zh-CN")+" "+d.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})' +
'}' +
'function buildTabs(){' +
'  var p={};' +
'  for(var i=0;i<DATA.length;i++){var pr=DATA[i].project;p[pr]=(p[pr]||0)+1}' +
'  var tabs=document.getElementById("tabs");' +
'  var h="<button class=\\"tab"+(activeTab==="All"?" active":"")+"\\" data-action=\\"switchTab\\" data-tab=\\"All\\">All ("+DATA.length+")</button>";' +
'  var keys=Object.keys(p).sort();' +
'  for(var i=0;i<keys.length;i++){' +
'    var proj=keys[i];' +
'    h+="<button class=\\"tab"+(activeTab===proj?" active":"")+"\\" data-action=\\"switchTab\\" data-tab=\\""+proj+"\\">"+proj+" ("+p[proj]+")</button>"' +
'  }' +
'  tabs.innerHTML=h' +
'}' +
'function switchTab(tab){activeTab=tab;expandedKey=null;buildTabs();renderTable()}' +
'function renderTable(){' +
'  var q=document.getElementById("searchInput").value.toLowerCase().trim();' +
'  var f=DATA.filter(function(d){' +
'    if(activeTab!=="All"&&d.project!==activeTab)return false;' +
'    if(q&&d.key.toLowerCase().indexOf(q)===-1&&d.email.toLowerCase().indexOf(q)===-1)return false;' +
'    return true' +
'  });' +
'  f.sort(function(a,b){return a.key<b.key?-1:a.key>b.key?1:0});' +
'  document.getElementById("countLabel").textContent=f.length+" entries";' +
'  if(f.length===0){document.getElementById("tableWrap").innerHTML="<div class=\\"empty\\">No entries</div>";return}' +
'  var pbc=function(proj){' +
'    var m={Katabump:"proj-katabump",Zampto:"proj-zampto",Vortexa:"proj-vortexa",Weirdhost:"proj-weirdhost",FreeMCHost:"proj-freemchost"};' +
'    return m[proj]||"proj-unknown"' +
'  };' +
'  var h="<table><thead><tr><th>Key</th><th>Project</th><th>Email</th><th>Cookies</th><th>Earliest Expiry</th><th>Updated</th><th>Actions</th></tr></thead><tbody>";' +
'  for(var i=0;i<f.length;i++){' +
'    var d=f[i];' +
'    var exp=expandedKey===d.key;' +
'    h+="<tr class=\\""+(exp?"expanded":"")+"\\" data-action=\\"toggleExpand\\" data-key=\\""+d.key+"\\">";' +
'    h+="<td class=\\"key-cell\\" title=\\""+d.key+"\\">"+d.key+"</td>";' +
'    h+="<td><span class=\\"proj-badge "+pbc(d.project)+"\\">"+d.project+"</span></td>";' +
'    h+="<td class=\\"email-cell\\" title=\\""+d.email+"\\">"+d.email+"</td>";' +
'    h+="<td><span class=\\"num-badge\\">"+d.count+"</span></td>";' +
'    h+="<td class=\\"expiry-cell\\">"+(d.earliestExpiry?fmtDate2(d.earliestExpiry):"-")+"</td>";' +
'    h+="<td class=\\"updated-cell\\">"+(d.updated?fmtDate2(d.updated):"-")+"</td>";' +
'    h+="<td class=\\"actions-cell\\"><button class=\\"btn-del\\" data-action=\\"deleteKey\\" data-key=\\""+d.key+"\\">Delete</button></td>";' +
'    h+="</tr>";' +
'    if(exp){' +
'      h+="<tr class=\\"detail-row\\"><td colspan=\\"7\\"><div class=\\"detail-inner\\">";' +
'      h+="<div class=\\"meta\\">Key: "+d.key+" &middot; "+d.count+" cookies</div>";' +
'      h+="<pre>"+JSON.stringify(d.cookies,null,2)+"</pre>";' +
'      h+="</div></td></tr>"' +
'    }' +
'  }' +
'  h+="</tbody></table>";' +
'  document.getElementById("tableWrap").innerHTML=h' +
'}' +
'function toggleExpand(key){' +
'  expandedKey=expandedKey===key?null:key;' +
'  renderTable()' +
'}' +
'async function confirmDelete(key){' +
'  var box=document.createElement("div");' +
'  box.className="modal-overlay";' +
'  box.innerHTML="<div class=\\"modal-box\\"><h3>Delete cookie entry?</h3><p>Key: <strong>"+key+"</strong><br>This will remove the saved login cookie.</p><div class=\\"modal-actions\\"><button class=\\"cancel\\" data-action=\\"closeModal\\">Cancel</button><button class=\\"confirm\\" data-action=\\"confirmDelete\\" data-key=\\""+key+"\\">Delete</button></div></div>";' +
'  document.body.appendChild(box)' +
'}' +
'async function doDelete(key){' +
'  var r=await api("/api/delete",{key:key});' +
'  if(r.ok){toast("Deleted: "+key);await loadData()}else toast("Delete failed","err")' +
'}' +
'function doRefresh(){loadData();toast("Refreshed")}' +
'</script>' +
'</body>' +
'</html>';

// === Worker 路由 ===
function getPass(req, u) {
  return req.headers.get('X-Admin-Pass') || u.searchParams.get('pass') || '';
}

export default {
  async fetch(request, env) {
    try {
    const url = new URL(request.url);
    const method = request.method;
    const ADMIN_PASS = env.KV_ADMIN_PASS || '';

    if (url.pathname === '/api/auth' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const pass = body.pass || '';
      console.log('[auth] ADMIN_PASS set: ' + !!ADMIN_PASS + ', pass len: ' + pass.length);
      if (!ADMIN_PASS || pass === ADMIN_PASS) {
        return json({ ok: true });
      }
      return json({ ok: false, error: 'invalid password' }, 401);
    }

    if (url.pathname.startsWith('/api/')) {
      const pass = getPass(request, url);
      if (ADMIN_PASS && pass !== ADMIN_PASS) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
    }

    if (url.pathname === '/api/list' && method === 'POST') {
      const prefix = '_cookie_';
      let cursor = undefined;
      const entries = [];
      do {
        const listOpts = { cursor };
        const page = await env.COOKIE_KV.list(listOpts);
        for (const key of page.keys) {
          if (key.name.includes(prefix)) {
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

    if (url.pathname === '/api/get' && method === 'POST') {
      const body = await request.json();
      const key = body.key;
      if (!key) return json({ ok: false, error: 'missing key' });
      const value = await env.COOKIE_KV.get(key);
      return json({ ok: true, key, value });
    }

    if (url.pathname === '/api/delete' && method === 'POST') {
      const body = await request.json();
      const key = body.key;
      if (!key) return json({ ok: false, error: 'missing key' });
      await env.COOKIE_KV.delete(key);
      return json({ ok: true, key, deleted: true });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(HTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    return new Response('Not Found', { status: 404 });
    } catch (e) {
      console.error('[worker] error: ' + e.message);
      return new Response('Internal Error: ' + e.message, { status: 500 });
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json;charset=utf-8' },
  });
}