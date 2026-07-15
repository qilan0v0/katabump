// Rustix.me 每月续期脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 登录页输邮箱密码 → 过 Turnstile → 导航到服务页 → 点击「Продлить」续期
// 账号来源: Secret RUSTIX_USERS_JSON =
//   [{"username":"xxx@gmail.com","password":"xxx","serverUrl":"https://rustix.me/me/services/18806"}]
// cookie 通过 KV Admin Worker 存取，key = rustix_cookie_<username>
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
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

    // 只有失败时才发截图，成功只发纯文本
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

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。期望: http://user:pass@host:port 或 http://host:port');
        process.exit(1);
    }
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

// 规范化 cookie 数组为 Playwright addCookies 接受的格式
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

// 注入脚本：hook 子 frame 里的 attachShadow，定位 Cloudflare Turnstile 复选框
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { console.error('[注入] Hook attachShadow 失败:', e); }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        await axios.get('https://www.google.com', axiosConfig);
        try {
            const ipResp = await axios.get('https://api.ipify.org?format=json', axiosConfig);
            const exitIp = ipResp.data && ipResp.data.ip ? ipResp.data.ip : '未知';
            console.log(`[代理] 连接成功！出口 IP: ${exitIp}`);
        } catch (e) {
            console.log('[代理] 连接成功！(出口 IP 获取失败，但代理可用)');
        }
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已开启。'); return; }
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--user-data-dir=/tmp/chrome_user_data'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`正在启动 Chrome (路径: ${CHROME_PATH}, 第 ${attempt} 次)...`);
        let stderr = '';
        const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        if (chrome.stderr) chrome.stderr.on('data', d => { stderr += d.toString(); });
        chrome.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
        chrome.unref();

        console.log('正在等待 Chrome 初始化...');
        for (let i = 0; i < 40; i++) {
            if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已就绪。'); return; }
            await new Promise(r => setTimeout(r, 1000));
        }
        console.error(`Chrome 第 ${attempt} 次未在端口 ${DEBUG_PORT} 起来。Chrome stderr 末尾:\n` + stderr.slice(-800));
        try { process.kill(-chrome.pid); } catch (e) { }
        try { fs.rmSync('/tmp/chrome_user_data', { recursive: true, force: true }); } catch (e) { }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Chrome 启动失败');
}

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
    // 后备：单用户模式
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
            await page.goto(url, { waitUntil: 'load', timeout: 30000 });
            return;
        } catch (e) {
            console.warn(`[导航] 打开 ${url} 失败 (第 ${i}/${retries} 次): ${e.message}`);
            if (i === retries) throw e;
            await page.waitForTimeout(3000);
        }
    }
}

function _race(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), ms))]);
}

// Cloudflare Turnstile (iframe 内复选框) 的 CDP 点击绕过
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
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
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
                console.log('>> Turnstile CDP 点击已发送');
                return true;
            }
        } catch (e) {
            console.warn('   >> Turnstile 检查异常:', e.message);
        }
    }
    return false;
}

// 登录单个账号：填写邮箱密码，处理 Turnstile，点击登录
async function login(page, user) {
    await gotoWithRetry(page, LOGIN_URL);
    await page.waitForTimeout(3000);

    console.log('   >> 填写邮箱...');
    const emailInput = page.locator('input[placeholder="Введите email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });
    await emailInput.fill(user.username);
    await page.waitForTimeout(400);

    console.log('   >> 填写密码...');
    const pwdInput = page.locator('input[placeholder="Введите пароль"]');
    await pwdInput.waitFor({ state: 'visible', timeout: 10000 });
    await pwdInput.fill(user.password);
    await page.waitForTimeout(400);

    console.log('   >> 点击 Войти...');
    const loginBtn = page.locator('button:has-text("Войти")');
    await loginBtn.click();

    // 处理 Turnstile（如果出现）
    for (let attempt = 1; attempt <= 15; attempt++) {
        await page.waitForTimeout(1500);
        const currentUrl = page.url();
        if (!currentUrl.includes('/auth/signin') && !currentUrl.includes('/auth/login')) {
            console.log(`   >> ✅ 登录成功! URL: ${currentUrl}`);
            return true;
        }
        // 尝试 Turnstile
        const clicked = await attemptTurnstileCdp(page);
        if (clicked) {
            console.log(`   >> Turnstile 已点击 (第 ${attempt} 次)`);
            // 等几秒后尝试重新点击登录按钮
            await page.waitForTimeout(2000);
            await loginBtn.click().catch(() => {});
        } else {
            // 没检测到 Turnstile 但也没跳转，再次点击登录按钮
            console.log(`   >> 未检测到 Turnstile，再次点击登录按钮 (第 ${attempt} 次)`);
            await loginBtn.click().catch(() => {});
        }
    }

    console.log(`   >> ❌ 登录超时，最终 URL: ${page.url()}`);
    return false;
}

// 解析服务页面信息
async function parseServiceInfo(page) {
    try {
        const pageText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        const info = {};

        // 服务名
        const nameMatch = pageText.match(/(.+?)\s*#\d+/);
        if (nameMatch) info.serverName = nameMatch[1].trim();

        // 续订方式
        if (pageText.includes('Ежемесячно') || pageText.includes('ежемесячно')) {
            info.renewalMode = 'Ежемесячно (每月)';
        }

        // 创建日期
        const createdMatch = pageText.match(/Создан:\s*(.+?)(?:\n|$)/);
        if (createdMatch) info.createdDate = createdMatch[1].trim();

        // 到期日期
        const expiresMatch = pageText.match(/Истекает:\s*(.+?)(?:\n|$)/);
        if (expiresMatch) info.expiresDate = expiresMatch[1].trim();

        // 剩余天数
        const remainingMatch = pageText.match(/Осталось:\s*(.+?)(?:\n|$)/);
        if (remainingMatch) info.remainingTime = remainingMatch[1].trim();

        return info;
    } catch (e) {
        console.warn('   >> 解析服务信息失败:', e.message);
        return {};
    }
}

// === 主流程 ===
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 RUSTIX_USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const ok = await checkProxy();
        if (!ok) { console.error('[代理] 代理无效，终止运行。'); process.exit(1); }
    }

    await launchChrome();

    console.log('正在连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) { console.error('连接失败。退出。'); process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加到页面上下文。');

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length}: ${user.username} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }
            // 清除上一用户的会话 cookie
            try { await context.clearCookies(); } catch (e) { }

            const cookieKey = `rustix_cookie_${safeUser}`;
            const targetUrl = user.serverUrl || `${BASE_URL}/me/services/18806`;

            // ===== Step 1: 尝试 KV 缓存的 cookie 免登录 =====
            let loggedIn = false;
            const saved = await kvGet(cookieKey);
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    if (cks.length) {
                        await context.addCookies(cks);
                        console.log(`   >> 已注入 KV cookie (${cks.length} 条)`);
                    }
                } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }
            }

            // 用 cookie 直接打开服务页，判断是否有效
            if (saved) {
                await gotoWithRetry(page, targetUrl);
                await page.waitForTimeout(2500);
                loggedIn = !page.url().includes('/auth/signin') && !page.url().includes('/auth/login');
                console.log(`   >> cookie ${loggedIn ? '有效，免登录' : '无效/已过期'} (当前: ${page.url()})`);
            }

            // ===== Step 2: cookie 失效 → 完整登录 =====
            if (!loggedIn) {
                console.log('   >> 需要完整登录...');
                loggedIn = await login(page, user);
                if (!loggedIn) {
                    const shot = path.join(photoDir, `rustix_${safeUser}_loginfail.png`);
                    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                    console.log(`   >> ❌ 登录失败`);
                    await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n无法登录到 Rustix.me`, shot);
                    continue;
                }
                console.log(`   >> ✅ 登录成功: ${page.url()}`);

                // 保存新 cookie 到 KV
                try {
                    const cookies = await context.cookies();
                    await kvPut(cookieKey, JSON.stringify(cookies));
                    console.log('   >> 新 cookie 已保存到 KV');
                } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }

                // 导航到服务页
                await gotoWithRetry(page, targetUrl);
                await page.waitForTimeout(2000);
            }

            // ===== Step 3: 解析服务信息 =====
            const serviceInfo = await parseServiceInfo(page);
            console.log('   >> 服务信息:', JSON.stringify(serviceInfo));

            // ===== Step 4: 点击「Продлить」(续期) 按钮 =====
            console.log('   >> 点击「Продлить」按钮...');
            const renewBtn = page.locator('button:has-text("Продлить")').first();
            try {
                await renewBtn.waitFor({ state: 'visible', timeout: 8000 });
                await renewBtn.click();
                console.log('   >> ✅ 已点击「Продлить」');
            } catch (e) {
                console.log('   >> ⚠️ 未找到「Продлить」按钮，可能未到续期时间');
                // 发送当前状态信息（纯文本，不截图）
                let msg = `ℹ️ *服务状态*\n用户: ${user.username}\n服务: ${serviceInfo.serverName || '#' + targetUrl.split('/').pop()}`;
                if (serviceInfo.renewalMode) msg += `\n续订方式: ${serviceInfo.renewalMode}`;
                if (serviceInfo.createdDate) msg += `\n创建日期: ${serviceInfo.createdDate}`;
                if (serviceInfo.expiresDate) msg += `\n有效期至: ${serviceInfo.expiresDate}`;
                if (serviceInfo.remainingTime) msg += `\n剩余: ${serviceInfo.remainingTime}`;
                await sendTelegramMessage(msg);
                continue;
            }

            // ===== Step 5: 等待续期弹窗出现，点击确认「Продлить」=====
            await page.waitForTimeout(1500);

            // 查找续期弹窗中的确认按钮
            console.log('   >> 等待续期弹窗...');
            const confirmBtn = page.locator('.fixed button:has-text("Продлить"), [class*="modal"] button:has-text("Продлить"), button:has-text("Продлить")').last();
            let confirmed = false;
            try {
                await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
                // 获取弹窗中的续期信息
                const dialogText = await page.locator('.fixed').innerText().catch(() => '');
                const costMatch = dialogText.match(/Будет стоить\s*(.+?)(?:\n|$)/);
                const extendMatch = dialogText.match(/Продлеваем\s*(.+?)(?:\n|$)/);
                const untilMatch = dialogText.match(/Будет продлено до\s*(.+?)(?:\n|$)/);

                console.log(`   >> 续期弹窗信息: 费用=${costMatch ? costMatch[1] : 'N/A'}, 期限=${extendMatch ? extendMatch[1] : 'N/A'}, 新到期=${untilMatch ? untilMatch[1] : 'N/A'}`);

                await confirmBtn.click();
                console.log('   >> ✅ 已点击确认「Продлить」');
                confirmed = true;
                await page.waitForTimeout(3000);
            } catch (e) {
                console.log('   >> ⚠️ 未找到续期确认弹窗或按钮:', e.message);
            }

            // ===== Step 6: 截图并发送结果 =====
            const shot = path.join(photoDir, `rustix_${safeUser}.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }

            // 续期后重新读取页面信息
            await page.waitForTimeout(1500);
            const updatedInfo = await parseServiceInfo(page);

            if (confirmed) {
                // 成功 — 只发纯文本，不传截图
                let msg = `✅ *续期成功*\n用户: ${user.username}\n服务: ${serviceInfo.serverName || '#' + targetUrl.split('/').pop()}`;
                if (serviceInfo.renewalMode) msg += `\n续订方式: ${serviceInfo.renewalMode}`;
                if (serviceInfo.createdDate) msg += `\n创建日期: ${serviceInfo.createdDate}`;
                if (updatedInfo.expiresDate) msg += `\n有效期至: ${updatedInfo.expiresDate}`;
                if (updatedInfo.remainingTime) msg += `\n剩余: ${updatedInfo.remainingTime}`;
                await sendTelegramMessage(msg);
                console.log('   >> ✅ 续期成功！');
            } else {
                // 失败 — 带截图
                let msg = `❌ *续期可能失败*\n用户: ${user.username}\n服务: ${serviceInfo.serverName || '#' + targetUrl.split('/').pop()}`;
                if (serviceInfo.renewalMode) msg += `\n续订方式: ${serviceInfo.renewalMode}`;
                if (updatedInfo.expiresDate) msg += `\n有效期至: ${updatedInfo.expiresDate}`;
                if (updatedInfo.remainingTime) msg += `\n剩余: ${updatedInfo.remainingTime}`;
                msg += '\n续期确认按钮未能点击，详情见截图';
                await sendTelegramMessage(msg, shot);
                console.log('   >> ❌ 续期确认可能失败');
            }

        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shotPath = path.join(photoDir, `rustix_${safeUser}_error.png`);
            try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, shotPath);
        }
        console.log('用户处理完成');
    }

    console.log('\n=== 完成 ===');
    await browser.close();
    process.exit(0);
})();