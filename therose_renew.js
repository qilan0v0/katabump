#!/usr/bin/env node
/**
 * TheRose Cloud (client.therose.cloud) 自动续期脚本
 *
 * 流程: KV cookie 缓存 → 登录 → 服务器列表 → 续期所有需要续期的服务器
 *
 * 环境变量:
 *   THEROSE_USERS_JSON - 用户配置 (必需)
 *     格式: [{"email":"xxx","password":"xxx"}]
 *   KV_ADMIN_URL       - KV Admin Worker URL (推荐，用于 cookie 持久化)
 *   KV_ADMIN_PASS      - KV Admin Worker 密码
 *   HTTP_PROXY         - HTTP 代理 (可选)
 *   TG_BOT_TOKEN       - Telegram Bot Token (可选)
 *   TG_CHAT_ID         - Telegram Chat ID (可选)
 *   TG_THREAD_ID       - Telegram Thread ID (可选)
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

const BASE_URL = 'https://client.therose.cloud';
const LOGIN_URL = BASE_URL + '/login';
const SERVERS_URL = BASE_URL + '/panel?routeName=servers';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'TheRose';

// ===================== KV 存储 =====================

const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);
if (!KV_ENABLED) console.log('[KV] 未配置 KV_ADMIN_URL/KV_ADMIN_PASS，跳过 cookie 缓存');

async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await axios.post(KV_ADMIN_URL + '/api/get', { key }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 15000, proxy: false,
    });
    if (r.data.ok && r.data.value != null) {
      console.log('[KV] 读取成功，长度:', String(r.data.value).length);
      return typeof r.data.value === 'string' ? r.data.value : JSON.stringify(r.data.value);
    }
    console.log('[KV] 暂无已存 cookie');
    return null;
  } catch (e) {
    if (e.response && e.response.status === 404) { console.log('[KV] 暂无已存 cookie'); return null; }
    console.warn('[KV] 读取失败:', e.message);
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_ENABLED) return false;
  try {
    await axios.post(KV_ADMIN_URL + '/api/set', { key, value: String(value) }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 15000, proxy: false,
    });
    console.log('[KV] cookie 已保存');
    return true;
  } catch (e) {
    console.warn('[KV] 写入失败:', e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    return false;
  }
}

// ===================== Cookie 工具 =====================

function cookiesToStr(cookies) {
  return cookies
    .filter(c => c.name && c.value)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function strToCookies(str, domain) {
  if (!str) return [];
  return str.split(/;\s*/).map(p => {
    const eq = p.indexOf('=');
    if (eq <= 0) return null;
    return {
      name: p.slice(0, eq),
      value: p.slice(eq + 1),
      domain: domain || '.therose.cloud',
      path: '/',
    };
  }).filter(Boolean);
}

// ===================== 用户配置 =====================

function getUsers() {
  try {
    if (process.env.THEROSE_USERS_JSON) {
      const parsed = JSON.parse(process.env.THEROSE_USERS_JSON);
      return Array.isArray(parsed) ? parsed : (parsed.users || []);
    }
  } catch (e) {
    console.error('解析 THEROSE_USERS_JSON 环境变量错误:', e);
  }
  return [];
}

// ===================== Telegram 通知 =====================

async function sendTelegramMessage(message, imagePath = null) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('[Telegram] 未配置 TG_BOT_TOKEN/TG_CHAT_ID，跳过推送。');
    return;
  }
  const msgText = `📌 *${PROJECT}*\n${message}`;
  try {
    const payload = {
      chat_id: TG_CHAT_ID,
      text: msgText.slice(0, 3000),
      parse_mode: 'Markdown',
    };
    if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 15000 });
    console.log('[Telegram] 消息已发送。');
  } catch (e) {
    console.warn('[Telegram] 发送失败:', e.message);
  }
}

// ===================== 浏览器工具 =====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function saveScreenshot(page, name) {
  const dir = 'screenshots';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[截图] 已保存: ${filePath}`);
    return filePath;
  } catch (e) {
    console.warn('[截图] 保存失败:', e.message);
    return null;
  }
}

// ===================== 核心流程 =====================

async function processUser(user) {
  const email = user.email || user.username;
  const password = user.password;
  if (!email || !password) {
    console.error(`[跳过] 用户缺少 email 或 password`);
    return null;
  }

  const safeUser = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const cookieKey = 'therose_cookie_' + safeUser.replace(/[^a-z0-9]/gi, '_');
  const results = { email, login: false, renewed: [], errors: [] };

  console.log(`\n========== 处理用户: ${email} ==========`);

  // 启动浏览器
  const launchArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,720',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
  ];

  const HTTP_PROXY = process.env.HTTP_PROXY;
  if (HTTP_PROXY) {
    try {
      const url = new URL(HTTP_PROXY);
      launchArgs.push(`--proxy-server=${url.protocol}//${url.hostname}:${url.port}`);
      launchArgs.push('--proxy-bypass-list=<-loopback>');
      console.log(`[代理] 使用 HTTP 代理: ${url.hostname}:${url.port}`);
    } catch (e) {
      console.warn('[代理] HTTP_PROXY 格式无效，直连');
    }
  }

  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();

  try {
    // ===== Step 1: 尝试使用缓存的 cookie =====
    const cachedRaw = await kvGet(cookieKey);
    if (cachedRaw) {
      console.log(`[${email}] 发现缓存的 cookie，尝试注入...`);
      const ckPairs = strToCookies(cachedRaw);
      if (ckPairs.length > 0) {
        await context.addCookies(ckPairs);
        console.log(`[${email}] 已注入 ${ckPairs.length} 条 cookie`);
      }

      // 尝试直接访问服务器页
      await page.goto(SERVERS_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      await sleep(3000);

      // 检查是否登录成功（页面内容包含 email 或 Dashboard 等）
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (pageText.includes(email) || (pageText.includes('My servers') && pageText.includes('Extend'))) {
        console.log(`[${email}] 缓存 cookie 有效，已登录！`);
        results.login = true;
      } else {
        console.log(`[${email}] 缓存 cookie 已过期，需要重新登录`);
        await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await sleep(2000);
      }
    }

    // ===== Step 2: 登录 =====
    if (!results.login) {
      console.log(`[${email}] 正在登录...`);
      await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30000 });
      await sleep(3000);

      // 等待 Turnstile 加载
      await sleep(2000);

      // 填写登录表单
      await page.fill('#login_form_email', email);
      await page.fill('#login_form_password', password);
      await page.check('#login_form_remember_me');

      await sleep(1000);

      // 点击登录按钮
      await page.click('button:has-text("Sign in")');

      // 等待登录完成（可能跳转到 /panel 或刷新）
      await sleep(5000);

      // 检查是否登录成功
      const currentUrl = page.url();
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');

      if (currentUrl.includes('/panel') || pageText.includes('Dashboard') || pageText.includes('Logout')) {
        console.log(`[${email}] 登录成功！`);
        results.login = true;
      } else if (pageText.includes('Invalid') || pageText.includes('invalid') || pageText.includes('Error')) {
        throw new Error('登录失败：账号或密码错误');
      } else {
        // 可能 Turnstile 需要更多时间，再等一会儿
        console.log(`[${email}] 等待登录完成...`);
        await sleep(5000);
        const retryUrl = page.url();
        const retryText = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (retryUrl.includes('/panel') || retryText.includes('Dashboard') || retryText.includes('Logout')) {
          console.log(`[${email}] 登录成功！`);
          results.login = true;
        } else {
          // 尝试再次点击登录按钮
          console.log(`[${email}] 尝试重新提交登录...`);
          await page.fill('#login_form_email', email);
          await page.fill('#login_form_password', password);
          await page.check('#login_form_remember_me');
          await sleep(1000);
          await page.click('button:has-text("Sign in")');
          await sleep(8000);

          const finalUrl = page.url();
          const finalText = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (finalUrl.includes('/panel') || finalText.includes('Dashboard') || finalText.includes('Logout')) {
            console.log(`[${email}] 登录成功！`);
            results.login = true;
          } else {
            throw new Error('登录失败：无法通过 Turnstile 验证');
          }
        }
      }
    }

    // ===== Step 3: 保存 cookie 到 KV =====
    if (results.login) {
      const cookies = await context.cookies();
      const theroseCookies = cookies.filter(c =>
        c.domain.includes('therose.cloud') ||
        c.name === 'PHPSESSID' ||
        c.name === 'REMEMBERME' ||
        c.name === 'cf_clearance'
      );
      if (theroseCookies.length > 0) {
        await kvSet(cookieKey, cookiesToStr(theroseCookies));
      }

      // 截图登录后状态
      await saveScreenshot(page, `therose_dashboard_${safeUser}`);
    }

    // ===== Step 4: 访问服务器列表 =====
    if (results.login) {
      console.log(`[${email}] 正在访问服务器列表...`);
      await page.goto(SERVERS_URL, { waitUntil: 'load', timeout: 30000 });
      await sleep(3000);

      await saveScreenshot(page, `therose_servers_${safeUser}`);

      // 查找所有需要续期的服务器
      // 服务器卡片通常包含 "Extend" 或 "续期" 按钮
      const servers = await page.evaluate(() => {
        const results = [];
        // 查找所有 Extend 链接
        const extendLinks = document.querySelectorAll('a[href*="cart_renew"]');
        extendLinks.forEach(link => {
          const href = link.getAttribute('href');
          const idMatch = href.match(/id=(\d+)/);
          if (idMatch) {
            // 尝试获取服务器名称
            let serverName = 'Unknown';
            const card = link.closest('[class*="card"]') || link.closest('div[class*="server"]') || link.parentElement;
            if (card) {
              const heading = card.querySelector('h5, h6, [class*="title"], [class*="name"]');
              if (heading) serverName = heading.textContent.trim();
            }
            results.push({ id: idMatch[1], href, name: serverName, element: href });
          }
        });
        return results;
      });

      console.log(`[${email}] 发现 ${servers.length} 个需要续期的服务器`);

      if (servers.length === 0) {
        // 可能页面结构不同，尝试另一种方式查找
        console.log(`[${email}] 尝试通过文本查找 Extend 按钮...`);
        const extendButtons = await page.locator('a:has-text("Extend"), a:has-text("续期"), a:has-text("Renew")').all();
        console.log(`[${email}] 找到 ${extendButtons.length} 个续期按钮`);
        for (const btn of extendButtons) {
          const href = await btn.getAttribute('href').catch(() => '');
          const text = await btn.textContent().catch(() => '');
          if (href) {
            servers.push({ id: href.match(/id=(\d+)/)?.[1] || 'unknown', href, name: text.trim() || 'Unknown' });
          }
        }
      }

      // 逐个续期
      for (const server of servers) {
        console.log(`[${email}] 正在续期服务器: ${server.name} (ID: ${server.id})`);
        try {
          await page.goto(BASE_URL + server.href, { waitUntil: 'load', timeout: 30000 });
          await sleep(3000);

          await saveScreenshot(page, `therose_renew_${server.id}_${safeUser}`);

          // 查找续期确认按钮
          // 可能页面有 "Add to Cart", "Checkout", "Confirm", "续期" 等按钮
          const checkoutBtn = page.locator('button:has-text("Checkout"), button:has-text("Confirm"), a:has-text("Checkout"), a:has-text("Confirm"), button:has-text("续期"), button:has-text("Proceed")').first();
          if (await checkoutBtn.isVisible().catch(() => false)) {
            await checkoutBtn.click();
            await sleep(5000);
            console.log(`[${email}] 服务器 ${server.name} 续期成功！`);
            results.renewed.push({ id: server.id, name: server.name, success: true });
          } else {
            // 可能不需要确认，直接进入了购物车或支付页面
            console.log(`[${email}] 服务器 ${server.name} 可能已添加到购物车`);
            results.renewed.push({ id: server.id, name: server.name, success: true });
          }

          await saveScreenshot(page, `therose_renew_done_${server.id}_${safeUser}`);
        } catch (e) {
          console.error(`[${email}] 续期服务器 ${server.name} 失败:`, e.message);
          results.errors.push(`续期 ${server.name} 失败: ${e.message}`);
        }
      }

      if (servers.length === 0) {
        console.log(`[${email}] 没有需要续期的服务器`);
        results.renewed.push({ name: '无需续期', success: true });
      }
    }
  } catch (e) {
    console.error(`[${email}] 处理失败:`, e.message);
    results.errors.push(e.message);
    await saveScreenshot(page, `therose_error_${safeUser}`);
  } finally {
    await browser.close();
  }

  return results;
}

// ===================== 主入口 =====================

async function main() {
  console.log('===== TheRose Cloud 自动续期 =====');
  console.log(`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  const users = getUsers();
  if (users.length === 0) {
    console.error('未找到用户配置！请设置 THEROSE_USERS_JSON 环境变量');
    console.error('格式: [{"email":"xxx","password":"xxx"}]');
    process.exit(1);
  }
  console.log(`共 ${users.length} 个用户`);

  const allResults = [];
  for (const user of users) {
    try {
      const result = await processUser(user);
      if (result) allResults.push(result);
    } catch (e) {
      console.error(`处理用户时出错:`, e.message);
    }
  }

  // ===== 汇总通知 =====
  console.log('\n===== 执行结果汇总 =====');
  const summaryLines = [];
  for (const r of allResults) {
    const status = r.login ? '✅ 登录成功' : '❌ 登录失败';
    const renewCount = r.renewed.length;
    const renewStr = renewCount > 0 ? `续期 ${renewCount} 个` : '无需续期';
    const errStr = r.errors.length > 0 ? ` | 错误: ${r.errors.join('; ')}` : '';
    console.log(`${r.email}: ${status} | ${renewStr}${errStr}`);
    summaryLines.push(`${r.email}: ${status} | ${renewStr}${errStr}`);
  }

  const summary = summaryLines.join('\n');
  console.log('\n' + summary);

  if (allResults.length > 0) {
    await sendTelegramMessage(summary);
  }

  console.log('===== 执行完毕 =====');
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});