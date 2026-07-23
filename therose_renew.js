#!/usr/bin/env node
/**
 * TheRose Cloud (client.therose.cloud) 自动续期
 *
 * 策略：
 *  1. 先访问根 URL 触发 CF 挑战，自动重定向到 /login
 *  2. addInitScript 防检测 + hook Turnstile checkbox
 *  3. 多层 Turnstile 处理：等待自动验证 → render() → CDP 点击
 *  4. 获取 token 后提交表单
 *  5. 遍历服务器列表续期
 *
 * 环境变量:
 *   THEROSE_USERS_JSON - [{"email":"xxx","password":"xxx"}]
 *   KV_ADMIN_URL / KV_ADMIN_PASS - KV cookie 缓存
 *   HTTP_PROXY - 代理
 *   TG_BOT_TOKEN / TG_CHAT_ID / TG_THREAD_ID - 通知
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

chromium.use(stealth);

const BASE_URL = 'https://client.therose.cloud';
const LOGIN_URL = BASE_URL + '/login';
const SERVERS_URL = BASE_URL + '/panel?routeName=servers';

const CHROME_PATH = process.env.CHROME_PATH;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'TheRose';

// 3 分钟超时杀手
const killer = spawn('bash', ['-c', `sleep 180 && kill -9 ${process.pid} 2>/dev/null`], { detached: true, stdio: 'ignore' });
killer.unref();

// ===== 日志 =====
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== KV 存储 =====
const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);

async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await axios.post(KV_ADMIN_URL + '/api/get', { key }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 10000, proxy: false,
    });
    if (r.data.ok && r.data.value != null) return r.data.value;
    return null;
  } catch (e) { return null; }
}
async function kvSet(key, value) {
  if (!KV_ENABLED) return;
  try {
    await axios.post(KV_ADMIN_URL + '/api/set', { key, value: String(value) }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 10000, proxy: false,
    });
  } catch (e) {}
}

// ===== Cookie 工具 =====
function cookiesToStr(cookies) {
  return cookies.filter(c => c.name && c.value).map(c => `${c.name}=${c.value}`).join('; ');
}
function strToCookies(str) {
  if (!str) return [];
  return str.split(/;\s*/).map(p => {
    const eq = p.indexOf('=');
    if (eq <= 0) return null;
    return { name: p.slice(0, eq), value: p.slice(eq + 1), domain: '.therose.cloud', path: '/' };
  }).filter(Boolean);
}

function getUsers() {
  try {
    if (process.env.THEROSE_USERS_JSON) {
      const parsed = JSON.parse(process.env.THEROSE_USERS_JSON);
      return Array.isArray(parsed) ? parsed : (parsed.users || []);
    }
  } catch (e) { log('解析 THEROSE_USERS_JSON 错误: ' + e.message); }
  return [];
}

// ===== Telegram =====
async function tgExec(args) {
  return new Promise((resolve) => {
    const proc = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('close', () => resolve(stdout));
    proc.on('error', e => resolve(`{error: ${e.message}}`));
  });
}
async function sendTg(msg, img) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const text = `*${PROJECT}*\n${msg}`;
  if (img && fs.existsSync(img)) {
    const capFile = img + '.cap.txt';
    try { fs.writeFileSync(capFile, text.slice(0, 1000)); } catch (e) {}
    const args = ['-s', '-X', 'POST', `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`,
      '-F', `chat_id=${TG_CHAT_ID}`];
    if (TG_THREAD_ID) args.push('-F', `message_thread_id=${TG_THREAD_ID}`);
    args.push('-F', `caption=<${capFile}`, '-F', 'parse_mode=Markdown', '-F', `photo=@${img}`);
    await tgExec(args);
    try { fs.unlinkSync(capFile); } catch (e) {}
  } else {
    const args = ['-s', '-X', 'POST', `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
      '-d', `chat_id=${TG_CHAT_ID}`, '-d', `parse_mode=Markdown`, '--data-urlencode', `text=${text.slice(0, 3000)}`];
    if (TG_THREAD_ID) args.push('-d', `message_thread_id=${TG_THREAD_ID}`);
    await tgExec(args);
  }
}

// ===== 注入脚本：防检测 + Turnstile hook =====
const INJECTED_SCRIPT = `
(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (window.chrome) window.chrome.runtime = window.chrome.runtime || {};
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', { get: () => {
      const a = [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' }];
      a.item = i => a[i]; a.namedItem = n => a.find(p => p.name === n); a.length = 1; return a;
    }});
  }
  if (navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  }
  // Turnstile iframe checkbox hook
  if (window.self !== window.top) {
    try {
      const orig = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(init) {
        const sr = orig.call(this, init);
        if (sr) {
          const check = () => {
            const cb = sr.querySelector('input[type="checkbox"]');
            if (cb) {
              const r = cb.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                window.__turnstile_data = { xRatio: (r.left + r.width/2) / window.innerWidth, yRatio: (r.top + r.height/2) / window.innerHeight };
                return true;
              }
            }
            return false;
          };
          if (!check()) {
            const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
            mo.observe(sr, { childList: true, subtree: true });
          }
        }
        return sr;
      };
    } catch(e) {}
  }
})();
`;

// ===== CDP 点击 Turnstile =====
async function attemptTurnstileCdp(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
      if (data) {
        const iframeEl = await frame.frameElement();
        if (!iframeEl) continue;
        const box = await iframeEl.boundingBox();
        if (!box) continue;
        const cx = box.x + (box.width * data.xRatio);
        const cy = box.y + (box.height * data.yRatio);
        log(`CDP 点击: (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
        const client = await page.context().newCDPSession(page);
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
        await sleep(50 + Math.random() * 100);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
        await client.detach();
        return true;
      }
    } catch (e) {}
  }
  return false;
}

// ===== 获取 Turnstile token =====
async function getTurnstileToken(page) {
  // 从页面获取 token
  const getToken = async () => {
    return await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      if (el && el.value && el.value.length > 10) return el.value;
      if (typeof turnstile !== 'undefined') {
        try { const t = turnstile.getResponse(); if (t && t.length > 10) return t; } catch(e) {}
      }
      return null;
    }).catch(() => null);
  };

  // 策略 1: 等待自动验证（最多 40 秒）
  log('等待 Turnstile 自动验证（40 秒）...');
  for (let i = 0; i < 80; i++) {
    const t = await getToken();
    if (t) { log('自动验证成功'); return t; }
    await sleep(500);
  }

  // 策略 2: turnstile.render() 带 callback
  log('自动验证超时，尝试 turnstile.render()...');
  const renderToken = await page.evaluate(() => {
    return new Promise((resolve) => {
      if (typeof turnstile === 'undefined') { resolve(null); return; }
      const container = document.querySelector('.cf-turnstile');
      if (!container) { resolve(null); return; }
      try {
        turnstile.remove();
      } catch(e) {}
      try {
        const to = setTimeout(() => resolve(null), 15000);
        turnstile.render(container, {
          sitekey: '0x4AAAAAADT5H9rlFdzDFH6e',
          callback: (token) => { clearTimeout(to); resolve(token); },
          'error-callback': () => { clearTimeout(to); resolve(null); }
        });
      } catch(e) { resolve(null); }
    });
  }).catch(() => null);
  if (renderToken) { log('render() 获取到 token'); return renderToken; }

  // 策略 3: CDP 点击 Turnstile checkbox
  log('render() 超时，尝试 CDP 点击...');
  const clicked = await attemptTurnstileCdp(page);
  if (clicked) {
    for (let i = 0; i < 20; i++) {
      const t = await getToken();
      if (t) { log('CDP 点击后获取到 token'); return t; }
      await sleep(500);
    }
  }

  log('所有 Turnstile 策略均失败');
  return null;
}

// ===== 登录 =====
async function loginUser(page, email, password) {
  // 先访问根 URL 触发 CF 挑战
  log('访问根 URL 触发 CF 挑战...');
  await page.goto(BASE_URL, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
  await sleep(3000);

  // 如果未重定向到 /login，手动导航
  if (!page.url().includes('/login')) {
    log('手动导航到 /login...');
    await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
    await sleep(2000);
  }

  // 填表单
  log('填写表单...');
  await page.fill('#login_form_email', email).catch(() => {});
  await page.fill('#login_form_password', password).catch(() => {});
  await page.check('#login_form_remember_me').catch(() => {});
  await sleep(500);

  // 获取 Turnstile token
  const token = await getTurnstileToken(page);
  if (token) {
    log(`Turnstile token 已获取 (${token.length} 字符)`);
  } else {
    log('Turnstile token 未生成，尝试直接提交...');
  }

  // 提交表单
  log('点击 Sign in...');
  await page.click('button:has-text("Sign in")').catch(() => {});
  await sleep(5000);

  // 检查结果
  const url = page.url();
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (url.includes('/panel') || text.includes('Dashboard') || text.includes('Logout') || text.includes('My servers')) {
    log('登录成功！');
    return true;
  }

  // 重试一次
  log('第一次提交失败，重试...');
  await page.fill('#login_form_email', email).catch(() => {});
  await page.fill('#login_form_password', password).catch(() => {});
  await page.check('#login_form_remember_me').catch(() => {});
  await sleep(500);
  await page.click('button:has-text("Sign in")').catch(() => {});
  await sleep(5000);

  const url2 = page.url();
  const text2 = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (url2.includes('/panel') || text2.includes('Dashboard') || text2.includes('Logout') || text2.includes('My servers')) {
    log('登录成功！');
    return true;
  }

  log('登录失败');
  return false;
}

// ===== 续期 =====
async function renewServers(page) {
  log('访问服务器列表...');
  await page.goto(SERVERS_URL, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
  await sleep(3000);

  const servers = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="cart_renew"]')).map(a => ({
      href: a.getAttribute('href'),
      text: a.textContent.trim() || 'Unknown'
    }));
  }).catch(() => []);
  log(`发现 ${servers.length} 个服务器`);

  if (servers.length === 0) return ['无需续期'];

  const results = [];
  for (const s of servers) {
    log(`续期: ${s.text}`);
    try {
      await page.goto(BASE_URL + s.href, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
      await sleep(2000);

      const hasOrderBtn = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        return Array.from(btns).some(b => b.textContent.includes('Order now'));
      }).catch(() => false);

      if (hasOrderBtn) {
        log('点击 Order now...');
        await page.click('button:has-text("Order now")').catch(() => {});
        await sleep(3000);
        log(`${s.text} 续期成功`);
        results.push(`${s.text}: 成功`);
      } else {
        results.push(`${s.text}: 已处理`);
      }
    } catch (e) {
      log(`续期失败: ${e.message}`);
      results.push(`${s.text}: 失败`);
    }
  }
  return results;
}

// ===== 主流程 =====
async function main() {
  log('===== TheRose Cloud Auto Renew =====');

  const users = getUsers();
  if (users.length === 0) { log('请设置 THEROSE_USERS_JSON'); process.exit(1); }
  log(`共 ${users.length} 个用户`);

  const allResults = [];
  let errScreenshot = null;

  for (const user of users) {
    const email = user.email || user.username;
    const password = user.password;
    if (!email || !password) continue;

    log(`\n========== ${email} ==========`);

    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720'];
    const proxy = process.env.HTTP_PROXY;
    if (proxy) {
      launchArgs.push(`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>');
    }

    const launchOpts = { headless: false, args: launchArgs };
    if (CHROME_PATH) launchOpts.executablePath = CHROME_PATH;

    const browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0',
      locale: 'en-US',
    });
    const page = await context.newPage();

    // 注入防检测脚本
    await page.addInitScript(INJECTED_SCRIPT);

    try {
      // 尝试缓存 cookie
      const cookieKey = 'therose_cookie_' + email.replace(/[^a-z0-9]/gi, '_');
      const cached = await kvGet(cookieKey);
      if (cached) {
        await context.addCookies(strToCookies(cached));
        await page.goto(SERVERS_URL, { waitUntil: 'commit', timeout: 10000 }).catch(() => {});
        await sleep(2000);
        const text = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (text.includes(email) || text.includes('My servers')) {
          log('缓存 cookie 有效');
          const results = await renewServers(page);
          allResults.push(`${email}: 续期: ${results.join(', ')}`);
          await browser.close();
          continue;
        }
      }

      // 登录
      const ok = await loginUser(page, email, password);
      if (ok) {
        // 保存 cookie
        const cookies = await context.cookies();
        const theroseCookies = cookies.filter(c => c.name === 'PHPSESSID' || c.name === 'REMEMBERME' || c.name === 'cf_clearance');
        if (theroseCookies.length > 0) await kvSet(cookieKey, cookiesToStr(theroseCookies));

        const results = await renewServers(page);
        allResults.push(`${email}: 登录成功 | 续期: ${results.join(', ')}`);
      } else {
        allResults.push(`${email}: 登录失败`);
        errScreenshot = 'error.png';
        await page.screenshot({ path: errScreenshot, fullPage: true }).catch(() => {});
      }
    } catch (e) {
      log(`异常: ${e.message}`);
      allResults.push(`${email}: 异常 - ${e.message}`);
      errScreenshot = 'error.png';
      await page.screenshot({ path: errScreenshot, fullPage: true }).catch(() => {});
    } finally {
      await browser.close();
    }
  }

  log('\n===== 结果 =====');
  const summary = allResults.join('\n');
  console.log(summary);
  await sendTg(summary, errScreenshot);
  log('===== 完毕 =====');
}

main().catch(e => {
  log('失败: ' + e.message);
  process.exit(1);
});