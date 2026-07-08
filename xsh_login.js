/**
 * X Systems Hosting — Discord Token 登录 + 自动看广告 (纯 API 版)
 * ================================================================
 * 全程无需浏览器！使用纯 HTTP API：
 *   1. Discord OAuth → 获取授权码 (API)
 *   2. xsystemshosting callback → 获取 session cookie (HTTP)
 *   3. 获取广告页 token + csrf (HTTP)
 *   4. 心跳 + 领取积分 (HTTP)
 *
 * 环境变量:
 *   XSH_USERS_JSON = [{"Discord-token":"MTM3..."}]
 *   HTTP_PROXY      = (可选) http://user:pass@host:port
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
// cookie 解析在 CookieJar 中已实现

const XSH_BASE = 'https://xsystemshosting.com';
const DISCORD_API = 'https://discord.com/api/v10';
const CLIENT_ID = '1472320867060023540';
const REDIRECT_URI = `${XSH_BASE}/auth/discord/callback`;
const SCOPES = 'identify email';
const MAX_ADS_PER_DAY = 25;

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
  /** 返回 Cookie header 字符串 */
  getHeader() {
    const parts = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`);
    return parts.join('; ');
  }
}


// ---------- 创建 HTTP 客户端 ----------
function createClient(proxyUrl) {
  const cfg = {
    baseURL: XSH_BASE,
    timeout: 30000,
    maxRedirects: 0, // 不自动跟随重定向
    validateStatus: (s) => s < 400 || s === 302 || s === 301, // 允许重定向
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

// ---------- 步骤 1: Discord OAuth 授权 ----------
async function discordOAuth(token) {
  log('Step 1: Discord OAuth 授权...', '1/5');

  // 验证 token
  const userRes = await axios.get(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: token },
    timeout: 15000,
  });
  if (userRes.status !== 200) {
    throw new Error(`Discord token 无效: ${userRes.status}`);
  }
  const user = userRes.data;
  log(`  ✅ Discord 用户: ${user.global_name || user.username} (${user.id})`, '1/5');

  // 直接调用 Discord OAuth authorize API
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });

  const authRes = await axios.post(
    `${DISCORD_API}/oauth2/authorize?${params}`,
    {
      authorize: true,
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      permissions: '0',
      integration_type: 0,
    },
    {
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: (s) => true,
    }
  );

  // 从重定向 location 提取 code
  const location = authRes.headers['location'] || '';
  if (!location.includes('code=')) {
    // 尝试从 body 找 location
    if (authRes.data && authRes.data.location) {
      const code = new URL(authRes.data.location).searchParams.get('code');
      if (code) {
        log(`  ✅ 获取到授权码: ${code.substring(0, 20)}...`, '1/5');
        return { code, user };
      }
    }
    throw new Error(`OAuth 授权失败: status=${authRes.status}, body=${JSON.stringify(authRes.data || '').substring(0, 200)}`);
  }

  const code = new URL(location).searchParams.get('code');
  log(`  ✅ 获取到授权码: ${code.substring(0, 20)}...`, '1/5');
  return { code, user };
}

// ---------- 步骤 2: 完成 xsystemshosting 登录 ----------
async function loginXSH(code, jar) {
  log('Step 2: 完成 xsystemshosting 登录...', '2/5');

  const client = createClient();

  // 访问 callback URL 获取 session cookie
  const callbackUrl = `${REDIRECT_URI}?code=${encodeURIComponent(code)}`;
  const res = await client.get(callbackUrl, {
    maxRedirects: 5, // 允许跟随重定向以获取完整 cookie
    validateStatus: (s) => true,
  });

  // 提取所有 set-cookie
  jar.setFromHeaders(res.headers);

  log(`  ✅ 登录完成: ${res.status}`, '2/5');
  log(`  🍪 Session cookie: ${Object.keys(jar.cookies).join(', ')}`, '2/5');

  return jar;
}

// ---------- 步骤 3: 获取广告页面 token+csrf ----------
async function fetchAdPage(jar) {
  log('Step 3: 获取广告页面...', '3/5');

  const client = createClient();
  const res = await client.get('/quests/ad', {
    headers: { Cookie: jar.getHeader() },
    maxRedirects: 5,
    validateStatus: (s) => true,
  });

  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  jar.setFromHeaders(res.headers);

  // 提取 token (通常在 URL 或 hidden input 中)
  // token 格式: URL /quests/ads/heartbeat 表单中的 token
  let token = '';
  let csrf = '';

  // 尝试从 HTML 中提取 token 和 csrf
  // 模式1: name="token" value="xxx"
  const tokenMatch = html.match(/name=["']token["'][^>]*value=["']([^"']+)["']/);
  if (tokenMatch) token = tokenMatch[1];

  // 模式2: name="csrf" value="xxx"
  const csrfMatch = html.match(/name=["']csrf["'][^>]*value=["']([^"']+)["']/);
  if (csrfMatch) csrf = csrfMatch[1];

  // 模式3: 从 JS 变量中提取
  if (!token) {
    const tMatch = html.match(/token["']?\s*[:=]\s*["']([^"']+)["']/);
    if (tMatch) token = tMatch[1];
  }

  log(`  📄 页面长度: ${html.length} 字节`, '3/5');

  if (!token) {
    // 看看页面内容
    const bodyExcerpt = html.substring(0, 1000);
    log(`  ⚠️ 未找到 token，页面内容: ${bodyExcerpt}`, '3/5');
    // 保存到文件以便调试
    fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR || '.', 'ad-page.html'), html);
    throw new Error('无法从广告页提取 token');
  }

  log(`  ✅ token: ${token.substring(0, 20)}...`, '3/5');
  log(`  ✅ csrf: ${csrf ? csrf.substring(0, 20) + '...' : '(无)'}`, '3/5');

  return { token, csrf, html };
}

// ---------- 步骤 4: 心跳 ----------
async function sendHeartbeat(jar, token, csrf, seconds) {
  const client = createClient();
  const formData = new URLSearchParams();
  formData.append('token', token);
  formData.append('seconds', String(seconds));
  if (csrf) formData.append('csrf', csrf);

  const res = await client.post('/quests/ads/heartbeat', formData.toString(), {
    headers: {
      Cookie: jar.getHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${XSH_BASE}/quests/ad`,
    },
    maxRedirects: 0,
    validateStatus: (s) => true,
  });

  jar.setFromHeaders(res.headers);
  return res.data;
}

// ---------- 步骤 5: 领取积分 ----------
async function claimCredit(jar, token, csrf) {
  log('Step 5: 领取积分...', '5/5');

  const client = createClient();
  const formData = new URLSearchParams();
  formData.append('token', token);
  if (csrf) formData.append('csrf', csrf);

  const res = await client.post('/quests/ads/claim', formData.toString(), {
    headers: {
      Cookie: jar.getHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${XSH_BASE}/quests/ad`,
    },
    maxRedirects: 0,
    validateStatus: (s) => true,
  });

  jar.setFromHeaders(res.headers);

  // 检查重定向到 dashboard 的 notice
  const location = res.headers['location'] || '';
  if (location.includes('notice=')) {
    const notice = decodeURIComponent(location.split('notice=')[1] || '');
    log(`  ✅ 领取成功! ${notice}`, '5/5');
    return { success: true, notice };
  }

  if (res.status === 302) {
    log(`  ✅ 领取成功 (重定向: ${location})`, '5/5');
    return { success: true, location };
  }

  // 尝试解析 body
  try {
    const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    log(`  ℹ️ 响应: ${JSON.stringify(body)}`, '5/5');
    if (body.ok) return { success: true, ...body };
    return { success: false, ...body };
  } catch {
    log(`  ℹ️ raw: ${String(res.data).substring(0, 200)}`, '5/5');
  }

  return { success: false, error: `status=${res.status}` };
}

// ---------- 主流程 ----------
async function processUser(userData, index, total) {
  const token = userData['Discord-token'] || userData.token;
  const label = `${index + 1}/${total}`;
  const jar = new CookieJar();

  console.log(`\n======= 用户 ${label} =======`);

  try {
    // 1. Discord OAuth
    const { code, user } = await discordOAuth(token);
    const username = user.global_name || user.username;
    log(`用户: ${username}`, label);

    // 2. 登录 xsystemshosting
    await loginXSH(code, jar);

    // 3-5. 循环看广告
    let adCount = 0;
    for (let i = 0; i < MAX_ADS_PER_DAY; i++) {
      log(`\n--- 第 ${i + 1}/${MAX_ADS_PER_DAY} 个广告 ---`, label);

      try {
        // 3. 获取广告页
        const { token: adToken, csrf: adCsrf } = await fetchAdPage(jar);

        // 4. 发送心跳 (一次发 10 秒直接达标)
        log(`  Step 4: 发送心跳...`, label);
        const hb = await sendHeartbeat(jar, adToken, adCsrf, 10);
        log(`  心跳响应: ${JSON.stringify(hb)}`, label);

        // 5. 领取
        const claimResult = await claimCredit(jar, adToken, adCsrf);
        if (claimResult.success) {
          adCount++;
          log(`  🎉 累计已领取 ${adCount} 个广告积分`, label);
        } else {
          log(`  ⚠️ 领取可能失败: ${JSON.stringify(claimResult)}`, label);
          break; // 可能当天已达上限
        }

        // 短暂延迟避免触发限流
        await sleep(1500);

      } catch (err) {
        if (err.message.includes('无法从广告页提取 token')) {
          log(`  ⚠️ 可能已达当日上限或没有更多广告`, label);
        } else {
          log(`  ❌ 广告 ${i + 1} 失败: ${err.message}`, label);
        }
        break;
      }
    }

    log(`\n✅ 用户 ${username} 完成，共观看 ${adCount} 个广告`, label);
    return { success: true, username, adsWatched: adCount };
  } catch (err) {
    log(`❌ 用户处理失败: ${err.message}`, label);
    return { success: false, error: err.message, adsWatched: 0 };
  }
}

// ---------- 入口 ----------
async function main() {
  console.log('🚀 X Systems Hosting 自动看广告 (纯 API 版)');
  console.log('='.repeat(50));

  // 读取用户配置
  const usersJson = process.env.XSH_USERS_JSON;
  if (!usersJson) {
    console.error('❌ 缺少环境变量 XSH_USERS_JSON');
    process.exit(1);
  }

  let users;
  try {
    users = JSON.parse(usersJson);
    if (!Array.isArray(users) || users.length === 0) {
      throw new Error('需要非空数组');
    }
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
  console.log(`\n📈 总计观看: ${totalAds} 个广告`);
  console.log(`💎 总计获得: ${totalAds} 积分`);
}

main().catch(err => {
  console.error(`\n❌ 严重错误: ${err.message}`);
  process.exit(1);
});