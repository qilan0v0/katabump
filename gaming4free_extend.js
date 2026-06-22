// Gaming4Free (control.gaming4free.net) 服务器续时脚本 —— 每 5 分钟点 +90 min
// 流程: 加载 KV cookie → 打开 serverUrl → 关广告弹窗 → 点 +90 min → 发通知
// Cookie 获取: 与 gaming4free_checkin.js 共用
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'G4F';

// 服务器管理地址，从环境变量或 secret 读取，逗号分隔
const SERVER_URLS = (process.env.G4F_SERVER_URLS || 'https://control.gaming4free.net/server/982a3aff/console').split(',').map(s => s.trim()).filter(Boolean);

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

// 转义 Telegram Markdown 特殊字符
function escapeMd(s) {
    if (typeof s !== 'string') return s || '';
    return s.replace(/_/g, '\\_').replace(/\*/g, '\\*').replace(/`/g, '\\`').replace(/\[/g, '\\[');
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

// --- KV Admin Worker ---
const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);

if (!KV_ENABLED) console.log('[KV] 未配置 KV_ADMIN_URL/KV_ADMIN_PASS，跳过 cookie');

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
        console.warn('[KV] 读取失败:', e.message);
        return null;
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
        if (c.sameSite && typeof c.sameSite === 'string') {
            var s = c.sameSite.toLowerCase();
            if (s === 'no_restriction' || s === 'none') out.sameSite = 'None';
            else if (s === 'lax') out.sameSite = 'Lax';
            else if (s === 'strict') out.sameSite = 'Strict';
        }
        if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
        else if (typeof c.expirationDate === 'number' && c.expirationDate > 0) out.expires = c.expirationDate;
        return out;
    });
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
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

function _race(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), ms))]);
}

// 关掉 Ad Blocker 弹窗和遮罩层
async function dismissAdblockPopup(page) {
    // 1. 尝试点击关闭按钮
    const adBtn = page.locator('button:has-text("I\'ve Disabled My Ad Blocker"), button:has-text("Continue")').first();
    if (await adBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await adBtn.click();
        console.log('   >> 已关闭广告拦截弹窗');
        await page.waitForTimeout(2000);
    }
    // 2. 无论按钮是否可见，总是用 JS 移除遮罩层（防止遮罩层残留拦截点击）
    await page.evaluate(() => {
        const overlay = document.getElementById('__g4f_adblock_overlay');
        if (overlay) { overlay.remove(); return true; }
        return false;
    }).catch(() => false);
}

// 给 promise 套整体超时
function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// 处理单个服务器的续时
async function extendServer(page, serverUrl, photoDir) {
    const sid = (serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || 'srv';
    const shot = path.join(photoDir, `g4f_extend_${sid}.png`);
    console.log(`\n--- 服务器 ${sid} ---`);
    console.log(`打开: ${serverUrl}`);

    await gotoWithRetry(page, serverUrl);
    await page.waitForTimeout(4000);

    // 关广告弹窗
    await dismissAdblockPopup(page);

    // 读取当前剩余时间
    let remainingTime = '';
    for (let w = 0; w < 10; w++) {
        const timeEl = page.locator('.time span, [class*="time"] span').first();
        const text = await timeEl.innerText().catch(() => '');
        if (text && /\d{2}:\d{2}:\d{2}/.test(text)) {
            remainingTime = text;
            break;
        }
        await page.waitForTimeout(1000);
    }
    console.log(`   >> 剩余时间: ${remainingTime || '未知'}`);

    // 找 +90 min 按钮
    const extendBtn = page.locator('button.rt-btn-free:not(.disabled)').first();
    const btnVisible = await extendBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (!btnVisible) {
        console.log('   >> +90 min 按钮不可见（可能是冷却中或无按钮）');
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
        return { status: 'cooldown', remaining: remainingTime, shot };
    }

    const btnText = await extendBtn.innerText().catch(() => '');
    console.log(`   >> 按钮文字: "${btnText}"`);

    // 如果按钮文字含 'cd' 说明在冷却
    if (/cd|wait/i.test(btnText) && !/90|min/i.test(btnText)) {
        console.log(`   >> 冷却中: ${btnText}`);
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
        return { status: 'cooldown', remaining: remainingTime, shot };
    }

    // 点击续时
    console.log('   >> 点击 +90 min...');
    try {
        await extendBtn.click({ timeout: 10000 });
    } catch (e) {
        console.log('   >> 普通点击失败(${e.message})，尝试 force 点击...');
        try { await extendBtn.click({ force: true, timeout: 5000 }); }
        catch (e2) { console.log('   >> force 点击也失败:', e2.message); }
    }
    await page.waitForTimeout(5000);

    // 等待按钮文本变化（冷却）或弹 captcha
    let newBtnText = '';
    for (let w = 0; w < 10; w++) {
        newBtnText = await extendBtn.innerText().catch(() => '');
        if (/cd|wait/i.test(newBtnText) || newBtnText.includes('loading')) {
            console.log(`   >> ✅ 续时成功，按钮变为: "${newBtnText}"`);
            break;
        }
        await page.waitForTimeout(1000);
    }

    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}

    // 再次读取剩余时间
    let newRemaining = '';
    for (let w = 0; w < 5; w++) {
        const timeEl = page.locator('.time span, [class*="time"] span').first();
        newRemaining = await timeEl.innerText().catch(() => '');
        if (newRemaining && /\d{2}:\d{2}:\d{2}/.test(newRemaining)) break;
        await page.waitForTimeout(1000);
    }
    console.log(`   >> 续时后剩余: ${newRemaining || '未知'}`);

    return { status: 'extended', remaining: newRemaining || remainingTime, oldRemaining: remainingTime, shot };
}

(async () => {
    if (SERVER_URLS.length === 0) {
        console.error('未配置服务器地址 (G4F_SERVER_URLS)');
        process.exit(1);
    }
    console.log(`目标服务器: ${SERVER_URLS.join(', ')}`);

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

    // 加载 cookie
    const cookieKey = 'gaming4free_cookie_g4f_user';
    const cookieStr = await kvGet(cookieKey);
    if (cookieStr) {
        try {
            const cks = normalizeCookies(JSON.parse(cookieStr));
            await context.addCookies(cks);
            console.log('   >> 已注入 cookie (' + cks.length + ' 条)');
        } catch (e) {
            console.warn('cookie 解析失败:', e.message);
        }
    }

    // 逐个服务器续时
    const results = [];
    for (const serverUrl of SERVER_URLS) {
        try {
            const r = await withTimeout(extendServer(page, serverUrl, photoDir), 60000, `续时 ${serverUrl}`);
            results.push({ serverUrl, ...r });
        } catch (e) {
            console.error(`服务器 ${serverUrl} 出错:`, e.message);
            results.push({ serverUrl, status: 'error', shot: '' });
        }
        await page.waitForTimeout(1000);
    }

    // 汇总通知
    const extended = results.filter(r => r.status === 'extended');
    const cooldown = results.filter(r => r.status === 'cooldown');

    if (extended.length > 0) {
        for (const r of extended) {
            const sid = (r.serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            const msg = `✅ *续时成功*\n服务器: \`${sid}\`\n剩余: ${escapeMd(r.remaining || '?')}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
            await sendTelegramMessage(msg, r.shot);
        }
    }
    if (cooldown.length > 0 && extended.length === 0) {
        // 全部冷却中，只发一条汇总
        const waitingList = cooldown.map(r => {
            const sid = (r.serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            return `  \`${sid}\`: 剩余 ${escapeMd(r.remaining || '?')}`;
        }).join('\n');
        await sendTelegramMessage(`⏳ *续时冷却中*\n暂无可用续时\n\n当前剩余:\n${waitingList}`);
    }

    console.log('\n完成。');
    await browser.close();
    process.exit(0);
})();
