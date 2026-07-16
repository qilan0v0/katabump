// Rustix.me 每月续期脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 优先使用 KV cookie 免登录 → 失败则尝试登录 → 导航到服务页 → 点击「Продлить」续期
// 支持每个账号独立 V2Ray 代理：user.V2 = "vless://..."
// 账号来源: Secret RUSTIX_USERS_JSON =
//   [{"username":"xxx@gmail.com","password":"xxx","serverUrl":"https://rustix.me/me/services/18806","V2":"vless://...","YC_CLIENT_KEY":"..."}]
// cookie 通过 KV Admin Worker 存取，key = rustix_cookie_<username>
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const BASE_URL = 'https://rustix.me';
const LOGIN_URL = BASE_URL + '/auth/signin';

// YesCaptcha 配置（优先从 RUSTIX_USERS_JSON 的每个账号读取，回退到环境变量）
const YC_CLIENT_KEY_DEFAULT = process.env.YC_CLIENT_KEY || '';
const YC_API = 'https://api.yescaptcha.com';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'Rustix';

// 全局 HTTP 代理 (回退用)
const HTTP_PROXY = process.env.HTTP_PROXY;

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

// ===== sing-box 管理 =====
const { buildConfig: buildSingboxConfig } = require('./.github/scripts/gen-singbox-config');
const SINGBOX_BIN = process.env.SINGBOX_BIN || `${process.env.HOME}/sing-box/sing-box`;
const singboxProcs = [];
let nextSocksPort = 10810;

async function startSingboxForLink(link) {
    if (!fs.existsSync(SINGBOX_BIN)) {
        console.error(`[sing-box] 未找到 sing-box 二进制 (${SINGBOX_BIN})`);
        return null;
    }
    const socksPort = nextSocksPort++;
    const httpPort = nextSocksPort++;
    let cfgPath;
    try {
        const cfg = buildSingboxConfig(link, socksPort, httpPort);
        cfgPath = path.join(process.cwd(), `singbox-rustix-${socksPort}.json`);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error(`[sing-box] 解析 V2 链接失败: ${e.message}`);
        return null;
    }
    console.log(`[sing-box] 启动实例 (SOCKS5 ${socksPort}, HTTP ${httpPort})...`);
    const proc = spawn(SINGBOX_BIN, ['run', '-c', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
    singboxProcs.push({ proc, port: socksPort });

    const ready = await new Promise((resolve) => {
        let n = 0;
        const tick = () => {
            const req = http.get({ host: '127.0.0.1', port: httpPort, path: '/', timeout: 3000 }, () => resolve(true));
            req.on('error', () => { if (++n >= 15) return resolve(false); setTimeout(tick, 2000); });
            req.on('timeout', () => { req.destroy(); if (++n >= 15) return resolve(false); else setTimeout(tick, 2000); });
            req.end();
        };
        tick();
    });
    if (!ready) {
        console.error(`[sing-box] 代理端口未就绪。stderr:\n${stderr.slice(-400)}`);
        return null;
    }
    const url = `socks5://127.0.0.1:${socksPort}`;
    console.log(`[sing-box] 代理就绪 → ${url}`);
    return { port: socksPort, url };
}

function cleanupSingbox() {
    for (const { proc, port } of singboxProcs) {
        try { proc.kill('SIGTERM'); } catch (e) { }
        try { fs.unlinkSync(path.join(process.cwd(), `singbox-rustix-${port}.json`)); } catch (e) { }
    }
    singboxProcs.length = 0;
}

process.on('exit', () => cleanupSingbox());
process.on('SIGINT', () => { cleanupSingbox(); process.exit(0); });
process.on('SIGTERM', () => { cleanupSingbox(); process.exit(0); });

// ===== 解析用户代理配置 =====
async function resolveProxyForUser(user) {
    const v2Link = user.V2 || user.v2;
    if (v2Link) {
        console.log(`[代理] 用户有 V2 链接，启动独立 sing-box...`);
        const result = await startSingboxForLink(v2Link);
        if (result) return result;
        console.warn('[代理] sing-box 启动失败，回退');
    }
    if (HTTP_PROXY) {
        console.log(`[代理] 使用全局 HTTP 代理: ${HTTP_PROXY}`);
        return { port: null, url: HTTP_PROXY };
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

function _race(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), ms))]);
}

// Cloudflare Turnstile (iframe 内复选框) 的 CDP 点击绕过
// 遍历页面所有 frame，读取注入脚本设置的 __turnstile_data，
// 通过 iframeElement.boundingBox() 计算绝对坐标，用 CDP 发送真实鼠标事件
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        const fu = (frame.url() || '');
        if (fu && !/cloudflare|turnstile|challenges|hcaptcha|^about:|^$/i.test(fu)) {
            if (frame !== page.mainFrame()) continue;
        }
        try {
            const data = await _race(frame.evaluate(() => window.__turnstile_data), 3000).catch(() => null);
            if (data) {
                console.log('   >> 在 frame 中发现 Turnstile。比例:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`   >> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                const client = await page.context().newCDPSession(page);
                // mouseMoved (mouseover 前置事件)
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
                await new Promise(r => setTimeout(r, 100));
                // mousePressed
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 80));
                // mouseReleased
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await client.detach();
                console.log('   >> Turnstile CDP 点击已发送');
                return true;
            }
        } catch (e) {
            // 静默跳过不可访问的 frame
        }
    }
    return false;
}

// YesCaptcha 打码 —— 通过外部 API 获取 Turnstile token
async function solveTurnstileViaCaptcha(page, clientKey) {
    if (!clientKey) {
        console.log('   >> 未配置 YC_CLIENT_KEY，跳过打码');
        return null;
    }
    console.log('   >> 正在通过 YesCaptcha 获取 Turnstile token...');
    try {
        // 创建任务
        const createResp = await axios.post(YC_API + '/createTask', {
            clientKey: clientKey,
            task: {
                type: 'TurnstileTaskProxyless',
                websiteURL: 'https://rustix.me/auth/signin',
                websiteKey: '0x4AAAAAAAfEZEkKcZVdYD02',
            },
        }, { timeout: 30000 });
        if (createResp.data.errorId !== 0 || !createResp.data.taskId) {
            console.warn('   >> YesCaptcha 创建任务失败:', createResp.data.errorDescription || JSON.stringify(createResp.data));
            return null;
        }
        const taskId = createResp.data.taskId;
        console.log(`   >> YesCaptcha 任务已创建: ${taskId}`);

        // 轮询结果
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const resultResp = await axios.post(YC_API + '/getTaskResult', {
                clientKey: clientKey,
                taskId,
            }, { timeout: 15000 });
            const data = resultResp.data;
            if (data.errorId !== 0) {
                console.warn('   >> YesCaptcha 查询失败:', data.errorDescription);
                return null;
            }
            if (data.status === 'ready') {
                const token = data.solution?.token;
                if (token) {
                    console.log('   >> ✅ YesCaptcha 获取到 token');
                    return token;
                }
            }
            console.log(`   >> YesCaptcha 处理中... (${i + 1}/30)`);
        }
        console.warn('   >> YesCaptcha 超时');
        return null;
    } catch (e) {
        console.warn('   >> YesCaptcha 异常:', e.message);
        return null;
    }
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
    const proxyInfo = await resolveProxyForUser(user);

    console.log(`[${user.username}] 启动 CloakBrowser...`);
    const { launchPersistentContext } = await import('cloakbrowser');
    const launchOpts = {
        headless: true,
        humanize: true,
        geoip: true,
        userDataDir: `/tmp/rustix-profile-${safeUser}`,
        args: [
            '--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure',
        ],
    };
    const proxyStr = proxyInfo ? proxyInfo.url : (HTTP_PROXY || '');
    if (proxyStr) {
        launchOpts.proxy = proxyStr;
        console.log(`[CloakBrowser] 使用代理: ${proxyStr}`);
    }
    console.log('[CloakBrowser] 正在启动...');
    const context = await launchPersistentContext(launchOpts);
    console.log('[CloakBrowser] 启动成功');
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
            await page.waitForTimeout(3000);

            // 调试：打印页面状态
            const pageDebug = await page.evaluate(() => ({
                url: window.location.href,
                title: document.title,
                hasTurnstile: typeof window.turnstile !== 'undefined',
                hasEmailInput: !!document.querySelector('input[type="email"]'),
                bodyPreview: (document.body?.innerText || '').substring(0, 200),
            }));
            console.log('   >> 页面状态:', JSON.stringify(pageDebug));

            await page.locator('input[type="email"]').first().fill(user.username);
            await page.waitForTimeout(400);
            await page.locator('input[type="password"]').first().fill(user.password);
            await page.waitForTimeout(500);

            // ===== Turnstile 处理 =====
            // rustix.me 使用 Turnstile (flexible 模式)。
            // Vue 组件 <VueTurnstile v-model="turnstile_token"> 通过 v-model 绑定 token，
            // 提交时发送 JSON {email, password, turnstile_token} 到 POST /api/auth/signin。
            // 策略: 先等待自动验证 → render() → CDP 点击 → YesCaptcha 打码。
            // 获取 token 后直接通过页面内 fetch 调用 API（绕过 Vue 的 v-model 限制）。
            const TURNSTILE_SITEKEY = '0x4AAAAAAAfEZEkKcZVdYD02';
            const API_BASE = 'https://rustix.me/api';
            let turnstileToken = null;

            // 辅助函数：从页面获取 token（检查 hidden input 和 turnstile.getResponse()）
            async function getPageToken() {
                return await page.evaluate(() => {
                    // 1. 检查 hidden input（VueTurnstile 组件内部设置的）
                    const inp = document.querySelector('input[name="cf-turnstile-response"]');
                    if (inp && inp.value && inp.value.length > 20) return inp.value;
                    // 2. 检查 turnstile.getResponse()
                    if (typeof window.turnstile !== 'undefined') {
                        try {
                            const t = window.turnstile.getResponse();
                            if (t && t.length > 20) return t;
                        } catch (e) {}
                    }
                    return null;
                }).catch(() => null);
            }

            console.log('   >> 正在等待 Turnstile 自动验证（最多 40 秒）...');
            for (let waitSec = 0; waitSec < 40; waitSec += 3) {
                const tok = await getPageToken();
                if (tok) {
                    console.log(`   >> ✅ Turnstile 自动验证成功 (等待 ${waitSec}s)`);
                    turnstileToken = tok;
                    break;
                }
                await page.waitForTimeout(3000);
            }

            // Fallback 1: turnstile.render() + callback
            if (!turnstileToken) {
                console.log('   >> 自动验证超时，尝试 turnstile.render()...');
                const renderToken = await page.evaluate(async (sk) => {
                    if (typeof window.turnstile === 'undefined') return null;
                    const container = document.querySelector('.turnstile-full > div') || document.querySelector('.turnstile-full');
                    if (!container) return null;
                    return new Promise((resolve) => {
                        const to = setTimeout(() => resolve(null), 25000);
                        try {
                            window.turnstile.render(container, {
                                sitekey: sk,
                                callback: (token) => { clearTimeout(to); resolve(token); },
                                'error-callback': () => { clearTimeout(to); resolve(null); },
                                theme: 'dark',
                            });
                        } catch(e) { clearTimeout(to); resolve(null); }
                    });
                }, TURNSTILE_SITEKEY).catch(() => null);
                if (renderToken) {
                    console.log('   >> ✅ turnstile.render() 获取到 token');
                    turnstileToken = renderToken;
                } else {
                    console.log('   >> ⚠️ turnstile.render() 未获取到 token');
                }
            }

            // Fallback 1.5: CDP 真实点击 Turnstile iframe 复选框
            if (!turnstileToken) {
                console.log('   >> 尝试 CDP 点击 Turnstile...');
                const clicked = await attemptTurnstileCdp(page).catch(() => false);
                if (clicked) {
                    for (let cdpWait = 0; cdpWait < 10; cdpWait++) {
                        await page.waitForTimeout(1000);
                        const tok = await getPageToken();
                        if (tok) {
                            console.log('   >> ✅ CDP 点击后获取到 token');
                            turnstileToken = tok;
                            break;
                        }
                    }
                    if (!turnstileToken) console.log('   >> ⚠️ CDP 点击未产生 token');
                }
            }

            // Fallback 2: YesCaptcha 打码
            if (!turnstileToken) {
                const captchaToken = await solveTurnstileViaCaptcha(page, user.YC_CLIENT_KEY || user.yc_client_key || YC_CLIENT_KEY_DEFAULT);
                if (captchaToken) {
                    console.log('   >> ✅ YesCaptcha 获取到 token');
                    turnstileToken = captchaToken;
                } else {
                    console.log('   >> ⚠️ YesCaptcha 未获取到 token');
                }
            }

            // ===== 提交登录 =====
            // Vue 组件通过 v-model 绑定 turnstile_token，提交时发送 JSON body。
            // 我们直接在页面内用 fetch 调用 /api/auth/signin，格式与 Vue 完全一致。
            if (turnstileToken) {
                console.log('   >> Turnstile token 已就绪，提交登录 (POST /api/auth/signin)...');
                const submitResult = await page.evaluate(async (creds) => {
                    try {
                        const resp = await fetch('https://rustix.me/api/auth/signin', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({
                                email: creds.email,
                                password: creds.password,
                                turnstile_token: creds.turnstileToken,
                            }),
                        });
                        const data = await resp.json().catch(() => ({}));
                        return { status: resp.status, ok: resp.ok, data, url: resp.url };
                    } catch (e) {
                        return { error: e.message };
                    }
                }, { email: user.username, password: user.password, turnstileToken });

                console.log('   >> 提交结果:', JSON.stringify(submitResult).substring(0, 500));

                if (submitResult.data && submitResult.data.token) {
                    console.log('   >> ✅ 登录成功！获取到 auth token');
                    // Nuxt auth 模块使用名为 user_token 的 cookie 存储认证 token
                    // (kr("user_token", {maxAge:2592000, path:"/", sameSite:"lax", secure:true}))
                    // 同时用 document.cookie 和 Playwright context.addCookies 双保险设置
                    const authToken = submitResult.data.token;
                    // 1. 通过 document.cookie 设置（与 Nuxt 的 kr() 一致）
                    await page.evaluate((t) => {
                        const maxAge = 60 * 60 * 24 * 30; // 30 天
                        document.cookie = `user_token=${encodeURIComponent(t)}; max-age=${maxAge}; path=/; SameSite=Lax; Secure`;
                    }, authToken).catch(() => {});
                    // 2. 通过 Playwright context.addCookies 设置（确保 cookie 被浏览器持久化）
                    await context.addCookies([{
                        name: 'user_token',
                        value: authToken,
                        domain: 'rustix.me',
                        path: '/',
                        httpOnly: false,
                        secure: true,
                        sameSite: 'Lax',
                        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
                    }]).catch(() => {});
                    // 跳转到 /me（带 token cookie，中间件会放行）
                    await page.goto('https://rustix.me/me', { waitUntil: 'load', timeout: 30000 });
                    await page.waitForTimeout(3000);
                    loggedIn = !page.url().includes('/auth/signin') && !page.url().includes('/auth/login');
                    if (loggedIn) {
                        console.log(`   >> ✅ 已进入用户面板: ${page.url()}`);
                    } else {
                        console.log(`   >> ⚠️ 跳转后仍在登录页: ${page.url()}`);
                    }
                } else if (submitResult.data && submitResult.data.message === '2fa code sent') {
                    console.log('   >> ⚠️ 账号需要 2FA 验证，暂不支持自动处理');
                    throw new Error('登录需要 2FA 验证码，请手动处理');
                } else {
                    const errMsg = submitResult.data?.message || submitResult.error || '未知错误';
                    console.log(`   >> ❌ 登录被拒: ${errMsg}`);
                }
            } else {
                console.log('   >> ❌ 未能获取 Turnstile token');
            }

            // ===== 兜底：如果直接 API 提交未成功但 token 存在，重试一次 =====
            if (!loggedIn && turnstileToken) {
                console.log('   >> API 提交未成功，重试提交...');
                const retryResult = await page.evaluate(async (creds) => {
                    try {
                        const resp = await fetch('https://rustix.me/api/auth/signin', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({
                                email: creds.email,
                                password: creds.password,
                                turnstile_token: creds.turnstileToken,
                            }),
                        });
                        const data = await resp.json().catch(() => ({}));
                        return { ok: resp.ok, data };
                    } catch (e) { return { error: e.message }; }
                }, { email: user.username, password: user.password, turnstileToken });
                if (retryResult.data && retryResult.data.token) {
                    console.log('   >> ✅ 重试登录成功');
                    const authToken = retryResult.data.token;
                    await page.evaluate((t) => {
                        document.cookie = `user_token=${encodeURIComponent(t)}; max-age=${60*60*24*30}; path=/; SameSite=Lax; Secure`;
                    }, authToken).catch(() => {});
                    await context.addCookies([{
                        name: 'user_token', value: authToken, domain: 'rustix.me', path: '/',
                        httpOnly: false, secure: true, sameSite: 'Lax',
                        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
                    }]).catch(() => {});
                    await page.goto('https://rustix.me/me', { waitUntil: 'load', timeout: 30000 });
                    await page.waitForTimeout(3000);
                    loggedIn = !page.url().includes('/auth/signin') && !page.url().includes('/auth/login');
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
        await context.close();
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

    cleanupSingbox();
    console.log(`\n=== 全部完成 === ${allSuccess ? '✅ 全部成功' : '⚠️ 部分失败'}`);
    process.exit(allSuccess ? 0 : 1);
})();