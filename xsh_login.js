/**
 * X Systems Hosting — Discord Token 登录 + 自动看广告 (纯 API 版)
 * ================================================================
 * 全程无需浏览器！使用纯 HTTP API：
 *   1. Discord OAuth → 获取授权码 (API)
 *   2. xsystemshosting callback → 获取 session cookie (HTTP)
 *   3. 存取 CK (KV 缓存 session cookie，免重复登录)
 *   4. 获取广告页 token + csrf (HTTP)
 *   5. 心跳 + 领取积分 (HTTP)
 *
 * 环境变量:
 *   XSH_USERS_JSON = [{"Discord-token":"MTM3..."}]
 *   KV_ADMIN_URL   = (可选) KV 存储 URL
 *   KV_ADMIN_PASS  = (可选) KV 存储密码
 *   HTTP_PROXY     = (可选) http://user:pass@host:port
 *   TG_BOT_TOKEN   = (可选) Telegram 通知
 *   TG_CHAT_ID     = (可选)
 *   TG_THREAD_ID   = (可选)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const XSH_BASE = 'https://xsystemshosting.com';
const DISCORD_API = 'https://discord.com/api/v10';
const CLIENT_ID = '1472320867060023540';
const REDIRECT_URI = `${XSH_BASE}/auth/discord/callback`;
const SCOPES = 'identify email';
const MAX_ADS_PER_DAY = 25;

// ---------- KV Cookie 存储 (同其他工作流) ----------
const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);

async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await axios.post(KV_ADMIN_URL + '/api/get', { key }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 15000, proxy: false,
    });
    if (r.data.ok && r.data.value != null) {
      console.log(`[KV] 读取 CK 成功，长度: ${String(r.data.value).length}`);
      return typeof r.data.value === 'string' ? r.data.value : JSON.stringify(r.data.value);
    }
    console.log('[KV] 暂无已存 CK');
    return null;
  } catch (e) {
    if (e.response && e.response.status === 404) { console.log('[KV] 暂无已存 CK'); return null; }
    console.warn('[KV] 读取 CK 失败:', e.message);
    return null;
  }
}

async function kvPut(key, value) {
  if (!KV_ENABLED) return false;
  try {
    await axios.post(KV_ADMIN_URL + '/api/set', { key, value: String(value) }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 15000, proxy: false,
    });
    console.log('[KV] CK 已保存');
    return true;
  } catch (e) {
    console.warn('[KV] 写入 CK 失败:', e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    return false;
  }
}

// ---------- 简易 cookie jar ----------
class CookieJar {
  constructor() {
    this.cookies = {};
  }
  /** 从 response headers 提取 set-cookie */
  setFromHeaders(headers) {
    const setCookies = headers['set-cookie'];
    if (!setCookies) return;
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const raw of list) {
      const eq = raw.indexOf('=');
      if (eq < 0) continue;
      const name = raw.substring(0, eq).trim();
      const semi = raw.indexOf(';', eq);
      const value = semi < 0 ? raw.substring(eq + 1) : raw.substring(eq + 1, semi);
      this.cookies[name] = value.trim();
    }
  }
  /** 从 JSON 字符串恢复 */
  fromJSON(str) {
    try { this.cookies = JSON.parse(str); } catch { this.cookies = {}; }
  }
  /** 序列化到 JSON 字符串 */
  toJSON() {
    return JSON.stringify(this.cookies);
  }
  /** 返回 Cookie header 字符串 */
  getHeader() {
    const parts = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`);
    return parts.join('; ');
  }
  /** 是否非空 */
  hasCookies() {
    return Object.keys(this.cookies).length > 0;
  }
}

// ---------- 创建 HTTP 客户端 ----------
function createClient(proxyUrl) {
  const cfg = {
    baseURL: XSH_BASE,
    timeout: 30000,
    maxRedirects: 0,
    validateStatus: (s) => s < 400 || s === 302 || s === 301,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  };
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    cfg.proxy = {
      host: url.hostname,
      port: parseInt(url.port) || 8080,
      protocol: url.protocol.replace(':', ''),
    };
    if (url.username) {
      cfg.proxy.auth = { username: url.username, password: url.password };
    }
  }
  return axios.create(cfg);
}

// ---------- 工具函数 ----------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg, label = '') {
  const prefix = label ? `[${label}]` : '[xsh]';
  console.log(`${prefix} ${msg}`);
}

// ---------- Telegram 通知 ----------
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;

async function sendTelegram(msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: 'Markdown' };
    if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
  } catch (e) {
    try {
      const payload = { chat_id: TG_CHAT_ID, text: msg };
      if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
      await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
    } catch {}
  }
}

// ---------- 步骤 1: 验证 CK 有效性 ----------
async function validateCK(jar) {
  if (!jar.hasCookies()) return false;
  // 尝试访问 dashboard，看是否被重定向到 login
  const client = createClient();
  try {
    const res = await client.get('/dashboard/discord', {
      headers: { Cookie: jar.getHeader() },
      maxRedirects: 0,
      validateStatus: (s) => true,
      timeout: 15000,
    });
    // 200 → 有效；302 到 /login → 过期
    if (res.status === 200) {
      log('  ✅ CK 有效，无需重新登录');
      return true;
    }
    log(`  ⚠️ CK 过期 (status=${res.status}, location=${res.headers['location'] || ''})`);
    return false;
  } catch (e) {
    log(`  ⚠️ CK 验证失败: ${e.message}`);
    return false;
  }
}

// ---------- 步骤 2: Discord OAuth 授权 ----------
async function discordOAuth(token) {
  log('Step 2: Discord OAuth 授权...');

  const userRes = await axios.get(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: token },
    timeout: 30000,
  });
  if (userRes.status !== 200) {
    throw new Error(`Discord token 无效: ${userRes.status}`);
  }
  const user = userRes.data;
  log(`  ✅ Discord 用户: ${user.global_name || user.username} (${user.id})`);

  const params = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code',
    redirect_uri: REDIRECT_URI, scope: SCOPES,
  });

  const authRes = await axios.post(
    `${DISCORD_API}/oauth2/authorize?${params}`,
    { authorize: true, client_id: CLIENT_ID, response_type: 'code',
      redirect_uri: REDIRECT_URI, scope: SCOPES, permissions: '0', integration_type: 0 },
    { headers: { Authorization: token, 'Content-Type': 'application/json' },
      timeout: 30000, maxRedirects: 0, validateStatus: (s) => true }
  );

  const location = authRes.headers['location'] || '';
  if (!location.includes('code=')) {
    if (authRes.data && authRes.data.location) {
      const code = new URL(authRes.data.location).searchParams.get('code');
      if (code) { log(`  ✅ 获取到授权码: ${code.substring(0, 20)}...`); return { code, user }; }
    }
    throw new Error(`OAuth 失败: ${authRes.status}, ${JSON.stringify(authRes.data || '').substring(0, 200)}`);
  }

  const code = new URL(location).searchParams.get('code');
  log(`  ✅ 获取到授权码: ${code.substring(0, 20)}...`);
  return { code, user };
}

// ---------- 手动跟随重定向（捕获每次 set-cookie） ----------
async function followRedirects(client, url, jar, options = {}) {
  const maxFollow = options.maxFollow || 5;
  let currentUrl = url;
  for (let i = 0; i < maxFollow; i++) {
    const res = await client.get(currentUrl, {
      headers: {
        Cookie: jar.getHeader(),
        ...((options.headers) || {}),
      },
      maxRedirects: 0,
      validateStatus: (s) => true,
      timeout: options.timeout || 15000,
    });
    jar.setFromHeaders(res.headers);
    const loc = res.headers['location'];
    if (!loc) return res;
    currentUrl = loc.startsWith('http') ? loc : `${XSH_BASE}${loc}`;
    log(`    → 跟随重定向 ${i + 1}: ${loc.substring(0, 60)}`, options.label || '');
  }
  // 最后一次尝试（最多 follow 次数后依然有重定向则返回最后一站）
  const finalRes = await client.get(currentUrl, {
    headers: { Cookie: jar.getHeader() },
    maxRedirects: 0, validateStatus: (s) => true, timeout: options.timeout || 15000,
  });
  jar.setFromHeaders(finalRes.headers);
  return finalRes;
}

// ---------- 步骤 3: 完成 xsystemshosting 登录 → 存 CK ----------
async function loginXSH(code, jar) {
  log('Step 3: 完成 xsystemshosting 登录...');

  const client = createClient();
  const callbackUrl = `${REDIRECT_URI}?code=${encodeURIComponent(code)}`;
  const res = await followRedirects(client, callbackUrl, jar, { label: 'login' });

  log(`  ✅ 登录完成 (${res.status})`);
  log(`  🍪 Cookie: ${Object.keys(jar.cookies).join(', ')}`);
  if (!jar.hasCookies()) {
    log(`  ⚠️ 未获取到任何 cookie! 响应头: ${JSON.stringify(res.headers)}`);
  }
  return jar;
}

// ---------- 步骤 4: 获取广告页 token+csrf ----------
async function fetchAdPage(jar) {
  log('Step 4: 获取广告页面...');

  const client = createClient();
  const res = await followRedirects(client, `${XSH_BASE}/quests/ad`, jar, { label: 'ad' });

  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

  let token = '', csrf = '';
  const tokenMatch = html.match(/name=["']token["'][^>]*value=["']([^"']+)["']/);
  if (tokenMatch) token = tokenMatch[1];
  const csrfMatch = html.match(/name=["']csrf["'][^>]*value=["']([^"']+)["']/);
  if (csrfMatch) csrf = csrfMatch[1];
  if (!token) {
    const tMatch = html.match(/token["']?\s*[:=]\s*["']([^"']+)["']/);
    if (tMatch) token = tMatch[1];
  }

  if (!token) {
    fs.writeFileSync('xsh-ad-page-debug.html', html);
    throw new Error('无法从广告页提取 token (已保存 xsh-ad-page-debug.html)');
  }

  log(`  ✅ token: ${token.substring(0, 20)}...`);
  return { token, csrf, html };
}

// ---------- 步骤 5: 心跳 ----------
async function sendHeartbeat(jar, token, csrf, seconds) {
  const client = createClient();
  const formData = new URLSearchParams();
  formData.append('token', token);
  formData.append('seconds', String(seconds));
  if (csrf) formData.append('csrf', csrf);

  const res = await client.post('/quests/ads/heartbeat', formData.toString(), {
    headers: { Cookie: jar.getHeader(), 'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${XSH_BASE}/quests/ad` },
    maxRedirects: 0, validateStatus: (s) => true,
  });
  jar.setFromHeaders(res.headers);
  return res.data;
}

// ---------- 步骤 6: 领取积分 ----------
async function claimCredit(jar, token, csrf) {
  log('Step 6: 领取积分...');

  const client = createClient();
  const formData = new URLSearchParams();
  formData.append('token', token);
  if (csrf) formData.append('csrf', csrf);

  const res = await client.post('/quests/ads/claim', formData.toString(), {
    headers: { Cookie: jar.getHeader(), 'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${XSH_BASE}/quests/ad` },
    maxRedirects: 0, validateStatus: (s) => true,
  });
  jar.setFromHeaders(res.headers);

  const location = res.headers['location'] || '';
  if (location.includes('notice=')) {
    const notice = decodeURIComponent(location.split('notice=')[1] || '');
    log(`  ✅ ${notice}`);
    return { success: true, notice };
  }
  if (res.status === 302) {
    log(`  ✅ 领取成功 (重定向: ${location})`);
    return { success: true, location };
  }
  try {
    const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    if (body.ok) return { success: true, ...body };
    return { success: false, ...body };
  } catch {
    return { success: false, error: `status=${res.status}` };
  }
}

// ---------- 处理单个用户 ----------
async function processUser(userData, index, total) {
  const token = userData['Discord-token'] || userData.token;
  const label = `${index + 1}/${total}`;
  const jar = new CookieJar();
  const ckKey = `xsh_${token.slice(0, 20)}`;

  console.log(`\n======= 用户 ${label} =======`);

  // ---- 尝试读取 CK ----
  const ckJson = await kvGet(ckKey);
  if (ckJson) {
    jar.fromJSON(ckJson);
    const valid = await validateCK(jar);
    if (valid) {
      log('使用已缓存 CK，跳过 Discord OAuth', label);
    } else {
      jar.cookies = {}; // 清空，重新登录
    }
  }

  // ---- 需要重新登录 ----
  if (!jar.hasCookies()) {
    try {
      const { code, user } = await discordOAuth(token);
      const username = user.global_name || user.username;
      log(`用户: ${username}`, label);
      await loginXSH(code, jar);
      // 保存 CK 到 KV
      await kvPut(ckKey, jar.toJSON());
    } catch (err) {
      log(`❌ 登录失败: ${err.message}`, label);
      return { success: false, error: err.message, adsWatched: 0, username: '?' };
    }
  }

  // ---- 看广告循环 ----
  let adCount = 0;
  for (let i = 0; i < MAX_ADS_PER_DAY; i++) {
    log(`\n--- 广告 ${i + 1}/${MAX_ADS_PER_DAY} ---`, label);

    try {
      const { token: adToken, csrf: adCsrf } = await fetchAdPage(jar);
      const hb = await sendHeartbeat(jar, adToken, adCsrf, 10);
      log(`心跳: ${JSON.stringify(hb)}`, label);

      const claimResult = await claimCredit(jar, adToken, adCsrf);
      if (claimResult.success) {
        adCount++;
        log(`🎉 累计 ${adCount} 个广告`, label);
      } else {
        log(`⚠️ 领取失败: ${JSON.stringify(claimResult)}`, label);
        break;
      }
      await sleep(1500);
    } catch (err) {
      if (err.message.includes('无法从广告页提取 token')) {
        log(`⚠️ 没有更多广告或已达当日上限`, label);
      } else {
        log(`❌ 广告 ${i + 1} 失败: ${err.message}`, label);
      }
      break;
    }
  }

  log(`\n✅ 完成，共观看 ${adCount} 个广告`, label);
  return { success: true, username: '', adsWatched: adCount };
}

// ---------- 入口 ----------
async function main() {
  console.log('🚀 X Systems Hosting 自动看广告 (纯 API + CK 版)');
  console.log('='.repeat(50));

  if (!KV_ENABLED) console.log('⚠️ 未配置 KV_ADMIN_URL/KV_ADMIN_PASS，CK 不会持久化');

  const usersJson = process.env.XSH_USERS_JSON;
  if (!usersJson) { console.error('❌ 缺少 XSH_USERS_JSON'); process.exit(1); }

  let users;
  try {
    users = JSON.parse(usersJson);
    if (!Array.isArray(users) || users.length === 0) throw new Error('需要非空数组');
  } catch (e) {
    console.error('❌ XSH_USERS_JSON 解析失败:', e.message);
    process.exit(1);
  }

  console.log(`📋 共 ${users.length} 个用户\n`);

  const results = [];
  for (let i = 0; i < users.length; i++) {
    const r = await processUser(users[i], i, users.length);
    results.push(r);
  }

  // 汇总
  console.log('\n' + '='.repeat(50));
  console.log('📊 汇总');
  console.log('='.repeat(50));
  let totalAds = 0;
  results.forEach((r, i) => {
    const status = r.success ? '✅' : '❌';
    console.log(`  ${status} 用户${i + 1}: ${r.username || '?'} — 看过 ${r.adsWatched || 0} 个广告${r.error ? ` (${r.error})` : ''}`);
    totalAds += r.adsWatched || 0;
  });
  const summary = `📈 总计观看: ${totalAds} 个广告\n💎 总计获得: ${totalAds} 积分`;
  console.log(`\n${summary}`);

  // TG 通知 (无论有没有广告都发)
  const lines = results.map((r, i) =>
    `${r.success ? '✅' : '❌'} 用户${i + 1}: ${r.adsWatched || 0} 广告${r.error ? ` (${r.error})` : ''}`
  );
  await sendTelegram(`*X Systems Hosting 自动看广告*\n${lines.join('\n')}\n\n${summary}`);
}

main().catch(err => {
  console.error(`\n❌ 严重错误: ${err.message}`);
  process.exit(1);
});