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
            await page.goto(url, { waitUntil: 'load', timeout: 30000 });
            return;
        } catch (e) {
            console.warn(`[导航] 打开 ${url} 失败 (第 ${i}/${retries} 次): ${e.message}`);
            if (i === retries) throw e;
            await page.waitForTimeout(3000);
        }
    }
}

// Cloudflare Turnstile (iframe 内复选框) 的 CDP 点击绕过
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

// 通过 Cloudflare 全屏验证：循环点击 Turnstile，直到目标元素 (readyLocator) 出现
async function passCloudflare(page, readyLocator, label) {
    for (let i = 0; i < 20; i++) {
        if (await readyLocator().isVisible().catch(() => false)) {
            if (i > 0) console.log(`   >> 已通过 Cloudflare (${label})`);
            return true;
        }
        await attemptTurnstileCdp(page);
        await page.waitForTimeout(2000);
    }
    return await readyLocator().isVisible().catch(() => false);
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
            try { await context.clearCookies(); } catch (e) { }

            const loggedIn = await loginOnce(page, user);
            if (!loggedIn) {
                const shot = path.join(photoDir, `weirdhost_${safeUser}_loginfail.png`);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                console.log(`   >> ❌ 登录失败，停留在: ${page.url()}`);
                await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n停留在: ${page.url()}`, shot);
                console.log('用户处理完成');
                continue;
            }
            console.log(`   >> ✅ 登录成功: ${page.url()}`);

            // --- 续期 ---
            if (!user.serverUrl) {
                const shot = path.join(photoDir, `weirdhost_${safeUser}.png`);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`✅ *登录成功*\n用户: ${user.username}\n(未配置 serverUrl，跳过续期)`, shot);
                console.log('用户处理完成');
                continue;
            }

            console.log(`打开续费页: ${user.serverUrl}`);
            await gotoWithRetry(page, user.serverUrl);
            await page.waitForTimeout(2000);
            // 服务器页可能再次触发 CF，等 연장하기 按钮出现
            const renewLoc = () => page.locator('button:has-text("연장하기"), button.RenewBox2__RenewButton-sc-jn9wls-3').first();
            await passCloudflare(page, renewLoc, '续费页');

            const renewBtn = renewLoc();
            await renewBtn.waitFor({ state: 'visible', timeout: 15000 });

            // 取到期时间 (유통기한 2026-06-15 18:02:54) 和倒计时 (X시간 후에 연장할수있어요)
            const readExpiry = async () => {
                let t = await page.locator('[class*="RenewBox2__ExpiryText"]').first().innerText().catch(() => '');
                if (!t) {
                    const body = await page.locator('body').innerText().catch(() => '');
                    t = (body.match(/유[통효]기한[^\n]*/) || [])[0] || '';
                }
                const dt = (t.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/) || [])[0] || '';
                return { raw: t.trim(), dt };
            };
            const statusText = (await page.locator('[class*="RenewBox2__StatusText"]').first().innerText().catch(() => '')).trim();
            let { dt: expiryDt } = await readExpiry();
            const expiryLine = expiryDt ? `\n到期: ${expiryDt}` : '';
            const countdownLine = statusText ? `\n${statusText}` : '';

            const shot = path.join(photoDir, `weirdhost_${safeUser}_renew.png`);
            const disabled = await renewBtn.isDisabled().catch(() => false);

            if (disabled) {
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                console.log(`   >> ⏳ 暂不可续期 (按钮禁用)。到期:${expiryDt} ${statusText}`);
                await sendTelegramMessage(`⏳ *暂不可续期*\n用户: ${user.username}\n原因: 还没到时间${countdownLine}${expiryLine}`, shot);
            } else {
                console.log('   >> 点击 연장하기 续期...');
                try { await renewBtn.click(); } catch (e) { await renewBtn.click({ force: true }); }
                await page.waitForTimeout(3000);
                const after = await page.locator('body').innerText().catch(() => '');
                const nowDisabled = await renewLoc().isDisabled().catch(() => false);
                const ok = /성공|완료|renewed|success/i.test(after) || nowDisabled;
                // 续期后到期时间通常会更新，重新读一次
                const newExpiry = (await readExpiry()).dt;
                const newExpiryLine = newExpiry ? `\n到期: ${newExpiry}` : expiryLine;
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                if (ok) {
                    console.log(`   >> ✅ 续期成功。到期: ${newExpiry || expiryDt}`);
                    await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n服务器已续期！${newExpiryLine}`, shot);
                } else {
                    console.log('   >> ⚠️ 已点击续期，结果未知。');
                    await sendTelegramMessage(`⚠️ *续期结果未知*\n用户: ${user.username}\n已点击 연장하기，详见截图${newExpiryLine}`, shot);
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
