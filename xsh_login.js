/**
 * X Systems Hosting — Discord Token 登录 + 自动看广告
 * ==================================================
 * 登录方式（参考 eooce/Auto-Renew-Bothosting）：
 *   1. Playwright 点击 "Continue with Discord" → 获取 OAuth 上下文
 *   2. Node.js HTTP 调用 Discord API 授权（Bearer token）
 *   3. Playwright 访问回调 URL 完成登录
 * 看广告：全程 Playwright 模拟点击
 *
 * 环境变量:
 *   XSH_USERS_JSON = [{"Discord-token":"MTM3..."}]
 *   KV_ADMIN_URL / KV_ADMIN_PASS
 *   TG_BOT_TOKEN / TG_CHAT_ID / TG_THREAD_ID
 */

const { chromium } = require('playwright');
const axios = require('axios');

const XSH_BASE = 'https://xsystemshosting.com';
const DISCORD_CLIENT_ID = '1472320867060023540';
const REDIRECT_URI = `${XSH_BASE}/auth/discord/callback`;
const SCOPES = 'identify email';
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

// ===================================================================
//  Discord OAuth API 授权（参考 eooce/Auto-Renew-Bothosting）
// ===================================================================
async function discordAuthorize(token) {
  log('  Discord API 授权...');

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });

  const authUrl = `https://discord.com/api/v10/oauth2/authorize?${params}`;

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

  // 响应可能是 JSON 或重定向
  const location = res.headers['location'] || (res.data && res.data.location) || '';
  if (!location.includes('code=')) {
    throw new Error(`Discord 授权失败: ${res.status} ${JSON.stringify(res.data || '').substring(0, 200)}`);
  }

  const code = new URL(location).searchParams.get('code');
  log(`  ✅ 获取到授权码: ${code.substring(0, 20)}...`);
  return code;
}

// ===================================================================
//  完整浏览器流程：登录 + 看广告
// ===================================================================
async function runUser(token) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  let adCount = 0;

  try {
    // ===== 1. 打开 xsystemshosting =====
    log('[1] 打开 xsystemshosting...');
    await page.goto(`${XSH_BASE}/dashboard/discord`, { waitUntil: 'networkidle', timeout: 30000 });
    log(`    URL: ${page.url()}`);

    // 如果已经在 dashboard，跳过登录
    if (!page.url().includes('/dashboard')) {
      // ===== 2. Discord API 授权 =====
      log('[2] 通过 Discord API 授权...');
      const code = await discordAuthorize(token);

      // ===== 3. 访问回调 URL 完成登录 =====
      log('[3] 访问回调 URL 完成登录...');
      const callbackUrl = `${REDIRECT_URI}?code=${encodeURIComponent(code)}`;
      await page.goto(callbackUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      log(`    URL: ${page.url()}`);

      // 如果还在 Discord 页面，等自动跳转
      if (page.url().includes('discord.com')) {
        await page.waitForTimeout(5000);
        log(`    等待后 URL: ${page.url()}`);
      }

      // 如果还没到 dashboard，再手动导航
      if (!page.url().includes('/dashboard')) {
        log('   → 手动导航到 dashboard...');
        await page.goto(`${XSH_BASE}/dashboard/discord`, { waitUntil: 'networkidle', timeout: 30000 });
      }
    }

    log(`  登录后 URL: ${page.url()}`);

    // ===== 保存 session cookie 到 KV =====
    const cookies = await context.cookies();
    const xshCookies = cookies.filter(c =>
      c.domain === 'xsystemshosting.com' || c.domain === '.xsystemshosting.com'
    );
    if (xshCookies.length > 0) {
      await kvPut(`xsh_${token.slice(0, 20)}`, JSON.stringify(xshCookies));
      log(`  🍪 已保存 ${xshCookies.length} 个 cookie`);
    }

    // ===== 4. 看广告循环 =====
    for (let i = 0; i < MAX_ADS_PER_DAY; i++) {
      log(`\n  [广告 ${i + 1}/${MAX_ADS_PER_DAY}]`);

      await page.goto(`${XSH_BASE}/quests/ad`, { waitUntil: 'networkidle', timeout: 30000 });
      log(`    URL: ${page.url()}`);

      // 检查是否有效广告页
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      if (!bodyText.includes('Claim') && !bodyText.includes('领取')) {
        log(`    没有更多广告: ${bodyText.substring(0, 200)}`);
        break;
      }

      // 等待倒计时结束 (Claim 按钮出现)
      log('    等待倒计时...');
      let claimed = false;
      for (let w = 0; w < 30; w++) {
        const claimBtn = page.locator('button').filter({ hasText: /Claim|领取/ }).first();
        if (await claimBtn.count() > 0) {
          const disabled = await claimBtn.isDisabled().catch(() => true);
          if (!disabled) {
            const txt = await claimBtn.textContent();
            log(`    找到按钮: "${txt?.trim()}"`);
            await claimBtn.click();
            log('    ✅ Claim 成功!');
            claimed = true;
            adCount++;
            break;
          }
        }
        await sleep(1000);
      }

      if (!claimed) {
        // 尝试用 evaluate 点击
        const clicked = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const btn of btns) {
            const t = btn.textContent || '';
            if ((t.includes('Claim') || t.includes('领取')) && !btn.disabled) {
              btn.click();
              return t.trim();
            }
          }
          return null;
        });
        if (clicked) {
          log(`    ✅ 通过 evaluate 点击: "${clicked}"`);
          adCount++;
        }
      }

      // 可选：点击 Discord 邀请
      const inviteLink = page.locator('a').filter({ hasText: /Discord invite|Open Discord/ }).first();
      if (await inviteLink.count() > 0) {
        log('    点击 Discord 邀请...');
        await inviteLink.click();
        await page.waitForTimeout(2000);
        const pages = context.pages();
        if (pages.length > 1) await pages[1].close();
      }

      await sleep(2000);
    }

    log(`\n  ✅ 共观看 ${adCount} 个广告`);
    await browser.close();
    return { success: true, adsWatched: adCount };
  } catch (err) {
    log(`❌ 错误: ${err.message}`);
    await page.screenshot({ path: 'xsh-error.png' }).catch(() => {});
    await browser.close();
    return { success: false, error: err.message, adsWatched: adCount };
  }
}

// ===================================================================
//  入口
// ===================================================================
async function main() {
  console.log('🚀 X Systems Hosting 自动看广告');
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
    const token = users[i]['Discord-token'] || users[i].token;
    console.log(`\n======= 用户 ${i + 1}/${users.length} =======`);
    const r = await runUser(token);
    results.push(r);
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 汇总');
  console.log('='.repeat(50));
  let totalAds = 0;
  results.forEach((r, i) => {
    const s = r.success ? '✅' : '❌';
    console.log(`  ${s} 用户${i + 1}: ${r.adsWatched || 0} 广告${r.error ? ` (${r.error})` : ''}`);
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