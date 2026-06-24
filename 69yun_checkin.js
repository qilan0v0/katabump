// 69云 (ewirjijiji11.337979.xyz) 每日签到 —— 默认使用 API，失败则浏览器模拟
// 流程: API: POST /auth/login → 获取 cookie → POST /uuid/user/checkin
//       失败: Playwright 浏览器: 打开登录页 → 填邮箱/密码 → 点登录 → 点每日签到
// 账号来源: Secret YUN69_USERS_JSON = [{"username":"xxx@qq.com","password":"xxx"}]
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const BASE_URL = 'https://ewirjijiji11.337979.xyz';
const LOGIN_URL = BASE_URL + '/auth/login';
const LOGIN_URL2 = BASE_URL + '/uuid/auth/login';
const CHECKIN_URL = BASE_URL + '/uuid/user/checkin';
const USER_URL = BASE_URL + '/uuid/user';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || '69Yun';

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

// --- KV Admin Worker：通过 Worker API 存取登录 cookie ---
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

function cookieToHeader(setCookieHeaders) {
    if (!setCookieHeaders) return '';
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    return arr.map(c => c.split(';')[0]).join('; ');
}

// ========== API 签到 (优先用缓存CK，失败再登录) ==========
async function apiCheckin(user) {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    const cookieKey = '69yun_cookie_' + user.username.replace(/[^a-z0-9]/gi, '_');

    // Step 1: 尝试用 KV 缓存的 cookie 直接签到
    const cachedRaw = await kvGet(cookieKey);
    if (cachedRaw) {
        console.log(`[API] 发现缓存的 cookie，尝试直接签到...`);
        try {
            const checkinResp = await axios.post(CHECKIN_URL, null, {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cookie': cachedRaw,
                    'User-Agent': ua,
                    'Referer': USER_URL,
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                },
                timeout: 20000,
            });
            const data = checkinResp.data;
            console.log(`[API] 缓存 cookie 签到响应:`, JSON.stringify(data));
            if (data && data.ret === 1) {
                const ti = data.trafficInfo || {};
                console.log(`[API] ✅ 使用缓存 cookie 签到成功`);
                return {
                    success: true, msg: data.msg, reward: data.traffic || '', cached: true,
                    unUsedTraffic: ti.unUsedTraffic || '',
                    todayUsedTraffic: ti.todayUsedTraffic || '',
                    lastUsedTraffic: ti.lastUsedTraffic || '',
                    unflowtraffic: data.unflowtraffic || '',
                };
            } else if (data && data.msg && data.msg.includes('已签到')) {
                console.log(`[API] 📌 今天已签到: ${data.msg}`);
                return { success: true, msg: data.msg, traffic: data.traffic, cached: true };
            } else {
                console.log(`[API] cookie 已过期 (${data ? data.msg : '无响应'})，重新登录`);
            }
        } catch (e) {
            console.log(`[API] cookie 已失效，重新登录: ${e.message.slice(0, 100)}`);
        }
    }

    // Step 2: 登录获取新 cookie
    console.log(`[API] 正在登录 ${user.username}...`);
    const loginBody = new URLSearchParams();
    loginBody.append('email', user.username);
    loginBody.append('passwd', user.password);
    loginBody.append('remember_me', 'on');
    loginBody.append('code', '');

    let cookieString = '';

    // 先试 /auth/login (返回 307, 带 Set-Cookie)
    console.log(`[API] POST ${LOGIN_URL}`);
    let resp;
    try {
        resp = await axios.post(LOGIN_URL, loginBody.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': ua,
                'Referer': LOGIN_URL2,
                'Accept': 'application/json, text/javascript, */*; q=0.01',
            },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400,
            timeout: 20000,
        });
    } catch (e) {
        if (e.response) resp = e.response;
        else throw e;
    }

    console.log(`[API] 登录响应状态: ${resp.status}`);
    cookieString = cookieToHeader(resp.headers['set-cookie']);

    if (!cookieString) {
        // 兜底：直连 /uuid/auth/login
        console.log('[API] /auth/login 无 Set-Cookie，试 /uuid/auth/login...');
        try {
            resp = await axios.post(LOGIN_URL2, loginBody.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'User-Agent': ua,
                    'Referer': LOGIN_URL2,
                },
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
                timeout: 20000,
            });
            cookieString = cookieToHeader(resp.headers['set-cookie']);
        } catch (e2) {
            cookieString = cookieToHeader(e2.response && e2.response.headers['set-cookie']);
            if (!cookieString) throw new Error(`登录失败：无法获取 cookie - ${e2.message}`);
        }
    }

    if (!cookieString) throw new Error('登录失败：未能获取到 cookie');
    console.log(`[API] 获取到 cookie: ${cookieString.slice(0, 120)}...`);

    // Step 3: 用新 cookie 签到
    console.log('[API] 正在签到...');
    const checkinResp = await axios.post(CHECKIN_URL, null, {
        headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': cookieString,
            'User-Agent': ua,
            'Referer': USER_URL,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
        },
        timeout: 20000,
    });

    console.log(`[API] 签到响应状态: ${checkinResp.status}`);
    const data = checkinResp.data;
    console.log(`[API] 签到结果:`, JSON.stringify(data));

    if (data && data.ret === 1) {
        // 保存 cookie 到 KV
        await kvPut(cookieKey, cookieString);
        const ti = data.trafficInfo || {};
        return {
            success: true,
            msg: data.msg,
            reward: data.traffic || '',
            unUsedTraffic: ti.unUsedTraffic || '',
            todayUsedTraffic: ti.todayUsedTraffic || '',
            lastUsedTraffic: ti.lastUsedTraffic || '',
            unflowtraffic: data.unflowtraffic || '',
        };
    } else {
        throw new Error(data && data.msg ? data.msg : '签到失败');
    }
}

// ========== 浏览器签到 (Playwright) ==========
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
    } catch (e) { }
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
            console.log(`[代理] 连接成功！出口 IP: ${ipResp.data.ip}`);
        } catch (e) {
            console.log('[代理] 连接成功！(出口 IP 获取失败)');
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
    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data_69yun'
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
            await page.goto(url, { waitUntil: 'load', timeout: 30000 });
            return;
        } catch (e) {
            console.warn(`[导航] 打开 ${url} 失败 (第 ${i}/${retries} 次): ${e.message}`);
            if (i === retries) throw e;
            await page.waitForTimeout(3000);
        }
    }
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
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

async function solveAltcha(page, scope) {
    scope = scope || page;
    const checkbox = scope.locator(
        'altcha-widget input[type="checkbox"], input.altcha-checkbox, #altcha_checkbox, input[type="checkbox"]'
    ).first();
    try {
        await checkbox.waitFor({ state: 'visible', timeout: 8000 });
    } catch (e) {
        console.log('   >> 未找到 ALTCHA 复选框');
        return false;
    }
    if (await checkbox.isChecked().catch(() => false)) {
        console.log('   >> ALTCHA 已是勾选状态');
        return true;
    }
    console.log('   >> 找到 ALTCHA 复选框，点击中...');
    try {
        await checkbox.click({ timeout: 5000 });
    } catch (e) {
        try { await checkbox.click({ force: true }); } catch (e2) {
            console.log('   >> 点击 ALTCHA 复选框失败:', e2.message);
            return false;
        }
    }
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(1000);
        const isChecked = await checkbox.isChecked().catch(() => false);
        const verified = await scope.getByText('Verified', { exact: false }).isVisible().catch(() => false);
        let payload = '';
        try { payload = await page.locator('input[name="altcha"]').first().inputValue(); } catch (e) { }
        if (isChecked || verified || (payload && payload.length > 10)) {
            console.log(`   >> ✅ ALTCHA 通过 (checked=${isChecked}, verified=${verified})`);
            return true;
        }
        console.log(`   >> 等待 ALTCHA PoW 计算... (${i + 1}/20)`);
    }
    console.log('   >> ⚠️ ALTCHA 验证超时');
    return false;
}

async function solveCaptcha(page) {
    console.log('   >> 正在处理验证码...');
    for (let i = 0; i < 15; i++) {
        if (await attemptTurnstileCdp(page)) {
            console.log('   >> Turnstile CDP 点击生效，等待校验...');
            for (let s = 0; s < 10; s++) {
                for (const f of page.frames()) {
                    if (f.url().includes('cloudflare')) {
                        const ok = await f.getByText('Success!', { exact: false })
                            .isVisible({ timeout: 500 }).catch(() => false);
                        if (ok) { console.log('   >> ✅ Turnstile 验证成功。'); return true; }
                    }
                }
                await page.waitForTimeout(1000);
            }
            return true;
        }
        await page.waitForTimeout(1000);
    }
    // 尝试 ALTCHA
    if (await solveAltcha(page)) return true;
    console.log('   >> 未检测到可处理的验证码。');
    return false;
}

async function browserCheckin(user) {
    console.log(`[浏览器] 正在通过 Playwright 浏览器签到 ${user.username}...`);

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
    console.log('注入脚本已添加。');

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
    const cookieKey = '69yun_cookie_' + safeUser;

    try {
        if (page.isClosed()) {
            page = await context.newPage();
            await page.addInitScript(INJECTED_SCRIPT);
        }
        try { await context.clearCookies(); } catch (e) { }

        // 尝试用 KV 缓存的 cookie 直接进用户中心
        const cachedRaw = await kvGet(cookieKey);
        let loggedIn = false;

        if (cachedRaw) {
            console.log('[浏览器] 发现缓存的 cookie，尝试注入...');
            try {
                const ckPairs = cachedRaw.split(/;\s*/).map(p => {
                    const eq = p.indexOf('=');
                    return eq > 0 ? { name: p.slice(0, eq), value: p.slice(eq + 1), domain: '.337979.xyz', path: '/' } : null;
                }).filter(Boolean);
                await context.addCookies(ckPairs);
                console.log(`[浏览器] 已注入 ${ckPairs.length} 条 cookie`);

                await gotoWithRetry(page, USER_URL);
                await page.waitForTimeout(3000);

                // 检查是否成功进入用户中心（未跳回登录页）
                if (!page.url().includes('/auth/login')) {
                    console.log('[浏览器] ✅ cookie 有效，跳过登录');
                    loggedIn = true;
                } else {
                    console.log('[浏览器] cookie 已过期，需要重新登录');
                    try { await context.clearCookies(); } catch (e) { }
                }
            } catch (e) {
                console.log('[浏览器] cookie 注入失败，重新登录:', e.message);
                try { await context.clearCookies(); } catch (e2) { }
            }
        }

        if (!loggedIn) {
            // 需要登录
            await gotoWithRetry(page, LOGIN_URL2);
            await page.waitForTimeout(2000);

            console.log('正在输入凭据...');
            await page.fill('#email', user.username);
            await page.fill('#password', user.password);
            await page.waitForTimeout(500);

            // 验证码处理
            await solveCaptcha(page);

            // 点击登录
            console.log('点击登录按钮...');
            const loginBtn = page.locator('button:has-text("登录")').first();
            try {
                await loginBtn.click();
            } catch (e) {
                await page.locator('button[type="submit"]').first().click();
            }

            // 等待登录完成
            for (let s = 0; s < 20; s++) {
                await page.waitForTimeout(1000);
                if (!page.url().includes('/auth/login')) { loggedIn = true; break; }
                const errVisible = await page.getByText(/invalid|incorrect|wrong|failed|error/i)
                    .first().isVisible().catch(() => false);
                if (errVisible) break;
            }

            if (!loggedIn) {
                const shotPath = path.join(photoDir, `69yun_${safeUser}_login_fail.png`);
                try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
                throw new Error('登录失败：凭据或验证码未通过');
            }

            console.log(`登录成功，当前页面: ${page.url()}`);

            // 保存 cookie 到 KV
            try {
                const cookies = await context.cookies();
                const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                await kvPut(cookieKey, cookieStr);
            } catch (e) {
                console.warn('[浏览器] 保存 cookie 失败:', e.message);
            }

            // 如果登录后不在 user 页面，导航过去
            if (!page.url().includes('/uuid/user')) {
                await gotoWithRetry(page, USER_URL);
                await page.waitForTimeout(2000);
            }
        }

        // 点击"每日签到"
        console.log('正在点击每日签到...');
        const checkinLink = page.locator('a:has-text("每日签到")').first();
        await checkinLink.waitFor({ state: 'visible', timeout: 10000 });

        // 监听 checkin 请求的响应
        const responsePromise = page.waitForResponse(
            resp => resp.url().includes('/user/checkin') || resp.url().includes('/uuid/user/checkin'),
            { timeout: 15000 }
        ).catch(() => null);

        await checkinLink.click();

        let checkinResult = null;
        if (responsePromise) {
            try {
                const resp = await responsePromise;
                if (resp.url().includes('/uuid/user/checkin') || resp.status() === 200) {
                    const body = await resp.json().catch(() => null);
                    if (body) checkinResult = body;
                }
            } catch (e) { }
        }

        // 等待一下让页面更新
        await page.waitForTimeout(3000);

        // 如果没从响应中拿到结果，检查页面上的提示
        if (!checkinResult) {
            const pageText = await page.locator('body').innerText().catch(() => '');
            const msgMatch = pageText.match(/(获得[\d.]+[GMK]B?流量|已签到|签到成功)/i);
            if (msgMatch) {
                checkinResult = { ret: 1, msg: msgMatch[0] };
            }
        }

        const shotPath = path.join(photoDir, `69yun_${safeUser}.png`);
        try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }

        if (checkinResult && checkinResult.ret === 1) {
            console.log(`[浏览器] ✅ 签到成功: ${checkinResult.msg}`);
            const ti = checkinResult.trafficInfo || {};
            const trafficLine = ti.unUsedTraffic
                ? `\n剩余流量: ${ti.unUsedTraffic} | 今日已用: ${ti.todayUsedTraffic || '0B'}`
                : checkinResult.traffic ? `\n获得流量: ${checkinResult.traffic}` : '';
            await sendTelegramMessage(
                `✅ *69云签到成功 (浏览器)*\n用户: ${user.username}${trafficLine}\n${checkinResult.msg}`,
                shotPath
            );
            return { success: true, msg: checkinResult.msg };
        } else {
            throw new Error(checkinResult ? checkinResult.msg : '签到失败（未获取到结果）');
        }

    } catch (err) {
        console.error('[浏览器] 签到出错:', err.message);
        const shotPath = path.join(photoDir, `69yun_${safeUser}_error.png`);
        try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
        await sendTelegramMessage(`❌ *69云签到失败*\n用户: ${user.username}\n错误: ${err.message}`, shotPath);
        throw err;
    } finally {
        try { await browser.close(); } catch (e) { }
    }
}

// ========== 主流程 ==========
(async () => {
    let users = [];
    try {
        if (process.env['YUN69_USERS_JSON']) {
            const parsed = JSON.parse(process.env['YUN69_USERS_JSON']);
            users = Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 YUN69_USERS_JSON 环境变量错误:', e);
    }

    // 也支持直接通过环境变量传入单个账号
    if (users.length === 0 && process.env['YUN69_USER'] && process.env['YUN69_PASS']) {
        users = [{ username: process.env['YUN69_USER'], password: process.env['YUN69_PASS'] }];
    }

    if (users.length === 0) {
        console.log('未在 YUN69_USERS_JSON 或 YUN69_USER/YUN69_PASS 中找到用户');
        process.exit(1);
    }

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length}: ${user.username} ===`);

        // 1. 先用 API 签到
        let apiSuccess = false;
        try {
            const result = await apiCheckin(user);
            const mode = result.cached ? ' (缓存CK)' : '';
            const trafficLine = result.unUsedTraffic
                ? `\n剩余流量: ${result.unUsedTraffic} | 今日已用: ${result.todayUsedTraffic || '0B'}`
                : result.reward ? `\n获得流量: ${result.reward}` : '';
            console.log(`✅ API 签到成功${mode}: ${result.msg}`);
            await sendTelegramMessage(
                `✅ *69云签到成功 (API${mode})*\n用户: ${user.username}${trafficLine}\n${result.msg}`
            );
            apiSuccess = true;
        } catch (apiErr) {
            console.warn(`⚠️ API 签到失败: ${apiErr.message}`);
            console.log('将尝试使用浏览器模拟签到...');
        }

        // 2. API 失败则用浏览器
        if (!apiSuccess) {
            try {
                await browserCheckin(user);
            } catch (browserErr) {
                console.error(`❌ 浏览器签到也失败: ${browserErr.message}`);
                if (i < users.length - 1) {
                    console.log('继续处理下一个用户...');
                }
            }
        }
    }

    console.log('\n全部完成。');
    process.exit(0);
})();
