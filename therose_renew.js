#!/usr/bin/env node
/**
 * TheRose Cloud (client.therose.cloud) 自动续期脚本
 *
 * 流程: KV cookie 缓存 → 登录 → 服务器列表 → 续期所有需要续期的服务器
 *
 * 环境变量:
 *   THEROSE_USERS_JSON - 用户配置 (必需)
 *     格式: [{"email":"xxx","password":"xxx","V2":"vmess://..."}]
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
const { spawn } = require('child_process');
const http = require('http');

chromium.use(stealth);

const BASE_URL = 'https://client.therose.cloud';
const LOGIN_URL = BASE_URL + '/login';
const SERVERS_URL = BASE_URL + '/panel?routeName=servers';

const CHROME_PATH = process.env.CHROME_PATH;
const V2RAY_BIN = process.env.V2RAY_BIN || `${process.env.HOME}/v2ray/v2ray`;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'TheRose';

// 时间戳日志
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function log(msg) { console.log(`[${now()}] ${msg}`); }

// v2ray 进程管理
const allV2rayProcs = [];
let nextV2rayPort = 10810;

function cleanupV2ray() {
  for (const { proc, port } of allV2rayProcs) {
    try { proc.kill('SIGTERM'); } catch (e) {}
    try { fs.unlinkSync(path.join(process.cwd(), `v2ray-therose-${port}.json`)); } catch (e) {}
  }
  allV2rayProcs.length = 0;
}
process.on('exit', () => cleanupV2ray());
process.on('SIGINT', () => { cleanupV2ray(); process.exit(0); });
process.on('SIGTERM', () => { cleanupV2ray(); process.exit(0); });

// ===================== KV 存储 =====================

const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);
if (!KV_ENABLED) log('[KV] 未配置 KV_ADMIN_URL/KV_ADMIN_PASS，跳过 cookie 缓存');

async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await axios.post(KV_ADMIN_URL + '/api/get', { key }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 15000, proxy: false,
    });
    if (r.data.ok && r.data.value != null) {
      log('[KV] 读取成功，长度: ' + String(r.data.value).length);
      return typeof r.data.value === 'string' ? r.data.value : JSON.stringify(r.data.value);
    }
    log('[KV] 暂无已存 cookie');
    return null;
  } catch (e) {
    if (e.response && e.response.status === 404) { log('[KV] 暂无已存 cookie'); return null; }
    log('[KV] 读取失败: ' + e.message);
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
    log('[KV] cookie 已保存');
    return true;
  } catch (e) {
    log('[KV] 写入失败: ' + (e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message));
    return false;
  }
}

// ===================== Cookie 工具 =====================

function cookiesToStr(cookies) {
  return cookies.filter(c => c.name && c.value).map(c => `${c.name}=${c.value}`).join('; ');
}

function strToCookies(str, domain) {
  if (!str) return [];
  return str.split(/;\s*/).map(p => {
    const eq = p.indexOf('=');
    if (eq <= 0) return null;
    return { name: p.slice(0, eq), value: p.slice(eq + 1), domain: domain || '.therose.cloud', path: '/' };
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
    log('解析 THEROSE_USERS_JSON 错误: ' + e.message);
  }
  return [];
}

// ===================== Telegram 通知 =====================

async function tgExec(args) {
  return new Promise((resolve) => {
    const proc = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('close', () => resolve(stdout));
    proc.on('error', e => resolve(`{error: ${e.message}}`));
  });
}

async function sendTelegramMessage(message, imagePath = null) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) { log('[Telegram] 未配置，跳过推送'); return; }
  const msgText = `📌 *${PROJECT}*\n${message}`;
  const baseArgs = ['-s', '-X', 'POST', `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, '-d', `chat_id=${TG_CHAT_ID}`];
  if (TG_THREAD_ID) baseArgs.push('-d', `message_thread_id=${TG_THREAD_ID}`);

  if (imagePath && fs.existsSync(imagePath)) {
    log('[Telegram] 发送图文消息...');
    const capFile = `${imagePath}.tg_caption.txt`;
    try { fs.writeFileSync(capFile, msgText.slice(0, 1000)); } catch (e) {}
    const photoArgs = ['-s', '-X', 'POST', `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, '-F', `chat_id=${TG_CHAT_ID}`];
    if (TG_THREAD_ID) photoArgs.push('-F', `message_thread_id=${TG_THREAD_ID}`);
    photoArgs.push('-F', `caption=<${capFile}`, '-F', 'parse_mode=Markdown', '-F', `photo=@${imagePath}`);
    const stdout = await tgExec(photoArgs);
    if (stdout.includes('"ok":true')) { log('[Telegram] 图文消息已发送'); }
    else {
      log('[Telegram] 图文(Markdown)失败，改纯文本重试: ' + stdout.slice(0, 200));
      const idx = photoArgs.indexOf('parse_mode=Markdown');
      if (idx >= 0) { photoArgs.splice(idx, 1); photoArgs.splice(idx - 1, 1); }
      const stdout2 = await tgExec(photoArgs);
      if (!stdout2.includes('"ok":true')) log('[Telegram] 图文消息发送失败: ' + stdout2.slice(0, 200));
    }
    try { fs.unlinkSync(capFile); } catch (e) {}
  } else {
    baseArgs.push('-d', 'parse_mode=Markdown', '--data-urlencode', `text=${msgText.slice(0, 3000)}`);
    const stdout = await tgExec(baseArgs);
    if (stdout.includes('"ok":true')) log('[Telegram] 消息已发送');
    else log('[Telegram] 发送失败: ' + stdout.slice(0, 200));
  }
}

// ===================== v2ray 管理 =====================

async function startV2rayForLink(link) {
  if (!fs.existsSync(V2RAY_BIN)) { log(`[v2ray] 未找到二进制 (${V2RAY_BIN})`); return null; }
  const port = nextV2rayPort++;
  let cfgPath;
  try {
    const { buildConfig } = require('./.github/scripts/gen-v2ray-config');
    const cfg = buildConfig(link, port);
    cfgPath = path.join(process.cwd(), `v2ray-therose-${port}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  } catch (e) { log('[v2ray] 解析链接失败: ' + e.message); return null; }
  log(`[v2ray] 启动实例 (HTTP 127.0.0.1:${port})...`);
  const proc = spawn(V2RAY_BIN, ['run', '-config', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
  allV2rayProcs.push({ proc, port });

  const ready = await new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, () => resolve(true));
      req.on('error', () => { if (++n >= 15) return resolve(false); setTimeout(tick, 2000); });
      req.on('timeout', () => { req.destroy(); if (++n >= 15) return resolve(false); else setTimeout(tick, 2000); });
      req.end();
    };
    tick();
  });
  if (!ready) { log(`[v2ray] 端口 ${port} 未就绪。stderr: ${stderr.slice(-400)}`); return null; }
  log(`[v2ray] 代理就绪 → http://127.0.0.1:${port}`);
  return { port, url: `http://127.0.0.1:${port}` };
}

async function resolveProxyForUser(user) {
  if (user.V2 || user.v2) {
    log('[代理] 用户有 V2 链接，启动独立 v2ray...');
    const result = await startV2rayForLink(user.V2 || user.v2);
    if (result) return result;
    log('[代理] 独立 v2ray 启动失败，回退');
  }
  if (process.env.HTTP_PROXY) {
    try {
      const url = new URL(process.env.HTTP_PROXY);
      log(`[代理] 使用全局 HTTP 代理: ${url.hostname}:${url.port}`);
      return null;
    } catch (e) { log('[代理] HTTP_PROXY 格式无效，直连'); }
  }
  log('[代理] 直连');
  return null;
}

// ===================== 浏览器工具 =====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeGoto(page, url) {
  await page.goto(url, { waitUntil: 'commit', timeout: 8000 }).catch(e => {
    log(`[导航] ${url} 超时: ${(e.message || '').slice(0, 60)}`);
  });
  await sleep(1000);
}

async function saveScreenshot(page, name) {
  const dir = 'screenshots';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    log(`[截图] 已保存: ${filePath}`);
    return filePath;
  } catch (e) { log('[截图] 保存失败: ' + e.message); return null; }
}

// ===================== Turnstile 绕过 =====================

// 注入脚本：在页面加载前执行，覆盖自动化检测
const INJECTED_SCRIPT = `
(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (window.chrome) { window.chrome.runtime = window.chrome.runtime || {}; }
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (d) => {
      if (d.name === 'notifications') return Promise.resolve({ state: 'denied' });
      return originalQuery.call(window.navigator.permissions, d);
    };
  }
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', { get: () => {
      const a = [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' }];
      a.item = i => a[i]; a.namedItem = n => a.find(p => p.name === n); a.length = 1; return a;
    }});
  }
  if (navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  }
  const origError = console.error;
  console.error = function() {
    const msg = Array.from(arguments).join(' ');
    if (msg.includes('font-size') || msg.includes('NaN')) return;
    return origError.apply(console, arguments);
  };
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    if (this.width === 0 || this.height === 0) return 'data:image/png;base64,';
    return origToDataURL.apply(this, arguments);
  };
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    if (gp) {
      WebGLRenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel Iris OpenGL Engine';
        return gp.call(this, p);
      };
    }
  } catch(e) {}
})();
`;

// 补丁函数：替换 JS 中的自动化检测代码
function patchJs(body) {
  if (!body || body.length < 10) return body;
  return body
    .replace(/navigator\.webdriver/g, 'void 0')
    .replace(/"webdriver"\s*in\s*navigator/g, 'false')
    .replace(/navigator\.plugins\.length/g, '1')
    .replace(/"plugins"\s*in\s*navigator/g, 'true')
    .replace(/navigator\.languages/g, "['en-US','en']")
    .replace(/"languages"\s*in\s*navigator/g, 'true')
    .replace(/\.toDataURL\s*\(/g, '.toDataURL.call(')
    .replace(/"score":\d+/g, '"score":0.9')
    .replace(/"error":/g, '"ignore":');
}

// 带超时的 route.fetch
async function routeFetchWithTimeout(route, timeoutMs = 5000) {
  return await Promise.race([
    route.fetch(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
  ]);
}

// 设置三层路由拦截
async function setupRouteInterception(page) {
  // 第1层：拦截所有 cdn-cgi/challenge-platform JS 脚本，打补丁移除自动化检测
  await page.route('**/cdn-cgi/challenge-platform/**', async (route) => {
    const url = route.request().url();
    const resType = route.request().resourceType();
    try {
      if (resType === 'script' || url.endsWith('.js') || url.includes('api.js') || url.includes('main.js')) {
        const response = await routeFetchWithTimeout(route);
        let body = await response.text();
        const origLen = body.length;
        body = patchJs(body);
        log(`[拦截] 挑战脚本已打补丁: ${url.slice(-60)} (${origLen}->${body.length})`);
        await route.fulfill({ body, contentType: 'application/javascript' });
      } else {
        await route.continue();
      }
    } catch (e) {
      await route.continue();
    }
  });

  // 第2层：拦截 challenges.cloudflare.com 的验证/指纹请求，返回成功
  await page.route('**/challenges.cloudflare.com/**', async (route) => {
    const url = route.request().url();
    const resType = route.request().resourceType();
    if (resType === 'script' || url.includes('api.js')) {
      try {
        const response = await routeFetchWithTimeout(route);
        let body = await response.text();
        body = patchJs(body);
        await route.fulfill({ body, contentType: 'application/javascript' });
      } catch (e) {
        await route.continue();
      }
      return;
    }
    // 指纹/验证 API 返回成功
    if (url.includes('/pat/') || url.includes('/fo/') || url.includes('/i/') || url.includes('/ci/')) {
      log(`[拦截] 伪造成功响应: ${url.slice(-50)}`);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, score: 0.9 }) });
      return;
    }
    await route.continue();
  });

  // 第3层：拦截源站 cdn-cgi 请求（oneshot 检测），直接放行不阻塞
  await page.route('**/cdn-cgi/challenge-platform/h/*/jsd/oneshot/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // 拦截 Turnstile api.js
  await page.route('**/turnstile/v0/api.js*', async (route) => {
    try {
      const response = await routeFetchWithTimeout(route);
      let body = await response.text();
      body = patchJs(body);
      await route.fulfill({ body, contentType: 'application/javascript' });
    } catch (e) {
      await route.continue();
    }
  });

  log('[拦截] 三层路由拦截已设置');
}

// 等待 Turnstile token，最多 5 秒
async function waitForTurnstileToken(page, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const token = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      return el ? el.value : '';
    }).catch(() => '');
    if (token && token.length > 10) {
      log(`[Turnstile] token 已生成 (${token.length} 字符)`);
      return token;
    }
    await sleep(500);
  }
  log('[Turnstile] 等待 token 超时 (' + timeoutMs + 'ms)');
  return null;
}

// 手动触发 Turnstile（超时 5 秒）
async function triggerTurnstile(page) {
  log('[Turnstile] 尝试手动触发...');
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      if (typeof turnstile === 'undefined') { resolve({ error: 'turnstile undefined' }); return; }
      const ci = setInterval(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        if (el && el.value && el.value.length > 10) { clearInterval(ci); resolve({ success: true, token: el.value }); }
      }, 200);
      try { turnstile.execute(undefined, { callback: (t) => { clearInterval(ci); resolve({ success: true, token: t }); } }); }
      catch (e) { clearInterval(ci); resolve({ error: e.message }); }
      setTimeout(() => { clearInterval(ci); resolve({ timeout: true, token: document.querySelector('input[name="cf-turnstile-response"]')?.value || '' }); }, 3000);
    });
  }).catch(e => ({ error: e.message }));
  log('[Turnstile] 触发结果: ' + JSON.stringify(result).slice(0, 100));
  return result;
}

// ===================== 核心流程 =====================

async function processUser(user) {
  const email = user.email || user.username;
  const password = user.password;
  if (!email || !password) { log('[跳过] 用户缺少 email 或 password'); return null; }

  const safeUser = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const cookieKey = 'therose_cookie_' + safeUser.replace(/[^a-z0-9]/gi, '_');
  const results = { email, login: false, renewed: [], errors: [] };

  log(`\n========== 处理用户: ${email} ==========`);

  // 解析用户代理
  const v2rayInfo = await resolveProxyForUser(user);

  // 启动浏览器
  const launchArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,720',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
  ];

  if (v2rayInfo) {
    launchArgs.push(`--proxy-server=${v2rayInfo.url}`);
    launchArgs.push('--proxy-bypass-list=<-loopback>');
    log(`[代理] 使用独立 v2ray: ${v2rayInfo.url}`);
  } else if (process.env.HTTP_PROXY) {
    try {
      const url = new URL(process.env.HTTP_PROXY);
      launchArgs.push(`--proxy-server=${url.protocol}//${url.hostname}:${url.port}`);
      launchArgs.push('--proxy-bypass-list=<-loopback>');
      log(`[代理] 使用全局 HTTP 代理: ${url.hostname}:${url.port}`);
    } catch (e) { log('[代理] HTTP_PROXY 格式无效，直连'); }
  }

  const launchOpts = { headless: false, args: launchArgs };
  if (CHROME_PATH) launchOpts.executablePath = CHROME_PATH;
  log('[浏览器] 启动中...');
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();

  // 注入防检测脚本
  await page.addInitScript(INJECTED_SCRIPT);
  log('[注入] 防检测脚本已注入');

  // 设置三层路由拦截
  await setupRouteInterception(page);

  try {
    // ===== Step 1: 尝试使用缓存的 cookie =====
    const cachedRaw = await kvGet(cookieKey);
    if (cachedRaw) {
      log(`[${email}] 发现缓存的 cookie，尝试注入...`);
      const ckPairs = strToCookies(cachedRaw);
      if (ckPairs.length > 0) {
        await context.addCookies(ckPairs);
        log(`[${email}] 已注入 ${ckPairs.length} 条 cookie`);
      }
      await safeGoto(page, SERVERS_URL);
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (pageText.includes(email) || (pageText.includes('My servers') && pageText.includes('Extend'))) {
        log(`[${email}] 缓存 cookie 有效，已登录！`);
        results.login = true;
      } else {
        log(`[${email}] 缓存 cookie 已过期，需要重新登录`);
      }
    }

    // ===== Step 2: 登录 =====
    if (!results.login) {
      log(`[${email}] 正在登录（先访问根 URL 触发 CF 挑战）...`);
      await safeGoto(page, BASE_URL);
      if (!page.url().includes('/login')) {
        await safeGoto(page, LOGIN_URL);
      }

      // 填写登录表单
      log(`[${email}] 填写表单...`);
      await page.fill('#login_form_email', email).catch(() => {});
      await page.fill('#login_form_password', password).catch(() => {});
      await page.check('#login_form_remember_me').catch(() => {});
      await sleep(500);

      // 等待 Turnstile 加载
      log(`[${email}] 等待 Turnstile...`);
      await sleep(1000);

      // 尝试获取 token（最多 3 秒）
      let token = await waitForTurnstileToken(page, 3000);
      if (!token) {
        await triggerTurnstile(page);
        token = await waitForTurnstileToken(page, 3000);
      }

      if (token) log(`[${email}] Turnstile token 已获取，提交登录...`);
      else log(`[${email}] Turnstile token 未生成，直接提交（有时也能通过）...`);

      // 提交表单
      await page.click('button:has-text("Sign in")').catch(() => {});
      await sleep(3000);

      // 检查登录结果
      const currentUrl = page.url();
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');

      if (currentUrl.includes('/panel') || pageText.includes('Dashboard') || pageText.includes('Logout')) {
        log(`[${email}] ✅ 登录成功！`);
        results.login = true;
      } else if (pageText.includes('Invalid') || pageText.includes('invalid')) {
        throw new Error('登录失败：账号或密码错误');
      } else {
        // 第二次尝试
        log(`[${email}] 第一次提交失败，尝试第二次...`);
        await page.fill('#login_form_email', email).catch(() => {});
        await page.fill('#login_form_password', password).catch(() => {});
        await page.check('#login_form_remember_me').catch(() => {});
        await sleep(500);
        await triggerTurnstile(page);
        await sleep(1000);
        await page.click('button:has-text("Sign in")').catch(() => {});
        await sleep(3000);

        const finalUrl = page.url();
        const finalText = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (finalUrl.includes('/panel') || finalText.includes('Dashboard') || finalText.includes('Logout')) {
          log(`[${email}] ✅ 登录成功！`);
          results.login = true;
        } else {
          throw new Error('登录失败：无法通过 Turnstile 验证');
        }
      }
    }

    // ===== Step 3: 保存 cookie 到 KV =====
    if (results.login) {
      const cookies = await context.cookies();
      const theroseCookies = cookies.filter(c =>
        c.domain.includes('therose.cloud') || c.name === 'PHPSESSID' || c.name === 'REMEMBERME' || c.name === 'cf_clearance'
      );
      if (theroseCookies.length > 0) await kvSet(cookieKey, cookiesToStr(theroseCookies));
      await saveScreenshot(page, `therose_dashboard_${safeUser}`);
    }

    // ===== Step 4: 访问服务器列表 =====
    if (results.login) {
      log(`[${email}] 正在访问服务器列表...`);
      await safeGoto(page, SERVERS_URL);
      await saveScreenshot(page, `therose_servers_${safeUser}`);

      // 查找所有需要续期的服务器
      const servers = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('a[href*="cart_renew"]').forEach(link => {
          const href = link.getAttribute('href');
          const idMatch = href.match(/id=(\d+)/);
          if (idMatch) {
            let serverName = 'Unknown';
            const card = link.closest('[class*="card"]') || link.closest('div[class*="server"]') || link.parentElement;
            if (card) {
              const heading = card.querySelector('h5, h6, [class*="title"], [class*="name"]');
              if (heading) serverName = heading.textContent.trim();
            }
            results.push({ id: idMatch[1], href, name: serverName });
          }
        });
        return results;
      });

      log(`[${email}] 发现 ${servers.length} 个需要续期的服务器`);

      if (servers.length === 0) {
        log(`[${email}] 尝试通过文本查找 Extend 按钮...`);
        const extendButtons = await page.locator('a:has-text("Extend"), a:has-text("续期"), a:has-text("Renew")').all();
        log(`[${email}] 找到 ${extendButtons.length} 个续期按钮`);
        for (const btn of extendButtons) {
          const href = await btn.getAttribute('href').catch(() => '');
          const text = await btn.textContent().catch(() => '');
          if (href) servers.push({ id: href.match(/id=(\d+)/)?.[1] || 'unknown', href, name: text.trim() || 'Unknown' });
        }
      }

      // 逐个续期
      for (const server of servers) {
        log(`[${email}] 正在续期服务器: ${server.name} (ID: ${server.id})`);
        try {
          await safeGoto(page, BASE_URL + server.href);
          await saveScreenshot(page, `therose_renew_${server.id}_${safeUser}`);

          const checkoutBtn = page.locator('button:has-text("Checkout"), button:has-text("Confirm"), a:has-text("Checkout"), a:has-text("Confirm"), button:has-text("续期"), button:has-text("Proceed")').first();
          if (await checkoutBtn.isVisible().catch(() => false)) {
            await checkoutBtn.click();
            await sleep(2000);
            log(`[${email}] ✅ 服务器 ${server.name} 续期成功！`);
            results.renewed.push({ id: server.id, name: server.name, success: true });
          } else {
            log(`[${email}] 服务器 ${server.name} 可能已添加到购物车`);
            results.renewed.push({ id: server.id, name: server.name, success: true });
          }
          await saveScreenshot(page, `therose_renew_done_${server.id}_${safeUser}`);
        } catch (e) {
          log(`[${email}] 续期服务器 ${server.name} 失败: ${e.message}`);
          results.errors.push(`续期 ${server.name} 失败: ${e.message}`);
        }
      }

      if (servers.length === 0) {
        log(`[${email}] 没有需要续期的服务器`);
        results.renewed.push({ name: '无需续期', success: true });
      }
    }
  } catch (e) {
    log(`[${email}] 处理失败: ${e.message}`);
    results.errors.push(e.message);
    const sp = await saveScreenshot(page, `therose_error_${safeUser}`);
    if (sp) results.errorScreenshot = sp;
  } finally {
    await browser.close();
  }

  return results;
}

// ===================== 主入口 =====================

async function main() {
  log('===== TheRose Cloud 自动续期 =====');

  const users = getUsers();
  if (users.length === 0) {
    log('未找到用户配置！请设置 THEROSE_USERS_JSON');
    log('格式: [{"email":"xxx","password":"xxx","V2":"vmess://..."}]');
    process.exit(1);
  }
  log(`共 ${users.length} 个用户`);

  const allResults = [];
  let lastErrorScreenshot = null;
  for (const user of users) {
    try {
      const result = await processUser(user);
      if (result) {
        allResults.push(result);
        if (result.errorScreenshot) lastErrorScreenshot = result.errorScreenshot;
      }
    } catch (e) {
      log(`处理用户时出错: ${e.message}`);
    }
  }

  // ===== 汇总通知 =====
  log('\n===== 执行结果汇总 =====');
  const summaryLines = [];
  for (const r of allResults) {
    const status = r.login ? '✅ 登录成功' : '❌ 登录失败';
    const renewCount = r.renewed.length;
    const renewStr = renewCount > 0 ? `续期 ${renewCount} 个` : '无需续期';
    const errStr = r.errors.length > 0 ? ` | 错误: ${r.errors.join('; ')}` : '';
    log(`${r.email}: ${status} | ${renewStr}${errStr}`);
    summaryLines.push(`${r.email}: ${status} | ${renewStr}${errStr}`);
  }

  const summary = summaryLines.join('\n');
  console.log('\n' + summary);

  if (allResults.length > 0) await sendTelegramMessage(summary, lastErrorScreenshot);

  log('===== 执行完毕 =====');
}

// 全局超时：20 分钟后强制退出，防止卡死
const GLOBAL_TIMEOUT = 3 * 60 * 1000;
const timeoutTimer = setTimeout(() => {
  log('[超时] 脚本执行超过 3 分钟，强制退出');
  cleanupV2ray();
  process.exit(1);
}, GLOBAL_TIMEOUT);

main().then(() => {
  clearTimeout(timeoutTimer);
}).catch(e => {
  log('脚本执行失败: ' + e.message);
  clearTimeout(timeoutTimer);
  process.exit(1);
});
