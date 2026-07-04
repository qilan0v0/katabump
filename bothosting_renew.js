// Bot-Hosting.net (bot-hosting.net) 续期保活脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 注入 cookie → 打开 https://bot-hosting.net/a/billings
//       → 点击 "Renew free plan" → 弹窗中过 Cloudflare Turnstile → 点击 "Renew for 4 days"
// 账号来源: Secret BOTHOSTING_USERS_JSON =
//   [{"username":"3100676552@qq.com"}]
// cookie 通过 KV Admin Worker 存取，key = bothosting_cookie_<username>
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const BILLING_URL = 'https://bot-hosting.net/a/billings';
const LOGIN_URL = 'https://bot-hosting.net/auth/login';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'BotHosting';

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

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

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
        if (process.env.BOTHOSTING_USERS_JSON) {
            const parsed = JSON.parse(process.env.BOTHOSTING_USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 BOTHOSTING_USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function gotoWithRetry(page, url, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
                // 1. mouseMoved (mouseover 前置事件)
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
                await new Promise(r => setTimeout(r, 100 + Math.random() * 150));
                // 2. mousePressed
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                // 3. mouseReleased
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

// 给 promise 套整体超时
function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// === 主流程 ===
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 BOTHOSTING_USERS_JSON 中找到用户');
        return;
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，中止。');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log('连接到 Chrome 实例...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('成功连接!');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败，2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) { console.error('无法连接到 Chrome。退出。'); return; }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加到页面上下文。');

    let allResults = [];
    const photoDir = 'screenshots';
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 处理用户 ${i + 1}/${users.length}: ${user.username} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }
            await context.clearCookies();

            const cookieKey = `bothosting_cookie_${user.username.replace(/[^a-z0-9]/gi, '_')}`;

            // 1. 从 KV 读取 cookie
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
            } else {
                console.log('   >> KV 中无 cookie，跳过该用户（请先手动上传 cookie 到 KV）');
                continue;
            }

            // 2. 打开账单页
            console.log('打开账单页...');
            await gotoWithRetry(page, BILLING_URL);
            await page.waitForTimeout(3000);

            // 检查是否已登录
            loggedIn = !page.url().includes('/auth/login') && !page.url().includes('login');
            console.log(`   >> 登录状态: ${loggedIn ? '已登录' : '未登录'} (${page.url()})`);

            if (!loggedIn) {
                console.log('   >> ⚠️ Cookie 已失效，需要重新登录。跳过该用户。');
                await sendTelegramMessage(`⚠️ *Cookie 已失效*\n用户: ${user.username}\nBot-Hosting cookie 已过期，需要手动更新。`);
                continue;
            }

            // 3. 保存 cookie 到 KV (登录有效)
            try {
                const cookies = await context.cookies();
                await kvPut(cookieKey, JSON.stringify(cookies));
            } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }

            // 4. 快速读取页面状态判断是否可续期
            let pageText = '';
            try { pageText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => ''); } catch (e) { }

            const isNotRenewed = pageText.includes('Not renewed');
            const isActive = pageText.includes('Active') || pageText.includes('Renew in');
            let expiryDate = '';
            const expMatch = pageText.match(/Expires\s+(\d{4}\/\d{2}\/\d{2})/);
            if (expMatch) expiryDate = expMatch[1];
            const expiryInfo = expiryDate ? `到期: ${expiryDate}` : '';

            if (!isNotRenewed || isActive) {
                console.log(`   >> 未到续期。${expiryInfo}`);
                await sendTelegramMessage(`⏳ *未到续期时间*\n用户: ${user.username}\n${expiryInfo}`);
                allResults.push({ user: user.username, status: 'wait' });
                continue;
            }

            // 5. 点击 "Renew free plan"
            console.log('点击 "Renew free plan"...');
            const renewBtn = page.locator('button:has-text("Renew free plan")').first();
            try {
                await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                await renewBtn.click();
                console.log('   >> 已点击');
            } catch (e) {
                console.log('   >> "Renew free plan" 按钮未找到，跳过。');
                await sendTelegramMessage(`⚠️ *续期按钮未找到*\n用户: ${user.username}`);
                continue;
            }

            // 6. 过 Cloudflare Turnstile
            console.log('处理 Cloudflare Turnstile...');
            let turnstileDone = false;
            for (let attempt = 1; attempt <= 15; attempt++) {
                const clicked = await attemptTurnstileCdp(page);
                if (clicked) {
                    console.log(`   >> Turnstile 已点击 (第 ${attempt} 次)`);
                    // 等待按钮启用，最多 8s
                    for (let w = 0; w < 8; w++) {
                        await page.waitForTimeout(1000);
                        const renew4Btn = page.locator('button:has-text("Renew for 4 days")');
                        const disabled = await renew4Btn.isDisabled().catch(() => true);
                        if (!disabled) {
                            console.log('   >> ✅ "Renew for 4 days" 按钮已启用');
                            turnstileDone = true;
                            break;
                        }
                    }
                    if (turnstileDone) break;
                }
                await page.waitForTimeout(800);
            }

            if (!turnstileDone) {
                console.log('   >> ⚠️ Turnstile 验证可能未完成，继续尝试点击续期...');
            }

            // 7. 点击 "Renew for 4 days"
            const renew4Btn = page.locator('button:has-text("Renew for 4 days")').first();
            try {
                await renew4Btn.waitFor({ state: 'visible', timeout: 5000 });
                const disabled = await renew4Btn.isDisabled().catch(() => true);
                if (disabled) {
                    console.log('   >> ⚠️ "Renew for 4 days" 按钮仍禁用，尝试 CDP 强制点击...');
                    const box = await renew4Btn.boundingBox();
                    if (box) {
                        const client = await page.context().newCDPSession(page);
                        const cx = box.x + box.width / 2;
                        const cy = box.y + box.height / 2;
                        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
                        await new Promise(r => setTimeout(r, 100));
                        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                        await new Promise(r => setTimeout(r, 80));
                        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                        await client.detach();
                        console.log('   >> CDP 强制点击已发送');
                    }
                } else {
                    await renew4Btn.click();
                    console.log('   >> 已点击 "Renew for 4 days"');
                }
            } catch (e) {
                console.log('   >> ⚠️ 无法点击续期按钮:', e.message);
            }

            // 8. 等待结果并截图
            await page.waitForTimeout(1500);
            const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
            const shot = path.join(photoDir, `bothosting_${safeUser}.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }

            // 续期后重新读取页面文本，获取新到期时间
            let body = '';
            try {
                body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
                const expMatch = body.match(/Expires\s+(\d{4}\/\d{2}\/\d{2})/);
                if (expMatch) expiryDate = expMatch[1];
            } catch (e) { }

            const isSuccess = /renewed|successfully|extended/i.test(body) || !body.includes('Not renewed');
            const isError = /error|failed|try again/i.test(body);

            const infoMsg = expiryDate ? `到期: ${expiryDate}` : '';

            if (isSuccess) {
                console.log(`   >> ✅ 续期成功！${infoMsg}`);
                await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n${infoMsg}`, shot);
                allResults.push({ user: user.username, status: 'success' });
            } else if (isError) {
                console.log('   >> ❌ 续期失败');
                await sendTelegramMessage(`❌ *续期失败*\n用户: ${user.username}`, shot);
                allResults.push({ user: user.username, status: 'error' });
            } else {
                console.log('   >> ⚠️ 续期结果未知');
                const notRenewed = await page.getByText('Not renewed').isVisible().catch(() => false);
                if (!notRenewed) {
                    console.log(`   >> ✅ 页面已无 "Not renewed" 标记，视为续期成功${infoMsg ? ` (${infoMsg})` : ''}`);
                    await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n${infoMsg}`, shot);
                    allResults.push({ user: user.username, status: 'success' });
                } else {
                    await sendTelegramMessage(`⚠️ *续期结果未知*\n用户: ${user.username}`, shot);
                    allResults.push({ user: user.username, status: 'unknown' });
                }
            }

        } catch (err) {
            console.error(`处理用户 ${user.username} 出错:`, err);
            allResults.push({ user: user.username, status: 'error', error: err.message });
        }
    }

    // 汇总
    const successCount = allResults.filter(r => r.status === 'success').length;
    const failCount = allResults.filter(r => r.status === 'error').length;
    console.log(`\n=== 完成 ===\n成功: ${successCount}, 失败: ${failCount}`);
    await sendTelegramMessage(
        `📊 *Bot-Hosting 续期汇总*\n成功: ${successCount}/${allResults.length}\n失败: ${failCount}/${allResults.length}`
    );

    console.log('关闭浏览器连接。');
    await browser.close();
})();
