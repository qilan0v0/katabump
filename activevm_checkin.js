/**
 * ActiveVM (panel.activevm.net) 续期 + 每日任务签到
 * ==================================================
 * 登录: Discord OAuth Token 授权登录
 * 功能:
 *   1. 打开 /dashboard 续期
 *   2. 打开 /dashboard/affiliate 领取 🎁 登录奖励、🎰每日扭蛋、
 *      通过在 Twitter 上分享来扩大影响力、每日和每周任务
 *   3. KV 缓存 Cookie 避免每次登录
 *
 * 环境变量:
 *   ACTIVEVM_USERS_JSON = [{"username":"xxx@282820.xyz","Discord-token":"MTM3..."}]
 *   KV_ADMIN_URL / KV_ADMIN_PASS
 *   TG_BOT_TOKEN / TG_CHAT_ID / TG_THREAD_ID
 */
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PANEL_BASE = 'https://panel.activevm.net';
const DISCORD_CLIENT_ID = '1507326014718607390';
const REDIRECT_URI = `${PANEL_BASE}/api/auth/callback/discord`;
const SCOPES = 'identify email';
const DISCORD_API = 'https://discord.com/api/v9/oauth2/authorize';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = 'ActiveVM';

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
    if (r.data.ok && r.data.value != null) return r.data.value;
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

// ---------- 工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg, label = '') {
  const p = label ? `[${label}]` : '[ActiveVM]';
  console.log(`${p} ${msg}`);
}

// ---------- Telegram ----------
async function sendTelegram(msg, imagePath = null) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const text = `📌 *${PROJECT}*\n${msg}`;
  try {
    const payload = { chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' };
    if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
    if (imagePath && fs.existsSync(imagePath)) {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('chat_id', TG_CHAT_ID);
      if (TG_THREAD_ID) form.append('message_thread_id', Number(TG_THREAD_ID));
      form.append('caption', text.slice(0, 1000));
      form.append('parse_mode', 'Markdown');
      form.append('photo', fs.createReadStream(imagePath));
      await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, form, {
        headers: form.getHeaders(), timeout: 30000,
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
    }
  } catch { try {
    const payload = { chat_id: TG_CHAT_ID, text };
    if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
  } catch {} }
}

// ===================================================================
//  normalizeCookies: 将 cookie 数组转为 Playwright addCookies 格式
// ===================================================================
function normalizeCookies(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(c => {
    const out = { name: c.name, value: String(c.value != null ? c.value : '') };
    if (c.domain) out.domain = c.domain;
    out.path = c.path || '/';
    const exp = (typeof c.expires === 'number' ? c.expires : c.expirationDate);
    if (typeof exp === 'number' && exp > 0) out.expires = Math.floor(exp);
    out.httpOnly = !!c.httpOnly;
    out.secure = !!c.secure;
    const ss = (c.sameSite || '').toString().toLowerCase();
    out.sameSite = ss === 'strict' ? 'Strict' : ss === 'none' ? 'None' : 'Lax';
    return out;
  }).filter(c => c.name && c.domain);
}

// ===================================================================
//  Discord OAuth 授权（参考 bothosting_renew.js / xsh_login.js）
// ===================================================================
async function discordAuthorize(token) {
  log('  Discord API 授权...');

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });

  const authUrl = `${DISCORD_API}?${params}`;

  const headers = {
    'Authorization': token,
    'Content-Type': 'application/json',
    'Origin': 'https://discord.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  const body = {
    authorize: true,
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    permissions: '0',
    integration_type: 0,
  };

  const res = await axios.post(authUrl, body, {
    headers,
    timeout: 30000,
    maxRedirects: 0,
    validateStatus: (s) => true,
  });

  const location = res.headers['location'] || (res.data && res.data.location) || '';
  if (!location.includes('code=')) {
    throw new Error(`Discord 授权失败: ${res.status} ${JSON.stringify(res.data || '').substring(0, 200)}`);
  }

  const code = new URL(location).searchParams.get('code');
  log(`  ✅ 获取到授权码: ${code.substring(0, 20)}...`);
  return code;
}

// ===================================================================
//  Discord OAuth 完整登录流程（使用浏览器）
// ===================================================================
async function discordLogin(page, context, token) {
  log('[登录] 通过 Discord OAuth 登录...');

  try {
    // Step 1: 打开首页，点击 Discord 登录按钮
    log('  打开 panel 首页...');
    await page.goto(PANEL_BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 如果已经在 dashboard 则跳过
    const currentUrl = page.url();
    log(`  当前 URL: ${currentUrl}`);
    if (!currentUrl.includes('discord.com') && !currentUrl.includes('/api/auth/callback')) {
      // 不在 Discord 页面，说明可能需要先点击登录按钮
      log('  点击 Discord 登录按钮...');
      const discordBtn = page.locator('button').filter({ hasText: 'Discord' }).first();
      if (await discordBtn.count() > 0) {
        await discordBtn.click();
        await page.waitForTimeout(3000);
        log(`  点击后 URL: ${page.url()}`);
      }
    }

    // Step 2: 从 Discord OAuth 页面提取 state
    let oauthUrl = page.url();
    log(`  OAuth URL: ${oauthUrl}`);

    if (!oauthUrl.includes('discord.com/oauth2/authorize')) {
      // 可能直接跳过了，检查回调
      if (oauthUrl.includes(REDIRECT_URI) || oauthUrl.includes('/api/auth/callback/discord')) {
        log('  已经在回调页面，等待跳转...');
        await page.waitForTimeout(5000);
        if (page.url().includes(PANEL_BASE) && !page.url().includes('/api/auth/callback')) {
          log('  ✅ 登录成功！');
          return true;
        }
      }
      // 再检查是否已经在 dashboard
      if (oauthUrl.includes(PANEL_BASE) && !oauthUrl.includes('/api/auth/callback')) {
        log('  ✅ 似乎已登录');
        return true;
      }
    }

    // 从 URL 提取 state
    const stateMatch = oauthUrl.match(/[?&]state=([^&]+)/);
    let state = stateMatch ? decodeURIComponent(stateMatch[1]) : null;
    if (!state) {
      log('  ❌ 无法提取 state 参数');
      return false;
    }
    log(`  ✅ 提取到 state: ${state.substring(0, 20)}...`);

    // Step 3: 用 Discord Token 调用 OAuth2 authorize API
    log('  调用 Discord API 授权...');
    const queryParams = {
      client_id: DISCORD_CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state: state,
    };
    const authorizeUrl = `${DISCORD_API}?${new URLSearchParams(queryParams).toString()}`;

    const axiosConfig = {
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'Origin': 'https://discord.com',
        'referer': `https://discord.com/oauth2/authorize?${new URLSearchParams(queryParams).toString()}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      timeout: 20000,
    };

    const discordApiPayload = {
      permissions: '0',
      authorize: true,
      integration_type: 0,
      location_context: {
        guild_id: '10000',
        channel_id: '10000',
        channel_type: 10000,
      },
    };

    let resp;
    try {
      resp = await axios.post(authorizeUrl, discordApiPayload, { ...axiosConfig, proxy: false });
      log('  Discord API 请求成功');
    } catch (directErr) {
      log(`  Discord API 直连失败: ${directErr.message.slice(0, 80)}`);
      // 如果有 HTTP_PROXY 则尝试走代理
      if (process.env.HTTP_PROXY) {
        try {
          const proxyUrl = new URL(process.env.HTTP_PROXY);
          resp = await axios.post(authorizeUrl, discordApiPayload, {
            ...axiosConfig,
            proxy: {
              protocol: 'http',
              host: proxyUrl.hostname,
              port: proxyUrl.port,
              ...(proxyUrl.username ? { auth: { username: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) } } : {}),
            },
          });
          log('  Discord API 请求（代理）成功');
        } catch (proxyErr) {
          log(`  ❌ Discord 授权失败（直连和代理均失败）`);
          return false;
        }
      } else {
        return false;
      }
    }

    if (resp.status !== 200) {
      log(`  ❌ Discord 授权失败: HTTP ${resp.status}`);
      return false;
    }

    const location = resp.data.location;
    if (!location) {
      log('  ❌ 授权响应中未找到 location 字段');
      return false;
    }

    const masked = location.replace(/code=[^&]+/, 'code=***');
    log(`  ✅ 拿到回调 URL: ${masked}`);

    // Step 4: 打开回调 URL 完成登录
    log('  携带授权码打开回调链接...');
    await page.goto(location, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    log(`  回调后 URL: ${finalUrl}`);

    // 检查是否登录成功
    if (finalUrl.includes(PANEL_BASE) && !finalUrl.includes('/api/auth/callback')) {
      log('  ✅ Discord OAuth 登录成功！');
      return true;
    }

    // 等待可能还在跳转
    for (let w = 0; w < 20; w++) {
      const url = page.url();
      if (url.includes(PANEL_BASE) && !url.includes('/api/auth/callback') && !url.includes('discord.com')) {
        log('  ✅ Discord OAuth 登录成功！');
        return true;
      }
      await sleep(500);
    }

    log(`  ❌ 登录超时，最终 URL: ${page.url()}`);
    return false;
  } catch (err) {
    log(`  ❌ 登录流程异常: ${err.message}`);
    return false;
  }
}

// ===================================================================
//  点击页面上的按钮（by text）
// ===================================================================
async function clickButton(page, text, timeout = 5000) {
  try {
    const btn = page.locator('button').filter({ hasText: text }).first();
    await btn.waitFor({ state: 'visible', timeout });
    if (await btn.count() > 0) {
      await btn.click();
      log(`  ✅ 点击按钮: "${text}"`);
      return true;
    }
  } catch (e) {
    // 按钮未找到
  }
  return false;
}

// ===================================================================
//  领取奖励 / 完成任务
// ===================================================================
async function claimRewards(page) {
  const results = [];

  // 1. 打开 affiliate 页面
  log('[任务] 打开 affiliate 页面...');
  try {
    await page.goto(`${PANEL_BASE}/dashboard/affiliate`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    log(`  当前 URL: ${page.url()}`);
  } catch (e) {
    log(`  打开 affiliate 失败: ${e.message}`);
    // 尝试通过 dashboard 导航
    try {
      await page.goto(`${PANEL_BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
    } catch (e2) {
      log(`  打开 dashboard 也失败: ${e2.message}`);
    }
  }

  // 读取页面内容
  let pageText = '';
  try { pageText = await page.evaluate(() => document.body?.innerText || ''); } catch (e) {}

  // 2. 🎁 领取登录奖励
  log('[任务] 寻找登录奖励...');
  const claimBtns = page.locator('button').filter({ hasText: /Claim|领取|受け取る|Get/i });
  const claimCount = await claimBtns.count();
  if (claimCount > 0) {
    for (let i = 0; i < claimCount; i++) {
      try {
        const btn = claimBtns.nth(i);
        const disabled = await btn.isDisabled().catch(() => false);
        if (!disabled) {
          await btn.click();
          log(`  ✅ 点击 Claim 按钮 #${i + 1}`);
          results.push('claim_clicked');
          await sleep(2000);
        }
      } catch (e) {}
    }
  }

  // 尝试通过文本检测可点击的元素
  const clickablePatterns = [
    /Claim|领取|受け取る|Get reward/i,
    /Spin|ガチャ|扭蛋|Gacha/i,
    /Share|シェア|分享|Twitter/i,
    /Task|タスク|任务/i,
  ];

  for (const pattern of clickablePatterns) {
    try {
      const elements = page.locator('button, a, [role="button"]').filter({ hasText: pattern });
      const count = await elements.count();
      for (let i = 0; i < count; i++) {
        try {
          const el = elements.nth(i);
          const disabled = await el.isDisabled().catch(() => false);
          if (!disabled && await el.isVisible().catch(() => false)) {
            await el.click();
            log(`  ✅ 点击匹配 "${pattern.source}" 的元素`);
            results.push(`clicked_${pattern.source}`);
            await sleep(2000);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 3. 🎰 每日扭蛋
  log('[任务] 寻找每日扭蛋...');
  // 查找 gacha/spin 相关按钮
  const spinBtn = page.locator('button').filter({ hasText: /Spin|ガチャ|Gacha|回す/i }).first();
  if (await spinBtn.count() > 0) {
    try {
      await spinBtn.click();
      log('  ✅ 点击扭蛋');
      results.push('gacha_clicked');
      await sleep(2000);
    } catch (e) {}
  }

  // 4. Twitter 分享
  log('[任务] 寻找 Twitter 分享按钮...');
  const tweetBtn = page.locator('button, a').filter({ hasText: /Tweet|Share|Twitter|シェア|分享/i }).first();
  if (await tweetBtn.count() > 0) {
    try {
      await tweetBtn.click();
      log('  ✅ 点击分享');
      results.push('share_clicked');
      await sleep(2000);
    } catch (e) {}
  }

  // 5. 每日和每周任务
  log('[任务] 寻找任务按钮...');
  const taskBtns = page.locator('button').filter({ hasText: /Task|タスク|任务|Complete|達成/i });
  const taskCount = await taskBtns.count();
  if (taskCount > 0) {
    for (let i = 0; i < taskCount; i++) {
      try {
        const btn = taskBtns.nth(i);
        const disabled = await btn.isDisabled().catch(() => false);
        if (!disabled) {
          await btn.click();
          log(`  ✅ 点击任务按钮 #${i + 1}`);
          results.push(`task_${i}_clicked`);
          await sleep(2000);
        }
      } catch (e) {}
    }
  }

  // 截图留存
  const photoDir = 'screenshots';
  if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
  try {
    await page.screenshot({ path: path.join(photoDir, 'activevm_affiliate.png'), fullPage: true });
    log('  📸 已截图');
  } catch (e) {}

  return results;
}

// ===================================================================
//  续期操作
// ===================================================================
async function renewServer(page) {
  log('[续期] 打开 dashboard...');
  try {
    await page.goto(`${PANEL_BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    log(`  当前 URL: ${page.url()}`);

    const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    log(`  页面内容片段: ${pageText.substring(0, 300)}`);

    // 查找续期/延长按钮
    const renewClicked = await clickButton(page, /Renew|延長|延長する|Extend|更新/i);
    if (renewClicked) {
      log('  ✅ 已点击续期按钮');
      await sleep(3000);
      // 检查是否有确认弹窗
      const confirmClicked = await clickButton(page, /Confirm|確認|Renew|延長|Yes/i);
      if (confirmClicked) {
        log('  ✅ 已确认续期');
        await sleep(2000);
      }
      return true;
    }

    log('  未找到续期按钮，可能已续期或无需操作');
    return false;
  } catch (e) {
    log(`  续期操作异常: ${e.message}`);
    return false;
  }
}

// ===================================================================
//  处理单个用户
// ===================================================================
async function processUser(user) {
  const token = user['Discord-token'] || user['discord_token'] || user['discordToken'] || '';
  const username = user.username || token.slice(0, 20);
  const safeUser = username.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const cookieKey = `activevm_cookie_${safeUser.replace(/[^a-z0-9]/gi, '_')}`;

  log(`\n======= 处理用户: ${username} =======`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'ja-JP',
  });
  const page = await context.newPage();

  try {
    // Step 1: 尝试从 KV 加载缓存的 cookie
    let loggedIn = false;
    const saved = await kvGet(cookieKey);
    if (saved) {
      try {
        const cks = normalizeCookies(JSON.parse(saved));
        if (cks.length > 0) {
          await context.addCookies(cks);
          log('  已注入 KV CK');

          // 验证 cookie 是否有效
          await page.goto(`${PANEL_BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(2000);
          const url = page.url();
          if (!url.includes('discord.com') && !url.includes('login') && url.includes(PANEL_BASE)) {
            log('  ✅ KV CK 有效，跳过登录');
            loggedIn = true;
          } else {
            log('  KV CK 已过期，重新登录');
            try { await context.clearCookies(); } catch (e) {}
          }
        }
      } catch (e) {
        log(`  CK 解析失败: ${e.message}`);
        try { await context.clearCookies(); } catch (e2) {}
      }
    }

    // Step 2: 如果 KV CK 无效，进行 Discord OAuth 登录
    if (!loggedIn) {
      if (!token) {
        log('  ❌ 未提供 Discord-token，跳过该用户');
        await browser.close();
        return { username, success: false, error: '缺少 Discord-token' };
      }
      loggedIn = await discordLogin(page, context, token);
      if (!loggedIn) {
        log('  ❌ Discord 登录失败');
        await sendTelegram(`❌ *ActiveVM 登录失败*\n用户: ${username}`);
        await browser.close();
        return { username, success: false, error: '登录失败' };
      }
    }

    // Step 3: 保存（更新）CK 到 KV
    try {
      const cookies = await context.cookies();
      await kvPut(cookieKey, JSON.stringify(cookies));
      log('  🍪 CK 已保存到 KV');
    } catch (e) {
      log(`  保存 CK 失败: ${e.message}`);
    }

    // Step 4: 续期操作
    const renewResult = await renewServer(page);

    // Step 5: 领取奖励
    const rewardResults = await claimRewards(page);

    // Step 6: 截图
    const photoDir = 'screenshots';
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    try {
      await page.screenshot({ path: path.join(photoDir, `activevm_${safeUser}.png`), fullPage: true });
    } catch (e) {}

    // Step 7: 发送 Telegram 通知
    const rewardSummary = rewardResults.length > 0 ? `领取操作: ${rewardResults.length} 次` : '无明确领取项';
    const renewSummary = renewResult ? '已尝试续期' : '无需续期或未找到续期按钮';
    const summary = `👤 *用户*: ${username}\n🔄 *续期*: ${renewSummary}\n🎁 *奖励*: ${rewardSummary}`;
    log(`${summary}`);
    await sendTelegram(summary, path.join(photoDir, `activevm_${safeUser}.png`));

    await browser.close();
    return { username, success: true, renew: renewResult, rewards: rewardResults.length };
  } catch (err) {
    log(`❌ 错误: ${err.message}`);
    try { await page.screenshot({ path: 'screenshots/activevm_error.png' }).catch(() => {}); } catch (e) {}
    await sendTelegram(`❌ *ActiveVM 错误*\n用户: ${username}\n错误: ${err.message}`);
    await browser.close();
    return { username, success: false, error: err.message };
  }
}

// ===================================================================
//  入口
// ===================================================================
async function main() {
  console.log('🚀 ActiveVM 自动续期 + 每日任务');
  console.log('='.repeat(50));
  if (!KV_ENABLED) console.log('⚠️ 未配置 KV，CK 不会持久化');

  const usersJson = process.env.ACTIVEVM_USERS_JSON;
  if (!usersJson) { console.error('❌ 缺少 ACTIVEVM_USERS_JSON'); process.exit(1); }
  let users;
  try {
    users = JSON.parse(usersJson);
    if (!Array.isArray(users) || users.length === 0) throw new Error('需要非空数组');
  } catch (e) { console.error('❌ 解析失败:', e.message); process.exit(1); }

  console.log(`📋 共 ${users.length} 个用户\n`);

  const results = [];
  for (let i = 0; i < users.length; i++) {
    const r = await processUser(users[i]);
    results.push(r);
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 汇总');
  console.log('='.repeat(50));
  results.forEach((r, i) => {
    const s = r.success ? '✅' : '❌';
    console.log(`  ${s} 用户${i + 1}: ${r.username}${r.error ? ` (${r.error})` : ''}`);
  });

  const successCount = results.filter(r => r.success).length;
  const summary = `✅ 成功: ${successCount}/${results.length}`;
  await sendTelegram(`*ActiveVM 自动续期*\n${summary}`);

  console.log(`\n${summary}`);
}

main().catch(err => {
  console.error(`\n❌ 严重错误: ${err.message}`);
  process.exit(1);
});