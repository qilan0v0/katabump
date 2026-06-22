// Searcade (searcade.com) 登录保活脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 打开首页 → 点右上角 Login → 跳到 userveria OAuth → 输邮箱点 "Continue with email"
//       → 输密码点 "Log in" → 跳回 searcade 显示 "Successfully signed in as ..."
// 账号来源: Secret SEARCADE_USERS_JSON = [{"username":"a@b.com","password":"pwd"}, ...]
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const HOME_URL = 'https://searcade.com/en/';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID; // 可选：超级群话题(Topic)的 message_thread_id
const PROJECT = process.env.PROJECT_NAME || 'Searcade';
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

function normalizeCookies(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function(c) {
        var out = { name: c.name, value: String(c.value != null ? c.value : '') };
        if (c.domain) out.domain = c.domain;
        out.path = c.path || '/';
        if (c.httpOnly) out.httpOnly = true;
        if (c.secure) out.secure = true;
        if (c.sameSite) out.sameSite = c.sameSite;
        if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
        else if (typeof c.expirationDate === 'number' && c.expirationDate > 0) out.expires = c.expirationDate;
        return out;
    });
}

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

function getUsers() {
    try {
        if (process.env.SEARCADE_USERS_JSON) {
            const parsed = JSON.parse(process.env.SEARCADE_USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 SEARCADE_USERS_JSON 环境变量错误:', e);
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

// 登录单个账号：返回 { ok, info }
async function loginOnce(page, user) {
    await gotoWithRetry(page, HOME_URL);
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (e) { }
    await page.waitForTimeout(1500);

    // 关掉可能的 cookie / 弹窗，避免遮挡
    for (const t of [/accept/i, /got it/i, /agree/i, /i understand/i, /close/i]) {
        const b = page.getByRole('button', { name: t }).first();
        if (await b.isVisible().catch(() => false)) { try { await b.click(); } catch (e) { } }
    }

    // 1. 进入登录：优先按 href 找登录链接 (含 login/account/auth) 直接导航；否则点文本/图标
    console.log('进入 Login...');
    let entered = false;
    const hrefLink = page.locator('a[href*="login" i], a[href*="account" i], a[href*="userveria" i], a[href*="/auth" i]').first();
    if (await hrefLink.count().catch(() => 0)) {
        const href = await hrefLink.getAttribute('href').catch(() => null);
        if (href) {
            const full = new URL(href, page.url()).href;
            console.log(`   >> 通过 href 进入登录: ${full}`);
            await gotoWithRetry(page, full);
            entered = true;
        }
    }
    if (!entered) {
        const loginEntry = page.getByRole('link', { name: /log\s?in/i })
            .or(page.getByRole('button', { name: /log\s?in/i }))
            .or(page.locator('a,button,[role="button"]').filter({ hasText: /log\s?in/i }))
            .first();
        try {
            await loginEntry.waitFor({ state: 'visible', timeout: 10000 });
            await loginEntry.click();
        } catch (e) {
            console.log('   >> 未找到 Login 入口，直接尝试已知登录路径...');
            await gotoWithRetry(page, 'https://searcade.com/accounts/userveria/login/');
        }
    }

    // 等待跳转到 userveria 授权页
    try { await page.waitForURL(/userveria\.com/i, { timeout: 20000 }); } catch (e) {
        console.log('   >> 未跳到 userveria，当前 URL:', page.url());
    }
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (e) { }
    await page.waitForTimeout(1500);

    // 2. 输入邮箱 → "Continue with email"
    console.log('输入邮箱...');
    const emailInput = page.locator('input[type="email"], input[name="email"], #email').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(user.username);
    await page.waitForTimeout(300);
    const continueBtn = page.getByRole('button', { name: /continue with email|continue/i })
        .or(page.locator('button[type="submit"]'))
        .first();
    await continueBtn.click();

    // 3. 输入密码 → "Log in"
    console.log('输入密码...');
    const pwdInput = page.locator('input[type="password"], input[name="password"], #password').first();
    await pwdInput.waitFor({ state: 'visible', timeout: 15000 });
    await pwdInput.fill(user.password);
    await page.waitForTimeout(300);
    const submitBtn = page.getByRole('button', { name: /^log\s?in$/i })
        .or(page.locator('button[type="submit"]'))
        .first();
    await submitBtn.click();

    // 4. 等待跳回 searcade 并确认登录成功
    try { await page.waitForURL(/searcade\.com/i, { timeout: 25000 }); } catch (e) { }
    let info = '';
    for (let s = 0; s < 15; s++) {
        await page.waitForTimeout(1000);
        const body = await page.locator('body').innerText().catch(() => '');
        const m = body.match(/Successfully signed in[^\n]*/i);
        if (m) { info = m[0].trim(); return { ok: true, info }; }
        // 登出/账户菜单出现也算成功
        const loggedOut = await page.getByText(/logout|log out|admin area/i).first().isVisible().catch(() => false);
        if (loggedOut && page.url().includes('searcade.com')) return { ok: true, info: '已登录 (检测到 Logout/Admin area)' };
        // 凭据错误
        const err = await page.getByText(/invalid|incorrect|wrong password|not found|error/i).first().isVisible().catch(() => false);
        if (err) {
            const eb = await page.getByText(/invalid|incorrect|wrong password|not found|error/i).first().innerText().catch(() => '');
            return { ok: false, info: eb.trim() || '登录出错' };
        }
    }
    // 跳回 searcade 但没抓到提示，也按 URL 粗判
    if (page.url().includes('searcade.com') && !page.url().includes('userveria')) {
        return { ok: true, info: '已跳回 searcade (未捕捉到提示)' };
    }
    return { ok: false, info: `未确认登录，停留在 ${page.url()}` };
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 SEARCADE_USERS_JSON 中找到用户');
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

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    // 检查服务器状态并保活
    async function keepServerAlive(serverUrl) {
        const sid = (serverUrl.match(/\/servers\/(\d+)/) || [])[1] || 'srv';
        console.log(`   >> 检查服务器 ${sid} 状态...`);
        await gotoWithRetry(page, serverUrl);
        await page.waitForTimeout(3000);

        // 读取状态文字
        let statusText = '';
        for (let w = 0; w < 10; w++) {
            statusText = await page.locator('.status.badge').first().innerText().catch(() => '');
            if (statusText) break;
            await page.waitForTimeout(1500);
        }
        console.log(`   >> [${sid}] 状态: ${statusText || '未知'}`);

        // 状态不是 Online → 点击 Start
        if (statusText && !/online/i.test(statusText)) {
            console.log(`   >> [${sid}] 服务器未运行 (${statusText})，尝试启动...`);
            const startBtn = page.locator('button[data-state="start"]');
            if (await startBtn.isVisible().catch(() => false)) {
                await startBtn.click();
                await page.waitForTimeout(3000);
                console.log(`   >> [${sid}] 已点击 Start，等待启动...`);
                // 等几秒检查状态是否变成 Online
                for (let w = 0; w < 12; w++) {
                    await page.waitForTimeout(5000);
                    const newStatus = await page.locator('.status.badge').first().innerText().catch(() => '');
                    if (/online/i.test(newStatus)) {
                        console.log(`   >> [${sid}] ✅ 启动成功，状态: ${newStatus}`);
                        return { ok: true, action: 'started', status: newStatus };
                    }
                    console.log(`   >> [${sid}] 等待启动中... (${newStatus || '无响应'})`);
                }
                return { ok: false, action: 'start_timeout', status: statusText };
            } else {
                console.log(`   >> [${sid}] 未找到 Start 按钮，跳过`);
                return { ok: false, action: 'no_start_btn', status: statusText };
            }
        }
        return { ok: true, action: 'already_running', status: statusText || 'Online' };
    }

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) page = await context.newPage();
            try { await context.clearCookies(); } catch (e) { }

            // 尝试从 KV 读取已存 cookie
            const cookieKey = 'searcade_cookie_' + user.username.replace(/[^a-z0-9]/gi, '_');
            const saved = await kvGet(cookieKey);
            let loggedIn = false;
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    await context.addCookies(cks);
                    console.log('   >> 已注入 KV cookie (' + cks.length + ' 条)');
                    await gotoWithRetry(page, 'https://searcade.com/en/');
                    await page.waitForTimeout(3000);
                    const body = await page.locator('body').innerText().catch(() => '');
                    if (body.includes('logout') || body.includes('Logout') || body.includes('admin')) {
                        console.log('   >> cookie 有效，跳过登录');
                        loggedIn = true;
                    } else {
                        console.log('   >> cookie 无效/已过期，重新登录');
                    }
                } catch (e) {
                    console.log('   >> cookie 解析失败，重新登录');
                }
            }

            if (!loggedIn) {
                const res = await loginOnce(page, user);
                const shotPath = path.join(photoDir, `searcade_${safeUser}.png`);
                try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }

                if (res.ok) {
                    console.log(`   >> ✅ 登录成功: ${res.info}`);
                    // 保存 cookie 到 KV
                    try { const cookies = await context.cookies(); await kvPut(cookieKey, JSON.stringify(cookies)); } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }
                    await sendTelegramMessage(`✅ *登录成功*\n用户: ${user.username}\n${res.info}`, shotPath);
                    loggedIn = true;
                } else {
                    console.log(`   >> ❌ 登录失败: ${res.info}`);
                    await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: ${res.info}`, shotPath);
                }
            }

            // 登录成功后检查并保活服务器
            if (loggedIn) {
                // 获取用户的服务器列表：优先 user.serverUrls 数组，回退 user.serverUrl，再回退带 ServerUrls 的 env
                let serverUrls = user.serverUrls || [];
                if (serverUrls.length === 0 && user.serverUrl) {
                    serverUrls = [user.serverUrl];
                }
                // 如果用户 JSON 中没有配置 serverUrls，尝试从环境变量 SEARCADE_SERVER_URLS 读取（逗号分隔）
                if (serverUrls.length === 0 && process.env.SEARCADE_SERVER_URLS) {
                    serverUrls = process.env.SEARCADE_SERVER_URLS.split(',').map(s => s.trim()).filter(Boolean);
                }

                if (serverUrls.length > 0) {
                    console.log(`   >> 开始保活检查 (${serverUrls.length} 个服务器)...`);
                    const results = [];
                    for (const su of serverUrls) {
                        try {
                            const r = await keepServerAlive(su);
                            results.push(r);
                            await page.waitForTimeout(1000);
                        } catch (e) {
                            console.error(`   >> 检查服务器 ${su} 出错:`, e.message);
                            results.push({ ok: false, action: 'error', status: e.message });
                        }
                    }

                    // 汇总通知
                    const successCount = results.filter(r => r.ok).length;
                    const failCount = results.filter(r => !r.ok).length;
                    const sid = (su => (su.match(/\/servers\/(\d+)/) || [])[1] || '?')(serverUrls[0]);
                    if (failCount === 0 && successCount > 0) {
                        await sendTelegramMessage(`✅ *保活完成*\n用户: ${user.username}\n${successCount} 个服务器正常运行`);
                    } else if (failCount > 0) {
                        const details = results.map((r, idx) => {
                            const sid = (serverUrls[idx].match(/\/servers\/(\d+)/) || [])[1] || '?';
                            return `  ${sid}: ${r.action === 'already_running' ? '✅ 运行中' : r.action === 'started' ? '✅ 已启动' : '❌ ' + (r.action || r.status)}`;
                        }).join('\n');
                        await sendTelegramMessage(`⚠️ *保活结果*\n用户: ${user.username}\n${details}`);
                    }
                } else {
                    console.log('   >> 未配置服务器 URL，跳过保活检查（可在用户 JSON 中添加 serverUrl 或设置 SEARCADE_SERVER_URLS 环境变量）');
                }
            }
        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shotPath = path.join(photoDir, `searcade_${safeUser}_error.png`);
            try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *登录异常*\n用户: ${user.username}\n错误: ${err.message}`, shotPath);
        }
        console.log('用户处理完成');
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
