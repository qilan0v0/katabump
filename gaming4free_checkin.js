// Gaming4Free (control.gaming4free.net) 每日签到脚本 —— 仅支持 Cookie 登录 (OAuth 无法自动化)
// 流程: 加载 KV 中的 cookie → 打开签到页 → 点击签到弹窗 → 截图通知
// Cookie 获取: 在本地浏览器用 Google/Discord 登录后，导出 cookie JSON 上传到 KV Admin 面板
// 账号来源: Secret G4F_COOKIE_JSON (备用，优先读 KV)
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const CLAIM_URL = 'https://control.gaming4free.net/'; // 签到弹窗在首页 (Servers 页) 就显示了

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'G4F';

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
        // sameSite 映射：Playwright 只接受 Strict/Lax/None
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

// 转义 Telegram Markdown 特殊字符：这些字符在 parse_mode=Markdown 时会被解析
function escapeMd(s) {
    if (typeof s !== 'string') return s || '';
    // 需要转义的字符: _ * [ ] ( ) ~ ` > # + - = | { } . !
    // 在 parse_mode=Markdown (非 MarkdownV2) 下，实际只转义 _ * ` [
    return s.replace(/_/g, '\\_').replace(/\*/g, '\\*').replace(/`/g, '\\`').replace(/\[/g, '\\[');
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

// 给任意 promise 套超时
function _race(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), ms))]);
}

(async () => {
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

    // 读取用户配置 G4F_USERS_JSON
    let g4fUsers = [];
    try {
        const raw = process.env.G4F_USERS_JSON;
        if (raw) {
            g4fUsers = JSON.parse(raw);
            if (!Array.isArray(g4fUsers)) g4fUsers = [];
        }
    } catch (e) {
        console.warn('[配置] G4F_USERS_JSON 解析失败:', e.message);
    }
    if (g4fUsers.length === 0) {
        console.error('未在 G4F_USERS_JSON 中找到用户');
        process.exit(1);
    }
    console.log('共 ' + g4fUsers.length + ' 个用户');

    // 预热: 先加载一次首页，让浏览器缓存资源，后续用户导航更快（解决首次加载慢的问题）
    console.log('预热首页...');
    await gotoWithRetry(page, CLAIM_URL).catch(() => {});
    await page.waitForTimeout(2000);

    for (let ui = 0; ui < g4fUsers.length; ui++) {
        const user = g4fUsers[ui];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        const shotPath = path.join(photoDir, 'gaming4free_' + safeUser + '.png');
        console.log('\n=== 用户 ' + (ui + 1) + '/' + g4fUsers.length + ': ' + safeUser + ' ===');

        try {
            // 清掉上一个用户的 cookie 会话
            try { await context.clearCookies(); } catch (e) {}

            // 1. 加载该用户的 cookie
            const cookieKey = 'gaming4free_cookie_' + safeUser;
            let cookieStr = await kvGet(cookieKey);

        // 备用：从环境变量读
        if (!cookieStr && process.env.G4F_COOKIE_JSON) {
            cookieStr = process.env.G4F_COOKIE_JSON;
            console.log('[KV] 从环境变量 G4F_COOKIE_JSON 读取 cookie');
        }

        if (!cookieStr) {
            console.error('未找到 cookie（KV 和 G4F_COOKIE_JSON 都没有）。请先在浏览器登录后导出 cookie 上传到 KV Admin 面板 (key: ' + escapeMd('gaming4free_cookie_' + safeUser) + ')');
            await sendTelegramMessage('❌ *Gaming4Free 签到失败*\n\n未找到 cookie: ' + escapeMd(safeUser) + '\n请先在浏览器登录后导出 cookie 上传到 KV Admin\n→ 面板新增 → Gaming4Free → 标识: ' + escapeMd(safeUser) + ' → 粘贴 cookie JSON → 保存');
            continue;
        }

        try {
            const cks = normalizeCookies(JSON.parse(cookieStr));
            await context.addCookies(cks);
            console.log('   >> 已注入 cookie (' + cks.length + ' 条)');
            // 检查 cookie 中关键会话字段
            const hasSession = cookieStr.includes('pelican_session');
            const hasRemember = cookieStr.includes('remember_web');
            console.log(`   >> cookie 有效期检查: session=${hasSession ? '✓' : '✗'} remember=${hasRemember ? '✓' : '✗'}`);
        } catch (e) {
            console.error('cookie 解析失败:', e.message);
            await sendTelegramMessage('❌ *Gaming4Free 签到失败*\ncookie 解析失败: ' + e.message + '\n请重新导出并上传 cookie');
            continue;
        }

        // 2. 导航到首页（签到弹窗在服务器列表页就显示了）
        console.log('打开首页: ' + CLAIM_URL);
        // 先清广告遮罩再导航
        await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});
        await gotoWithRetry(page, CLAIM_URL);
        // 等待页面渲染完成 — 检测到签到面板、登录重定向或页面内容即继续
        try {
            await page.waitForFunction(() => {
                return window.location.href.includes('/login')
                    || document.querySelector('.lsm-card')
                    || document.querySelector('.lsm-claim-btn')
                    || document.querySelector('.lsm-header-text')
                    || (document.body && document.body.innerText.trim().length > 20);
            }, { timeout: 20000 });
        } catch (e) {
            console.log('   >> 等待页面渲染超时(20s)，继续处理...');
        }
        await page.waitForTimeout(2000); // 额外等动画完成

        // 关广告弹窗和遮罩
        for (let c = 0; c < 3; c++) {
            await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});
            const adBtn = page.locator('button:has-text("I\'ve Disabled")').first();
            if (await adBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
                await adBtn.click();
                console.log('   >> 已关闭广告拦截弹窗');
                await page.waitForTimeout(2000);
            }
        }

        // 3. 检查是否已登录（页面是否跳回登录页）
        if (page.url().includes('/login')) {
            console.log('   >> cookie 已过期，被重定向到登录页');
            await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
            await sendTelegramMessage('❌ *Gaming4Free 签到失败*\ncookie 已过期 用户: ' + escapeMd(safeUser) + '\n请重新在浏览器登录后导出 cookie\n→ 打开 KV 管理面板 → 找到 ' + escapeMd('gaming4free_cookie_' + safeUser) + ' → 编辑 → 粘贴新 cookie → 保存', shotPath);
            continue;
        }

        console.log('   >> 当前 URL:', page.url());

        // 读取页面整体状态（余额、弹窗等）
        const pageState = await page.evaluate(() => {
            const body = document.body ? document.body.innerText : '';
            const balanceMatch = body.match(/\$?([0-9]+\.[0-9]+)\s*credits?/i);
            const balance = balanceMatch ? balanceMatch[0] : '';
            return { balance };
        }).catch(() => ({}));

        // 4. 查找签到弹窗，提取签到信息
        // 页面结构: lsm-card 弹窗中有 ⚡ Claim Daily Reward 按钮 (class: lsm-claim-btn)
        let claimed = false;
        let dayText = '';
        let rewardText = '';
        let streakInfo = '';

        // 先提取弹窗中的信息（不管有没有签到按钮都先读）
        const modalInfo = await page.evaluate(() => {
            const info = { day: '', reward: '', streak: '' };
            // 读取签到天数
            const welcomeEl = document.querySelector('.lsm-header-text');
            if (welcomeEl) {
                const text = welcomeEl.textContent || '';
                const dayMatch = text.match(/Day\s*(\d+)/i);
                if (dayMatch) info.day = dayMatch[0];
                // 剩余描述文字
                info.streak = text.replace(/Day\s*\d+/i, '').trim();
            }
            // 读取奖励金额
            const rewardEl = document.querySelector('.lsm-reward-lbl');
            const rewardSubEl = document.querySelector('.lsm-reward-text');
            if (rewardSubEl) {
                info.reward = rewardSubEl.textContent.trim();
            } else if (rewardEl) {
                info.reward = rewardEl.textContent.trim();
            }
            // 读取里程碑进度
            const body = document.body ? document.body.innerText : '';
            const bonusMatch = body.match(/(\d+) more days to ([\s\S]*?)(?:\n|$)/i);
            if (bonusMatch) {
                info.streak = (info.streak ? info.streak + ' | ' : '') + bonusMatch[1] + ' days to ' + bonusMatch[2].trim();
            }
            return info;
        }).catch(() => ({}));

        dayText = modalInfo.day || '';
        rewardText = modalInfo.reward || '';
        streakInfo = modalInfo.streak || '';

        console.log(`   >> 签到面板: ${dayText} | ${rewardText}${streakInfo ? ' | ' + streakInfo : ''}`);

        for (let w = 0; w < 20; w++) {
            // 检查弹窗是否可见 (lsm-card 或 lsm-claim-btn)
            const claimBtn = page.locator('.lsm-claim-btn, button:has-text("Claim Daily Rewar"), button:has-text("⚡")').first();
            if (await claimBtn.isVisible().catch(() => false)) {
                const btnText = await claimBtn.innerText().catch(() => '');
                console.log('   >> 找到签到按钮: "' + btnText + '"');
                // 尝试普通点击，如果被广告遮罩阻挡则用 force
                try { await claimBtn.click({ timeout: 5000 }); }
                catch (e) {
                    // 移除广告遮罩再试
                    await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});
                    await page.waitForTimeout(500);
                    try { await claimBtn.click({ force: true, timeout: 5000 }); }
                    catch (e2) { console.log('   >> 点击失败:', e2.message); continue; }
                }
                console.log('   >> ✅ 已点击签到按钮');
                await page.waitForTimeout(5000);
                claimed = true;
                break;
            }

            // 也检查普通按钮文本
            const anyClaim = page.locator('button:has-text("Claim")').first();
            if (await anyClaim.isVisible().catch(() => false)) {
                try { await anyClaim.click({ timeout: 5000 }); }
                catch (e) {
                    await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});
                    await page.waitForTimeout(500);
                    try { await anyClaim.click({ force: true, timeout: 5000 }); } catch (e2) {}
                }
                console.log('   >> ✅ 已点击 Claim 按钮');
                await page.waitForTimeout(5000);
                claimed = true;
                break;
            }

            await page.waitForTimeout(1000);
        }

        // 截图
        try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) {}

        if (claimed) {
            console.log('   >> ✅ 签到成功');
            // 签到后读取余额
            let balanceText = '';
            for (let w = 0; w < 5; w++) {
                const postBody = await page.locator('body').innerText().catch(() => '');
                const balMatch = postBody.match(/\$?([0-9]+\.[0-9]+)\s*credits?/i);
                if (balMatch) { balanceText = balMatch[0]; break; }
                await page.waitForTimeout(1000);
            }
            const detail = [escapeMd(dayText), escapeMd(rewardText), escapeMd(streakInfo), balanceText ? '余额: ' + balanceText : ''].filter(Boolean).join(' | ');
            await sendTelegramMessage(
                `✅ *Gaming4Free 签到成功*\n` +
                '用户: ' + escapeMd(safeUser) + '\n' +
                (detail ? `\n${detail}` : '') +
                `\n\n签到时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
                shotPath
            );
        } else {
            // 没找到签到按钮，可能是已经签过到了，或者页面结构变了
            const bodyText = await page.locator('body').innerText().catch(() => '');
            const alreadyClaimed = /already|claimed|collected|已签到|已领取|today|Day \d+|Welcome/i.test(bodyText) && !/Claim Daily/i.test(bodyText);
            if (alreadyClaimed) {
                // 读取当前余额
                let balanceText = '';
                const balMatch = bodyText.match(/\$?([0-9]+\.[0-9]+)\s*credits?/i);
                if (balMatch) balanceText = balMatch[0];
                const detail = [escapeMd(dayText), escapeMd(rewardText), escapeMd(streakInfo), balanceText ? '余额: ' + balanceText : ''].filter(Boolean).join(' | ');
                console.log('   >> ⚠️ 今日已签到（未显示签到按钮）');
                await sendTelegramMessage(
                    `✅ *Gaming4Free 今日已签到*\n` +
                    '用户: ' + escapeMd(safeUser) + '\n' +
                    `无需重复签到${detail ? '\n' + detail : ''}\n` +
                    `\n签到时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
                    shotPath
                );
            } else {
                console.log('   >> ⚠️ 未找到签到按钮，可能页面结构已变更');
                // 尝试读取页面关键信息辅助排查
                const bodyText = await page.locator('body').innerText().catch(() => '');
                const pageInfo = {
                    url: page.url(),
                    hasBalance: bodyText.includes('BALANCE') || bodyText.includes('$'),
                    hasCreateServer: bodyText.includes('Create Free Server') || bodyText.includes('CHOOSE YOUR GAME'),
                    bodyLength: bodyText.length,
                };
                await sendTelegramMessage(
                    `⚠️ *Gaming4Free 签到结果未知*\n` +
                    '用户: ' + escapeMd(safeUser) + '\n' +
                    `URL: ${escapeMd(pageInfo.url)}\n` +
                    `页面状态: ${pageInfo.hasBalance ? '已登录' : '未登录'} | ${pageInfo.hasCreateServer ? '创建页可见' : '页面异常'}\n` +
                    `提示: 未找到签到按钮，可能页面已变更请手动检查\n` +
                    `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
                    shotPath
                );
            }
        }
    } catch (err) {
        console.error('签到出错:', err.message);
        try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) {}
        await sendTelegramMessage(
            `❌ *Gaming4Free 签到异常*\n` +
            '用户: ' + escapeMd(safeUser) + '\n' +
            `URL: ${page.url()}\n` +
            `错误: ${err.message}\n` +
            `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
            shotPath
        );
    }
    } // end for loop over users

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
