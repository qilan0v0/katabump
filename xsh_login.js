/**
 * X Systems Hosting — Discord Token 登录 + 自动看广告
 * ==================================================
 * 混合模式:
 *   - 登录: Playwright (可靠处理 Discord OAuth 重定向)
 *   - CK 存取: KV 缓存 session cookie
 *   - 看广告: 纯 HTTP API (heartbeat + claim)
 *
 * 环境变量:
 *   XSH_USERS_JSON = [{"Discord-token":"MTM3..."}]
 *   KV_ADMIN_URL / KV_ADMIN_PASS
 *   HTTP_PROXY
 *   TG_BOT_TOKEN / TG_CHAT_ID / TG_THREAD_ID
 */

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const XSH_BASE = 'https://xsystemshosting.com';
const MAX_ADS_PER_DAY = 25;

// ---------- KV Cookie 存储 ----------
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
      console.log(`[KV] 读取 CK 成功 (${String(r.data.value).length} 字节)`);
      return r.data.value;
    }
    return null;
  } catch (e) {
    if (e.response?.status === 404) return null;
    console.warn('[KV] 读取失败:', e.message);
    return null;
  }
}

async function kvPut(key, value) {
  if (!KV_ENABLED) return;
  try {
    await axios.post(KV_ADMIN_URL + '/api/set', { key, value: String(value) }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 15000, proxy: false,
    });
    console.log('[KV] CK 已保存');
  } catch (e) {
    console.warn('[KV] 写入失败:', e.message);
  }
}

// ---------- Cookie 操作 ----------
function cookiesToHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function parseCookiesFromBrowser(cookies) {
  return cookies.filter(c => c.domain === 'xsystemshosting.com' || c.domain === '.xsystemshosting.com');
}

// ---------- 工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg, label = '') {
  const p = label ? `[${label}]` : '[xsh]';
  console.log(`${p} ${msg}`);
}

// ---------- Telegram ----------
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;

async function sendTelegram(msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: 'Markdown' };
    if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
  } catch { try {
    const payload = { chat_id: TG_CHAT_ID, text: msg };
    if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
  } catch {} }
}

// ---------- 步骤 1: Playwright 登录获取 cookie ----------
async function loginWithBrowser(token, cookieHeader) {
  log('Step 1: 浏览器登录获取 session...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  try {
    // 如果有已缓存的 cookie，先设置上
    if (cookieHeader) {
      const pairs = cookieHeader.split(';').map(s => s.trim()).filter(Boolean);
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.substring(0, eq).trim();
        const value = pair.substring(eq + 1).trim();
        await context.addCookies([{
          name, value,
          domain: 'xsystemshosting.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        }]);
      }
    }

    // 打开 dashboard，看是否已登录
    await page.goto(`${XSH_BASE}/dashboard/discord`, { waitUntil: 'networkidle', timeout: 30000 });

    // 检查是否已登录（有 Cookie 且未重定向到 login）
    if (page.url().includes('/dashboard')) {
      log('  ✅ 已有有效 session，直接使用');
      const cookies = await context.cookies();
      const xshCookies = parseCookiesFromBrowser(cookies);
      await browser.close();
      return xshCookies;
    }

    log('  → 需要 Discord OAuth 登录...');

    // 点击 "Continue with Discord"
    log('  → 点击 "Continue with Discord"...');
    await page.click('text="Continue with Discord"');
    await page.waitForTimeout(3000);
    log(`  → 当前 URL: ${page.url()}`);

    // 如果已经跳转到 xsystemshosting dashboard，说明已登录
    if (page.url().includes(XSH_BASE)) {
      log('  ✅ 已重定向回 xsystemshosting，直接提取 cookie');
      const cookies = await context.cookies();
      const xshCookies = parseCookiesFromBrowser(cookies);
      await browser.close();
      return xshCookies;
    }

    // 注入 Discord Token
    log('  → 注入 Discord Token...');
    await page.evaluate((t) => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      iframe.contentWindow.localStorage.setItem('token', JSON.stringify(t));
      document.body.removeChild(iframe);
    }, token);

    // 触发 Discord 登录
    log('  → 触发 Discord 登录...');
    await page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    log(`  → Discord 登录后 URL: ${page.url()}`);

    // 回到 OAuth 授权页
    log('  → 回到 OAuth 授权页...');
    await page.goto(
      'https://discord.com/oauth2/authorize?client_id=1472320867060023540&redirect_uri=https%3A%2F%2Fxsystemshosting.com%2Fauth%2Fdiscord%2Fcallback&response_type=code&scope=identify%20email',
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await page.waitForTimeout(3000);
    log(`  → OAuth URL: ${page.url()}`);

    // 检查是否已授权成功（被重定向回 xsystemshosting）
    if (page.url().includes(XSH_BASE)) {
      log('  ✅ 已自动授权，提取 cookie');
      const cookies = await context.cookies();
      const xshCookies = parseCookiesFromBrowser(cookies);
      await browser.close();
      return xshCookies;
    }

    // 调试：打印页面内容
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
    log(`  → 页面内容: ${pageText}`);

    // 尝试找到授权按钮（支持中文/英文）
    log('  → 查找授权按钮...');
    const authBtn = [
      'button:has-text("授权")',
      'button:has-text("Authorize")',
      '[type="submit"]:has-text("授权")',
      '[type="submit"]:has-text("Authorize")',
    ];
    let clicked = false;
    for (const sel of authBtn) {
      const btn = await page.$(sel);
      if (btn) {
        const text = await btn.textContent();
        log(`  → 点击: "${text?.trim()}"`);
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // 最后的尝试：点击任何包含 "授权" 或 "Authorize" 的按钮
      log('  → 尝试模糊匹配...');
      await page.click('button:has-text("授权")').catch(() => page.click('[type="submit"]').catch(() => {}));
    }
    await page.waitForTimeout(5000);

    // 等待跳转到 dashboard
    try {
      await page.waitForURL('**/dashboard**', { timeout: 15000 });
    } catch {
      // 可能已经在了
    }

    log(`  ✅ 登录成功: ${page.url()}`);

    // 提取 cookie
    const cookies = await context.cookies();
    const xshCookies = parseCookiesFromBrowser(cookies);
    log(`  🍪 获取到 ${xshCookies.length} 个 xsystemshosting cookie`);

    await browser.close();
    return xshCookies;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ---------- 步骤 2: 获取广告页 token+csrf ----------
async function fetchAdPage(cookieHeader) {
  log('Step 2: 获取广告页面...');
  const res = await axios.get(`${XSH_BASE}/quests/ad`, {
    headers: { Cookie: cookieHeader, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    maxRedirects: 5, validateStatus: (s) => true, timeout: 15000,
  });

  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

  let token = '', csrf = '';
  const tMatch = html.match(/name=["']token["'][^>]*value=["']([^"']+)["']/);
  if (tMatch) token = tMatch[1];
  const cMatch = html.match(/name=["']csrf["'][^>]*value=["']([^"']+)["']/);
  if (cMatch) csrf = cMatch[1];

  if (!token) {
    fs.writeFileSync('xsh-ad-debug.html', html.substring(0, 5000));
    throw new Error('无法从广告页提取 token');
  }
  log(`  ✅ token: ${token.substring(0, 20)}...`);
  return { token, csrf };
}

// ---------- 步骤 3: 心跳 ----------
async function heartbeat(cookieHeader, token, csrf) {
  const form = new URLSearchParams({ token, seconds: '10' });
  if (csrf) form.append('csrf', csrf);
  const res = await axios.post(`${XSH_BASE}/quests/ads/heartbeat`, form.toString(), {
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${XSH_BASE}/quests/ad`, 'User-Agent': 'Mozilla/5.0' },
    maxRedirects: 0, validateStatus: (s) => true, timeout: 15000,
  });
  return res.data;
}

// ---------- 步骤 4: 领取积分 ----------
async function claim(cookieHeader, token, csrf) {
  log('Step 3: 领取积分...');
  const form = new URLSearchParams({ token });
  if (csrf) form.append('csrf', csrf);
  const res = await axios.post(`${XSH_BASE}/quests/ads/claim`, form.toString(), {
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${XSH_BASE}/quests/ad`, 'User-Agent': 'Mozilla/5.0' },
    maxRedirects: 0, validateStatus: (s) => true, timeout: 15000,
  });
  const loc = res.headers['location'] || '';
  if (loc.includes('notice=')) {
    log(`  ✅ ${decodeURIComponent(loc.split('notice=')[1] || '')}`);
    return true;
  }
  if (res.status === 302) { log(`  ✅ 领取成功`); return true; }
  try {
    const body = JSON.parse(res.data || '{}');
    if (body.ok) return true;
    log(`  ⚠️ 领取失败: ${JSON.stringify(body)}`);
    return false;
  } catch {
    log(`  ⚠️ 响应异常: ${String(res.data || res.status)}`);
    return false;
  }
}

// ---------- 处理单个用户 ----------
async function processUser(userData, index, total) {
  const token = userData['Discord-token'] || userData.token;
  const label = `${index + 1}/${total}`;
  const ckKey = `xsh_${token.slice(0, 20)}`;

  console.log(`\n======= 用户 ${label} =======`);

  // ---- 尝试读 CK ----
  let cookieHeader = null;
  const ckJson = await kvGet(ckKey);
  if (ckJson && ckJson.length > 10) {
    try {
      const parsed = JSON.parse(ckJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cookieHeader = cookiesToHeader(parsed);
        log(`  🍪 从 KV 加载 CK: ${parsed.map(c => c.name).join(', ')}`, label);
      }
    } catch { /* 不是数组格式 */ }
  }

  if (!cookieHeader) {
    log('需要浏览器登录获取 session...', label);
    try {
      const xshCookies = await loginWithBrowser(token, null);
      cookieHeader = cookiesToHeader(xshCookies);
      // 存 CK
      await kvPut(ckKey, JSON.stringify(xshCookies));
    } catch (err) {
      log(`❌ 浏览器登录失败: ${err.message}`, label);
      return { success: false, error: err.message, adsWatched: 0, username: label };
    }
  }

  // ---- 看广告循环 ----
  let adCount = 0;
  for (let i = 0; i < MAX_ADS_PER_DAY; i++) {
    log(`\n--- 广告 ${i + 1}/${MAX_ADS_PER_DAY} ---`, label);
    try {
      const { token: adToken, csrf: adCsrf } = await fetchAdPage(cookieHeader);
      const hb = await heartbeat(cookieHeader, adToken, adCsrf);
      log(`心跳: ${JSON.stringify(hb)}`, label);
      const ok = await claim(cookieHeader, adToken, adCsrf);
      if (ok) {
        adCount++;
        log(`🎉 累计 ${adCount} 个广告`, label);
      } else {
        log(`⚠️ 领取失败，可能已达上限`, label);
        break;
      }
      await sleep(1500);
    } catch (err) {
      if (err.message.includes('无法提取 token')) {
        log(`⚠️ 没有更多广告或已达当日上限`, label);
      } else {
        log(`❌ 广告 ${i + 1} 失败: ${err.message}`, label);
      }
      break;
    }
  }

  log(`\n✅ 完成，共观看 ${adCount} 个广告`, label);
  return { success: true, username: label, adsWatched: adCount };
}

// ---------- 入口 ----------
async function main() {
  console.log('🚀 X Systems Hosting 自动看广告 (混合模式)');
  console.log('='.repeat(50));
  if (!KV_ENABLED) console.log('⚠️ 未配置 KV，CK 不会持久化');

  const usersJson = process.env.XSH_USERS_JSON;
  if (!usersJson) { console.error('❌ 缺少 XSH_USERS_JSON'); process.exit(1); }
  let users;
  try {
    users = JSON.parse(usersJson);
    if (!Array.isArray(users) || users.length === 0) throw new Error('需要非空数组');
  } catch (e) { console.error('❌ 解析失败:', e.message); process.exit(1); }

  console.log(`📋 共 ${users.length} 个用户\n`);

  const results = [];
  for (let i = 0; i < users.length; i++) {
    const r = await processUser(users[i], i, users.length);
    results.push(r);
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 汇总');
  console.log('='.repeat(50));
  let totalAds = 0;
  results.forEach((r, i) => {
    const s = r.success ? '✅' : '❌';
    console.log(`  ${s} 用户${i + 1}: 看过 ${r.adsWatched || 0} 个广告${r.error ? ` (${r.error})` : ''}`);
    totalAds += r.adsWatched || 0;
  });
  const summary = `📈 总计观看: ${totalAds} 个广告\n💎 总计获得: ${totalAds} 积分`;
  console.log(`\n${summary}`);
  await sendTelegram(`*X Systems Hosting 自动看广告*\n${results.map((r, i) =>
    `${r.success ? '✅' : '❌'} 用户${i + 1}: ${r.adsWatched || 0} 广告${r.error ? ` (${r.error})` : ''}`
  ).join('\n')}\n\n${summary}`);
}

main().catch(err => {
  console.error(`\n❌ 严重错误: ${err.message}`);
  process.exit(1);
});