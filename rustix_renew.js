// Rustix.me 每月续期脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 优先使用 KV cookie 免登录 → 失败则尝试登录 → 导航到服务页 → 点击「Продлить」续期
// 支持每个账号独立 V2Ray 代理：user.V2 = "vless://..."
// 账号来源: Secret RUSTIX_USERS_JSON =
//   [{"username":"xxx@gmail.com","password":"xxx","serverUrl":"https://rustix.me/me/services/18806","V2":"vless://..."}]
// cookie 通过 KV Admin Worker 存取，key = rustix_cookie_<username>
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const BASE_URL = 'https://rustix.me';
const LOGIN_URL = BASE_URL + '/auth/signin';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'Rustix';

// 全局 HTTP 代理 (由 workflow 启动的 v2ray 全局代理，或用户设置的 HTTP_PROXY)
const HTTP_PROXY = process.env.HTTP_PROXY;

// v2ray 二进制路径
const V2RAY_BIN = process.env.V2RAY_BIN || `${process.env.HOME}/v2ray/v2ray`;

// 管理所有启动的 v2ray 子进程
const allV2rayProcs = [];
let nextV2rayPort = 10810;

// ===== Telegram 通知 =====
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.warn('[Telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }
    const text = `📌 *${PROJECT}*\n${message}`;
    const tgErr = (e) => (e.response && e.response.data && e.response.data.description)
        ? `${e.response.data.error_code} ${e.response.data.description}`
        : e.message;
    const threadArg = TG_THREAD_ID ? ` -F message_thread_id="${TG_THREAD_ID}"` : '';

    if (imagePath && fs.existsSync(imagePath)) {
        const captionFile = `${imagePath}.caption.txt`;
        try { fs.writeFileSync(captionFile, text.slice(0, 1000)); } catch (e) { }
        const sendPhoto = (withMd) => new Promise(resolve => {
            const md = withMd ? ' -F parse_mode="Markdown"' : '';
            const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto"`
                + ` -F chat_id="${TG_CHAT_ID}"${threadArg}`
                + ` -F "caption=<${captionFile}"${md} -F photo="@${imagePath}"`;
            exec(cmd, (err, stdout) => resolve({ err, stdout: stdout || '' }));
        });
        let r = await sendPhoto(true);
        if (!r.err && r.stdout.includes('"ok":true')) {
            console.log('[Telegram] 图文消息已发送。');
        } else {
            console.warn('[Telegram] 图文(Markdown)发送失败，改纯文本重试:', (r.stdout || (r.err && r.err.message) || '').slice(0, 200));
            r = await sendPhoto(false);
            if (!r.err && r.stdout.includes('"ok":true')) console.log('[Telegram] 图文消息已发送 (纯文本)。');
            else console.error('[Telegram] 图文消息发送失败:', (r.stdout || '').slice(0, 300));
        }
        try { fs.unlinkSync(captionFile); } catch (e) { }
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        const base = { chat_id: TG_CHAT_ID };
        if (TG_THREAD_ID) base.message_thread_id = Number(TG_THREAD_ID);
        try {
            await axios.post(url, { ...base, text, parse_mode: 'Markdown' });
            console.log('[Telegram] Message sent.');
        } catch (e) {
            console.warn('[Telegram] Markdown 发送失败，改用纯文本重试:', tgErr(e));
            await axios.post(url, { ...base, text });
            console.log('[Telegram] Message sent (plain text).');
        }
    } catch (e) {
        console.error('[Telegram] 文字推送失败:', tgErr(e),
            '\n   >> 提示: "chat not found" 通常表示 TG_CHAT_ID 填错，或你还没主动给该 bot 发过一条消息。');
    }
}

// ===== v2ray 管理 =====
async function startV2rayForLink(link) {
    if (!fs.existsSync(V2RAY_BIN)) {
        console.error(`[v2ray] 未找到 v2ray 二进制 (${V2RAY_BIN})`);
        return null;
    }
    const port = nextV2rayPort++;
    let cfgPath;
    try {
        const { buildConfig } = require('./.github/scripts/gen-v2ray-config');
        const cfg = buildConfig(link, port);
        cfgPath = path.join(process.cwd(), `v2ray-rustix-${port}.json`);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error(`[v2ray] 解析 V2 链接失败: ${e.message}`);
        return null;
    }
    console.log(`[v2ray] 启动实例 (HTTP 127.0.0.1:${port})...`);
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
    if (!ready) {
        console.error(`[v2ray] 端口 ${port} 未就绪。stderr:\n${stderr.slice(-400)}`);
        return null;
    }
    console.log(`[v2ray] 代理就绪 → http://127.0.0.1:${port}`);
    return { port, url: `http://127.0.0.1:${port}` };
}

function cleanupV2ray() {
    for (const { proc, port } of allV2rayProcs) {
        try { proc.kill('SIGTERM'); } catch (e) { }
        try { fs.unlinkSync(path.join(process.cwd(), `v2ray-rustix-${port}.json`)); } catch (e) { }
    }
    allV2rayProcs.length = 0;
}

process.on('exit', () => cleanupV2ray());
process.on('SIGINT', () => { cleanupV2ray(); process.exit(0); });
process.on('SIGTERM', () => { cleanupV2ray(); process.exit(0); });

// 测试代理是否能连通目标网站
async function testProxy(proxyUrl, testUrl = 'https://rustix.me', timeout = 10000) {
    try {
        const url = new URL(proxyUrl);
        const axiosConfig = {
            proxy: { protocol: 'http', host: url.hostname, port: parseInt(url.port || '80', 10) },
            timeout,
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        };
        await axios.get(testUrl, axiosConfig);
        console.log(`[代理] 代理连通性测试通过: ${proxyUrl}`);
        return true;
    } catch (e) {
        console.warn(`[代理] 代理连通性测试失败: ${e.message}`);
        return false;
    }
}

// ===== 解析用户代理配置 =====
async function resolveProxyForUser(user) {
    const v2Link = user.V2 || user.v2;
    if (v2Link) {
        console.log(`[代理] 用户有 V2 链接，启动独立 v2ray...`);
        const result = await startV2rayForLink(v2Link);
        if (result) {
            // 测试代理连通性
            const ok = await testProxy(result.url);
            if (ok) return result;
            console.warn('[代理] V2 代理连通性测试失败，回退');
            // 关闭失败的 v2ray
            const idx = allV2rayProcs.findIndex(p => p.port === result.port);
            if (idx >= 0) {
                try { allV2rayProcs[idx].proc.kill('SIGTERM'); } catch (e) {}
                allV2rayProcs.splice(idx, 1);
            }
        } else {
            console.warn('[代理] 独立 v2ray 启动失败，回退');
        }
    }
    if (HTTP_PROXY) {
        const ok = await testProxy(HTTP_PROXY);
        if (ok) {
            console.log(`[代理] 使用全局 HTTP 代理: ${HTTP_PROXY}`);
            return { port: null, url: HTTP_PROXY };
        }
        console.warn('[代理] 全局 HTTP 代理连通性测试失败，直连');
    }
    console.log('[代理] 直连');
    return null;
}

// --- KV Cookie Admin Worker ---
const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);
if (!KV_ENABLED) console.log('[KV] 未配置 KV_ADMIN_URL/KV_ADMIN_PASS，跳过 cookie 缓存');

async function kvGet(key) {
    if (!KV_ENABLED) return null;
    try {
        const r = await axios.post(KV_ADMIN_URL + '/api/get', { key }, {
            headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
            timeout: 15000, proxy: false
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

async function kvPut(key, value) {
    if (!KV_ENABLED) return false;
    try {
        await axios.post(KV_ADMIN_URL + '/api/set', { key, value: String(value) }, {
            headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
            timeout: 15000, proxy: false
        });
        console.log('[KV] cookie 已保存');
        return true;
    } catch (e) {
        console.warn('[KV] 写入失败:', e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
        return false;
    }
}

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

// 注入脚本：隐藏自动化痕迹 + hook Turnstile 复选框
const INJECTED_SCRIPT = `
(function() {
    try {
        const dp = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
        if (dp) {
            Object.defineProperty(Navigator.prototype, 'webdriver', {
                configurable: true, enumerable: true, get: () => undefined
            });
        }
    } catch (e) { }
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
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
    } catch (e) { }
})();
`;

function getUsers() {
    try {
        if (process.env.RUSTIX_USERS_JSON) {
            const raw = process.env.RUSTIX_USERS_JSON.trim();
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (parsed.users) return parsed.users;
        }
    } catch (e) {
        console.error('解析 RUSTIX_USERS_JSON 环境变量错误:', e.message);
    }
    if (process.env.RUSTIX_USER && process.env.RUSTIX_PASS) {
        const obj = { username: process.env.RUSTIX_USER, password: process.env.RUSTIX_PASS };
        if (process.env.RUSTIX_SERVER_URL) obj.serverUrl = process.env.RUSTIX_SERVER_URL;
        return [obj];
    }
    return [];
}

async function gotoWithRetry(page, url, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto(url, { waitUntil: 'load', timeout: 60000 });
            return;
        } catch (e) {
            console.warn(`[导航] 打开 ${url} 失败 (第 ${i}/${retries} 次): ${e.message}`);
            if (i === retries) throw e;
            await page.waitForTimeout(5000);
        }
    }
}

async function waitForLoginForm(page, timeoutMs = 60000) {
    const emailInput = page.locator('input[type="email"]');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const visible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
            if (visible) return true;
        } catch (e) {}
        const bodyText = await page.locator('body').innerText().catch(() => '');
        if (bodyText.includes('Just a moment') || bodyText.includes('Checking your browser')) {
            console.log('   >> ⏳ 正在等待 Cloudflare 验证通过...');
        }
        await page.waitForTimeout(3000);
        if (Date.now() - start > 15000 && !bodyText.includes('Введите email')) {
            console.log('   >> ⚠️ 登录页似乎未加载，尝试刷新...');
            try { await page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => {}); } catch (e) {}
            await page.waitForTimeout(3000);
        }
    }
    return false;
}

// 尝试通过 Turnstile API 获取 token
async function tryGetTurnstileToken(page) {
    const token = await page.evaluate(async () => {
        if (typeof window.turnstile === 'undefined') return null;
        let t = window.turnstile.getResponse();
        if (t) return t;
        try {
            t = await Promise.race([
                window.turnstile.execute(),
                new Promise(r => setTimeout(() => r('__TIMEOUT__'), 8000))
            ]);
            if (t && t !== '__TIMEOUT__') return t;
        } catch (e) {}
        return null;
    });
    return token;
}

// 解析服务页面信息
async function parseServiceInfo(page) {
    try {
        const pageText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        const info = {};
        const nameMatch = pageText.match(/(.+?)\s*#\d+/);
        if (nameMatch) info.serverName = nameMatch[1].trim();
        if (pageText.includes('Ежемесячно') || pageText.includes('ежемесячно')) {
            info.renewalMode = 'Ежемесячно (每月)';
        }
        const createdMatch = pageText.match(/Создан:\s*(.+?)(?:\n|$)/);
        if (createdMatch) info.createdDate = createdMatch[1].trim();
        const expiresMatch = pageText.match(/Истекает:\s*(.+?)(?:\n|$)/);
        if (expiresMatch) info.expiresDate = expiresMatch[1].trim();
        const remainingMatch = pageText.match(/Осталось:\s*(.+?)(?:\n|$)/);
        if (remainingMatch) info.remainingTime = remainingMatch[1].trim();
        return info;
    } catch (e) {
        console.warn('   >> 解析服务信息失败:', e.message);
        return {};
    }
}

// 处理单个用户
async function processUser(user) {
    const photoDir = 'screenshots';
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
    const cookieKey = `rustix_cookie_${safeUser}`;
    const targetUrl = user.serverUrl || `${BASE_URL}/me/services/18806`;

    // 解析该用户的代理
    const v2rayInfo = await resolveProxyForUser(user);

    console.log(`[${user.username}] 启动 CloakBrowser...`);
    const { launch } = await import('cloakbrowser');
    const launchOpts = {
        headless: true,
        humanize: true,
    };
    const proxyStr = v2rayInfo ? v2rayInfo.url : (HTTP_PROXY || '');
    if (proxyStr) {
        launchOpts.proxy = proxyStr;
        console.log(`[CloakBrowser] 使用代理: ${proxyStr}`);
    }
    const browser = await launch(launchOpts);
    console.log('[CloakBrowser] 启动成功');

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    try {
        await page.addInitScript(INJECTED_SCRIPT);
        console.log(`[${user.username}] 注入脚本已添加`);

        // ===== Step 1: 尝试 KV 缓存的 cookie 免登录 =====
        let loggedIn = false;
        const saved = await kvGet(cookieKey);
        if (saved) {
            console.log(`[${user.username}] 尝试注入缓存的 cookie...`);
            try {
                const cks = normalizeCookies(JSON.parse(saved));
                if (cks.length) {
                    await context.addCookies(cks);
                    console.log(`   >> 已注入 ${cks.length} 条 cookie`);
                }
            } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }

            await gotoWithRetry(page, targetUrl);
            await page.waitForTimeout(2500);
            loggedIn = !page.url().includes('/auth/signin') && !page.url().includes('/auth/login');
            console.log(`   >> cookie ${loggedIn ? '有效' : '无效/已过期'}`);
        }

        // ===== Step 2: cookie 失效 → 尝试登录 =====
        if (!loggedIn) {
            console.log(`[${user.username}] 需要完整登录...`);
            await gotoWithRetry(page, LOGIN_URL);
            const formReady = await waitForLoginForm(page);
            if (!formReady) {
                throw new Error('等待登录表单超时，可能被 Cloudflare 拦截');
            }
            await page.waitForTimeout(2000);

            await page.locator('input[type="email"]').first().fill(user.username);
            await page.waitForTimeout(400);
            await page.locator('input[type="password"]').first().fill(user.password);
            await page.waitForTimeout(500);

            console.log('   >> 尝试获取 Turnstile token...');
            const token = await tryGetTurnstileToken(page);
            if (token) {
                console.log('   >> ✅ 获取到 Turnstile token');
                await page.evaluate((t) => {
                    const input = document.querySelector('input[name="cf-turnstile-response"]');
                    if (input) input.value = t;
                }, token);
            } else {
                console.log('   >> ⚠️ 未获取到 Turnstile token，直接点击按钮...');
            }

            console.log('   >> 点击 Войти...');
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(b => b.textContent.includes('Войти'));
                if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            });
            await page.waitForTimeout(1000);

            try {
                const btnLoc = page.locator('button:has-text("Войти")');
                const box = await btnLoc.boundingBox({ timeout: 3000 });
                if (box) {
                    const client = await page.context().newCDPSession(page);
                    const cx = box.x + box.width / 2;
                    const cy = box.y + box.height / 2;
                    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                    await new Promise(r => setTimeout(r, 50));
                    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                    await client.detach();
                }
            } catch (e) {}

            console.log('   >> 等待登录结果...');
            for (let attempt = 1; attempt <= 30; attempt++) {
                await page.waitForTimeout(2000);
                const currentUrl = page.url();
                if (!currentUrl.includes('/auth/signin') && !currentUrl.includes('/auth/login')) {
                    console.log(`   >> ✅ 登录成功! URL: ${currentUrl}`);
                    loggedIn = true;
                    break;
                }
            }

            if (!loggedIn) {
                throw new Error('登录失败 — Cloudflare Turnstile 拦截，请手动上传 cookie 到 KV');
            }

            try {
                const cookies = await context.cookies();
                await kvPut(cookieKey, JSON.stringify(cookies));
                console.log('   >> 新 cookie 已保存到 KV');
            } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }

            await gotoWithRetry(page, targetUrl);
            await page.waitForTimeout(2000);
        }

        // ===== Step 3: 解析服务信息 =====
        const serviceInfo = await parseServiceInfo(page);
        console.log('   >> 服务信息:', JSON.stringify(serviceInfo));

        // ===== Step 4: 点击续期 =====
        console.log('   >> 点击「Продлить」按钮...');
        const renewBtn = page.locator('button:has-text("Продлить")').first();
        try {
            await renewBtn.waitFor({ state: 'visible', timeout: 8000 });
            await renewBtn.click();
            console.log('   >> ✅ 已点击「Продлить」');
        } catch (e) {
            console.log('   >> ⚠️ 未找到「Продлить」按钮，可能未到续期时间');
            let msg = `ℹ️ *服务状态*\n用户: ${user.username}\n服务: ${serviceInfo.serverName || '#' + targetUrl.split('/').pop()}`;
            if (serviceInfo.renewalMode) msg += `\n续订方式: ${serviceInfo.renewalMode}`;
            if (serviceInfo.createdDate) msg += `\n创建日期: ${serviceInfo.createdDate}`;
            if (serviceInfo.expiresDate) msg += `\n有效期至: ${serviceInfo.expiresDate}`;
            if (serviceInfo.remainingTime) msg += `\n剩余: ${serviceInfo.remainingTime}`;
            await sendTelegramMessage(msg);
            return;
        }

        // ===== Step 5: 确认续期弹窗 =====
        await page.waitForTimeout(1500);
        console.log('   >> 等待续期弹窗...');
        const confirmBtn = page.locator('.fixed button:has-text("Продлить"), [class*="modal"] button:has-text("Продлить"), button:has-text("Продлить")').last();
        let confirmed = false;
        try {
            await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
            const dialogText = await page.locator('.fixed').innerText().catch(() => '');
            const costMatch = dialogText.match(/Будет стоить\s*(.+?)(?:\n|$)/);
            const untilMatch = dialogText.match(/Будет продлено до\s*(.+?)(?:\n|$)/);
            console.log(`   >> 续期弹窗: 费用=${costMatch ? costMatch[1] : 'N/A'}, 新到期=${untilMatch ? untilMatch[1] : 'N/A'}`);
            await confirmBtn.click();
            console.log('   >> ✅ 已确认续期');
            confirmed = true;
            await page.waitForTimeout(3000);
        } catch (e) {
            console.log('   >> ⚠️ 未找到续期确认弹窗:', e.message);
        }

        // ===== Step 6: 发送结果 =====
        const shot = path.join(photoDir, `rustix_${safeUser}.png`);
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
        await page.waitForTimeout(1500);
        const updatedInfo = await parseServiceInfo(page);

        if (confirmed) {
            let msg = `✅ *续期成功*\n用户: ${user.username}\n服务: ${serviceInfo.serverName || '#' + targetUrl.split('/').pop()}`;
            if (serviceInfo.renewalMode) msg += `\n续订方式: ${serviceInfo.renewalMode}`;
            if (serviceInfo.createdDate) msg += `\n创建日期: ${serviceInfo.createdDate}`;
            if (updatedInfo.expiresDate) msg += `\n有效期至: ${updatedInfo.expiresDate}`;
            if (updatedInfo.remainingTime) msg += `\n剩余: ${updatedInfo.remainingTime}`;
            await sendTelegramMessage(msg);
            console.log('   >> ✅ 续期成功！');
        } else {
            let msg = `❌ *续期可能失败*\n用户: ${user.username}\n服务: ${serviceInfo.serverName || '#' + targetUrl.split('/').pop()}`;
            if (serviceInfo.renewalMode) msg += `\n续订方式: ${serviceInfo.renewalMode}`;
            if (updatedInfo.expiresDate) msg += `\n有效期至: ${updatedInfo.expiresDate}`;
            if (updatedInfo.remainingTime) msg += `\n剩余: ${updatedInfo.remainingTime}`;
            msg += '\n续期确认按钮未能点击，详情见截图';
            await sendTelegramMessage(msg, shot);
            console.log('   >> ❌ 续期确认可能失败');
        }

    } catch (err) {
        console.error(`[${user.username}] 出错:`, err.message);
        const shotPath = path.join(photoDir, `rustix_${safeUser}_error.png`);
        try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
        await sendTelegramMessage(`❌ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, shotPath);
        throw err;
    } finally {
        await browser.close();
    }
}

// === 主流程 ===
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 RUSTIX_USERS_JSON 中找到用户');
        process.exit(1);
    }

    let allSuccess = true;
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 处理用户 ${i + 1}/${users.length}: ${user.username} ===`);
        try {
            await processUser(user);
            console.log(`[${user.username}] 完成`);
        } catch (err) {
            console.error(`[${user.username}] 失败: ${err.message}`);
            allSuccess = false;
        }
    }

    cleanupV2ray();
    console.log(`\n=== 全部完成 === ${allSuccess ? '✅ 全部成功' : '⚠️ 部分失败'}`);
    process.exit(allSuccess ? 0 : 1);
})();