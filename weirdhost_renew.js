// Weirdhost (hub.weirdhost.xyz) 续期保活脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 打开 /account → 过 Cloudflare 全屏验证 → 填邮箱/密码 + 勾选同意框 → 点 "로그인"
//       → 登录成功后打开 serverUrl(Pterodactyl 服务器页) → 点 "연장하기" 续期
// 账号来源: Secret WEIRDHOST_USERS_JSON =
//   [{"username":"a@b.com","password":"pwd","serverUrl":"https://hub.weirdhost.xyz/server/xxxxxxx"}]
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const ACCOUNT_URL = 'https://hub.weirdhost.xyz/account';
const DASHBOARD_URL = 'https://hub.weirdhost.xyz/';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'Weirdhost';

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
// 续期窗口按浏览器本地时区计算：runner 默认 UTC 会判定"未到时间"，强制用中国时区(UTC+8)
const TIMEZONE = process.env.WEIRDHOST_TZ || 'Asia/Shanghai';
process.env.TZ = TIMEZONE;

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

// --- Cloudflare KV：存取登录 cookie，避免每次都登录(weirdhost 登录后长期有效) ---
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const KV_ENABLED = !!(CF_ACCOUNT_ID && CF_KV_NAMESPACE_ID && CF_API_TOKEN);

function kvUrl(key) {
    return `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`
        + `/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
}
// 直连 (proxy:false)，不走 v2ray，避免被节点干扰
async function kvGet(key) {
    if (!KV_ENABLED) return null;
    try {
        const r = await axios.get(kvUrl(key), {
            headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
            timeout: 15000, proxy: false, transformResponse: [(d) => d]
        });
        return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    } catch (e) {
        if (e.response && e.response.status === 404) { console.log('[KV] 暂无已存 cookie'); return null; }
        console.warn('[KV] 读取失败:', e.message);
        return null;
    }
}
async function kvPut(key, value) {
    if (!KV_ENABLED) return false;
    try {
        await axios.put(kvUrl(key), value, {
            headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' },
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

    // 最多尝试启动 2 次，捕获 stderr 以便诊断
    for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`正在启动 Chrome (路径: ${CHROME_PATH}, 第 ${attempt} 次)...`);
        let stderr = '';
        const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TZ: TIMEZONE } });
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
        if (process.env.WEIRDHOST_USERS_JSON) {
            const parsed = JSON.parse(process.env.WEIRDHOST_USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 WEIRDHOST_USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function gotoWithRetry(page, url, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            // 用 domcontentloaded 而非 load：有广告/长连接的页面 load 事件可能永不触发导致卡死
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            return;
        } catch (e) {
            console.warn(`[导航] 打开 ${url} 失败 (第 ${i}/${retries} 次): ${e.message}`);
            if (i === retries) throw e;
            await page.waitForTimeout(3000);
        }
    }
}

// 给任意 promise 套超时(模块级复用)
function _race(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), ms))]);
}

// Cloudflare Turnstile (iframe 内复选框) 的 CDP 点击绕过
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        // 跳过实时终端等无关 frame，且 evaluate 套超时，避免在挂死的 frame(如 xterm 控制台)上卡住
        const fu = (frame.url() || '');
        if (fu && !/cloudflare|turnstile|challenges|hcaptcha|^about:|^$/i.test(fu)) {
            // 只在主文档和 CF 相关 frame 上找 __turnstile_data
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
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

// 通过 Cloudflare 全屏验证：循环点击 Turnstile，直到目标元素 (readyLocator) 出现
async function passCloudflare(page, readyLocator, label) {
    const ready = async () => await _race(readyLocator().isVisible(), 5000).catch(() => false);
    for (let i = 0; i < 20; i++) {
        if (await ready()) {
            if (i > 0) console.log(`   >> 已通过 Cloudflare (${label})`);
            return true;
        }
        await _race(attemptTurnstileCdp(page), 10000).catch(() => false);
        await page.waitForTimeout(2000);
    }
    return await ready();
}

// 登录单个账号
async function loginOnce(page, user) {
    await gotoWithRetry(page, ACCOUNT_URL);
    await page.waitForTimeout(3000);

    // 1. 过 Cloudflare 全屏验证，直到登录表单 (密码框) 出现
    console.log('过 Cloudflare 验证 + 等待登录表单...');
    const pwdLoc = () => page.locator('input[type="password"]').first();
    const ready = await passCloudflare(page, pwdLoc, '登录表单');
    if (!ready) throw new Error('未通过 Cloudflare 或登录表单未出现');

    // 2. 填邮箱 / 密码
    console.log('输入凭据...');
    const emailInput = page.locator('input[type="email"], input[name="email"], input[type="text"]').first();
    await emailInput.fill(user.username);
    await page.locator('input[type="password"]').first().fill(user.password);
    await page.waitForTimeout(300);

    // 3. 勾选同意复选框 (만14세 이상 및 개인정보처리방침... 동의)
    const agree = page.locator('input[type="checkbox"]').first();
    if (await agree.isVisible().catch(() => false)) {
        if (!await agree.isChecked().catch(() => false)) {
            try { await agree.check(); } catch (e) { try { await agree.click({ force: true }); } catch (e2) { } }
        }
        console.log('   >> 已勾选同意复选框');
    }

    // 4. 点登录按钮 "로그인"
    console.log('点击 로그인...');
    const loginBtn = page.getByRole('button', { name: /로그인/ })
        .or(page.locator('button:has-text("로그인")'))
        .first();
    await loginBtn.click();

    // 5. 等待登录成功 (离开 /auth/login)
    for (let s = 0; s < 20; s++) {
        await page.waitForTimeout(1000);
        if (!/\/auth\/login/i.test(page.url()) && !/login/i.test(page.url())) return true;
        const err = await page.getByText(/invalid|incorrect|wrong|틀렸|오류|실패|error/i).first().isVisible().catch(() => false);
        if (err) return false;
    }
    return !/\/auth\/login/i.test(page.url());
}

// 给 promise 套整体超时，避免单台卡住拖垮整个流程
function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// 一次性快照读续期框状态(用 evaluate，不走会自动重试的 locator —— 实时刷新页上 locator 会重试到 60s 超时)
// 返回 { found, expiry, status, disabled }
async function readRenewBox(page) {
    return await _race(page.evaluate(() => {
        // 兼容两种组件：RenewBox__ (不带2) 和 RenewBox2__
        const btn = document.querySelector('button[class*="RenewButton"]')
            || Array.from(document.querySelectorAll('button')).find(b => /연장하기/.test(b.textContent || ''));
        const box = btn ? (btn.closest('[class*="RenewContainer"]') || btn.parentElement) : null;
        const exp = box && box.querySelector('[class*="ExpiryText"]');
        const st = box && box.querySelector('[class*="StatusText"]');
        return {
            found: !!btn,
            disabled: btn ? btn.disabled : true,
            expiry: exp ? (exp.textContent || '').trim() : '',
            status: st ? (st.textContent || '').trim() : ''
        };
    }), 8000).catch(() => ({ found: false, disabled: true, expiry: '', status: '' }));
}

// 续期单个服务器，返回 { status: 'success'|'wait'|'unknown'|'error', message, shot }
async function renewServer(page, user, serverUrl, photoDir) {
    const renewLoc = () => page.locator('button:has-text("연장하기"), button[class*="RenewButton"]').first();
    const sid = (serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || 'srv';
    const shot = path.join(photoDir, `weirdhost_${user.username.replace(/[^a-z0-9]/gi, '_')}_${sid}.png`);
    const dtOf = (s) => (s.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/) || [])[0] || '';

    console.log(`打开续费页: ${serverUrl}`);
    await gotoWithRetry(page, serverUrl);
    await page.waitForTimeout(2000);

    // 轮询快照，等续期框出现并刷新到真实状态(可点)，最多 ~30 秒；中途 reload 一次强制刷新续期状态
    let snap = { found: false, disabled: true, expiry: '', status: '' };
    let reloads = 0;
    for (let w = 0; w < 20; w++) {
        snap = await readRenewBox(page);
        // 可续(按钮启用 或 状态显示"지금/가능") → 立即结束等待
        if (snap.found && (!snap.disabled || /지금|가능/.test(snap.status))) break;

        // 页面报 "Something went wrong / could not be found"(SPA 路由偶发) → reload 重试
        const errPage = await _race(page.evaluate(() =>
            /something went wrong|could not be found|찾을 수 없습니다/i.test(document.body ? document.body.innerText : '')
        ), 5000).catch(() => false);
        if (errPage && reloads < 2) {
            reloads++;
            console.log(`   >> [${sid}] 页面报错(资源未找到)，reload 重试 ${reloads}/2...`);
            await gotoWithRetry(page, serverUrl);
            await page.waitForTimeout(2500);
            continue;
        }

        // 续期框找到但禁用：到点冷却结束(8시간 후에...)，确认几轮即可，无需久等
        if (snap.found && w >= 3) break;

        // 没找到可能是 CF 拦截，点一下(套超时，绝不卡死)
        if (!snap.found) await _race(attemptTurnstileCdp(page), 8000).catch(() => false);
        await page.waitForTimeout(1500);
    }
    console.log(`   >> [${sid}] 快照: found=${snap.found} disabled=${snap.disabled} status="${snap.status}"`);

    if (!snap.found) {
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
        return { status: 'error', message: '未找到续期按钮(可能页面报错/资源未找到，详见截图)', shot };
    }

    const expiryDt = dtOf(snap.expiry);
    const expiryLine = expiryDt ? `\n到期: ${expiryDt}` : '';
    const renewable = !snap.disabled || /지금|가능/.test(snap.status);

    if (!renewable) {
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
        console.log(`   >> [${sid}] ⏳ 暂不可续期。${snap.status}`);
        return { status: 'wait', message: `还没到时间${snap.status ? '\n' + snap.status : ''}${expiryLine}`, shot };
    }

    console.log(`   >> [${sid}] 点击 연장하기 续期...`);
    try { await _race(renewLoc().click({ force: true }), 10000); }
    catch (e) { console.log('   >> 点击续期失败:', e.message); }
    await page.waitForTimeout(3000);

    const after = await readRenewBox(page);
    const newExpiry = dtOf(after.expiry) || expiryDt;
    const newExpiryLine = newExpiry ? `\n到期: ${newExpiry}` : expiryLine;
    const ok = after.disabled || (newExpiry && newExpiry !== expiryDt); // 点完变禁用 或 到期时间变了 = 成功
    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
    if (ok) {
        console.log(`   >> [${sid}] ✅ 续期成功。到期: ${newExpiry}`);
        return { status: 'success', message: `服务器已续期！${newExpiryLine}`, shot };
    }
    console.log(`   >> [${sid}] ⚠️ 已点击续期，结果未知。`);
    return { status: 'unknown', message: `已点击 연장하기，详见截图${newExpiryLine}`, shot };
}

// 从面板首页抓取所有服务器的 URL
async function discoverServers(page) {
    let urls = await page.locator('a[href*="/server/"]').evaluateAll(
        els => Array.from(new Set(els.map(e => e.href)))
    ).catch(() => []);
    urls = (urls || []).filter(u => /\/server\/[^/?#]+/i.test(u));
    return Array.from(new Set(urls));
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 WEIRDHOST_USERS_JSON 中找到用户');
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

    // 通过 CDP 强制浏览器时区为中国(双保险，确保续期窗口按 UTC+8 计算)
    const applyTimezone = async (p) => {
        try {
            const cdp = await context.newCDPSession(p);
            await cdp.send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE });
            await cdp.detach();
        } catch (e) { console.warn('[时区] 设置失败:', e.message); }
    };
    await applyTimezone(page);
    console.log(`[时区] 已设置为 ${TIMEZONE}`);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        const cookieKey = `weirdhost_cookie_${safeUser}`;
        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
                await applyTimezone(page);
            }
            try { await context.clearCookies(); } catch (e) { }

            // 目标服务器：优先 serverUrls(数组) / serverUrl(单个)，都没有则登录后自动发现
            // 只保留含 /server/ 的有效 URL，过滤空串/脏数据，避免卡死
            const validUrl = (u) => typeof u === 'string' && /\/server\/[^/?#]+/i.test(u.trim());
            let targets = Array.isArray(user.serverUrls)
                ? user.serverUrls.map(u => (u || '').trim()).filter(validUrl)
                : (validUrl(user.serverUrl) ? [user.serverUrl.trim()] : null);
            const renewLoc = () => page.locator('button:has-text("연장하기"), button[class*="RenewButton"]').first();

            // 1. 注入 KV cookie 尝试免登录
            const saved = await kvGet(cookieKey);
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    if (cks.length) { await context.addCookies(cks); console.log(`   >> 已注入 KV cookie (${cks.length} 条)`); }
                } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }
            }

            // 2. 打开首页(或首个目标)，过 CF，判断是否已登录
            const firstNav = targets && targets[0] ? targets[0] : DASHBOARD_URL;
            console.log(`打开: ${firstNav}`);
            await gotoWithRetry(page, firstNav);
            await page.waitForTimeout(2000);
            const contentReady = () => page.locator('a[href*="/server/"], button:has-text("연장하기"), button[class*="RenewButton"], input[type="password"]').first();
            await passCloudflare(page, contentReady, '页面');

            const pwdVisible = await _race(page.locator('input[type="password"]').first().isVisible(), 5000).catch(() => false);
            let loggedIn = !/\/auth\/login/i.test(page.url()) && !pwdVisible;

            // 3. cookie 失效 → 完整登录 → 存新 cookie
            if (!loggedIn) {
                console.log('   >> cookie 无效/缺失，执行完整登录...');
                loggedIn = await loginOnce(page, user);
                if (!loggedIn) {
                    const shot = path.join(photoDir, `weirdhost_${safeUser}_loginfail.png`);
                    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                    console.log(`   >> ❌ 登录失败，停留在: ${page.url()}`);
                    await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n停留在: ${page.url()}\n` +
                        (KV_ENABLED ? '⚠️ 可能遇到 reCAPTCHA。请手动登录后更新 KV 中的 cookie。' : '⚠️ 未配置 CF KV，每次都需登录。'), shot);
                    console.log('用户处理完成');
                    continue;
                }
                try {
                    const cookies = await context.cookies();
                    await kvPut(cookieKey, JSON.stringify(cookies));
                } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }
            } else {
                console.log('   >> ✅ cookie 有效，免登录');
            }

            // 4. 没配置目标 → 从面板首页自动发现所有服务器
            if (!targets) {
                await gotoWithRetry(page, DASHBOARD_URL);
                await page.waitForTimeout(2000);
                await passCloudflare(page, () => page.locator('a[href*="/server/"], [class*="ServerRow"]').first(), '面板');
                targets = await discoverServers(page);
                console.log(`   >> 自动发现 ${targets.length} 个服务器: ${targets.join(', ')}`);
            }
            if (!targets.length) {
                await sendTelegramMessage(`⚠️ *无服务器*\n用户: ${user.username}\n未发现可续期的服务器，请确认账号下有服务器或手动配置 serverUrls`);
                console.log('用户处理完成');
                continue;
            }

            // 5. 逐个服务器续期，各自发通知
            for (const serverUrl of targets) {
                try {
                    const r = await withTimeout(renewServer(page, user, serverUrl, photoDir), 120000, `续期 ${serverUrl}`);
                    const sid = (serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || serverUrl;
                    const head = { success: '✅ *续期成功*', wait: '⏳ *暂不可续期*', unknown: '⚠️ *续期结果未知*', error: '❌ *续期出错*' }[r.status] || '❓';
                    await sendTelegramMessage(`${head}\n用户: ${user.username}\n服务器: ${sid}\n${r.message}`, r.shot);
                } catch (e) {
                    console.error(`服务器 ${serverUrl} 续期出错:`, e.message);
                    const sid = (serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || 'srv';
                    const errShot = path.join(photoDir, `weirdhost_${safeUser}_${sid}_timeout.png`);
                    try { await page.screenshot({ path: errShot, fullPage: true }); } catch (e2) { }
                    await sendTelegramMessage(`❌ *续期出错*\n用户: ${user.username}\n服务器: ${sid}\n错误: ${e.message}`,
                        fs.existsSync(errShot) ? errShot : null);
                }
            }
        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shot = path.join(photoDir, `weirdhost_${safeUser}_error.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, shot);
        }
        console.log('用户处理完成');
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
