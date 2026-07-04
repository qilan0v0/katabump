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
  { label: 'Gaming4Free', prefix: 'gaming4free_cookie_' },
  { label: 'BotHosting', prefix: 'bothosting_cookie_' },
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
'<title>KV Cookie 管理</title>' +
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
'.proj-gaming4free{background:#ffd70022;color:#ffd700}' +
'.proj-unknown{background:#30363d44;color:#8b949e}' +
'.email-cell{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.num-badge{display:inline-block;min-width:22px;text-align:center;padding:1px 6px;border-radius:8px;font-size:11px;background:#30363d;color:#e6edf3}' +
'.expiry-cell{font-size:12px;color:#8b949e;white-space:nowrap}' +
'.updated-cell{font-size:12px;color:#8b949e;white-space:nowrap}' +
'.btn-del{display:inline-block;padding:4px 10px;border-radius:4px;border:1px solid #f8514944;background:transparent;color:#f85149;font-size:11px;cursor:pointer}' +
'.btn-del:hover{background:#f8514911;border-color:#f85149}' +
'.btn-edit{display:inline-block;padding:4px 10px;border-radius:4px;border:1px solid #58a6ff44;background:transparent;color:#58a6ff;font-size:11px;cursor:pointer}' +
'.btn-edit:hover{background:#58a6ff11;border-color:#58a6ff}' +
'.btn-add{display:inline-block;padding:4px 12px;border-radius:4px;border:1px solid #3fb95044;background:#3fb95011;color:#3fb950;font-size:12px;cursor:pointer}' +
'.btn-add:hover{background:#3fb95022}' +
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
'.modal-wide{max-width:640px}' +
'.editor-row{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}' +
'.editor-row select,.editor-row input{flex:1;min-width:120px;padding:8px 12px;border:1px solid #30363d;border-radius:6px;background:#161b22;color:#e6edf3;font-size:13px;outline:none}' +
'.editor-row select:focus,.editor-row input:focus{border-color:#58a6ff}' +
'.key-preview{padding:6px 10px;border-radius:4px;background:#21262d;color:#8b949e;font-size:11px;font-family:monospace;word-break:break-all;margin-bottom:12px}' +
'.editor-value textarea{width:100%;padding:10px;border:1px solid #30363d;border-radius:6px;background:#161b22;color:#e6edf3;font-size:12px;font-family:monospace;outline:none;resize:vertical;min-height:180px}' +
'.editor-value textarea:focus{border-color:#58a6ff}' +
'.editor-hint{font-size:11px;color:#8b949e;margin-bottom:8px}' +
'</style>' +
'</head>' +
'<body>' +
'<div id="app">' +
'  <div class="login-box" id="loginBox">' +
'    <h1>KV Cookie 管理</h1>' +
'    <input type="password" id="passInput" placeholder="输入管理员密码" autofocus>' +
'    <button id="loginBtn" class="login-btn">登录</button>' +
'    <div class="err" id="loginErr">密码错误</div>' +
'  </div>' +
'  <div id="mainPanel" style="display:none">' +
'    <div class="container">' +
'      <div style="display:flex;justify-content:space-between;align-items:center">' +
'        <div><h1>KV Cookie 管理</h1><div class="sub">管理 KV 中存储的登录 Cookie</div></div>' +
'        <div style="display:flex;gap:6px"><button class="btn-add" data-action="addCK">新增</button><button class="btn-del" data-action="refresh" style="color:#8b949e;border-color:#30363d">刷新</button></div>' +
'      </div>' +
'      <div class="tabs" id="tabs"></div>' +
'      <div class="search-row">' +
'        <input type="text" id="searchInput" placeholder="按 Key 或邮箱搜索…">' +
'        <span class="count" id="countLabel">0 条记录</span>' +
'      </div>' +
'      <div id="tableWrap"></div>' +
'    </div>' +
'  </div>' +
'</div>' +
'<div class="toast" id="toast"></div>' +
'<script>' +
'const PASS=(new URLSearchParams(location.search)).get("pass")||"";' +
'let DATA=[];' +
'let activeTab="全部";' +
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
'  else if(a==="refresh")doRefresh();' +
'  else if(a==="addCK")showCKEditor(null,null);' +
'  else if(a==="editCK"){e.stopPropagation();(function(){var k=t.dataset.key;for(var i=0;i<DATA.length;i++){if(DATA[i].key===k){showCKEditor(k,JSON.stringify(DATA[i].cookies,null,2));return}}})()}' +
'  else if(a==="saveCK"){var k=t.dataset.key||"";doSaveCK(k)}' +
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
'  }catch(e){console.error(e);document.getElementById("loginErr").textContent="错误： "+e.message;document.getElementById("loginErr").style.display="block"}' +
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
'  document.getElementById("tableWrap").innerHTML="<div class=\\"loading\\">加载中…</div>";' +
'  var r=await api("/api/list",{});' +
'  if(!r.ok){document.getElementById("tableWrap").innerHTML="<div class=\\"empty\\">加载失败</div>";return}' +
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
'  var h="<button class=\\"tab"+(activeTab==="全部"?" active":"")+"\\" data-action=\\"switchTab\\" data-tab=\\"全部\\">全部 ("+DATA.length+")</button>";' +
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
'    if(activeTab!=="全部"&&d.project!==activeTab)return false;' +
'    if(q&&d.key.toLowerCase().indexOf(q)===-1&&d.email.toLowerCase().indexOf(q)===-1)return false;' +
'    return true' +
'  });' +
'  f.sort(function(a,b){return a.key<b.key?-1:a.key>b.key?1:0});' +
'  document.getElementById("countLabel").textContent=f.length+" 条记录";' +
'  if(f.length===0){document.getElementById("tableWrap").innerHTML="<div class=\\"empty\\">无记录</div>";return}' +
'  var pbc=function(proj){' +
'    var m={Katabump:"proj-katabump",Zampto:"proj-zampto",Vortexa:"proj-vortexa",Weirdhost:"proj-weirdhost",FreeMCHost:"proj-freemchost",Gaming4Free:"proj-gaming4free"};' +
'    return m[proj]||"proj-unknown"' +
'  };' +
'  var h="<table><thead><tr><th>键名</th><th>项目</th><th>邮箱</th><th>Cookie</th><th>最早过期</th><th>更新时间</th><th>操作</th></tr></thead><tbody>";' +
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
'    h+="<td class=\\"actions-cell\\"><button class=\\"btn-edit\\" data-action=\\"editCK\\" data-key=\\""+d.key+"\\" style=\\"margin-right:4px\\">编辑</button><button class=\\"btn-del\\" data-action=\\"deleteKey\\" data-key=\\""+d.key+"\\">删除</button></td>";' +
'    h+="</tr>";' +
'    if(exp){' +
'      h+="<tr class=\\"detail-row\\"><td colspan=\\"7\\"><div class=\\"detail-inner\\">";' +
'      h+="<div class=\\"meta\\">键名： "+d.key+" &middot; "+d.count+" 个 Cookie <button class=\\"btn-edit\\" data-action=\\"editCK\\" data-key=\\""+d.key+"\\" style=\\"margin-left:8px\\">编辑</button></div>";' +
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
'  box.innerHTML="<div class=\\"modal-box\\"><h3>删除此 Cookie 记录？</h3><p>键名： <strong>"+key+"</strong><br>这将移除已保存的登录 Cookie。</p><div class=\\"modal-actions\\"><button class=\\"cancel\\" data-action=\\"closeModal\\">取消</button><button class=\\"confirm\\" data-action=\\"confirmDelete\\" data-key=\\""+key+"\\">删除</button></div></div>";' +
'  document.body.appendChild(box)' +
'}' +
'async function doDelete(key){' +
'  var r=await api("/api/delete",{key:key});' +
'  if(r.ok){toast("已删除： "+key);await loadData()}else toast("删除失败","err")' +
'}' +
'function doRefresh(){loadData();toast("已刷新")}' +
'var PROJECTS=[{label:"Katabump",prefix:"katabump_cookie_"},{label:"Zampto",prefix:"zampto_cookie_"},{label:"Vortexa",prefix:"vortexa_cookie_"},{label:"Weirdhost",prefix:"weirdhost_cookie_"},{label:"FreeMCHost",prefix:"freemchost_cookie_"},{label:"Gaming4Free",prefix:"gaming4free_cookie_"},{label:"BotHosting",prefix:"bothosting_cookie_"}];' +
'function showCKEditor(key,rawVal){' +
'  var isNew=!key;var proj="";var suf="";var ckText="[]";' +
'  if(key){for(var i=0;i<PROJECTS.length;i++){if(key.startsWith(PROJECTS[i].prefix)){proj=PROJECTS[i].label;suf=key.slice(PROJECTS[i].prefix.length);break}}}' +
'  if(rawVal){try{ckText=JSON.stringify(JSON.parse(rawVal),null,2)}catch(e){ckText=rawVal}}' +
'  var box=document.createElement("div");box.className="modal-overlay";' +
'  var h="<div class=\\"modal-box modal-wide\\"><h3>"+(isNew?"新增 Cookie":"编辑 Cookie")+"</h3>";' +
'  h+="<div class=\\"editor-row\\"><select id=\\"ckProject\\">";' +
'  for(var i=0;i<PROJECTS.length;i++){h+="<option value=\\""+PROJECTS[i].label+"\\""+(PROJECTS[i].label===proj?" selected":"")+">"+PROJECTS[i].label+"</option>"}' +
'  h+="</select><input id=\\"ckSuffix\\" value=\\""+suf+"\\" placeholder=\\"邮箱或标识\\"></div>";' +
'  h+="<div id=\\"ckKeyPreview\\" class=\\"key-preview\\">"+(key?key:"")+"</div>";' +
'  h+="<div class=\\"editor-value\\"><div class=\\"editor-hint\\">Cookie JSON 数组（每个对象含 name,value,domain,expires 等字段）</div><textarea id=\\"ckValue\\">"+ckText+"</textarea></div>";' +
'  h+="<div class=\\"modal-actions\\"><button class=\\"cancel\\" data-action=\\"closeModal\\">取消</button>";' +
'  if(key){h+="<button class=\\"confirm\\" data-action=\\"saveCK\\" data-key=\\""+key+"\\" style=\\"background:#238636;border-color:#238636\\">保存</button>"}else{h+="<button class=\\"confirm\\" data-action=\\"saveCK\\" style=\\"background:#238636;border-color:#238636\\">保存</button>"}' +
'  h+="</div></div>";box.innerHTML=h;document.body.appendChild(box);' +
'  document.getElementById("ckProject").addEventListener("change",function(){updateKeyPreview()});' +
'  document.getElementById("ckSuffix").addEventListener("input",function(){updateKeyPreview()});' +
'  function updateKeyPreview(){var sel=document.getElementById("ckProject");var pfx="";for(var i=0;i<PROJECTS.length;i++){if(PROJECTS[i].label===sel.value){pfx=PROJECTS[i].prefix;break}}document.getElementById("ckKeyPreview").textContent=pfx+document.getElementById("ckSuffix").value}' +
'}' +
'function getFullKey(){var sel=document.getElementById("ckProject");var pfx="";for(var i=0;i<PROJECTS.length;i++){if(PROJECTS[i].label===sel.value){pfx=PROJECTS[i].prefix;break}}return pfx+document.getElementById("ckSuffix").value}' +
'async function doSaveCK(key){' +
'  var fullKey=key||getFullKey();' +
'  if(!fullKey||fullKey.indexOf("_cookie_")===-1){toast("Key 格式错误","err");return}' +
'  var val=document.getElementById("ckValue").value;' +
'  if(!val){toast("请输入 Cookie 数据","err");return}' +
'  try{JSON.parse(val)}catch(e){toast("JSON 格式错误: "+e.message,"err");return}' +
'  var r=await api("/api/set",{key:fullKey,value:val});' +
'  if(r.ok){toast("已保存: "+fullKey);var m=document.querySelector(".modal-overlay");if(m)m.remove();await loadData()}else toast("保存失败","err")}' +
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

    if (url.pathname === '/api/set' && method === 'POST') {
      const body = await request.json();
      const key = body.key;
      const value = body.value;
      if (!key) return json({ ok: false, error: 'missing key' });
      if (value === undefined || value === null) return json({ ok: false, error: 'missing value' });
      await env.COOKIE_KV.put(key, String(value));
      return json({ ok: true, key });
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