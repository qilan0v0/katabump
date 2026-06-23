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

// 注入脚本：在 iframe 内直接搜索复选框 + hook attachShadow 双重策略
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    // 2. 搜索复选框（支持常规 DOM + shadow DOM）
    function findCheckbox() {
        // 搜索常规 DOM
        try {
            const cb = document.querySelector('input[type="checkbox"], [role="checkbox"]');
            if (cb) {
                const rect = cb.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                    window.__turnstile_data = {
                        xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                        yRatio: (rect.top + rect.height / 2) / window.innerHeight
                    };
                    return true;
                }
            }
        } catch (e) {}
        // 搜索所有 shadow DOM
        try {
            const all = document.querySelectorAll('*');
            for (const el of all) {
                if (el.shadowRoot) {
                    const cb = el.shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]');
                    if (cb) {
                        const rect = cb.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            window.__turnstile_data = {
                                xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                                yRatio: (rect.top + rect.height / 2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                }
            }
        } catch (e) {}
        return false;
    }

    // 立即搜索一次
    if (findCheckbox()) return;

    // 3. attachShadow Hook — 拦截未来创建的 shadow DOM
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkShadow = () => {
                    const cb = shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]');
                    if (cb) {
                        const rect = cb.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            window.__turnstile_data = {
                                xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                                yRatio: (rect.top + rect.height / 2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkShadow()) {
                    const obs = new MutationObserver(() => { if (checkShadow()) obs.disconnect(); });
                    obs.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }

    // 4. MutationObserver 监听 DOM 变化（捕获动态添加的复选框）
    var mo = new MutationObserver(function() {
        if (findCheckbox()) mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // 5. 延迟重试（某些框架异步渲染）
    setTimeout(function() { if (findCheckbox()) { try { mo.disconnect(); } catch(e) {} } }, 1500);
})();
`;

// Cloudflare Turnstile 点击
// 读取注入脚本的 __turnstile_data 进行精确定位 + 点击后验证
async function attemptTurnstileCdp(page) {
    return await new Promise(async (resolve) => {
        const timeout = setTimeout(() => resolve(false), 12000);
        try {
            // 先清除所有遮罩
            await page.evaluate(() => {
                const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
                for (const id of overlayIds) {
                    const el = document.getElementById(id);
                    if (el) el.remove();
                }
            }).catch(() => {});

            // --- 方案1：遍历 Playwright frames（放宽匹配） ---
            const frames = page.frames();
            let turnstileBox = null;
            let preciseCoords = null;
            let candidateCount = 0;
            for (const frame of frames) {
                const fu = (frame.url() || '');
                if (fu.includes('favicon')) continue;
                // 放宽匹配：URL 含 turnstile 或为空/about:blank（Turnstile iframe 初始可能未稳定）
                const isTurnstile = /turnstile|challenges\.cloudflare/i.test(fu);
                const isBlank = !fu || fu === 'about:blank';
                if (!isTurnstile && !isBlank) continue;
                try {
                    const iframeElement = await frame.frameElement().catch(() => null);
                    if (!iframeElement) continue;
                    const box = await iframeElement.boundingBox().catch(() => null);
                    if (!box || box.width < 50 || box.height < 30) continue;

                    // about:blank frame 二次校验：父 iframe 标签是否含 turnstile 标识
                    if (isBlank && !isTurnstile) {
                        const looksLikeTurnstile = await iframeElement.evaluate((el) => {
                            const src = (el.getAttribute('src') || '').toLowerCase();
                            const cls = (el.className || '').toLowerCase();
                            const id = (el.id || '').toLowerCase();
                            return /turnstile|challenges|cloudflare|cf-/.test(src + cls + id);
                        }).catch(() => false);
                        if (!looksLikeTurnstile) continue;
                    }

                    candidateCount++;
                    const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
                    turnstileBox = box;

                    if (data && data.xRatio && data.yRatio) {
                        console.log('>> 在 frame 中发现 Turnstile。比例:', data);
                        preciseCoords = {
                            x: box.x + (box.width * data.xRatio),
                            y: box.y + (box.height * data.yRatio)
                        };
                        break;
                    }
                } catch (e) { }
            }

            // --- 方案2：兜底，直接从 DOM 找 Turnstile iframe ---
            if (!turnstileBox) {
                const domBox = await page.evaluate(() => {
                    const ifrs = Array.from(document.querySelectorAll('iframe'));
                    for (const f of ifrs) {
                        const src = (f.src || '').toLowerCase();
                        const id = (f.id || '').toLowerCase();
                        const cls = (f.className || '').toLowerCase();
                        if (/turnstile|challenges\.cloudflare|cf-chl|cf-turnstile/.test(src + ' ' + id + ' ' + cls)) {
                            const r = f.getBoundingClientRect();
                            if (r.width >= 50 && r.height >= 30) {
                                return { x: r.left, y: r.top, width: r.width, height: r.height };
                            }
                        }
                    }
                    return null;
                }).catch(() => null);
                if (domBox) {
                    console.log('>> 通过 DOM 找到 Turnstile iframe (frame tree 未注册)');
                    turnstileBox = domBox;
                }
            }

            if (!turnstileBox) {
                console.log('>> 未发现 Turnstile iframe (candidates: ' + candidateCount + ')');
                clearTimeout(timeout);
                resolve(false);
                return;
            }

            // 精确点击（如果有）or 在 iframe 左上区域搜索点击
            const clickPoints = preciseCoords
                ? [preciseCoords]  // 单点精确点击
                : [                 // 多点密集搜索 (CDP 扫描)
                    { x: turnstileBox.x + 12, y: turnstileBox.y + 15 },
                    { x: turnstileBox.x + 12, y: turnstileBox.y + 30 },
                    { x: turnstileBox.x + 25, y: turnstileBox.y + 15 },
                    { x: turnstileBox.x + 25, y: turnstileBox.y + 30 },
                    { x: turnstileBox.x + 38, y: turnstileBox.y + 15 },
                    { x: turnstileBox.x + 38, y: turnstileBox.y + 30 },
                    { x: turnstileBox.x + 12, y: turnstileBox.y + 45 },
                    { x: turnstileBox.x + 25, y: turnstileBox.y + 45 },
                    { x: turnstileBox.x + 38, y: turnstileBox.y + 45 },
                  ];

            if (!preciseCoords) console.log('>> 注入脚本未返回数据，使用 CDP 密集扫描...');

            const client = await page.context().newCDPSession(page).catch(() => null);
            if (!client) { clearTimeout(timeout); resolve(false); return; }

            // 点击所有候选点
            for (const cp of clickPoints) {
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cp.x, y: cp.y, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cp.x, y: cp.y, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 400));
            }
            await client.detach();
            if (preciseCoords) console.log('>> CDP 精确点击已发送。');
            else console.log('>> CDP 密集扫描完成');

            // --- 验证：等待 3 秒后检查 Turnstile 是否通过 ---
            await page.waitForTimeout(3000);

            const verified = await page.evaluate(() => {
                // 检查按钮是否进入冷却（全部类型的按钮）
                const allBtns = document.querySelectorAll('button');
                for (const btn of allBtns) {
                    const txt = btn.innerText || '';
                    // 匹配冷却/等待状态
                    if (/^(cd|wait|loading)/i.test(txt) || /\b(cd|loading)\b/i.test(txt)) {
                        if (!/90|min/i.test(txt)) return true;
                    }
                }
                // 检查 iframe 是否消失
                const ifrs = Array.from(document.querySelectorAll('iframe'));
                return !ifrs.some(f => /turnstile|challenges\.cloudflare/i.test(f.src || '') && f.offsetWidth > 50);
            }).catch(() => false);

            clearTimeout(timeout);
            if (verified) {
                console.log('>> ✅ Turnstile 验证通过');
                resolve(true);
            } else {
                console.log('>> ⚠️ Turnstile 验证未通过，需要重试');
                resolve(false);
            }
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

    // === 诊断：监听网络请求 + 控制台 + 页面错误 ===
    const reqLog = [];
    const consoleLog = [];
    const onReq = (req) => {
        const u = req.url();
        const m = req.method();
        if (m !== 'GET' && /control\.gaming4free|\/server\/|renew|extend|claim|free/i.test(u)) {
            reqLog.push(m + ' ' + u);
        }
    };
    const onConsole = (msg) => {
        const type = msg.type();
        if (type === 'error' || type === 'warning') {
            const t = msg.text();
            if (t && !/favicon|google-analytics|gtag|tracking/i.test(t)) consoleLog.push(type + ': ' + t.slice(0, 200));
        }
    };
    const onPageError = (err) => { consoleLog.push('pageerror: ' + (err.message || String(err)).slice(0, 200)); };
    page.on('request', onReq);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

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

    // 全力解决 Turnstile 验证（最多 ~30 秒）
    // Turnstile 弹窗在普通点击后 1-5 秒出现，CDP 需点击复选框
    console.log('   >> 处理 Turnstile 验证...');
    let turnstileResolved = false;
    for (let t = 0; t < 12; t++) {
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

        // 先检查 Turnstile iframe / 容器 是否已出现（放宽匹配 + 诊断 + 重点击）
        const probe = await page.evaluate(() => {
            const result = { hasIframe: false, hasContainer: false, iframes: [], containers: [] };
            const ifrs = Array.from(document.querySelectorAll('iframe'));
            for (const f of ifrs) {
                const src = (f.src || '').toLowerCase();
                const id = (f.id || '').toLowerCase();
                const cls = (f.className || '').toLowerCase();
                const name = (f.getAttribute('name') || '').toLowerCase();
                const title = (f.getAttribute('title') || '').toLowerCase();
                const combined = src + ' ' + id + ' ' + cls + ' ' + name + ' ' + title;
                const r = f.getBoundingClientRect();
                const matches = /turnstile|challenges\.cloudflare|cf-chl|cf-turnstile|cf-chl-widget/.test(combined);
                if (matches && r.width >= 30 && r.height >= 20) result.hasIframe = true;
                result.iframes.push({ src: f.src || '', id: f.id || '', cls: f.className || '', name: f.getAttribute('name') || '', title: f.getAttribute('title') || '', w: Math.round(r.width), h: Math.round(r.height), matches });
            }
            const containers = Array.from(document.querySelectorAll('.cf-turnstile, [data-sitekey], div[id*="turnstile" i], div[class*="turnstile" i]'));
            for (const c of containers) {
                const r = c.getBoundingClientRect();
                if (r.width >= 30 && r.height >= 20) result.hasContainer = true;
                result.containers.push({ tag: c.tagName, id: c.id, cls: c.className, sitekey: c.getAttribute('data-sitekey') || '', w: Math.round(r.width), h: Math.round(r.height) });
            }
            return result;
        }).catch(() => ({ hasIframe: false, hasContainer: false, iframes: [], containers: [] }));

        const iframePresent = probe.hasIframe || probe.hasContainer;

        if (!iframePresent) {
            if (t < 2) {
                await page.waitForTimeout(2500);
                continue;
            }
            if (t === 2) {
                console.log('   >> 诊断: iframe 数=' + probe.iframes.length + ' container 数=' + probe.containers.length);
                for (const f of probe.iframes) console.log('      iframe: ' + JSON.stringify(f).slice(0, 240));
                for (const c of probe.containers) console.log('      container: ' + JSON.stringify(c).slice(0, 240));
                console.log('   >> 未检测到 Turnstile，重新点击 +90 min 按钮...');
                await extendBtn.click({ force: true, timeout: 3000 }).catch(() => {});
                await page.waitForTimeout(2500);
                continue;
            }
            const btnText = await extendBtn.innerText().catch(() => '');
            if (/cd|wait|loading/i.test(btnText) && !/90|min/i.test(btnText)) {
                console.log('   >> 按钮已进入冷却，无需 Turnstile');
                turnstileResolved = true;
                break;
            }
            await page.waitForTimeout(2000);
            continue;
        }

        const clicked = await attemptTurnstileCdp(page).catch(() => false);
        if (clicked) {
            console.log('   >> ✅ Turnstile 已点击');
            turnstileResolved = true;
            break;
        }
        // 检查按钮是否自动进入冷却（Turnstile 自动通过的情况）
        const btnText = await extendBtn.innerText().catch(() => '');
        if (/cd|wait|loading/i.test(btnText) && !/90|min/i.test(btnText)) {
            turnstileResolved = true;
            break;
        }
        await page.waitForTimeout(2000);
    }
    if (!turnstileResolved) console.log('   >> ⚠️ Turnstile 未在超时内解决');

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
