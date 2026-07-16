// FreeGameHost (panel.freegamehost.xyz) 续期保活脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 打开登录页 → 填邮箱/密码 → 点 "Login" → 登录成功跳主面板
//       → 打开配置的 serverUrl → 点 "+8 Hours" 续期
// 账号来源: Secret FREEGAMEHOST_USERS_JSON =
//   [{"username":"a@b.com","password":"pwd","serverUrl":"https://panel.freegamehost.xyz/server/xxxx"}]
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execFile } = require('child_process');
const http = require('http');
const os = require('os');

const LOGIN_URL = 'https://panel.freegamehost.xyz/auth/login';

// --- v2ray 进程管理 (per-user 代理) ---
const V2RAY_BIN = process.env.V2RAY_BIN || `${process.env.HOME}/v2ray/v2ray`;
let nextV2rayPort = 11080;
const v2rayProcs = [];      // 当前用户的 v2ray
const allV2rayProcs = [];   // 全局 v2ray（用于 exit 时全部清理）

function cleanupV2ray(procs = allV2rayProcs) {
    for (const { proc, port } of procs) {
        try { proc.kill('SIGTERM'); } catch (e) { }
        try { proc.kill('SIGKILL'); } catch (e) { }
    }
    procs.length = 0;
}

// 启动一个 v2ray 实例用于 per-user 代理
async function startV2rayForLink(link) {
    if (!require('fs').existsSync(V2RAY_BIN)) {
        console.error(`[v2ray] 未找到 v2ray 二进制 (${V2RAY_BIN})`);
        return null;
    }
    const port = nextV2rayPort++;
    let cfgPath;
    try {
        const { buildConfig } = require('./.github/scripts/gen-v2ray-config');
        const cfg = buildConfig(link, port);
        cfgPath = path.join(process.cwd(), `v2ray-freegamehost-${port}.json`);
        require('fs').writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error(`[v2ray] 解析 V2 链接失败: ${e.message}`);
        return null;
    }
    console.log(`[v2ray] 启动实例 (HTTP 127.0.0.1:${port})...`);
    const proc = spawn(V2RAY_BIN, ['run', '-config', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
    const entry = { proc, port, link };
    v2rayProcs.push(entry);
    allV2rayProcs.push(entry);

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
        cleanupV2ray(v2rayProcs);
        return null;
    }
    console.log(`[v2ray] 代理就绪 → http://127.0.0.1:${port}`);
    return { port, url: `http://127.0.0.1:${port}` };
}

function parseProxyUrl(urlStr) {
    const url = new URL(urlStr);
    return {
        server: `${url.protocol}//${url.hostname}:${url.port}`,
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined
    };
}

// 解析每个用户应使用的代理:
//   user.V2 → 启动 per-user v2ray, 覆盖全局 HTTP_PROXY
//   不带 V2 → 回退到全局 HTTP_PROXY
async function resolveUserProxy(user, skipV2 = false) {
    // 清理上一用户的 v2ray
    cleanupV2ray(v2rayProcs);

    if (!skipV2 && (user.V2 || user.v2)) {
        const link = (user.V2 || user.v2).trim();
        console.log(`   >> 检测到用户专属 V2 链接，启动独立 v2ray...`);
        const localUrl = await startV2rayForLink(link);
        if (localUrl) {
            const cfg = parseProxyUrl(localUrl.url);
            return { config: cfg, label: `v2ray (${localUrl.url})` };
        }
        console.warn('   >> 专属 v2ray 启动失败，回退到全局代理。');
    } else if (skipV2 && (user.V2 || user.v2)) {
        console.log('   >> 跳过 V2 (已降级)，回退到全局代理/直连。');
    }

    // 回退到全局 HTTP_PROXY
    if (HTTP_PROXY) {
        try {
            const url = new URL(HTTP_PROXY);
            console.log(`   >> 使用全局 HTTP 代理: ${url.hostname}:${url.port}`);
            return {
                config: {
                    server: `${url.protocol}//${url.hostname}:${url.port}`,
                    username: url.username ? decodeURIComponent(url.username) : undefined,
                    password: url.password ? decodeURIComponent(url.password) : undefined
                },
                label: `全局代理 (${HTTP_PROXY})`
            };
        } catch (e) {
            console.warn(`   >> HTTP_PROXY 格式无效: ${HTTP_PROXY}`);
        }
    }

    console.log('   >> 直连 (无代理)');
    return { config: null, label: '直连 (无代理)' };
}

process.on('exit', () => cleanupV2ray());
process.on('SIGINT', () => { cleanupV2ray(); process.exit(0); });
process.on('SIGTERM', () => { cleanupV2ray(); process.exit(0); });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID; // 可选：超级群话题(Topic)的 message_thread_id
const PROJECT = process.env.PROJECT_NAME || 'FreeGameHost';

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
let chromeProcess = null; // 追踪 Chrome 进程以便按用户重启
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

// --- KV Cookie Admin Worker：通过 Worker API 存取登录 cookie ---
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


// 规范化 cookie 数组为 Playwright addCookies 接受的格式 (兼容浏览器扩展导出的 expirationDate/sameSite 等)
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

// --- injected.js 核心逻辑 ---
// 这个脚本会被注入到每个 Frame 中。它劫持 attachShadow 以捕获 Turnstile 的 checkbox，
// 计算其相对于 Frame 视口的位置比例，并存入 window.__turnstile_data 供外部读取。
const INJECTED_SCRIPT = `
(function() {
    // 只在 iframe 中运行（Turnstile 通常在 iframe 里）
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标 (尝试保留这个优化)
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { 
        // 忽略错误，如果不允许修改也没关系，不影响主流程
    }

    // 2. 简单的 attachShadow Hook (回退到这个版本，确保能找到元素)
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    // 尝试在 Shadow Root 中查找 checkbox
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        // 确保元素已渲染且可见
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            
                            // 暴露数据给 Playwright
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };

                // 立即检查一次
                if (!checkAndReport()) {
                    // 如果没找到，监听 DOM 变化
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[Injected] Error hooking attachShadow:', e);
    }
})();
`;

async function checkProxy(proxyConfig) {
    const cfg = proxyConfig || PROXY_CONFIG;
    if (!cfg) return true;
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(cfg.server).hostname,
                port: new URL(cfg.server).port,
            },
            timeout: 10000
        };
        if (cfg.username && cfg.password) {
            axiosConfig.proxy.auth = { username: cfg.username, password: cfg.password };
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

async function stopChrome() {
    if (chromeProcess) {
        console.log('正在停止 Chrome...');
        try { process.kill(-chromeProcess.pid); } catch (e) { }
        chromeProcess = null;
        await new Promise(r => setTimeout(r, 2000));
    }
    // 确保端口关闭
    for (let i = 0; i < 20; i++) {
        if (!(await checkPort(DEBUG_PORT))) return;
        await new Promise(r => setTimeout(r, 1000));
    }
}

async function launchChrome(proxyConfig) {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启，先停止旧实例...');
        await stopChrome();
    }
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1440,900',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--user-data-dir=/tmp/chrome_user_data'
    ];
    if (proxyConfig) {
        args.push(`--proxy-server=${proxyConfig.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`正在启动 Chrome (路径: ${CHROME_PATH}, 第 ${attempt} 次)...`);
        let stderr = '';
        const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        chromeProcess = chrome;
        if (chrome.stderr) chrome.stderr.on('data', d => { stderr += d.toString(); });
        chrome.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
        chrome.unref();
        console.log('正在等待 Chrome 初始化...');
        for (let i = 0; i < 40; i++) {
            if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已就绪。'); return; }
            await new Promise(r => setTimeout(r, 1000));
        }
        console.error(`Chrome 第 ${attempt} 次未在端口 ${DEBUG_PORT} 起来。stderr 末尾:\n` + stderr.slice(-800));
        try { process.kill(-chrome.pid); } catch (e) { }
        try { fs.rmSync('/tmp/chrome_user_data', { recursive: true, force: true }); } catch (e) { }
        chromeProcess = null;
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Chrome 启动失败');
}

function getUsers() {
    try {
        if (process.env.FREEGAMEHOST_USERS_JSON) {
            // 清除字符串值中的控制字符（如换行符），避免 JSON.parse 失败
            const cleaned = process.env.FREEGAMEHOST_USERS_JSON.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
            const parsed = JSON.parse(cleaned);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 FREEGAMEHOST_USERS_JSON 环境变量错误:', e);
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

/**
 * 核心功能：遍历所有 Frames，查找被注入脚本标记的 Turnstile 坐标，
 * 计算绝对屏幕坐标，并使用 CDP 发送原生鼠标点击事件。
 */
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> Found Turnstile in frame. Ratios:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`>> Calculated absolute click coordinates: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                console.log('>> CDP Click sent successfully.');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

// --- reCAPTCHA 音频绕过 (移植自 sarperavci/GoogleRecaptchaBypass) ---
// Python 子进程路径：优先用 python3，回退到 python
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const RECAPTCHA_SOLVER_PY = path.join(__dirname, 'recaptcha_solver.py');

// 调用 recaptcha_solver.py 识别音频文件，返回识别文本
async function recognizeAudio(mp3Path) {
    return new Promise((resolve) => {
        execFile(PYTHON_BIN, [RECAPTCHA_SOLVER_PY, mp3Path], { timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            if (err) {
                console.warn(`   >> [reCAPTCHA] 语音识别子进程失败: ${err.message}`);
                if (stderr) console.warn(`   >> [reCAPTCHA] stderr: ${stderr.slice(0, 300)}`);
                return resolve(null);
            }
            const text = (stdout || '').trim();
            if (!text) {
                console.warn('   >> [reCAPTCHA] 语音识别返回空结果');
                return resolve(null);
            }
            console.log(`   >> [reCAPTCHA] 识别结果: "${text}"`);
            resolve(text);
        });
    });
}

// 判断 reCAPTCHA anchor iframe 是否已通过 (checkbox 勾选)
async function isRecaptchaSolved(page) {
    for (const frame of page.frames()) {
        try {
            const url = frame.url();
            if (!/recaptcha\/api2\/anchor/i.test(url)) continue;
            const checked = await frame.evaluate(() => {
                const el = document.getElementById('recaptcha-anchor');
                if (!el) return false;
                return el.getAttribute('aria-checked') === 'true';
            }).catch(() => false);
            if (checked) return true;
        } catch (e) { }
    }
    return false;
}

// 判断是否被 Google 检测为机器人 ("Try again later")
async function isRecaptchaDetected(page) {
    for (const frame of page.frames()) {
        try {
            const url = frame.url();
            if (!/recaptcha\/api2\/bframe/i.test(url)) continue;
            const detected = await frame.evaluate(() => {
                const all = document.body ? document.body.innerText : '';
                return /try again later/i.test(all);
            }).catch(() => false);
            if (detected) return true;
        } catch (e) { }
    }
    return false;
}

// 查找 reCAPTCHA anchor iframe 并点击 checkbox
async function clickRecaptchaCheckbox(page) {
    for (const frame of page.frames()) {
        try {
            const url = frame.url();
            if (!/recaptcha\/api2\/anchor/i.test(url)) continue;
            const anchor = await frame.locator('#recaptcha-anchor').first();
            const visible = await anchor.isVisible().catch(() => false);
            if (!visible) continue;
            await anchor.click({ timeout: 5000 }).catch(() => { });
            console.log('   >> [reCAPTCHA] 已点击 checkbox');
            return true;
        } catch (e) { }
    }
    return false;
}

// 切换到音频挑战并下载音频 URL
async function getAudioChallengeUrl(page) {
    for (const frame of page.frames()) {
        try {
            const url = frame.url();
            if (!/recaptcha\/api2\/bframe/i.test(url)) continue;
            const audioBtn = frame.locator('#recaptcha-audio-button').first();
            const visible = await audioBtn.isVisible({ timeout: 7000 }).catch(() => false);
            if (!visible) continue;
            await audioBtn.click({ timeout: 5000 }).catch(() => { });
            console.log('   >> [reCAPTCHA] 已切换到音频挑战');
            await page.waitForTimeout(800);
            // 等待 audio-source 出现
            const audioSrc = await frame.locator('#audio-source').first().getAttribute('src', { timeout: 10000 }).catch(() => null);
            if (audioSrc) return { frame, audioSrc };
        } catch (e) { }
    }
    return null;
}

// 完整的 reCAPTCHA 解决流程 (音频绕过)，返回 true/false
async function solveRecaptcha(page, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`   >> [reCAPTCHA] 第 ${attempt}/${maxRetries} 次尝试...`);

        // 1. 点击 checkbox
        const clicked = await clickRecaptchaCheckbox(page);
        if (!clicked) {
            console.warn('   >> [reCAPTCHA] 未找到 anchor checkbox，可能不是 reCAPTCHA v2');
            return false;
        }
        await page.waitForTimeout(2000);

        // 2. 检查是否已直接通过
        if (await isRecaptchaSolved(page)) {
            console.log('   >> [reCAPTCHA] ✅ 仅点击 checkbox 即通过');
            return true;
        }

        // 3. 切换音频挑战
        const challenge = await getAudioChallengeUrl(page);
        if (!challenge) {
            console.warn('   >> [reCAPTCHA] 无法切换到音频挑战');
            await page.waitForTimeout(1500);
            continue;
        }

        // 4. 检查是否被检测为机器人
        if (await isRecaptchaDetected(page)) {
            console.warn('   >> [reCAPTCHA] ❌ 被检测为机器人 (Try again later)');
            return false;
        }

        // 5. 下载音频到临时文件
        const tmpFile = path.join(os.tmpdir(), `recaptcha_${Date.now()}.mp3`);
        let recognized = null;
        try {
            const resp = await axios.get(challenge.audioSrc, { responseType: 'arraybuffer', timeout: 20000, proxy: false });
            fs.writeFileSync(tmpFile, resp.data);
            console.log(`   >> [reCAPTCHA] 音频已下载 (${resp.data.length} bytes)`);

            // 6. 调用 Python 子进程识别
            recognized = await recognizeAudio(tmpFile);
        } catch (e) {
            console.warn(`   >> [reCAPTCHA] 下载/识别失败: ${e.message}`);
        } finally {
            try { fs.unlinkSync(tmpFile); } catch (e) { }
        }

        if (!recognized) {
            await page.waitForTimeout(1500);
            continue;
        }

        // 7. 填入答案并验证
        try {
            const bframe = challenge.frame;
            const responseInput = bframe.locator('#audio-response').first();
            await responseInput.waitFor({ state: 'visible', timeout: 5000 });
            await responseInput.fill(recognized);
            await page.waitForTimeout(300);
            await bframe.locator('#recaptcha-verify-button').first().click({ timeout: 5000 });
            console.log('   >> [reCAPTCHA] 已提交答案，等待验证...');
            await page.waitForTimeout(2500);

            if (await isRecaptchaSolved(page)) {
                console.log('   >> [reCAPTCHA] ✅ 验证通过');
                return true;
            }
            console.warn('   >> [reCAPTCHA] 答案错误，重试...');
        } catch (e) {
            console.warn(`   >> [reCAPTCHA] 提交答案失败: ${e.message}`);
        }
    }
    return false;
}

// 检测页面上是否存在 reCAPTCHA (anchor iframe)
async function hasRecaptcha(page) {
    try {
        for (const frame of page.frames()) {
            if (/recaptcha\/api2\/anchor/i.test(frame.url())) return true;
        }
        // 回退：检测页面 DOM 中是否有 g-recaptcha 容器
        const found = await page.locator('.g-recaptcha, iframe[title*="reCAPTCHA" i]').first().isVisible({ timeout: 1500 }).catch(() => false);
        return !!found;
    } catch (e) {
        return false;
    }
}

// 登录单个账号：返回 true/false
async function loginOnce(page, user) {
    await gotoWithRetry(page, LOGIN_URL);
    await page.waitForTimeout(2000);

    console.log('输入凭据...');
    // Pterodactyl 登录页：用户名/邮箱输入框
    const emailInput = page.locator('input[type="text"], input[placeholder*="email" i], input[name="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(user.username);
    const pwdInput = page.locator('input[type="password"], input[placeholder*="password" i], input[name="password"]').first();
    await pwdInput.fill(user.password);
    await page.waitForTimeout(500);

    console.log('点击 Login...');
    const loginBtn = page.getByRole('button', { name: /log\s?in|sign\s?in/i })
        .or(page.locator('button[type="submit"]'))
        .first();
    await loginBtn.click();

    // 等待离开登录页 = 登录成功；期间检测并处理 reCAPTCHA
    let captchaSolved = false;
    for (let s = 0; s < 30; s++) {
        await page.waitForTimeout(1000);
        if (!/\/auth\/login/i.test(page.url())) return true;
        const err = await page.getByText(/invalid|incorrect|wrong|failed|error|not found/i)
            .first().isVisible().catch(() => false);
        if (err) return false;

        // 检测 reCAPTCHA（Google 图片验证）并尝试音频绕过
        if (!captchaSolved && await hasRecaptcha(page)) {
            console.log('   >> 检测到 reCAPTCHA，启动音频绕过...');
            const ok = await solveRecaptcha(page, 3);
            captchaSolved = true; // 避免重复触发
            if (ok) {
                console.log('   >> reCAPTCHA 已通过，等待登录跳转...');
                // 部分表单可能需要重新点击登录，因为 reCAPTCHA 通过后才会提交 token
                await page.waitForTimeout(1500);
                if (!/\/auth\/login/i.test(page.url())) return true;
                // 仍停留在登录页，尝试再次点击 Login 提交带 token 的表单
                try { await loginBtn.click({ timeout: 5000 }); } catch (e) { }
            } else {
                console.warn('   >> reCAPTCHA 绕过失败');
            }
        }
    }
    return !/\/auth\/login/i.test(page.url());
}

// 尝试点击 +8 Hours 续期按钮，处理可能出现的 Turnstile 验证
async function clickRenewButton(page) {
    // 先检查是否是冷却状态（按钮显示 "XX:XX:XXrenewal cooldown"）
    const cooldownInfo = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
            const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.includes('renewal cooldown')) {
                return { found: true, text };
            }
        }
        return { found: false };
    }).catch(() => ({ found: false }));
    if (cooldownInfo.found) {
        console.log(`   >> ⏳ 冷却中: ${cooldownInfo.text}`);
        return { status: 'cooldown', cooldown: cooldownInfo.text };
    }

    // 查找 +8 Hours 续期按钮
    const renewBtn = page.locator('button').filter({ hasText: /\+8 hours/i }).first();
    try {
        await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
    } catch (e) {
        console.log('   >> 未找到续期按钮');
        return { status: 'no_button' };
    }

    const disabled = await renewBtn.isDisabled().catch(() => false);
    if (disabled) {
        console.log('   >> ⏳ +8 Hours 按钮禁用');
        return { status: 'disabled' };
    }

    console.log('   >> 点击 +8 Hours 续期...');
    try { await renewBtn.click({ timeout: 8000 }); } catch (e) { await renewBtn.click({ force: true }); }
    await page.waitForTimeout(2000);

    // 检测是否弹出 Turnstile 安全验证
    let turnstileAttempts = 0;
    while (turnstileAttempts < 15) {
        const hasTurnstile = await page.locator('text=Complete security check').first().isVisible().catch(() => false);
        if (hasTurnstile) {
            console.log('   >> 检测到 Turnstile 安全验证，尝试自动通过...');
            const clicked = await attemptTurnstileCdp(page);
            if (clicked) {
                console.log('   >> Turnstile 点击完成，等待验证结果...');
                await page.waitForTimeout(3000);
                // 检查是否还有 Turnstile
                const stillThere = await page.locator('text=Complete security check').first().isVisible().catch(() => false);
                if (!stillThere) break;
            }
            // 如果第一次没点到或还有，尝试定位到 Cancel 按钮，或者尝试不同的 iframe
            // 尝试直接点击 iframe 中的 checkbox
            const frames = page.frames();
            for (const f of frames) {
                try {
                    const cb = await f.locator('input[type="checkbox"]').isVisible().catch(() => false);
                    if (cb) {
                        await f.locator('input[type="checkbox"]').click({ force: true });
                        console.log('   >> 直接点击了 Turnstile checkbox');
                        await page.waitForTimeout(3000);
                        break;
                    }
                } catch (e) { }
            }
        } else {
            // Turnstile 可能已通过或未出现
            break;
        }
        turnstileAttempts++;
        await page.waitForTimeout(1000);
    }

    await page.waitForTimeout(3000);

    // 获取续期后的到期时间 (仅用于日志)
    const expiryText = await page.evaluate(() => {
        const allEls = document.querySelectorAll('div, span, p, section');
        for (const el of allEls) {
            const text = (el.textContent || '').trim();
            if (/^\d{1,2}:\d{2}:\d{2}$/.test(text) && !text.includes('renewal')) return text;
        }
        for (const el of allEls) {
            const text = (el.textContent || '').trim();
            if (text === 'Time remaining' && el.nextElementSibling) {
                const val = (el.nextElementSibling.textContent || '').trim();
                if (/^\d{1,2}:\d{2}:\d{2}$/.test(val)) return val;
            }
        }
        return '';
    }).catch(() => '');
    if (expiryText) console.log(`   >> 续期后到期: ${expiryText}`);

    return { status: 'clicked' };
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 FREEGAMEHOST_USERS_JSON 中找到用户');
        process.exit(1);
    }

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    // 先解析全局代理是否可用（用于没有 V2 链接的用户）
    if (PROXY_CONFIG) {
        const ok = await checkProxy();
        if (!ok) {
            console.error('[代理] 全局代理无效，降级直连。');
            PROXY_CONFIG = null;
            process.env.HTTP_PROXY = '';
        }
    }

    let lastProxyConfig = undefined;

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        // 解析该用户的代理（支持独立 V2 链接）
        let { config: proxyConfig, label: proxyLabel } = await resolveUserProxy(user);
        console.log(`   >> 使用代理: ${proxyLabel}`);

        // 代理配置变化时重启 Chrome
        let proxyChanged = JSON.stringify(proxyConfig) !== JSON.stringify(lastProxyConfig);
        if (proxyChanged) {
            await stopChrome();
            // per-user V2 代理验证失败时，降级到全局代理/直连，而非跳过用户
            if (proxyConfig) {
                let ok = await checkProxy(proxyConfig);
                if (!ok && (user.V2 || user.v2)) {
                    console.warn('[代理] 用户专属 V2 代理无效，降级到全局代理/直连...');
                    cleanupV2ray(v2rayProcs);
                    ({ config: proxyConfig, label: proxyLabel } = await resolveUserProxy(user, true));
                    console.log(`   >> 降级后使用代理: ${proxyLabel}`);
                    ok = proxyConfig ? await checkProxy(proxyConfig) : true;
                }
                if (!ok) {
                    console.error('[代理] 代理无效，跳过该用户。');
                    await sendTelegramMessage(`❌ *代理无效*\n用户: ${user.username}\n代理: ${proxyLabel}`);
                    continue;
                }
            }
            await launchChrome(proxyConfig);
            lastProxyConfig = proxyConfig;
        }

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
        if (!browser) { console.error('连接失败，跳过该用户。'); continue; }

        const context = browser.contexts()[0];
        let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        page.setDefaultTimeout(60000);

        // 注入 Turnstile Hook 脚本
        await page.addInitScript(INJECTED_SCRIPT);

        if (proxyConfig && proxyConfig.username) {
            await context.setHTTPCredentials({ username: proxyConfig.username, password: proxyConfig.password });
        } else {
            await context.setHTTPCredentials(null);
        }

        const cookieKey = `freegamehost_cookie_${safeUser}`;
        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }
            try { await context.clearCookies(); } catch (e) { }

            // 1. 先注入 KV 里的 cookie，尝试免登录
            const saved = await kvGet(cookieKey);
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    if (cks.length) { await context.addCookies(cks); console.log(`   >> 已注入 KV cookie (${cks.length} 条)`); }
                } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }
            }

            // 2. 用 cookie 直接打开面板，判断 cookie 是否有效
            let loggedIn = false;
            if (saved) {
                await gotoWithRetry(page, 'https://panel.freegamehost.xyz/');
                await page.waitForTimeout(2500);
                loggedIn = !/\/auth\/login/i.test(page.url());
                console.log(`   >> cookie ${loggedIn ? '有效，免登录' : '无效/已过期'} (当前: ${page.url()})`);
            }

            // 3. cookie 失效 → 完整登录 → 存新 cookie
            if (!loggedIn) {
                loggedIn = await loginOnce(page, user);
                if (!loggedIn) {
                    const shot = path.join(photoDir, `freegamehost_${safeUser}_loginfail.png`);
                    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                    console.log(`   >> ❌ 登录失败，停留在: ${page.url()}`);
                    await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n停留在: ${page.url()}`, shot);
                    console.log('用户处理完成');
                    await browser.close();
                    continue;
                }
                console.log(`   >> ✅ 登录成功: ${page.url()}`);
                // 保存新 cookie 到 KV
                try {
                    const cookies = await context.cookies();
                    await kvPut(cookieKey, JSON.stringify(cookies));
                } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }
            }

            if (!user.serverUrl) {
                const shot = path.join(photoDir, `freegamehost_${safeUser}.png`);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`✅ *登录成功*\n用户: ${user.username}\n(未配置 serverUrl，跳过续期)`, shot);
                console.log('用户处理完成');
                await browser.close();
                continue;
            }

            // 打开服务器页并点 +8 Hours 续期
            console.log(`打开续费页: ${user.serverUrl}`);
            await gotoWithRetry(page, user.serverUrl);
            await page.waitForTimeout(3000);

            // 获取续期前的到期时间
            const beforeExpiry = await page.evaluate(() => {
                // 先找匹配 HH:MM:SS 格式的纯时间文本（最精确）
                const allEls = document.querySelectorAll('div, span, p, section');
                for (const el of allEls) {
                    const text = (el.textContent || '').trim();
                    if (/^\d{1,2}:\d{2}:\d{2}$/.test(text) && !text.includes('renewal')) return text;
                }
                // 回退：找 "Time remaining" 的下一个兄弟元素，并验证是时间格式
                for (const el of allEls) {
                    const text = (el.textContent || '').trim();
                    if (text === 'Time remaining' && el.nextElementSibling) {
                        const val = (el.nextElementSibling.textContent || '').trim();
                        if (/^\d{1,2}:\d{2}:\d{2}$/.test(val)) return val;
                    }
                }
                return '';
            }).catch(() => '');
            console.log(`   >> 续期前到期: ${beforeExpiry || '?'}`);

            const result = await clickRenewButton(page);

            const shot = path.join(photoDir, `freegamehost_${safeUser}_renew.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }

            if (result.status === 'no_button') {
                await sendTelegramMessage(`⚠️ *未找到续期按钮*\n用户: ${user.username}\n到期: ${beforeExpiry || '?'}\n详见截图`, shot);
            } else if (result.status === 'cooldown') {
                console.log(`   >> ⏳ 冷却中: ${result.cooldown}`);
                console.log(`   >> 服务器剩余时间: ${beforeExpiry || '?'}`);
                await sendTelegramMessage(
                    `⏳ *冷却中，暂不可续期*\n用户: ${user.username}\n`
                    + `冷却: ${result.cooldown}\n`
                    + `服务器到期: ${beforeExpiry || '?'}`, shot);
            } else if (result.status === 'disabled') {
                console.log('   >> ⏳ +8 Hours 按钮禁用。');
                await sendTelegramMessage(`⏳ *续期按钮禁用*\n用户: ${user.username}\n到期: ${beforeExpiry || '?'}`, shot);
            } else if (result.status === 'clicked') {
                console.log('   >> ✅ 已点击续期。');
                await sendTelegramMessage(
                    `✅ *续期操作已完成*\n用户: ${user.username}\n`
                    + `到期: ${beforeExpiry || '?'}`, shot);
            }
        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shot = path.join(photoDir, `freegamehost_${safeUser}_error.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, shot);
        }
        console.log('用户处理完成');
        await browser.close();
    }

    cleanupV2ray();
    await stopChrome();
    console.log('完成。');
    process.exit(0);
})();