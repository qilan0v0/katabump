// Lunes Host (betadash.lunes.host) 登录保活脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 定时登录一次进入 dashboard，截图并发 Telegram 通知，防止账号因长期不活跃被重置密码。
// 账号来源: Secret LUNES_USERS_JSON = [{"username":"a@b.com","password":"pwd"}, ...]
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const LOGIN_URL = 'https://betadash.lunes.host/login';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID; // 可选：超级群话题(Topic)的 message_thread_id
const PROJECT = process.env.PROJECT_NAME || 'Lunes'; // 项目名，加在每条 TG 推送前缀

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

    // 有图片：用 sendPhoto + caption，图文合并成一条消息
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

    // 无图片：sendMessage
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

// 注入脚本：hook 子 frame 里的 attachShadow，定位 Turnstile 复选框 (ALTCHA 不需要它)
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
    // Secret LUNES_USERS_JSON = [{"username":..., "password":...}]
    try {
        if (process.env.LUNES_USERS_JSON) {
            const parsed = JSON.parse(process.env.LUNES_USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 LUNES_USERS_JSON 环境变量错误:', e);
    }
    return [];
}

// 带重试的页面跳转：瞬时网络错误自动重试
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

// Turnstile (iframe 内复选框) 的 CDP 点击绕过
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

// ALTCHA (工作量证明)：点击复选框后浏览器本地计算自动完成
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
            console.log(`   >> ✅ ALTCHA 通过 (checked=${isChecked}, verified=${verified}, payload=${payload ? '有' : '无'})`);
            return true;
        }
        console.log(`   >> 等待 ALTCHA PoW 计算... (${i + 1}/20)`);
    }
    console.log('   >> ⚠️ ALTCHA 验证超时');
    return false;
}

// lunes 登录只有 Cloudflare Turnstile：优先用 CDP 点击 iframe 内复选框并等 "Success!"，ALTCHA 仅兜底
async function solveCaptcha(page) {
    console.log('   >> 正在处理 Cloudflare Turnstile 验证码...');
    let clicked = false;
    for (let i = 0; i < 15; i++) {
        if (await attemptTurnstileCdp(page)) { clicked = true; break; }
        await page.waitForTimeout(1000);
    }
    if (clicked) {
        console.log('   >> Turnstile CDP 点击生效，等待 Cloudflare 校验 (最多 10秒)...');
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
        return true; // 已点击，即使没捕捉到 Success 标志也继续提交
    }

    // 兜底：万一某些账号是 ALTCHA
    console.log('   >> 未检测到 Turnstile，尝试 ALTCHA 兜底...');
    if (await solveAltcha(page)) return true;

    console.log('   >> 未检测到可处理的验证码 (可能本次无需验证码)。');
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 LUNES_USERS_JSON 中找到用户');
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
    console.log('注入脚本已添加。');

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }
            // 清掉上一个账号的会话，确保干净登录
            try { await context.clearCookies(); } catch (e) { }

            await gotoWithRetry(page, LOGIN_URL);
            await page.waitForTimeout(2000);

            console.log('正在输入凭据...');
            const emailInput = page.locator('input[type="email"], input[name="email"], #email').first();
            await emailInput.waitFor({ state: 'visible', timeout: 15000 });
            await emailInput.fill(user.username);
            const pwdInput = page.locator('input[type="password"], input[name="password"], #password').first();
            await pwdInput.fill(user.password);
            await page.waitForTimeout(500);

            // 处理验证码 (ALTCHA / Turnstile)
            await solveCaptcha(page);

            // 点击 "Continue to dashboard"
            console.log('点击登录按钮...');
            const loginBtn = page.getByRole('button', { name: /continue to dashboard|sign in|log ?in|continue/i }).first();
            try {
                await loginBtn.click();
            } catch (e) {
                await page.locator('button[type="submit"]').first().click();
            }

            // 等待跳离登录页 (= 登录成功)
            let loggedIn = false;
            for (let s = 0; s < 20; s++) {
                await page.waitForTimeout(1000);
                if (!page.url().includes('/login')) { loggedIn = true; break; }
                // 登录错误提示 (凭据错误 / 验证码失败)
                const errVisible = await page.getByText(/invalid|incorrect|wrong|failed|error/i)
                    .first().isVisible().catch(() => false);
                if (errVisible) break;
            }

            const shotPath = path.join(photoDir, `lunes_${safeUser}.png`);
            try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }

            if (loggedIn) {
                console.log(`   >> ✅ 登录成功，当前页面: ${page.url()}`);
                await sendTelegramMessage(`✅ *Lunes 登录成功*\n用户: ${user.username}\n页面: ${page.url()}`, shotPath);
            } else {
                console.log(`   >> ❌ 登录失败，仍停留在: ${page.url()}`);
                await sendTelegramMessage(`❌ *Lunes 登录失败*\n用户: ${user.username}\n原因: 凭据或验证码未通过 (详见截图)`, shotPath);
            }
        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shotPath = path.join(photoDir, `lunes_${safeUser}_error.png`);
            try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *Lunes 登录异常*\n用户: ${user.username}\n错误: ${err.message}`, shotPath);
        }
        console.log('用户处理完成');
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
