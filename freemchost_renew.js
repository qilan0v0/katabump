// FreeMCHost (new.freemchost.com) 续期保活脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 打开登录页 → 填邮箱/密码 → 点 "Sign In" → 登录成功跳主面板
//       → 打开配置的 serverUrl → 点 "Renew now" 续期
// 账号来源: Secret FREEMCHOST_USERS_JSON =
//   [{"username":"a@b.com","password":"pwd","serverUrl":"https://new.freemchost.com/server/xxxx"}]
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const LOGIN_URL = 'https://new.freemchost.com/login';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID; // 可选：超级群话题(Topic)的 message_thread_id
const PROJECT = process.env.PROJECT_NAME || 'FreeMCHost';

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


// 规范化 cookie 数组为 Playwright addCookies 接受的格式 (兼容浏览器扩展导出的 expirationDate/sameSite 等)


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
        '--window-size=1440,900',
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
        console.error(`Chrome 第 ${attempt} 次未在端口 ${DEBUG_PORT} 起来。stderr 末尾:\n` + stderr.slice(-800));
        try { process.kill(-chrome.pid); } catch (e) { }
        try { fs.rmSync('/tmp/chrome_user_data', { recursive: true, force: true }); } catch (e) { }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Chrome 启动失败');
}

function getUsers() {
    try {
        if (process.env.FREEMCHOST_USERS_JSON) {
            const parsed = JSON.parse(process.env.FREEMCHOST_USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 FREEMCHOST_USERS_JSON 环境变量错误:', e);
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

// 登录单个账号：返回 true/false
async function loginOnce(page, user) {
    await gotoWithRetry(page, LOGIN_URL);
    await page.waitForTimeout(2000);

    console.log('输入凭据...');
    const emailInput = page.locator('input[type="email"], input[placeholder*="email" i], input[name="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(user.username);
    const pwdInput = page.locator('input[type="password"], input[placeholder*="password" i], input[name="password"]').first();
    await pwdInput.fill(user.password);
    await page.waitForTimeout(500);

    console.log('点击 Sign In...');
    const signInBtn = page.getByRole('button', { name: /sign\s?in|log\s?in/i })
        .or(page.locator('button[type="submit"]'))
        .first();
    await signInBtn.click();

    // 等待离开登录页 = 登录成功
    for (let s = 0; s < 20; s++) {
        await page.waitForTimeout(1000);
        if (!/\/login/i.test(page.url())) return true;
        const err = await page.getByText(/invalid|incorrect|wrong|failed|error|not found/i)
            .first().isVisible().catch(() => false);
        if (err) return false;
    }
    return !/\/login/i.test(page.url());
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 FREEMCHOST_USERS_JSON 中找到用户');
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

        const cookieKey = `freemchost_cookie_${safeUser}`;
        try {
            if (page.isClosed()) page = await context.newPage();
            try { await context.clearCookies(); } catch (e) { }

            // 1. 先注入 KV 里的 cookie，尝试免登录
            const saved = await kvGet(cookieKey);
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    if (cks.length) { await context.addCookies(cks); console.log(`   >> 已注入 KV cookie (${cks.length} 条)`); }
                } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }
            }

            // 2. 用 cookie 直接打开服务器页(无 serverUrl 则打开登录页)，判断 cookie 是否有效
            let loggedIn = false;
            if (saved) {
                const probeUrl = user.serverUrl || LOGIN_URL;
                await gotoWithRetry(page, probeUrl);
                await page.waitForTimeout(2500);
                // 没被跳回登录页 = cookie 有效
                loggedIn = !/\/login/i.test(page.url());
                console.log(`   >> cookie ${loggedIn ? '有效，免登录' : '无效/已过期'} (当前: ${page.url()})`);
            }

            // 3. cookie 失效 → 完整登录 → 存新 cookie
            if (!loggedIn) {
                loggedIn = await loginOnce(page, user);
                if (!loggedIn) {
                    const shot = path.join(photoDir, `freemchost_${safeUser}_loginfail.png`);
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

            if (!user.serverUrl) {
                const shot = path.join(photoDir, `freemchost_${safeUser}.png`);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`✅ *登录成功*\n用户: ${user.username}\n(未配置 serverUrl，跳过续期)`, shot);
                console.log('用户处理完成');
                continue;
            }

            // 打开服务器页并点 Renew now
            console.log(`打开续费页: ${user.serverUrl}`);
            await gotoWithRetry(page, user.serverUrl);
            await page.waitForTimeout(3000);

            // 新面板: Renew now 按钮在 Manage 标签页内，需要先点击 Manage 标签
            // 侧边栏资源面板会遮挡标签栏，需用 force:true 或先调大视口
            console.log('   >> 点击 Manage 标签...');
            try {
                const manageTab = page.getByRole('tab', { name: /manage/i });
                await manageTab.waitFor({ state: 'visible', timeout: 10000 });
                await manageTab.click({ force: true });
                await page.waitForTimeout(2000);
                console.log('   >> Manage 标签已激活');
            } catch (e) {
                console.warn('   >> Manage 标签点击异常:', e.message);
                // 降级方案：通过 evaluate 强制激活
                await page.evaluate(() => {
                    const tab = document.querySelector('button[role="tab"][id*="manage"]');
                    if (tab) tab.click();
                });
                await page.waitForTimeout(2000);
            }

            const renewBtn = page.getByRole('button', { name: /renew now/i })
                .or(page.locator('button:has-text("Renew now")'))
                .first();
            const shot = path.join(photoDir, `freemchost_${safeUser}_renew.png`);
            try {
                await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
            } catch (e) {
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e2) { }
                const expiry = await page.locator('timer').first().innerText().catch(() => '');
                await sendTelegramMessage(`⚠️ *未找到续期按钮*\n用户: ${user.username}\n到期: ${expiry || '?'}\n详见截图`, shot);
                console.log('用户处理完成');
                continue;
            }

            const disabled = await renewBtn.isDisabled().catch(() => false);
            if (disabled) {
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                const expiry = await page.locator('timer').first().innerText().catch(() => '');
                console.log('   >> ⏳ 暂不可续期 (按钮禁用)。');
                await sendTelegramMessage(`⏳ *暂不可续期*\n用户: ${user.username}\n到期: ${expiry || '?'}\n原因: 续期按钮禁用 (可能未到时间)`, shot);
            } else {
                // 获取续期前的到期时间
                const beforeExpiry = await page.locator('timer').first().innerText().catch(() => '');
                console.log(`   >> 续期前到期: ${beforeExpiry}`);

                console.log('   >> 点击 Renew now 续期...');
                try { await renewBtn.click({ timeout: 8000 }); } catch (e) { await renewBtn.click({ force: true }); }
                await page.waitForTimeout(5000);

                // 获取续期后的到期时间
                const afterExpiry = await page.locator('timer').first().innerText().catch(() => '');
                console.log(`   >> 续期后到期: ${afterExpiry}`);

                // 检测续期结果：检查 toast 通知、页面文本或计时器变化
                const after = await page.locator('body').innerText().catch(() => '');
                const toastText = await page.locator('[data-sonner-toast]').first().innerText().catch(() => '');
                const ok = /success|renewed|extended|renewed successfully|renewal successful/i.test(after + ' ' + toastText);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                if (ok) {
                    console.log('   >> ✅ 续期成功。');
                    await sendTelegramMessage(
                        `✅ *续期成功*\n用户: ${user.username}\n`
                        + `到期: ${beforeExpiry || '?'} → ${afterExpiry || '?'}`, shot);
                } else {
                    console.log('   >> ⚠️ 已点击续期，结果未知 (页面文本无明确成功标记)。');
                    await sendTelegramMessage(
                        `⚠️ *续期结果未知*\n用户: ${user.username}\n`
                        + `续期前到期: ${beforeExpiry || '?'}\n`
                        + `续期后到期: ${afterExpiry || '?'}\n`
                        + `已点击 Renew now，详见截图`, shot);
                }
            }
        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shot = path.join(photoDir, `freemchost_${safeUser}_error.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, shot);
        }
        console.log('用户处理完成');
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
