/**
 * X Systems Hosting — Discord Token 登录 + 自动看广告 (全浏览器版)
 * ================================================================
 * 全程 Playwright 模拟点击，和手动操作完全一致。
 *
 * 环境变量:
 *   XSH_USERS_JSON = [{"Discord-token":"MTM3..."}]
 *   KV_ADMIN_URL / KV_ADMIN_PASS
 *   TG_BOT_TOKEN / TG_CHAT_ID / TG_THREAD_ID
 */

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');

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

// ---------- 工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    console.log('  [1] 打开 xsystemshosting...');
    await page.goto(`${XSH_BASE}/dashboard/discord`, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`      URL: ${page.url()}`);

    // 如果已经在 dashboard，跳过登录
    if (!page.url().includes('/dashboard')) {
      // ===== 2. 点击 "Continue with Discord" =====
      console.log('  [2] 点击 Continue with Discord...');
      await page.click('text="Continue with Discord"');
      await page.waitForTimeout(3000);
      console.log(`      URL: ${page.url()}`);

      // 如果已跳回 xsh，跳过 Discord 登录
      if (!page.url().includes(XSH_BASE)) {
        // ===== 3. 注入 Discord Token =====
        console.log('  [3] 注入 Discord Token...');
        await page.evaluate((t) => {
          const iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          document.body.appendChild(iframe);
          iframe.contentWindow.localStorage.setItem('token', JSON.stringify(t));
          document.body.removeChild(iframe);
        }, token);

        // 跳转 Discord 频道页触发 token 认证
        await page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        console.log(`      Discord URL: ${page.url()}`);

        // ===== 4. 回到 OAuth 授权页 =====
        console.log('  [4] 回到 OAuth 授权页...');
        await page.goto(
          'https://discord.com/oauth2/authorize?client_id=1472320867060023540&redirect_uri=https%3A%2F%2Fxsystemshosting.com%2Fauth%2Fdiscord%2Fcallback&response_type=code&scope=identify%20email',
          { waitUntil: 'networkidle', timeout: 30000 }
        );
        await page.waitForTimeout(3000);
        console.log(`      OAuth URL: ${page.url()}`);

        // ===== 5. 点击授权按钮 =====
        console.log('  [5] 点击授权按钮...');

        // 等待按钮出现（最多 10 秒）
        await page.waitForSelector('button:has-text("授权")', { timeout: 10000 }).catch(() => {});
        await page.waitForSelector('button:has-text("Authorize")', { timeout: 3000 }).catch(() => {});

        // 用 locator 方式点击
        const authBtn = page.locator('button').filter({ hasText: /授权|Authorize/ }).first();
        if (await authBtn.count() > 0) {
          const text = await authBtn.textContent();
          console.log(`      找到按钮: "${text?.trim()}"`);
          await authBtn.click();
        } else {
          // fallback: 用 evaluate 直接提交
          console.log('      按钮未找到，尝试 JavaScript 提交...');
          await page.evaluate(() => {
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {
              if (btn.textContent?.includes('授权') || btn.textContent?.includes('Authorize')) {
                btn.click();
                return;
              }
            }
          });
        }

        // 等待跳转回 xsystemshosting
        await page.waitForTimeout(5000);
        try {
          await page.waitForURL('**/xsystemshosting.com/**', { timeout: 20000 });
        } catch {}
      }

      console.log(`      登录后 URL: ${page.url()}`);
    }

    // ===== 保存 session cookie 到 KV =====
    const cookies = await context.cookies();
    const xshCookies = cookies.filter(c =>
      c.domain === 'xsystemshosting.com' || c.domain === '.xsystemshosting.com'
    );
    if (xshCookies.length > 0) {
      await kvPut(`xsh_${token.slice(0, 20)}`, JSON.stringify(xshCookies));
      console.log(`  🍪 已保存 ${xshCookies.length} 个 cookie`);
    }

    // ===== 6. 看广告循环 =====
    for (let i = 0; i < MAX_ADS_PER_DAY; i++) {
      console.log(`\n  [广告 ${i + 1}/${MAX_ADS_PER_DAY}]`);

      // 6a. 点击 "Watch ads"
      console.log('    点击 Watch ads...');
      await page.goto(`${XSH_BASE}/quests/ad`, { waitUntil: 'networkidle', timeout: 30000 });
      console.log(`    URL: ${page.url()}`);

      // 检查是否有效广告页
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      if (!bodyText.includes('Claim') && !bodyText.includes('领取')) {
        console.log(`    没有更多广告: ${bodyText.substring(0, 200)}`);
        break;
      }
      console.log(`    页面内容: ${bodyText.substring(0, 100)}`);

      // 6b. 等待倒计时结束 (Claim 按钮出现)
      console.log('    等待倒计时...');
      for (let w = 0; w < 30; w++) {
        const claimBtn = page.locator('button').filter({ hasText: /Claim|领取/ }).first();
        if (await claimBtn.count() > 0 && await claimBtn.isEnabled().catch(() => false)) {
          const txt = await claimBtn.textContent();
          console.log(`    找到按钮: "${txt?.trim()}"`);
          await claimBtn.click();
          console.log('    ✅ Claim 点击成功!');
          adCount++;
          break;
        }
        await sleep(1000);
      }

      // 6c. 可选：点击 Discord 邀请
      const inviteLink = page.locator('a').filter({ hasText: /Discord invite|Open Discord/ }).first();
      if (await inviteLink.count() > 0) {
        console.log('    点击 Discord 邀请...');
        await inviteLink.click();
        await page.waitForTimeout(2000);
        // 切回原标签页
        const pages = context.pages();
        if (pages.length > 1) await pages[1].close();
        console.log('    ✅ Discord 邀请奖励已领取');
      }

      await sleep(2000);
    }

    console.log(`\n  ✅ 共观看 ${adCount} 个广告`);
    await browser.close();
    return { success: true, adsWatched: adCount };
  } catch (err) {
    console.error(`  ❌ 错误: ${err.message}`);
    await page.screenshot({ path: 'xsh-error.png' }).catch(() => {});
    await browser.close();
    return { success: false, error: err.message, adsWatched: adCount };
  }
}

// ===================================================================
//  入口
// ===================================================================
async function main() {
  console.log('🚀 X Systems Hosting 自动看广告 (全浏览器版)');
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