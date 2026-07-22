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
const PROJECT = process.env.PROJECT_NAME || 'TheRose'; // 项目名，加在每条 TG 推送前缀

// 目标面板地址
const BASE_URL = 'https://client.therose.cloud';
const LOGIN_URL = BASE_URL + '/login';
const SERVERS_URL = BASE_URL + '/panel?routeName=servers';
const TURNSTILE_SITEKEY = '0x4AAAAAADT5H9rlFdzDFH6e';
// 登录后首页直接有 Renew 按钮 (如 aclclouds)，无需点 "See" 进详情页。设 DASH_RENEW_ON_HOME=true 开启
const RENEW_ON_HOME = process.env.DASH_RENEW_ON_HOME === 'true';
// 点 Renew 后没有弹窗、只出 toast 提示 (如 aclclouds)。设 DASH_NO_MODAL=true 开启
const NO_MODAL = process.env.DASH_NO_MODAL === 'true';

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.warn('[Telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }
    // 统一加项目名前缀
    const text = `📌 *${PROJECT}*\n${message}`;

    const tgErr = (e) => (e.response && e.response.data && e.response.data.description)
        ? `${e.response.data.error_code} ${e.response.data.description}`
        : e.message;
    const threadArg = TG_THREAD_ID ? ` -F message_thread_id="${TG_THREAD_ID}"` : '';

    // 有图片：用 sendPhoto + caption，图文合并成一条消息
    if (imagePath && fs.existsSync(imagePath)) {
        // caption 上限 1024 字符；用临时文件传值，避免命令行转义问题 (换行/特殊字符)
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
            // Markdown 解析失败 (用户名含 _ * 等) → 退回纯文本 caption 重发
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


    let stderrBuf = '';
    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe']
    });
    chrome.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
        if (stderrBuf) console.error('Chrome stderr:', stderrBuf.slice(0, 1000));
        throw new Error('Chrome 启动失败');
    }
}

function getUsers() {
    // 从环境变量读取 JSON 字符串
    // GitHub Actions Secret: USERS_JSON = [{"username":..., "password":...}]
    try {
        if (process.env.THEROSE_USERS_JSON) {
            const parsed = JSON.parse(process.env.THEROSE_USERS_JSON);
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
        const fu = (frame.url() || '');
        if (fu && !/cloudflare|turnstile|challenges|hcaptcha|^about:|^$/i.test(fu)) {
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

                // mouseMoved (mouseover 前置事件，Cloudflare 需要)
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
                await new Promise(r => setTimeout(r, 100 + Math.random() * 150));

                // mousePressed
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });
                await new Promise(r => setTimeout(r, 80 + Math.random() * 120));

                // mouseReleased
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

// 自定义"我不是机器人"复选框 + 图形挑战 (aclclouds: <div class="auth-captcha-inner" role="checkbox">)。
// 点击复选框后可能出现图形验证码挑战（从多个选项中点击匹配目标文字的那一个），
// 通过后 aria-checked 才变 true。参考 https://github.com/cuooc/Auto-Renew-AclClouds
async function clickSimpleCaptcha(page, scope) {
    const root = (scope || page);
    const box = root.locator('.auth-captcha-inner, .auth-captcha-box [role="checkbox"]').first();
    try {
        await box.waitFor({ state: 'visible', timeout: 5000 });
    } catch (e) {
        return false;
    }
    const isChecked = async () => (await box.getAttribute('aria-checked').catch(() => null)) === 'true';
    if (await isChecked()) {
        console.log('   >> 自定义验证码已勾选');
        return true;
    }

    // ---- 辅助：获取图形挑战元素 ----
    const getChallenge = async () => {
        for (const sel of ['.auth-captcha-challenge', '.auth-capcha-challenge',
            'div[class*="captcha"]:not(.auth-captcha-inner):not(.auth-captcha-box)',
            ':scope div[class*="captcha"]']) {
            const el = root.locator(sel).first();
            if (await el.isVisible().catch(() => false)) return el;
        }
        return null;
    };

    // ---- 辅助：获取选项列表 ----
    const getOptions = async (challenge) => {
        for (const sel of ['.auth-captcha-option', '.auth-capcha-option', 'button', 'a', '[role="button"]']) {
            const opts = challenge.locator(sel);
            const count = await opts.count().catch(() => 0);
            if (count > 1) return opts;
        }
        return null;
    };

    // ---- 辅助：获取提示目标文字 ----
    const getTargetText = async (challenge) => {
        for (const sel of ['.auth-captcha-prompt strong', '.auth-capcha-prompt strong', '[class*="prompt"] strong', '[class*="prompt"] b']) {
            const el = challenge.locator(sel).first();
            const txt = await el.innerText().catch(() => '');
            if (txt.trim()) return txt.trim();
        }
        // 也尝试 aria-label
        const label = await challenge.getAttribute('aria-label').catch(() => '');
        if (label) {
            const m = label.match(/Click on\s+(.+)/i);
            if (m) return m[1].trim();
        }
        return '';
    };

    // ---- 辅助：获取选项文字 ----
    const getOptionText = async (opt) => {
        let txt = (await opt.innerText().catch(() => '')).trim();
        if (!txt) {
            const img = opt.locator('img').first();
            txt = (await img.getAttribute('alt').catch(() => '')).trim();
        }
        if (!txt) {
            txt = (await opt.getAttribute('aria-label').catch(() => '')).trim();
        }
        return txt;
    };

    // ---- 点击复选框（第 1 次）----
    await page.waitForTimeout(800);
    console.log('   >> 点击自定义验证码...');
    try { await box.click({ timeout: 4000 }); } catch (e) {
        try { await box.click({ force: true }); } catch (e2) { }
    }

    // ---- 等待挑战出现或复选框已勾选 ----
    let challenge;
    for (let w = 0; w < 15; w++) {
        await page.waitForTimeout(500);
        if (await isChecked()) {
            console.log('   >> ✅ 自定义验证码已勾选（无挑战）');
            return true;
        }
        challenge = await getChallenge();
        if (challenge) break;
    }

    // ---- 处理图形挑战 ----
    if (challenge) {
        console.log('   >> 检测到图形验证码挑战，开始处理...');
        for (let round = 0; round < 10; round++) {
            // 每次循环重新获取当前挑战
            challenge = await getChallenge();
            if (!challenge) {
                // 挑战已消失，检查是否已勾选
                if (await isChecked()) {
                    console.log('   >> ✅ 挑战完成，验证码已勾选');
                    return true;
                }
                await page.waitForTimeout(500);
                continue;
            }

            const target = await getTargetText(challenge);
            const opts = await getOptions(challenge);
            if (!opts) {
                console.log('   >> ⚠️ 未找到挑战选项，等待...');
                await page.waitForTimeout(800);
                continue;
            }

            console.log(`   >> 挑战目标: "${target}"，选项数: ${await opts.count()}`);

            // 找匹配的选项
            let matchedOpt = null;
            const count = await opts.count();
            for (let i = 0; i < count; i++) {
                const opt = opts.nth(i);
                const optText = await getOptionText(opt);
                if (target && optText.toLowerCase().includes(target.toLowerCase())) {
                    matchedOpt = opt;
                    break;
                }
            }

            // 如果没找到匹配，点第一个
            const pick = matchedOpt || opts.first();
            const pickText = await getOptionText(pick);
            console.log(`   >> ${matchedOpt ? '匹配' : '默认'}选项: "${pickText}"`);
            try { await pick.click({ timeout: 3000 }); } catch (e) {
                try { await pick.click({ force: true }); } catch (e2) { }
            }

            await page.waitForTimeout(800);

            if (await isChecked()) {
                console.log('   >> ✅ 验证码挑战通过');
                return true;
            }
        }
        console.log('   >> ⚠️ 图形挑战多次尝试未通过');
    }

    // ---- 后备：旧版逻辑（多次点击复选框）----
    if (!(await isChecked())) {
        for (let attempt = 2; attempt <= 5; attempt++) {
            console.log(`   >> 点击自定义验证码 (第 ${attempt}/5 次)...`);
            try { await box.click({ timeout: 4000 }); } catch (e) {
                try { await box.click({ force: true }); } catch (e2) { }
            }
            for (let i = 0; i < 6; i++) {
                await page.waitForTimeout(500);
                if (await isChecked()) {
                    console.log('   >> ✅ 自定义验证码已勾选');
                    return true;
                }
            }
        }
    }

    console.log('   >> ⚠️ 自定义验证码多次点击仍未勾选');
    return false;
}

// 带重试的页面跳转：瞬时网络错误 (ERR_CONNECTION_CLOSED / RESET / 超时) 时自动重试，
// 常见于第一个账号、或刚走 v2ray 代理时首个请求被掐断。
async function gotoWithRetry(page, url, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            // 如果当前页面崩溃 (chrome-error)，先导航到 about:blank 恢复
            const cur = page.url();
            if (cur.includes('chrome-error') || cur.includes('chromewebdata')) {
                await page.goto('about:blank', { waitUntil: 'load', timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(1000);
            }
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
        console.log('未在 process.env.THEROSE_USERS_JSON 中找到用户');
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

async function getPageToken(page) {
    return await page.evaluate(() => {
        const inp = document.querySelector('input[name="cf-turnstile-response"]');
        if (inp && inp.value && inp.value.length > 20) return inp.value;
        if (typeof window.turnstile !== 'undefined') {
            try {
                const t = window.turnstile.getResponse();
                if (t && t.length > 20) return t;
            } catch (e) { }
        }
        return null;
    }).catch(() => null);
}

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

    if (KV_ENABLED) {
        console.log('[KV] KV Admin Worker 已启用，将缓存登录 cookie 避免重复登录。');
    } else {
        // [KV] 未配置信息已在启动时输出
    }

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        // 兼容 email/username 两种字段名
        if (user.email && !user.username) user.username = user.email;
        if (user.pass && !user.password) user.password = user.pass;
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`); // 隐去具体邮箱 logging

        try {
            const photoDir = path.join(process.cwd(), 'screenshots');
            if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
            if (page.isClosed()) {
                page = await context.newPage();
                // Context credentials apply
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 清掉上一个账号的 cookie，防止跨账号污染
            try { await context.clearCookies(); } catch (e) { }

            const cookieKey = `therose_cookie_${user.username.replace(/[^a-z0-9]/gi, '_')}`;

            // 1. 尝试注入 KV cookie 免登录
            let loggedIn = false;
            const saved = await kvGet(cookieKey);
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    if (cks.length) { await context.addCookies(cks); console.log(`   >> 已注入 KV cookie (${cks.length} 条)`); }
                } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }
                // 用 cookie 直接打开 dashboard 探测是否有效
                await page.goto(SERVERS_URL, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(2000);
                loggedIn = !page.url().includes('/login');
                // 如果 chrome-error (页面崩溃)，cookie 无效
                if (page.url().includes('chrome-error')) loggedIn = false;
                console.log(`   >> cookie ${loggedIn ? '有效，免登录' : '无效/已过期'} (${page.url()})`);
            }

            // 2. cookie 无效或没有 → 完整登录（带重试机制）
            if (!loggedIn) {
                let loginFinalSucceeded = false;
                LOGIN_RETRY:
                for (let loginRetryCount = 1; loginRetryCount <= 2; loginRetryCount++) {
                    if (loginRetryCount > 1) {
                        console.log(`   >> 重新尝试登录 (第 ${loginRetryCount} 次)...`);
                    }

                    // 导航到登录页（首次或重试均适用）
                    if (page.url().includes('chrome-error') || page.url().includes('chromewebdata')) {
                        await page.goto('about:blank').catch(() => {});
                        await page.waitForTimeout(1000);
                    }
                    if (page.url().includes('dashboard')) {
                        await gotoWithRetry(page, `${BASE_URL}/logout`); // may not exist on TheRose
                        await page.waitForTimeout(2000);
                    }
                    await gotoWithRetry(page, LOGIN_URL);
                    await page.waitForTimeout(2000);
                    if (page.url().includes('dashboard')) {
                        await gotoWithRetry(page, `${BASE_URL}/logout`);
                        await page.waitForTimeout(2000);
                        await gotoWithRetry(page, LOGIN_URL);
                    }

                    console.log('正在输入凭据...');
                    try {
                        const emailInput = page.getByRole('textbox', { name: 'Email' });
                        await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                        await emailInput.fill(user.username);
                        await page.waitForTimeout(300);
                        var filledEmail = await emailInput.inputValue();
                        console.log('   >> 输入验证: email=' + (filledEmail ? 'OK' : 'EMPTY'));
                        if (!filledEmail) {
                            console.log('   >> email fill 失败，改用 type...');
                            await emailInput.click();
                            await emailInput.fill('');
                            await page.keyboard.type(user.username, {delay: 50});
                            filledEmail = await emailInput.inputValue();
                            console.log('   >> type 后验证: email=' + (filledEmail ? 'OK' : 'EMPTY'));
                        }
                        const pwdInput = page.getByRole('textbox', { name: 'Password' });
                        await pwdInput.fill(user.password);
                        await page.waitForTimeout(300);
                        var filledPwd = await pwdInput.inputValue();
                        console.log('   >> 输入验证: pwd=' + (filledPwd ? 'OK' : 'EMPTY'));
                        if (!filledPwd) {
                            console.log('   >> pwd fill 失败，改用 type...');
                            await pwdInput.click();
                            await pwdInput.fill('');
                            await page.keyboard.type(user.password, {delay: 50});
                            filledPwd = await pwdInput.inputValue();
                            console.log('   >> type 后验证: pwd=' + (filledPwd ? 'OK' : 'EMPTY'));
                        }
                        await page.waitForTimeout(500);

                        // --- 登录验证码处理 ---
                        const simpleCaptcha = await clickSimpleCaptcha(page);

                        console.log('   >> 正在登录前检查 Turnstile (使用 CDP 绕过)...');
                        let cdpClickResult = false;
                        if (!simpleCaptcha) {
                            for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                                cdpClickResult = await attemptTurnstileCdp(page);
                                if (cdpClickResult) break;
                                await page.waitForTimeout(1000);
                            }
                        }

                        if (simpleCaptcha) {
                            console.log('   >> 登录验证码 (自定义复选框) 已处理。');
                        } else if (cdpClickResult) {
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

                        // 点击 Sign in 按钮
                        var signInBtn = page.locator('button[type="submit"]');
                        if (await signInBtn.isVisible().catch(function(){return false;})) {
                            await signInBtn.click();
                            console.log('   >> Sign in 按钮已点击');
                        } else {
                            console.log('   >> Sign in 按钮不可见，尝试 JS 提交表单');
                            await page.evaluate(function(){var f=document.querySelector('form');if(f)f.submit();});
                        }

                        // Check for incorrect password
                        try {
                            const errorMsg = page.getByText('Incorrect password or no account');
                            if (await errorMsg.isVisible({ timeout: 3000 })) {
                                console.error(`   >> ❌ 登录失败: 用户 ${user.username} 账号或密码错误`);
                                const failShotPath = path.join(photoDir, `${safeUsername}.png`);
                                try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }
                                await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);
                                break LOGIN_RETRY; // 密码错误无需重试，跳出
                            }
                        } catch (e) { }

                        // [修复1] 等待页面跳离 /login，确认登录真正完成
                        // 避免 Turnstile 未通过时静默失败：保存了无效 cookie，后续找不到 Renew 按钮

                        // --- Turnstile token 轮询兜底 ---
                        console.log('   >> 检查 Turnstile token...');
                        let turnstileToken = null;
                        for (let tw = 0; tw < 5; tw++) {
                            turnstileToken = await getPageToken(page);
                            if (turnstileToken) {
                                console.log('   >> 自动验证获取到 token (长度 ' + turnstileToken.length + ')');
                                break;
                            }
                            await page.waitForTimeout(3000);
                        }

                        // 兜底: 尝试 turnstile.execute()
                        if (!turnstileToken) {
                            console.log('   >> 自动验证超时，尝试 turnstile.execute()...');
                            turnstileToken = await page.evaluate(() => {
                                return new Promise((resolve) => {
                                    if (typeof window.turnstile === 'undefined' || !window.turnstile.execute) return resolve(null);
                                    const inp = document.querySelector('input[name="cf-turnstile-response"]');
                                    const wid = inp && inp.id ? inp.id.replace('_response', '') : null;
                                    try {
                                        window.turnstile.execute(wid, {
                                            callback: (t) => resolve(t),
                                            'error-callback': () => resolve(null),
                                        });
                                    } catch (e) { resolve(null); }
                                    setTimeout(() => resolve(null), 15000);
                                });
                            }).catch(() => null);
                            if (turnstileToken) console.log('   >> turnstile.execute() 获取到 token (长度 ' + turnstileToken.length + ')');
                            else console.log('   >> turnstile.execute() 未获取到 token');
                        }

                        // 兜底 2: 尝试 turnstile.render()
                        if (!turnstileToken) {
                            console.log('   >> 尝试 turnstile.render()...');
                            turnstileToken = await page.evaluate(async (sk) => {
                                if (typeof window.turnstile === 'undefined') return null;
                                let container = document.querySelector('.cf-turnstile, [class*="turnstile"], .pteroca-turnstile');
                                if (!container) return null;
                                const existing = document.querySelector('input[name="cf-turnstile-response"]');
                                if (existing && existing.id) {
                                    const wid = existing.id.replace('_response', '');
                                    try { window.turnstile.remove(wid); } catch (e) { }
                                }
                                return new Promise((resolve) => {
                                    const to = setTimeout(() => resolve(null), 25000);
                                    try {
                                        window.turnstile.render(container, {
                                            sitekey: sk,
                                            size: 'compact',
                                            callback: (t) => { clearTimeout(to); resolve(t); },
                                            'error-callback': () => { clearTimeout(to); resolve(null); },
                                        });
                                    } catch (e) { clearTimeout(to); resolve(null); }
                                });
                            }, TURNSTILE_SITEKEY).catch(() => null);
                            if (turnstileToken) console.log('   >> turnstile.render() 获取到 token');
                        }

                        for (let w = 0; w < 30; w++) {
                            await page.waitForTimeout(500);
                            if (!page.url().includes('/login')) {
                                loginFinalSucceeded = true;
                                break;
                            }
                        }
                        if (loginFinalSucceeded) {
                            console.log('   >> 登录成功，已跳离登录页');
                            break LOGIN_RETRY; // 登录成功，退出重试
                        } else {
                            console.log('   >> ⚠️ 点击登录后页面未跳离 /login，Turnstile 验证可能未通过');
                        }

                    } catch (e) {
                        console.log(`登录错误 (第 ${loginRetryCount} 次):`, e.message);
                    }
                    // retry 循环继续
                } // end LOGIN_RETRY

                if (!loginFinalSucceeded) {
                    console.error(`   >> ❌ 登录失败: 用户 ${user.username} 多次尝试后仍无法完成登录`);
                    try { await page.screenshot({ path: path.join(photoDir, `${safeUsername}.png`) }); } catch (e) { }
                    continue; // 跳过该用户
                }
            } // end if (!loggedIn)

            // 3. 登录成功 → 保存 cookie 到 KV
            if (!loggedIn) {
                try { const cookies = await context.cookies(); await kvPut(cookieKey, JSON.stringify(cookies)); } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }
                loggedIn = true;
            }

            if (RENEW_ON_HOME) {
                // aclclouds 等：登录后首页就有 Renew 按钮，无需点 See
                console.log('首页直接续期模式 (DASH_RENEW_ON_HOME)，跳过 "See"。');
            } else {
                console.log('正在寻找 "See" 链接...');
                try {
                    const res = await goToServerPage(page, user);
                    if (!res.ok) {
                        console.log('未找到 "See" 按钮。');
                        continue;
                    }
                    page = res.page; // 可能切换到了新标签页
                    // [修复2] 检测页面是否被重定向到登录页（会话无效）
                    if (page.url().includes('/login')) {
                        console.log('   >> ⚠️ 导航到服务器页后被重定向到登录页，会话无效，跳过该用户');
                        continue;
                    }
                } catch (e) {
                    console.log('进入服务器页失败:', e.message);
                    continue;
                }
            }

            // --- Renew 逻辑 ---
            let renewSuccess = false;
            let notified = false; // 是否已在循环内发过结果通知 (避免循环后重复发失败通知)
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

                // Renew 可能是按钮，也可能是链接 (aclclouds 表格里是 <a>/自定义元素)
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true })
                    .or(page.getByRole('link', { name: 'Renew', exact: true }))
                    .or(page.locator('a,button').filter({ hasText: /^Renew$/i }))
                    .first();
                try {
                    // 稍微等待一下，防止页面刚刷新还没渲染出来
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。');

                    // aclclouds 模式：点 Renew 后可能出现 Anti-bot 弹窗验证，验证后自动续期，只出 toast 提示
                    if (NO_MODAL) {
                        // 等待并处理可能出现的 Anti-bot 验证弹窗
                        try {
                            const antiBotDialog = page.getByRole('dialog').filter({ hasText: /Anti-bot confirmation/i }).first();
                            await antiBotDialog.waitFor({ state: 'visible', timeout: 5000 });
                            console.log('   >> 检测到 Anti-bot 验证弹窗，正在处理验证码...');
                            // 处理自定义复选框 + 可能出现的图形挑战 (clickSimpleCaptcha 已内置完整流程)
                            const captchaOk = await clickSimpleCaptcha(page, antiBotDialog);
                            if (captchaOk) {
                                console.log('   >> ✅ Anti-bot 验证通过，等待续期完成...');
                                // 勾选后弹窗会自动关闭并执行续期
                                await antiBotDialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
                            } else {
                                console.log('   >> ⚠️ Anti-bot 验证码未通过，继续等待结果...');
                            }
                        } catch (e) {
                            console.log('   >> 未检测到 Anti-bot 验证弹窗，或弹窗已自行消失');
                        }
                        const fs = require('fs');
                        const path = require('path');
                        await page.waitForTimeout(3000);
                        let msg = '';
                        for (const sel of ['[role="alert"]', '.toast', '.toast-body', '.notification',
                            '.alert', '.swal2-popup', '.Toastify__toast', '.notyf__toast', '.snackbar']) {
                            const loc = page.locator(sel).first();
                            if (await loc.isVisible().catch(() => false)) {
                                msg = (await loc.innerText().catch(() => '')).trim();
                                if (msg) break;
                            }
                        }
                        const body = await page.locator('body').innerText().catch(() => '');
                        // 基于整页文本分类 (toast 可能没抓到，且表头 "UPCOMING RENEWALS" 含 renew 会误判)
                        const isError = /error while renewing|erreur|échou|failed to renew/i.test(body) || /error|erreur|fail/i.test(msg);
                        const isSuccess = !isError && /renewed successfully|successfully renewed|server renewed|renouvel[ée]|renewal success|renewed!/i.test(body);
                        // 优先用精确短语作为展示消息
                        if (!msg || /upcoming renewals/i.test(msg)) {
                            const em = body.match(/[^\n]*error while renewing[^\n]*/i)
                                || body.match(/[^\n]*(renewed|successfully|renouvel|succ[eè]s)[^\n]*/i);
                            msg = em ? em[0].trim() : (isError ? 'Error while renewing' : '');
                        }
                        // 抓 "Available: 3j 23h" 这类倒计时，告知何时可续
                        const availMatch = body.match(/Available:\s*[^\n<]{1,30}/i);
                        const avail = availMatch ? availMatch[0].trim() : '';
                        console.log(`   >> 续期结果提示: ${msg || '(未捕捉到提示)'}${avail ? ' | ' + avail : ''}`);

                        const photoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                        const shot = path.join(photoDir, `${safeUser}_renew.png`);
                        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }

                        if (isSuccess) {
                            console.log('   >> ✅ 续期成功。');
                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n提示: ${msg}`, shot);
                            renewSuccess = true;
                        } else if (isError) {
                            // "Error while renewing" 基本就是还没到续期时间
                            console.log('   >> ⏳ 暂不可续期 (未到时间)。');
                            await sendTelegramMessage(`⏳ *暂不可续期*\n用户: ${user.username}\n原因: 还没到时间 (${msg})${avail ? '\n' + avail : ''}`, shot);
                            renewSuccess = true; // 视为已处理，非真实失败
                        } else {
                            console.log('   >> ⚠️ 未续期 (结果未知)。');
                            await sendTelegramMessage(`⚠️ *未续期*\n用户: ${user.username}\n提示: ${msg || '未捕捉到提示，详见截图'}`, shot);
                        }
                        notified = true;
                        break; // aclclouds 不需要再循环重试
                    }

                    console.log('   >> 等待模态框...');
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

                    // B. 解决续期验证码
                    console.log('正在处理续期验证码...');
                    const simpleOk = await clickSimpleCaptcha(page, modal);
                    const altchaOk = simpleOk || await solveAltcha(page, modal);
                    if (!altchaOk) {
                        console.log('   >> 验证码未确认通过，本轮稍后仍会尝试点击 Renew。');
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
                    if (RENEW_ON_HOME) {
                        // 首页续期模式：直接刷新首页等 Renew 按钮渲染
                        await page.reload();
                    } else {
                        // 可能仍停在 Dashboard：有 serverUrl 或页面上有 "See" 链接，就重新进入服务器详情页；否则刷新
                        const seeLink = page.getByRole('link', { name: 'See' }).first();
                        if (user.serverUrl || await seeLink.isVisible().catch(() => false)) {
                            console.log('   >> 重新进入服务器页...');
                            try { const res = await goToServerPage(page, user); page = res.page; } catch (e) { }
                        } else {
                            await page.reload();
                        }
                    }
                    await page.waitForTimeout(3000);
                    continue;
                }
            }

            // 循环结束仍未成功且循环内没发过结果通知 → 发送失败通知 (带截图)，不再静默空转
            if (!renewSuccess && !notified) {
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
