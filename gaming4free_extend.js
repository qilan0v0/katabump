// Gaming4Free (control.gaming4free.net) 服务器续时脚本 —— 每 5 分钟点 +90 min
// 流程: 加载 KV cookie → 打开 serverUrl → 关广告弹窗 → 点 +90 min → 发通知
// Cookie 获取: 与 gaming4free_checkin.js 共用
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'G4F';

// 读取用户配置 G4F_USERS_JSON = [{"username":"...","serverUrl":"..."}]
let G4F_USERS = [];
try {
    const raw = process.env.G4F_USERS_JSON;
    if (raw) {
        G4F_USERS = JSON.parse(raw);
        if (!Array.isArray(G4F_USERS)) G4F_USERS = [];
    }
} catch (e) {
    console.warn('[配置] G4F_USERS_JSON 解析失败:', e.message);
}
if (G4F_USERS.length === 0) {
    console.error('未在 G4F_USERS_JSON 中找到用户配置');
    process.exit(1);
}
console.log('共 ' + G4F_USERS.length + ' 个用户');

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
        console.error('[Telegram] 文字推送失败:', tgErr(e));
    }
}

// 转义 Telegram Markdown 特殊字符
function escapeMd(s) {
    if (typeof s !== 'string') return s || '';
    return s.replace(/_/g, '\\_').replace(/\*/g, '\\*').replace(/`/g, '\\`').replace(/\[/g, '\\[');
}

chromium.use(stealth);

let CHROME_PATH = process.env.CHROME_PATH;
if (!CHROME_PATH) {
    try {
        const p = chromium.executablePath();
        if (p && fs.existsSync(p)) {
            CHROME_PATH = p;
            console.log('[Chrome] 使用 Playwright Chromium:', p);
        }
    } catch (e) {}
    if (!CHROME_PATH) {
        const candidates = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
        for (const c of candidates) {
            if (fs.existsSync(c)) { CHROME_PATH = c; break; }
        }
        CHROME_PATH = CHROME_PATH || '/usr/bin/google-chrome';
        console.log('[Chrome] 使用系统浏览器:', CHROME_PATH);
    }
}
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

// --- KV Admin Worker ---
const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);

if (!KV_ENABLED) console.log('[KV] 未配置 KV_ADMIN_URL/KV_ADMIN_PASS，跳过 cookie');

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
        console.warn('[KV] 读取失败:', e.message);
        return null;
    }
}

function normalizeCookies(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function(c) {
        var out = { name: c.name, value: String(c.value != null ? c.value : '') };
        if (c.domain) out.domain = c.domain;
        out.path = c.path || '/';
        if (c.httpOnly) out.httpOnly = true;
        if (c.secure) out.secure = true;
        if (c.sameSite && typeof c.sameSite === 'string') {
            var s = c.sameSite.toLowerCase();
            if (s === 'no_restriction' || s === 'none') out.sameSite = 'None';
            else if (s === 'lax') out.sameSite = 'Lax';
            else if (s === 'strict') out.sameSite = 'Strict';
        }
        if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
        else if (typeof c.expirationDate === 'number' && c.expirationDate > 0) out.expires = c.expirationDate;
        return out;
    });
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

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

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已开启。'); return; }
    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    args.push('--disable-dev-shm-usage');

    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
        throw new Error('Chrome 启动失败');
    }
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

// 注入脚本：在所有上下文中定位 Turnstile 复选框
const INJECTED_SCRIPT = `
(function() {
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    // 尝试在所有可能的上下文中查找复选框
    function findCheckboxInFrame(win) {
        try {
            const doc = win.document;
            if (!doc) return null;
            // 搜索 checkbox
            const checkbox = doc.querySelector('input[type="checkbox"], [role="checkbox"]');
            if (checkbox) {
                const rect = checkbox.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && win.innerWidth > 0 && win.innerHeight > 0) {
                    const xRatio = (rect.left + rect.width / 2) / win.innerWidth;
                    const yRatio = (rect.top + rect.height / 2) / win.innerHeight;
                    return { xRatio, yRatio, rect };
                }
            }
            // 搜索 shadow DOM
            const allElements = doc.querySelectorAll('*');
            for (const el of allElements) {
                if (el.shadowRoot) {
                    const shadowCheckbox = el.shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]');
                    if (shadowCheckbox) {
                        const rect = shadowCheckbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && win.innerWidth > 0 && win.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / win.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / win.innerHeight;
                            return { xRatio, yRatio, rect };
                        }
                    }
                }
            }
        } catch (e) {}
        return null;
    }

    // 先检查当前窗口
    const data = findCheckboxInFrame(window);
    if (data) {
        window.__turnstile_data = data;
        return;
    }

    // 检查所有 iframe
    const ifrs = document.querySelectorAll('iframe');
    for (const ifr of ifrs) {
        try {
            const iframeWin = ifr.contentWindow;
            if (iframeWin) {
                const iframeData = findCheckboxInFrame(iframeWin);
                if (iframeData) {
                    // 将 iframe 内的相对坐标转换为页面坐标
                    const iframeRect = ifr.getBoundingClientRect();
                    window.__turnstile_click_x = iframeRect.left + iframeData.rect.left + iframeData.rect.width / 2;
                    window.__turnstile_click_y = iframeRect.top + iframeData.rect.top + iframeData.rect.height / 2;
                    return;
                }
            }
        } catch (e) {}
    }
})();
`;

// Cloudflare Turnstile CDP 点击
// 直接定位 iframe 内的复选框元素，获取精确坐标后点击
async function attemptTurnstileCdp(page) {
    return await new Promise(async (resolve) => {
        const timeout = setTimeout(() => resolve(false), 6000);
        try {
            await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});

            // 核心方案：直接扫描所有 iframe，找到 Turnstile iframe，然后尝试定位复选框
            // 不再依赖注入脚本，直接通过 CDP 获取 iframe 内的 DOM 信息
            const turnstileFound = await page.evaluate(() => {
                const ifrs = Array.from(document.querySelectorAll('iframe'));
                for (const ifr of ifrs) {
                    const src = ifr.src || '';
                    if (!(/turnstile|challenges\.cloudflare/i.test(src) && ifr.offsetWidth > 100)) continue;
                    // 尝试通过 iframe 的 contentDocument 访问（跨域会失败）
                    try {
                        const doc = ifr.contentDocument || ifr.contentWindow.document;
                        // 搜索复选框
                        const checkbox = doc.querySelector('input[type="checkbox"], [role="checkbox"]');
                        if (checkbox) {
                            const rect = checkbox.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                // 返回复选框的页面坐标
                                window.__turnstile_click_x = rect.left + rect.width / 2;
                                window.__turnstile_click_y = rect.top + rect.height / 2;
                                return true;
                            }
                        }
                    } catch (e) {
                        // 跨域 iframe，无法直接访问
                        // 尝试通过 parent 窗口检测
                        try {
                            const parentDoc = ifr.ownerDocument || document;
                            // 查找包含 iframe 的容器，通过容器位置推断
                            const container = ifr.closest('[class*="turnstile"], [class*="widget"], [class*="challenge"]');
                            if (container) {
                                const cr = container.getBoundingClientRect();
                                // 复选框通常在容器的左上区域
                                window.__turnstile_click_x = cr.left + cr.width * 0.15;
                                window.__turnstile_click_y = cr.top + cr.height * 0.45;
                                return true;
                            }
                        } catch (e2) {}
                    }
                }
                return false;
            }).catch(() => false);

            if (turnstileFound && window.__turnstile_click_x && window.__turnstile_click_y) {
                const clickX = window.__turnstile_click_x;
                const clickY = window.__turnstile_click_y;
                console.log(`>> 定位到复选框: (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);

                const client = await page.context().newCDPSession(page).catch(() => null);
                if (client) {
                    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                    await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                    // 等待验证处理
                    await new Promise(r => setTimeout(r, 2000));

                    // 检查是否通过：iframe 消失 或 按钮进入冷却
                    const checkResult = await page.evaluate(() => {
                        const ifrs = Array.from(document.querySelectorAll('iframe'));
                        const hasTurnstileIframe = ifrs.some(f => /turnstile|challenges\.cloudflare/i.test(f.src || ''));
                        if (!hasTurnstileIframe) return 'passed'; // iframe 消失 = 通过
                        // iframe 还在，检查是否有错误提示
                        for (const ifr of ifrs) {
                            if (/turnstile|challenges\.cloudflare/i.test(ifr.src || '')) {
                                const txt = (ifr.parentElement?.textContent || '').trim();
                                if (/incorrect|error|failed|try again|unsuccessful/i.test(txt)) return 'failed';
                            }
                        }
                        // iframe 还在且无错误，检查按钮状态
                        const btn = document.querySelector('button.rt-btn-free:not(.disabled)');
                        if (btn) {
                            const txt = btn.innerText || '';
                            // 按钮进入冷却 = 验证通过
                            if (/cd|wait|loading/i.test(txt) && !/90|min/i.test(txt)) return 'passed';
                        }
                        return 'pending'; // 还在验证中
                    }).catch(() => 'pending');

                    await client.detach();

                    if (checkResult === 'passed') {
                        clearTimeout(timeout);
                        console.log('>> ✅ Turnstile 验证通过');
                        resolve(true);
                        return;
                    } else if (checkResult === 'failed') {
                        console.log('>> ⚠️ Turnstile 验证失败');
                        clearTimeout(timeout);
                        resolve(false);
                        return;
                    } else {
                        // pending = 不确定是否通过，返回 false 让外层重试
                        clearTimeout(timeout);
                        console.log('>> ⚠️ Turnstile 验证不确定，返回 false 重试');
                        resolve(false);
                        return;
                    }
                }
            }

            // 备选方案：通过 page.evaluate 扫描所有 iframe，找到可见的验证弹窗 iframe
            console.log('>> 直接定位失败，使用页面级 iframe 扫描...');
            const iframeCandidates = await page.evaluate(() => {
                const results = [];
                const ifrs = Array.from(document.querySelectorAll('iframe'));
                for (const ifr of ifrs) {
                    const src = ifr.src || '';
                    if (/turnstile|challenges\.cloudflare/i.test(src) && ifr.offsetWidth > 50 && ifr.offsetHeight > 50) {
                        const r = ifr.getBoundingClientRect();
                        results.push({ x: r.left, y: r.top, w: r.width, h: r.height });
                    }
                }
                return results;
            }).catch(() => []);

            if (iframeCandidates.length > 0) {
                console.log(`   [调试] 找到 ${iframeCandidates.length} 个可见 Turnstile iframe`);
                for (const ic of iframeCandidates) {
                    console.log(`   [调试] iframe: x=${ic.x}, y=${ic.y}, w=${ic.w}, h=${ic.h}`);
                }
                // 取第一个可见 iframe，使用更精确的坐标（复选框通常在左上角）
                const ic = iframeCandidates[0];
                const client = await page.context().newCDPSession(page).catch(() => null);
                if (client) {
                    // 密集候选点：覆盖 10%-30% 宽度范围，35%-55% 高度范围
                    const xOffsets = [0.10, 0.14, 0.18, 0.22, 0.26, 0.30];
                    const yOffsets = [0.35, 0.40, 0.45, 0.50, 0.55];
                    for (const xPct of xOffsets) {
                        for (const yPct of yOffsets) {
                            const cx = ic.x + ic.w * xPct;
                            const cy = ic.y + ic.h * yPct;
                            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                            await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                            await new Promise(r => setTimeout(r, 1500));

                            const checkResult = await page.evaluate(() => {
                                const ifrs = Array.from(document.querySelectorAll('iframe'));
                                const hasTurnstileIframe = ifrs.some(f => /turnstile|challenges\.cloudflare/i.test(f.src || ''));
                                if (!hasTurnstileIframe) return 'passed';
                                for (const ifr of ifrs) {
                                    if (/turnstile|challenges\.cloudflare/i.test(ifr.src || '')) {
                                        const txt = (ifr.parentElement?.textContent || '').trim();
                                        if (/incorrect|error|failed|try again|unsuccessful/i.test(txt)) return 'failed';
                                    }
                                }
                                const btn = document.querySelector('button.rt-btn-free:not(.disabled)');
                                if (btn) {
                                    const txt = btn.innerText || '';
                                    if (/cd|wait|loading/i.test(txt) && !/90|min/i.test(txt)) return 'passed';
                                }
                                return 'pending';
                            }).catch(() => 'pending');

                            if (checkResult === 'passed') {
                                await client.detach();
                                clearTimeout(timeout);
                                console.log('>> ✅ CDP 点击 Turnstile 成功 (' + cx.toFixed(0) + ', ' + cy.toFixed(0) + ')');
                                resolve(true);
                                return;
                            } else if (checkResult === 'failed') {
                                await client.detach();
                                clearTimeout(timeout);
                                console.log('>> ⚠️ CDP 点击 Turnstile 失败');
                                resolve(false);
                                return;
                            }
                            await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});
                        }
                    }
                    await client.detach();
                }
            }

            // 最终备选：通过 Playwright frame API
            console.log('>> 页面扫描失败，使用 Playwright frame API 扫描...');
            for (const frame of page.frames()) {
                const fu = (frame.url() || '');
                if (!/turnstile|challenges/i.test(fu) || fu.includes('favicon')) continue;
                try {
                    const el = await frame.frameElement().catch(() => null);
                    if (!el) continue;
                    const box = await el.boundingBox().catch(() => null);
                    if (!box || box.width < 50) continue;

                    // 调试：打印 iframe 信息
                    console.log(`   [调试] iframe URL: ${fu}, box: x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}`);

                    // 更密集的候选点扫描
                    const candidates = [
                        { x: box.x + box.width * 0.15, y: box.y + box.height * 0.45 },
                        { x: box.x + box.width * 0.25, y: box.y + box.height * 0.45 },
                        { x: box.x + box.width * 0.15, y: box.y + box.height * 0.35 },
                        { x: box.x + box.width * 0.25, y: box.y + box.height * 0.35 },
                        { x: box.x + box.width * 0.12, y: box.y + box.height * 0.42 },
                        { x: box.x + box.width * 0.18, y: box.y + box.height * 0.42 },
                        { x: box.x + box.width * 0.12, y: box.y + box.height * 0.48 },
                        { x: box.x + box.width * 0.18, y: box.y + box.height * 0.48 },
                    ];

                    const client = await page.context().newCDPSession(page).catch(() => null);
                    if (!client) continue;

                    for (const cand of candidates) {
                        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cand.x, y: cand.y, button: 'left', clickCount: 1 });
                        await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cand.x, y: cand.y, button: 'left', clickCount: 1 });
                        await new Promise(r => setTimeout(r, 2000));

                        // 验证：检查 iframe 状态 + 按钮状态 + 时间变化
                        const checkResult = await page.evaluate(() => {
                            const ifrs = Array.from(document.querySelectorAll('iframe'));
                            const hasTurnstileIframe = ifrs.some(f => /turnstile|challenges\.cloudflare/i.test(f.src || ''));
                            if (!hasTurnstileIframe) return 'passed'; // iframe 消失 = 通过
                            // iframe 还在，检查是否有错误提示
                            for (const ifr of ifrs) {
                                if (/turnstile|challenges\.cloudflare/i.test(ifr.src || '')) {
                                    const txt = (ifr.parentElement?.textContent || '').trim();
                                    if (/incorrect|error|failed|try again|unsuccessful/i.test(txt)) return 'failed';
                                }
                            }
                            // iframe 还在且无错误，检查按钮状态
                            const btn = document.querySelector('button.rt-btn-free:not(.disabled)');
                            if (btn) {
                                const txt = btn.innerText || '';
                                // 按钮进入冷却 = 验证通过
                                if (/cd|wait|loading/i.test(txt) && !/90|min/i.test(txt)) return 'passed';
                            }
                            return 'pending';
                        }).catch(() => 'pending');

                        if (checkResult === 'passed') {
                            await client.detach();
                            clearTimeout(timeout);
                            console.log('>> ✅ CDP 点击 Turnstile 成功 (' + cand.x.toFixed(0) + ', ' + cand.y.toFixed(0) + ')');
                            resolve(true);
                            return;
                        } else if (checkResult === 'failed') {
                            await client.detach();
                            clearTimeout(timeout);
                            console.log('>> ⚠️ CDP 点击 Turnstile 失败 (' + cand.x.toFixed(0) + ', ' + cand.y.toFixed(0) + ')');
                            resolve(false);
                            return;
                        }
                        await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});
                    }
                    await client.detach();
                } catch (e) { console.warn('[Turnstile 备选] 失败:', e.message); }
            }

            clearTimeout(timeout);
            resolve(false);
        } catch (e) {
            clearTimeout(timeout);
            resolve(false);
        }
    });
}

// 关掉 Ad Blocker 弹窗和遮罩层
async function dismissAdblockPopup(page) {
    // 1. 尝试点击关闭按钮
    const adBtn = page.locator('button:has-text("I\'ve Disabled My Ad Blocker"), button:has-text("Continue")').first();
    if (await adBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await adBtn.click();
        console.log('   >> 已关闭广告拦截弹窗');
        await page.waitForTimeout(2000);
    }
    // 2. 无论按钮是否可见，总是用 JS 移除遮罩层（防止遮罩层残留拦截点击）
    await page.evaluate(() => {
        const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
        for (const id of overlayIds) {
            const el = document.getElementById(id);
            if (el) el.remove();
        }
        // 移除非 iframe 的全屏 fixed 遮罩
        document.querySelectorAll('div').forEach(el => {
            const cs = window.getComputedStyle(el);
            if ((cs.position === 'fixed' || cs.position === 'absolute') &&
                cs.zIndex > 50 && !el.id && !el.querySelector('iframe')) {
                el.remove();
            }
        });
    }).catch(() => false);
}

// 给 promise 套整体超时
function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// 处理单个服务器的续时
async function extendServer(page, serverUrl, photoDir) {
    const sid = (serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || 'srv';
    const shot = path.join(photoDir, `g4f_extend_${sid}.png`);
    console.log(`\n--- 服务器 ${sid} ---`);
    console.log(`打开: ${serverUrl}`);

    await gotoWithRetry(page, serverUrl);
    await page.waitForTimeout(4000);

    // 关广告弹窗
    await dismissAdblockPopup(page);

    // 读取当前剩余时间
    let remainingTime = '';
    for (let w = 0; w < 10; w++) {
        const timeEl = page.locator('.time span, [class*="time"] span').first();
        const text = await timeEl.innerText().catch(() => '');
        if (text && /\d{2}:\d{2}:\d{2}/.test(text)) {
            remainingTime = text;
            break;
        }
        await page.waitForTimeout(1000);
    }
    console.log('   >> 剩余时间: ' + (remainingTime || '未知'));

    // 读取进度条和 cap 上限，判断是否已满
    const capInfo = await page.evaluate(() => {
        const segs = document.querySelectorAll('.seg-track i');
        const onSegs = document.querySelectorAll('.seg-track i.on');
        const capEl = document.querySelector('.rt-badge-cap');
        return {
            total: segs.length,
            on: onSegs.length,
            cap: capEl ? capEl.textContent.trim() : ''
        };
    }).catch(() => ({ total: 0, on: 0, cap: '' }));
    console.log('   >> 进度: ' + capInfo.on + '/' + capInfo.total + ' 格 | ' + capInfo.cap);

    // 满格判断：16格全部 on 表示 48h 上限已到，无需续时
    if (capInfo.total > 0 && capInfo.on >= capInfo.total) {
        console.log('   >> ✅ 续时已满 (' + capInfo.cap + ')，无需继续续时');
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
        return { status: 'full', remaining: remainingTime, capInfo: capInfo, shot };
    }

    // 找 +90 min 按钮
    const extendBtn = page.locator('button.rt-btn-free:not(.disabled)').first();
    const btnVisible = await extendBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (!btnVisible) {
        console.log('   >> +90 min 按钮不可见（可能是冷却中或无按钮）');
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
        return { status: 'cooldown', remaining: remainingTime, shot };
    }

    const btnText = await extendBtn.innerText().catch(() => '');
    console.log(`   >> 按钮文字: "${btnText}"`);

    // 如果按钮文字含 'cd' 说明在冷却
    if (/cd|wait/i.test(btnText) && !/90|min/i.test(btnText)) {
        console.log(`   >> 冷却中: ${btnText}`);
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
        return { status: 'cooldown', remaining: remainingTime, shot };
    }

    // 点击续时
    console.log('   >> 点击 +90 min...');

    // 关键：必须用普通点击（非 force）触发 Alpine.js 事件 → Turnstile 弹窗才会出现
    // 改进：先用 JS 移除所有可能的遮罩层，再通过 DOM dispatchEvent 点击按钮
    for (let r = 0; r < 3; r++) {
        // 全局清除所有可能的遮罩层
        await page.evaluate(() => {
            // 按 ID 移除
            const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
            for (const id of overlayIds) {
                const el = document.getElementById(id);
                if (el) el.remove();
            }
            // 按 class 移除常见的遮罩层
            const overlayClasses = ['.adblock-overlay', '.overlay', '.modal-backdrop', '.ad-overlay', '.block-overlay'];
            for (const cls of overlayClasses) {
                try {
                    const els = document.querySelectorAll(cls);
                    els.forEach(el => el.remove());
                } catch (e) {}
            }
            // 移除所有 fixed/absolute 定位且覆盖全屏的 div（遮罩层特征）
            document.querySelectorAll('div').forEach(el => {
                const cs = window.getComputedStyle(el);
                if ((cs.position === 'fixed' || cs.position === 'absolute') &&
                    el.offsetWidth >= window.innerWidth * 0.8 &&
                    el.offsetHeight >= window.innerHeight * 0.8 &&
                    cs.zIndex > 100) {
                    // 跳过重要元素
                    if (el.id || el.querySelector('iframe')) return;
                    el.remove();
                }
            });
            // 恢复 body 滚动
            document.body.style.overflow = 'auto';
        }).catch(() => {});
        await page.waitForTimeout(500);

        try {
            // 优先通过 Playwright 的 locator.click()（保留事件处理）
            await extendBtn.click({ timeout: 5000, force: false });
            console.log('   >> 普通点击成功');
            break;
        } catch (e) {
            console.log('   >> 普通点击被遮挡(第' + (r+1) + '次)，改用 DOM dispatchEvent...');
            // 通过 JS dispatchEvent 点击（保留 Alpine.js 事件）
            const jsClicked = await page.evaluate(() => {
                const btn = document.querySelector('button.rt-btn-free:not(.disabled)');
                if (!btn) return false;
                // 模拟真正的点击事件
                const rect = btn.getBoundingClientRect();
                const evt = new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2
                });
                return btn.dispatchEvent(evt);
            }).catch(() => false);
            if (jsClicked) console.log('   >> JS dispatchEvent 点击成功');
            else console.log('   >> JS dispatchEvent 点击失败');

            if (r === 2) {
                // 最后一次尝试：强制移除所有遮罩后 force click
                await page.evaluate(() => {
                    document.querySelectorAll('div').forEach(el => {
                        const cs = window.getComputedStyle(el);
                        if ((cs.position === 'fixed' || cs.position === 'absolute') && cs.zIndex > 50) {
                            if (!el.id && !el.querySelector('iframe, button, input')) el.remove();
                        }
                    });
                }).catch(() => {});
                try { await extendBtn.click({ force: true, timeout: 5000 }); } catch (e2) {}
            }
        }
    }
    await page.waitForTimeout(2000);

    // 再次移除广告遮罩
    await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});

    // 全力解决 Turnstile 验证（最多 ~20 秒）
    // Turnstile 弹窗在普通点击后 1-3 秒出现，CDP 需点击复选框
    console.log('   >> 处理 Turnstile 验证...');
    for (let t = 0; t < 8; t++) {
        // 全局清除遮罩
        await page.evaluate(() => {
            const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
            for (const id of overlayIds) {
                const el = document.getElementById(id);
                if (el) el.remove();
            }
            document.querySelectorAll('div').forEach(el => {
                const cs = window.getComputedStyle(el);
                if ((cs.position === 'fixed' || cs.position === 'absolute') &&
                    el.offsetWidth >= window.innerWidth * 0.8 &&
                    el.offsetHeight >= window.innerHeight * 0.8 &&
                    cs.zIndex > 100 && !el.id && !el.querySelector('iframe')) {
                    el.remove();
                }
            });
        }).catch(() => {});
        const clicked = await _race(attemptTurnstileCdp(page), 4000).catch(() => false);
        if (clicked) {
            console.log('   >> ✅ Turnstile 已点击');
            break;
        }
        // 检查按钮是否自动进入冷却（Turnstile 自动通过的情况）
        const btnText = await extendBtn.innerText().catch(() => '');
        if (/cd|wait|loading/i.test(btnText) && !/90|min/i.test(btnText)) break;
        await page.waitForTimeout(2000);
    }

    await page.evaluate(() => {
        const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
        for (const id of overlayIds) {
            const el = document.getElementById(id);
            if (el) el.remove();
        }
    }).catch(() => {});

    // 解析剩余时间 → 秒数
    function parseTime(str) {
        if (!str) return 0;
        const m = str.match(/(\d{2}):(\d{2}):(\d{2})/);
        if (!m) return 0;
        return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
    }
    const oldSeconds = parseTime(remainingTime);

    // 等候续时生效（最多 ~40 秒）
    console.log('   >> 等候续时生效...');
    let extendOk = false;
    for (let w = 0; w < 20; w++) {
        // 全局清除遮罩
        await page.evaluate(() => {
            const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
            for (const id of overlayIds) {
                const el = document.getElementById(id);
                if (el) el.remove();
            }
        }).catch(() => {});

        // 检查按钮是否进入冷却
        const curBtnText = await extendBtn.innerText().catch(() => '');
        if (/cd|wait|loading/i.test(curBtnText) && !/90|min/i.test(curBtnText)) {
            console.log('   >> 按钮进入冷却，续时成功');
            extendOk = true;
            break;
        }
        // 检查剩余时间是否增加
        const curTime = await page.locator('.time span, [class*="time"] span').first().innerText().catch(() => '');
        const curSeconds = parseTime(curTime);
        if (curSeconds > oldSeconds + 30) {
            console.log('   >> 剩余时间已增加，续时成功 (' + remainingTime + ' → ' + curTime + ')');
            extendOk = true;
            break;
        }
        await page.waitForTimeout(2000);
    }

    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}

    // 再次读取剩余时间
    let newRemaining = '';
    for (let w = 0; w < 5; w++) {
        const timeEl = page.locator('.time span, [class*="time"] span').first();
        newRemaining = await timeEl.innerText().catch(() => '');
        if (newRemaining && /\d{2}:\d{2}:\d{2}/.test(newRemaining)) break;
        await page.waitForTimeout(1000);
    }
    console.log('   >> 续时后剩余: ' + (newRemaining || '未知'));

    return { status: 'extended', remaining: newRemaining || remainingTime, oldRemaining: remainingTime, shot };
}

(async () => {
    if (G4F_USERS.length === 0) {
        console.error('未配置用户 (G4F_USERS_JSON)');
        process.exit(1);
    }
    console.log('共 ' + G4F_USERS.length + ' 个用户');

    if (PROXY_CONFIG) {
        const ok = await checkProxy();
        if (!ok) { console.error('[代理] 代理无效，终止运行。'); process.exit(1); }
    }

    await launchChrome();

    console.log('正在连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP('http://localhost:' + DEBUG_PORT);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log('连接尝试 ' + (k + 1) + ' 失败。2秒后重试...');
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

    // 注入 Turnstile 检测脚本
    await page.addInitScript(INJECTED_SCRIPT);

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    // 逐个用户续时
    const results = [];
    for (const user of G4F_USERS) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        const serverUrl = user.serverUrl;
        if (!serverUrl) {
            console.log('用户 ' + safeUser + ' 未配置 serverUrl，跳过');
            continue;
        }

        // 加载该用户的 cookie
        const cookieKey = 'gaming4free_cookie_' + safeUser;
        const cookieStr = await kvGet(cookieKey);
        if (cookieStr) {
            try {
                const cks = normalizeCookies(JSON.parse(cookieStr));
                try { await context.clearCookies(); } catch (e) {}
                await context.addCookies(cks);
                console.log('   >> [' + safeUser + '] 已注入 cookie (' + cks.length + ' 条)');
            } catch (e) {
                console.warn('   >> [' + safeUser + '] cookie 解析失败:', e.message);
            }
        }

        try {
            const r = await withTimeout(extendServer(page, serverUrl, photoDir), 90000, '续时 ' + safeUser);
            results.push({ serverUrl, user: safeUser, ...r });
        } catch (e) {
            console.error('用户 ' + safeUser + ' 出错:', e.message);
            results.push({ serverUrl, user: safeUser, status: 'error', shot: '' });
        }
        await page.waitForTimeout(1000);
    }

    // 汇总通知
    const extended = results.filter(r => r.status === 'extended');
    const cooldown = results.filter(r => r.status === 'cooldown');
    const full = results.filter(r => r.status === 'full');

    if (full.length > 0) {
        const fullList = full.map(r => {
            const sid = (r.serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            const cap = r.capInfo ? r.capInfo.cap : '48h cap';
            return '  ' + escapeMd(r.user) + ' / `' + sid + '`: ' + escapeMd(cap) + ' 已满';
        }).join('\n');
        const stillGoing = extended.length > 0 ? '\n' + extended.length + ' 个已续时' : '';
        const cooling = cooldown.length > 0 ? '\n' + cooldown.length + ' 个冷却中' : '';
        await sendTelegramMessage('✅ *续时已达上限*\n' + fullList + stillGoing + cooling);
    }

    if (extended.length > 0) {
        for (const r of extended) {
            const sid = (r.serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            const msg = '✅ *续时成功*\n用户: ' + escapeMd(r.user) + '\n服务器: `' + sid + '`\n剩余: ' + escapeMd(r.remaining || '?') + '\n时间: ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            await sendTelegramMessage(msg, r.shot);
        }
    }
    if (cooldown.length > 0 && extended.length === 0 && full.length === 0) {
        const waitingList = cooldown.map(r => {
            const sid = (r.serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            return '  ' + escapeMd(r.user) + ' / `' + sid + '`: 剩余 ' + escapeMd(r.remaining || '?');
        }).join('\n');
        await sendTelegramMessage('⏳ *续时冷却中*\n暂无可用续时\n\n当前剩余:\n' + waitingList);
    }

    console.log('\n完成。');
    await browser.close();
    process.exit(0);
})();
