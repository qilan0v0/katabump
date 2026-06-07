const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID; // 可选：超级群话题(Topic)的 message_thread_id

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.warn('[Telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }

    // 把 Telegram 返回的真实错误原因提取出来 (axios 的 e.message 只会显示 "status code 400")
    const tgErr = (e) => (e.response && e.response.data && e.response.data.description)
        ? `${e.response.data.error_code} ${e.response.data.description}`
        : e.message;

    // 1. 发送文字消息
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        // 公共参数：设置了话题 ID 才带 message_thread_id
        const base = { chat_id: TG_CHAT_ID };
        if (TG_THREAD_ID) base.message_thread_id = Number(TG_THREAD_ID);
        try {
            await axios.post(url, {
                ...base,
                text: message,
                parse_mode: 'Markdown'
            });
            console.log('[Telegram] Message sent.');
        } catch (e) {
            // Markdown 解析失败 (如用户名含 _ * 等字符会导致 400)，退回纯文本重发
            console.warn('[Telegram] Markdown 发送失败，改用纯文本重试:', tgErr(e));
            await axios.post(url, {
                ...base,
                text: message
            });
            console.log('[Telegram] Message sent (plain text).');
        }
    } catch (e) {
        console.error('[Telegram] 文字推送失败:', tgErr(e),
            '\n   >> 提示: "chat not found" 通常表示 TG_CHAT_ID 填错，或你还没主动给该 bot 发过一条消息。');
    }

    // 2. 发送图片 (如果有)
    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        // 使用 curl 发送图片，避免引入额外的 multipart 依赖
        // -s 静默但仍要拿到响应体判断真伪 (curl 在 HTTP 400 时进程仍返回 0，不能只看 err)
        const threadArg = TG_THREAD_ID ? ` -F message_thread_id="${TG_THREAD_ID}"` : '';
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}"${threadArg} -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err, stdout) => {
                if (err) {
                    console.error('[Telegram] 图片推送失败 (curl 错误):', err.message);
                } else if (stdout && stdout.includes('"ok":true')) {
                    console.log('[Telegram] Photo sent.');
                } else {
                    // Telegram 返回了错误 JSON，但 curl 进程是成功的 —— 之前的"假成功"就出在这
                    console.error('[Telegram] 图片推送被 Telegram 拒绝:', (stdout || '').slice(0, 300));
                }
                resolve();
            });
        });
    }
}

// 启用 stealth 插件
chromium.use(stealth);

// GitHub Actions 环境下的 Chrome 路径 (通常是 google-chrome)
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// 确保 localhost 不走代理
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
        console.error('[代理] TODO HTTP_PROXY 格式无效。期望格式: http://user:pass@host:port 或 http://host:port');
        process.exit(1);
    }
}

// --- INJECTED_SCRIPT ---
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

    // 2. 简单的 attachShadow Hook
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
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// 辅助函数：检测代理是否可用
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
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }

        await axios.get('https://www.google.com', axiosConfig);

        // 额外请求一个 IP 回显服务，打印出口 IP，确认确实走了 v2ray 节点
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
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        // '--headless=new', // (已被注释) 使用 xvfb-run 时不需要 headless 模式，这样可以模拟有头浏览器增加成功率
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data' // 必须指定用户数据目录，否则远程调试可能失败
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    // 添加针对 Linux 环境的额外稳定性参数
    args.push('--disable-dev-shm-usage'); // 避免共享内存不足


    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
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
    // 从环境变量读取 JSON 字符串
    // GitHub Actions Secret: USERS_JSON = [{"username":..., "password":...}]
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
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

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

// 解决 ALTCHA 验证码 (续期弹窗使用)：ALTCHA 是工作量证明(PoW)机制，
// 点击复选框后由浏览器本地计算 SHA-256 难题自动完成，不依赖 IP 信誉。
async function solveAltcha(page, scope) {
    scope = scope || page;
    // ALTCHA 复选框 (Playwright 默认穿透 open shadow DOM)。优先用 altcha 专属选择器，
    // 续期模态框内只有这一个复选框，最后的通用选择器作为兜底。
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

    // 等待 PoW 完成：复选框打勾 / 出现 "Verified" / 隐藏 input[name=altcha] 拿到 payload
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

// 带重试的页面跳转：瞬时网络错误 (ERR_CONNECTION_CLOSED / RESET / 超时) 时自动重试，
// 常见于第一个账号、或刚走 v2ray 代理时首个请求被掐断。
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

// 进入服务器详情页 (Renew 按钮所在页)。返回 { ok, page }，page 可能是切换后的新标签页。
// 优先用账号配置的 serverUrl 直达；否则点击 "See" (href="#"，靠 JS 跳转，并处理开新标签的情况)。
async function goToServerPage(page, user) {
    // 0. 账号配置了 serverUrl → 直接导航，最稳，绕开 See 点击
    if (user && user.serverUrl) {
        console.log(`   >> 使用配置的续期页 URL: ${user.serverUrl}`);
        await gotoWithRetry(page, user.serverUrl);
        return { ok: true, page };
    }

    const seeLink = page.getByRole('link', { name: 'See' }).first();
    try {
        await seeLink.waitFor({ state: 'visible', timeout: 15000 });
    } catch (e) {
        return { ok: false, page };
    }
    await page.waitForTimeout(1500); // 等页面 JS (See 的点击处理器) 初始化完成

    const href = await seeLink.getAttribute('href').catch(() => null);
    const realHref = href && href.trim() !== '' && !href.trim().startsWith('#')
        && !href.trim().toLowerCase().startsWith('javascript');
    if (realHref) {
        const fullUrl = new URL(href, page.url()).href;
        console.log(`   >> 直接打开服务器详情页: ${fullUrl}`);
        await gotoWithRetry(page, fullUrl);
        return { ok: true, page };
    }

    // href 不可用 (#/js)：点击触发 JS 跳转，同时监听是否开了新标签页
    console.log('   >> "See" 通过 JS 跳转，点击中...');
    const ctx = page.context();
    const popupP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    try { await seeLink.click(); } catch (e) { console.log('   >> 点击 See 失败:', e.message); }
    const popup = await popupP;
    if (popup) {
        console.log('   >> See 打开了新标签页，切换过去');
        try { await popup.addInitScript(INJECTED_SCRIPT); } catch (e) { }
        try { await popup.waitForLoadState('networkidle', { timeout: 10000 }); } catch (e) { }
        console.log(`   >> 新标签 URL: ${popup.url()}`);
        return { ok: true, page: popup };
    }
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (e) { }
    console.log(`   >> 点击后当前 URL: ${page.url()}`);
    return { ok: true, page };
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
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

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`); // 隐去具体邮箱 logging

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                // Context credentials apply
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // --- 登录逻辑 (简略版，逻辑一致) ---
            if (page.url().includes('dashboard')) {
                await gotoWithRetry(page, 'https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            // 总是先去登录页
            await gotoWithRetry(page, 'https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                // 如果登出没成功，再次登出
                await gotoWithRetry(page, 'https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await gotoWithRetry(page, 'https://dashboard.katabump.com/auth/login');
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // --- Cloudflare Turnstile Bypass for Login ---
                console.log('   >> 正在登录前检查 Turnstile (使用 CDP 绕过)...');
                let cdpClickResult = false;
                for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    await page.waitForTimeout(1000);
                }

                if (cdpClickResult) {
                    console.log('   >> 登录 CDP 点击生效。正在等待最多 10秒 Cloudflare 成功标志...');
                    for (let waitSec = 0; waitSec < 10; waitSec++) {
                        const frames = page.frames();
                        let isSuccess = false;
                        for (const f of frames) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                        isSuccess = true;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                        if (isSuccess) {
                            console.log('   >> 登录前 Turnstile 验证成功。');
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
                } else {
                    console.log('   >> 登录前未检测到或未点击 Turnstile，继续操作...');
                }
                // --------------------------------------------

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // User Request: Check for incorrect password
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 用户 ${user.username} 账号或密码错误`);
                        const failShotPath = path.join(photoDir, `${safeUsername}.png`);
                        try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }

                        await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);

                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录错误:', e.message);
            }

            console.log('正在寻找 "See" 链接...');
            try {
                const res = await goToServerPage(page, user);
                if (!res.ok) {
                    console.log('未找到 "See" 按钮。');
                    continue;
                }
                page = res.page; // 可能切换到了新标签页
            } catch (e) {
                console.log('进入服务器页失败:', e.message);
                continue;
            }

            // --- Renew 逻辑 ---
            let renewSuccess = false;
            let captchaFailStreak = 0; // 连续 captcha 失败次数，用于提前退出
            let renewBtnMissStreak = 0; // 连续找不到 Renew 按钮的次数 (通常是页面没加载完)
            const MAX_ATTEMPTS = 6;
            const MAX_CAPTCHA_FAILS = 3;
            const MAX_BTN_MISS = 3;
            // 2. 一个扁平化的主循环：尝试 Renew 整个流程
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                let hasCaptchaError = false;

                // 1. 如果是重试 (attempt > 1)，说明之前失败了或者刚刷新完页面
                // 我们直接开始寻找 Renew 按钮
                console.log(`\n[尝试 ${attempt}/${MAX_ATTEMPTS}] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    // 稍微等待一下，防止页面刚刷新还没渲染出来
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // A. 在模态框里晃晃鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // B. 解决 ALTCHA 验证码 (工作量证明 PoW，点击复选框后浏览器本地计算)
                    console.log('正在处理 ALTCHA 验证码...');
                    const altchaOk = await solveAltcha(page, modal);
                    if (!altchaOk) {
                        console.log('   >> ALTCHA 未通过，本轮稍后仍会尝试点击 Renew。');
                    }

                    // D. 准备点击确认
                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {

                        // User Requested: Screenshot BEFORE final click
                        const fs = require('fs');
                        const path = require('path');
                        const photoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                        const tsScreenshotName = `${safeUser}_Turnstile_${attempt}.png`;
                        try {
                            await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true });
                            console.log(`   >> 📸 快照已保存: ${tsScreenshotName}`);
                        } catch (e) { }

                        // User Request: 找不到的话这个循环直接下一步点击renew，然后检测有没有Please complete the captcha to continue
                        console.log('   >> 点击 Renew 确认按钮 (无论 Turnstile 状态如何)...');
                        await confirmBtn.click();

                        try {
                            // 1. Check for Errors (Captcha or Date limit)
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                // A. Captcha Error
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 检测到错误: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }

                                // B. Not Renew Time Error
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${dateStr}`);

                                    // 截图证明
                                    const fs = require('fs');
                                    const path = require('path');
                                    const photoDir = path.join(process.cwd(), 'screenshots');
                                    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                                    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                                    const skipShotPath = path.join(photoDir, `${safeUser}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) { }

                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n用户: ${user.username}\n原因: 还没到时间\n下次可用: ${dateStr}`, skipShotPath);

                                    renewSuccess = true; // Mark as done to stop retries
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break; // Break loop if not time yet

                        if (hasCaptchaError) {
                            captchaFailStreak++;
                            console.log(`   >> Captcha 失败 (连续 ${captchaFailStreak}/${MAX_CAPTCHA_FAILS})。`);
                            if (captchaFailStreak >= MAX_CAPTCHA_FAILS) {
                                console.log('   >> 连续多次 captcha 失败，提前放弃 (很可能是代理 IP 信誉差或 Turnstile 升级挑战)。');
                                break; // 提前退出大循环，不再空转
                            }
                            console.log('   >> Refreshing page to reset Turnstile...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue; // 刷新后，重新开始大循环
                        }
                        captchaFailStreak = 0; // 本轮没有 captcha 错误，重置连败计数

                        // F. 检查成功 (模态框消失)
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Modal closed. Renew successful!');

                            // 截图成功状态
                            const fs = require('fs');
                            const path = require('path');
                            const photoDir = path.join(process.cwd(), 'screenshots');
                            if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                            const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                            const successShotPath = path.join(photoDir, `${safeUser}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }

                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！`, successShotPath);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的验证按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    renewBtnMissStreak++;
                    console.log(`未找到 Renew 按钮 (第 ${renewBtnMissStreak}/${MAX_BTN_MISS} 次，可能页面未加载完)。`);
                    if (renewBtnMissStreak >= MAX_BTN_MISS) {
                        console.log('   >> 多次未找到 Renew 按钮，停止重试 (服务器可能已续期或页面异常)。');
                        break;
                    }
                    // 可能仍停在 Dashboard：有 serverUrl 或页面上有 "See" 链接，就重新进入服务器详情页；否则刷新
                    const seeLink = page.getByRole('link', { name: 'See' }).first();
                    if (user.serverUrl || await seeLink.isVisible().catch(() => false)) {
                        console.log('   >> 重新进入服务器页...');
                        try { const res = await goToServerPage(page, user); page = res.page; } catch (e) { }
                    } else {
                        await page.reload();
                    }
                    await page.waitForTimeout(3000);
                    continue;
                }
            }

            // 循环结束仍未成功 → 发送失败通知 (带截图)，不再静默空转
            if (!renewSuccess) {
                console.log('   >> ❌ 续期未成功 (已用尽重试或提前放弃)。');
                const fs = require('fs');
                const path = require('path');
                const photoDir = path.join(process.cwd(), 'screenshots');
                if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                const failShotPath = path.join(photoDir, `${safeUser}_fail.png`);
                try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(
                    `❌ *续期失败*\n用户: ${user.username}\n原因: 未找到 Renew 按钮或验证码未通过 (详见截图)`,
                    failShotPath
                );
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        // Snapshot before handling next user
        // In GitHub Actions, we save to 'screenshots' dir
        const fs = require('fs');
        const path = require('path');
        const photoDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        // Use safe filename
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        const screenshotPath = path.join(photoDir, `${safeUsername}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
