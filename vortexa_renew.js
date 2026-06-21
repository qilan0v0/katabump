// Vortexa (www.vortexa.cloud) 保活启动脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 打开登录页 → 输邮箱密码点 Sign In → 登录成功
//       → 打开配置的 serverUrl → 检查机器状态是否为 Offline
//       → 若 Offline 则点击 Start 按钮启动机器
// 账号来源: Secret VORTEXA_USERS_JSON =
//   [{"username":"a@b.com","password":"pwd","serverUrl":"https://www.vortexa.cloud/server/xxxx"}]
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const LOGIN_URL = 'https://www.vortexa.cloud/login';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'Vortexa';

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


// 规范化 cookie 数组为 Playwright addCookies 接受的格式


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
        if (process.env.VORTEXA_USERS_JSON) {
            const parsed = JSON.parse(process.env.VORTEXA_USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 VORTEXA_USERS_JSON 环境变量错误:', e);
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

// 登录单个账号：返回 true/false
async function loginOnce(page, user) {
    await gotoWithRetry(page, LOGIN_URL);
    await page.waitForTimeout(2000);

    console.log('输入邮箱...');
    const emailInput = page.locator('input#email, input[type="email"], input[name="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(user.username);
    await page.waitForTimeout(400);

    console.log('输入密码...');
    const pwdInput = page.locator('input#password, input[type="password"], input[name="password"]').first();
    await pwdInput.waitFor({ state: 'visible', timeout: 15000 });
    await pwdInput.fill(user.password);
    await page.waitForTimeout(400);

    console.log('点击 Sign In...');
    const signInBtn = page.locator('button[type="submit"]').first();
    await signInBtn.click();

    // 等待离开登录页 = 登录成功
    for (let s = 0; s < 25; s++) {
        await page.waitForTimeout(1000);
        if (!/\/login/i.test(page.url())) return true;
        const err = await page.getByText(/invalid|incorrect|wrong|failed|error/i)
            .first().isVisible().catch(() => false);
        if (err) return false;
    }
    return !/\/login/i.test(page.url());
}

// 检查服务器状态：返回 'offline' | 'starting' | 'online' | 'unknown'
async function getServerStatus(page) {
    try {
        // 查找状态标签
        const pageText = await page.locator('body').innerText().catch(() => '');

        // 按优先级检测：Starting > Online > Offline (避免子串误匹配)
        if (/Starting/i.test(pageText)) {
            console.log('   >> 检测到机器状态: Starting (启动中，正常)');
            return 'starting';
        }
        if (/Online/i.test(pageText)) {
            console.log('   >> 检测到机器状态: Online (运行中)');
            return 'online';
        }
        // 精确匹配 Offline 标签（span 中的 Offline 文字）
        const offlineBadge = page.locator('span:has-text("Offline")').first();
        if (await offlineBadge.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log('   >> 检测到机器状态: Offline');
            return 'offline';
        }
        // 也检查 console 中的 offline 提示
        const consoleOffline = page.locator('text=Server status: offline').first();
        if (await consoleOffline.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log('   >> 检测到 Console 提示: Server status: offline');
            return 'offline';
        }
        console.log('   >> 未能识别机器状态 (可能状态标签未加载)');
        return 'unknown';
    } catch (e) {
        console.warn('   >> 检查状态时出错:', e.message);
        return 'unknown';
    }
}

// 等待服务器变为 Online
async function waitServerOnline(page, timeoutMs = 120000) {
    console.log('   >> 等待服务器上线...');
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(3000);
        // 刷新页面获取最新状态
        await page.reload({ waitUntil: 'networkidle' }).catch(() => page.waitForTimeout(5000));
        await page.waitForTimeout(2000);

        try {
            const pageText = await page.locator('body').innerText().catch(() => '');
            if (/Online/i.test(pageText)) {
                console.log('   >> ✅ 机器状态已变为 Online!');
                return true;
            }
            if (/Starting/i.test(pageText)) {
                console.log(`   >> 机器正在启动中 Starting... (已等待 ${Math.round((Date.now() - startTime) / 1000)}s)`);
                continue;
            }
            const offlineBadge = page.locator('span:has-text("Offline")').first();
            if (await offlineBadge.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log(`   >> 仍处于 Offline... (已等待 ${Math.round((Date.now() - startTime) / 1000)}s)`);
                continue;
            }
            // 状态标签可能消失了（非 offline/starting 也非 online）
            console.log(`   >> 状态标签无匹配，可能已变更... (已等待 ${Math.round((Date.now() - startTime) / 1000)}s)`);
        } catch (e) {
            console.log(`   >> 刷新检查异常: ${e.message}`);
        }
    }
    console.log('   >> ⚠️ 等待超时，服务器可能仍未上线');
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 VORTEXA_USERS_JSON 中找到用户');
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

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
            }
            // 清掉上一个账号的会话，确保干净登录
            try { await context.clearCookies(); } catch (e) { }

            const cookieKey = `vortexa_cookie_${safeUser}`;

            // 1. 先注入 KV 里的 cookie，尝试免登录
            const saved = await kvGet(cookieKey);
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    if (cks.length) { await context.addCookies(cks); console.log(`   >> 已注入 KV cookie (${cks.length} 条)`); }
                } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }
            }

            // 2. 用 cookie 直接打开服务器页，判断 cookie 是否有效
            let loggedIn = false;
            const targetUrl = user.serverUrl || LOGIN_URL;
            if (saved) {
                await gotoWithRetry(page, targetUrl);
                await page.waitForTimeout(2500);
                loggedIn = !/\/login/i.test(page.url());
                console.log(`   >> cookie ${loggedIn ? '有效，免登录' : '无效/已过期'} (当前: ${page.url()})`);
            }

            // 3. cookie 失效 → 完整登录 → 存新 cookie
            if (!loggedIn) {
                loggedIn = await loginOnce(page, user);
                if (!loggedIn) {
                    const shot = path.join(photoDir, `vortexa_${safeUser}_loginfail.png`);
                    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                    console.log(`   >> ❌ 登录失败，停留在: ${page.url()}`);
                    await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n停留在: ${page.url()}`, shot);
                    console.log('用户处理完成');
                    continue;
                }
                console.log(`   >> ✅ 登录成功: ${page.url()}`);
                // 保存新 cookie 到 KV
                try {
                    const cookies = await context.cookies();
                    await kvPut(cookieKey, JSON.stringify(cookies));
                } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }
            }

            // 如果没有 serverUrl，只登录后截图通知
            if (!user.serverUrl) {
                const shot = path.join(photoDir, `vortexa_${safeUser}.png`);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`✅ *登录成功*\n用户: ${user.username}\n(未配置 serverUrl，跳过启动检查)`, shot);
                console.log('用户处理完成');
                continue;
            }

            // 4. 打开服务器页
            console.log(`打开服务器页: ${user.serverUrl}`);
            await gotoWithRetry(page, user.serverUrl);
            await page.waitForTimeout(3000);

            // 5. 检查机器状态
            const status = await getServerStatus(page);
            const shot = path.join(photoDir, `vortexa_${safeUser}.png`);

            if (status === 'online' || status === 'starting') {
                // 机器已在运行或正在启动中，都正常，跳过
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                const statusLabel = status === 'online' ? 'Online (运行中)' : 'Starting (启动中)';
                console.log(`   >> ✅ 服务器状态=${statusLabel}，无需启动。`);
                await sendTelegramMessage(`✅ *服务器状态正常*\n用户: ${user.username}\n服务器: ${user.serverUrl}\n状态: ${statusLabel}`, shot);
                console.log('用户处理完成');
                continue;
            }

            if (status === 'unknown') {
                // 未知状态：可能是页面没加载完，截个图通知但不点 Start
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                console.log('   >> ⚠️ 无法确认机器状态，跳过启动以免误操作。');
                await sendTelegramMessage(`⚠️ *无法确认状态*\n用户: ${user.username}\n服务器: ${user.serverUrl}\n未能读取状态标签，已跳过启动`, shot);
                console.log('用户处理完成');
                continue;
            }

            // 6. 机器 Offline → 点击 Start 按钮
            console.log('   >> 机器 Offline，正在点击 Start 按钮...');
            const startBtn = page.locator('button:has-text("Start")').first();

            try {
                await startBtn.waitFor({ state: 'visible', timeout: 10000 });
            } catch (e) {
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e2) { }
                console.log('   >> ⚠️ 未找到 Start 按钮');
                await sendTelegramMessage(`⚠️ *未找到启动按钮*\n用户: ${user.username}\n服务器状态: Offline 但找不到 Start 按钮`, shot);
                console.log('用户处理完成');
                continue;
            }

            const isDisabled = await startBtn.isDisabled().catch(() => false);
            if (isDisabled) {
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                console.log('   >> ⚠️ Start 按钮被禁用');
                await sendTelegramMessage(`⚠️ *启动按钮被禁用*\n用户: ${user.username}\n机器 Offline 但 Start 按钮不可点击`, shot);
                console.log('用户处理完成');
                continue;
            }

            // 点击 Start
            await startBtn.click();
            console.log('   >> Start 已点击，等待服务器启动...');
            // 等几秒让启动指令生效
            await page.waitForTimeout(5000);

            // 7. 等待服务器上线 (最多 2 分钟)
            const online = await waitServerOnline(page);

            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }

            if (online) {
                console.log('   >> ✅ 服务器启动成功！');
                await sendTelegramMessage(`✅ *服务器启动成功*\n用户: ${user.username}\n服务器: ${user.serverUrl}\n状态: Online`, shot);
            } else {
                console.log('   >> ⚠️ 服务器启动超时，可能仍在启动中');
                await sendTelegramMessage(`⚠️ *服务器启动中*\n用户: ${user.username}\n服务器: ${user.serverUrl}\n已点击 Start，等待上线中，详见截图`, shot);
            }

        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shotPath = path.join(photoDir, `vortexa_${safeUser}_error.png`);
            try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, shotPath);
        }
        console.log('用户处理完成');
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();