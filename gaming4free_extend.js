// Gaming4Free (control.gaming4free.net) 服务器续时脚本 —— 每 5 分钟点 +90 min
// 流程: 加载 KV cookie → 打开 serverUrl → 关广告弹窗 → 点 +90 min → 发通知
// Cookie 获取: 与 gaming4free_checkin.js 共用
// 使用 CloakBrowser (https://github.com/CloakHQ/cloakbrowser) 绕过 Turnstile 验证
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'G4F';

// 读取用户配置 G4F_USERS_JSON = [{"username":"...","serverUrl":"..."}]
let G4F_USERS = [];
try {
    const raw = process.env.G4F_USERS_JSON;
    if (raw) {
        G4F_USERS = JSON.parse(raw);
        if (!Array.isArray(G4F_USERS)) G4F_USERS = [];
    }
} catch (e) {
    console.warn('[配置] G4F_USERS_JSON 解析失败:', e.message);
}
if (G4F_USERS.length === 0) {
    console.error('未在 G4F_USERS_JSON 中找到用户配置');
    process.exit(1);
}
console.log('共 ' + G4F_USERS.length + ' 个用户');

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


process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
const PROXY_STR = HTTP_PROXY || undefined;
if (HTTP_PROXY) console.log(`[代理] 检测到配置: ${HTTP_PROXY}`);

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

// 关掉 Ad Blocker 弹窗和遮罩层
async function dismissAdblockPopup(page) {
    // 1. 尝试点击关闭按钮
    const adBtn = page.locator('button:has-text("I\'ve Disabled My Ad Blocker"), button:has-text("Continue")').first();
    if (await adBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await adBtn.click();
        console.log('   >> 已关闭广告拦截弹窗');
        await page.waitForTimeout(2000);
    }
    // 2. 无论按钮是否可见，总是用 JS 移除遮罩层
    await page.evaluate(() => {
        const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
        for (const id of overlayIds) {
            const el = document.getElementById(id);
            if (el) el.remove();
        }
        document.querySelectorAll('div').forEach(el => {
            const cs = window.getComputedStyle(el);
            if ((cs.position === 'fixed' || cs.position === 'absolute') &&
                cs.zIndex > 50 && !el.id && !el.querySelector('iframe')) {
                el.remove();
            }
        });
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
    console.log('   >> 剩余时间: ' + (remainingTime || '未知'));

    // 读取进度条和 cap 上限，判断是否已满
    const capInfo = await page.evaluate(() => {
        const segs = document.querySelectorAll('.seg-track i');
        const onSegs = document.querySelectorAll('.seg-track i.on');
        const capEl = document.querySelector('.rt-badge-cap');
        return {
            total: segs.length,
            on: onSegs.length,
            cap: capEl ? capEl.textContent.trim() : ''
        };
    }).catch(() => ({ total: 0, on: 0, cap: '' }));
    console.log('   >> 进度: ' + capInfo.on + '/' + capInfo.total + ' 格 | ' + capInfo.cap);

    // 满格判断
    if (capInfo.total > 0 && capInfo.on >= capInfo.total) {
        console.log('   >> ✅ 续时已满 (' + capInfo.cap + ')，无需继续续时');
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
        return { status: 'full', remaining: remainingTime, capInfo: capInfo, shot };
    }

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

    if (/cd|wait/i.test(btnText) && !/90|min/i.test(btnText)) {
        console.log(`   >> 冷却中: ${btnText}`);
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
        return { status: 'cooldown', remaining: remainingTime, shot };
    }

    // 点击续时
    console.log('   >> 点击 +90 min...');
    for (let r = 0; r < 3; r++) {
        await page.evaluate(() => {
            const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
            for (const id of overlayIds) {
                const el = document.getElementById(id);
                if (el) el.remove();
            }
            document.querySelectorAll('div').forEach(el => {
                const cs = window.getComputedStyle(el);
                if ((cs.position === 'fixed' || cs.position === 'absolute') &&
                    el.offsetWidth >= window.innerWidth * 0.8 &&
                    el.offsetHeight >= window.innerHeight * 0.8 &&
                    cs.zIndex > 100 && !el.id && !el.querySelector('iframe')) {
                    el.remove();
                }
            });
            document.body.style.overflow = 'auto';
        }).catch(() => {});
        await page.waitForTimeout(500);

        try {
            await extendBtn.click({ timeout: 5000, force: false });
            console.log('   >> 普通点击成功');
            break;
        } catch (e) {
            console.log('   >> 点击被遮挡(第' + (r+1) + '次)，尝试 force click...');
            if (r === 2) {
                await page.evaluate(() => {
                    document.querySelectorAll('div').forEach(el => {
                        const cs = window.getComputedStyle(el);
                        if ((cs.position === 'fixed' || cs.position === 'absolute') && cs.zIndex > 50) {
                            if (!el.id && !el.querySelector('iframe, button, input')) el.remove();
                        }
                    });
                }).catch(() => {});
                try { await extendBtn.click({ force: true, timeout: 5000 }); } catch (e2) {}
            }
        }
    }
    await page.waitForTimeout(2000);

    // 清除遮罩
    await page.evaluate(() => { const o = document.getElementById('__g4f_adblock_overlay'); if (o) o.remove(); }).catch(() => {});

    // Turnstile 由 CloakBrowser 自动处理，等待几秒让验证完成
    console.log('   >> 等待 Turnstile 自动验证...');
    let turnstileResolved = false;
    for (let t = 0; t < 10; t++) {
        await page.evaluate(() => {
            const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
            for (const id of overlayIds) {
                const el = document.getElementById(id);
                if (el) el.remove();
            }
        }).catch(() => {});

        // 1. 通过 frameLocator 跨域访问 Turnstile iframe 内部并点击复选框
        const turnstileFrame = page.frameLocator('iframe[src*="challenges"], iframe[src*="turnstile"]').first();
        const tsCheckbox = turnstileFrame.locator('[role="checkbox"], input[type="checkbox"]').first();
        if (await tsCheckbox.isVisible({ timeout: 1500 }).catch(() => false)) {
            try { await tsCheckbox.click({ timeout: 2000 }); } catch (e) {}
            console.log('   >> 点击 Turnstile 复选框');
            await page.waitForTimeout(2000);
        }

        // 2. 检查按钮是否进入冷却（= Turnstile 通过）
        const curBtnText = await extendBtn.innerText().catch(() => '');
        if (/cd|wait|loading/i.test(curBtnText) && !/90|min/i.test(curBtnText)) {
            console.log('   >> ✅ Turnstile 验证通过，按钮进入冷却');
            turnstileResolved = true;
            break;
        }

        // 3. 检查 iframe 是否消失
        const hasIframe = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('iframe')).some(f => /turnstile|challenges\.cloudflare/i.test(f.src || '') && f.offsetWidth > 30);
        }).catch(() => true);
        if (!hasIframe) {
            console.log('   >> ✅ Turnstile iframe 已消失，验证通过');
            turnstileResolved = true;
            break;
        }

        await page.waitForTimeout(2000);
    }
    if (!turnstileResolved) console.log('   >> ⚠️ Turnstile 未在超时内解决');

    await page.evaluate(() => {
        const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
        for (const id of overlayIds) {
            const el = document.getElementById(id);
            if (el) el.remove();
        }
    }).catch(() => {});

    // 解析剩余时间 → 秒数
    function parseTime(str) {
        if (!str) return 0;
        const m = str.match(/(\d{2}):(\d{2}):(\d{2})/);
        if (!m) return 0;
        return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
    }
    const oldSeconds = parseTime(remainingTime);

    // 等候续时生效（最多 ~40 秒）
    console.log('   >> 等候续时生效...');
    let extendOk = false;
    for (let w = 0; w < 20; w++) {
        await page.evaluate(() => {
            const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
            for (const id of overlayIds) {
                const el = document.getElementById(id);
                if (el) el.remove();
            }
        }).catch(() => {});

        const curBtnText = await extendBtn.innerText().catch(() => '');
        if (/cd|wait|loading/i.test(curBtnText) && !/90|min/i.test(curBtnText)) {
            console.log('   >> 按钮进入冷却，续时成功');
            extendOk = true;
            break;
        }
        const curTime = await page.locator('.time span, [class*="time"] span').first().innerText().catch(() => '');
        const curSeconds = parseTime(curTime);
        if (curSeconds > oldSeconds + 30) {
            console.log('   >> 剩余时间已增加，续时成功 (' + remainingTime + ' → ' + curTime + ')');
            extendOk = true;
            break;
        }
        await page.waitForTimeout(2000);
    }

    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}

    let newRemaining = '';
    for (let w = 0; w < 5; w++) {
        const timeEl = page.locator('.time span, [class*="time"] span').first();
        newRemaining = await timeEl.innerText().catch(() => '');
        if (newRemaining && /\d{2}:\d{2}:\d{2}/.test(newRemaining)) break;
        await page.waitForTimeout(1000);
    }
    console.log('   >> 续时后剩余: ' + (newRemaining || '未知'));

    return { status: 'extended', remaining: newRemaining || remainingTime, oldRemaining: remainingTime, shot };
}

(async () => {
    const { launch } = await import('cloakbrowser');
    console.log('[CloakBrowser] 模块加载成功');
    if (G4F_USERS.length === 0) {
        console.error('未配置用户 (G4F_USERS_JSON)');
        process.exit(1);
    }
    console.log('共 ' + G4F_USERS.length + ' 个用户');

    // 使用 CloakBrowser 启动浏览器（自带指纹修补，可过 Turnstile）
    console.log('[CloakBrowser] 正在启动...');
    const launchOpts = {
        headless: false,
        humanize: true,
    };
    if (PROXY_STR) {
        launchOpts.proxy = PROXY_STR;
        console.log('[CloakBrowser] 使用代理:', PROXY_STR);
    }
    const browser = await launch(launchOpts);
    console.log('[CloakBrowser] 启动成功');

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    const context = page.context();

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    // 逐个用户续时
    const results = [];
    for (const user of G4F_USERS) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        const serverUrl = user.serverUrl;
        if (!serverUrl) {
            console.log('用户 ' + safeUser + ' 未配置 serverUrl，跳过');
            continue;
        }

        const cookieKey = 'gaming4free_cookie_' + safeUser;
        const cookieStr = await kvGet(cookieKey);
        if (cookieStr) {
            try {
                const cks = normalizeCookies(JSON.parse(cookieStr));
                await context.clearCookies().catch(() => {});
                await context.addCookies(cks);
                console.log('   >> [' + safeUser + '] 已注入 cookie (' + cks.length + ' 条)');
            } catch (e) {
                console.warn('   >> [' + safeUser + '] cookie 解析失败:', e.message);
            }
        }

        try {
            const r = await withTimeout(extendServer(page, serverUrl, photoDir), 90000, '续时 ' + safeUser);
            results.push({ serverUrl, user: safeUser, ...r });
        } catch (e) {
            console.error('用户 ' + safeUser + ' 出错:', e.message);
            results.push({ serverUrl, user: safeUser, status: 'error', shot: '' });
        }
        await page.waitForTimeout(1000);
    }

    // 汇总通知
    const extended = results.filter(r => r.status === 'extended');
    const cooldown = results.filter(r => r.status === 'cooldown');
    const full = results.filter(r => r.status === 'full');

    if (full.length > 0) {
        const fullList = full.map(r => {
            const sid = (r.serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            const cap = r.capInfo ? r.capInfo.cap : '48h cap';
            return '  ' + escapeMd(r.user) + ' / `' + sid + '`: ' + escapeMd(cap) + ' 已满';
        }).join('\n');
        const stillGoing = extended.length > 0 ? '\n' + extended.length + ' 个已续时' : '';
        const cooling = cooldown.length > 0 ? '\n' + cooldown.length + ' 个冷却中' : '';
        await sendTelegramMessage('✅ *续时已达上限*\n' + fullList + stillGoing + cooling);
    }

    if (extended.length > 0) {
        for (const r of extended) {
            const sid = (r.serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            const msg = '✅ *续时成功*\n用户: ' + escapeMd(r.user) + '\n服务器: `' + sid + '`\n剩余: ' + escapeMd(r.remaining || '?') + '\n时间: ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            await sendTelegramMessage(msg, r.shot);
        }
    }
    if (cooldown.length > 0 && extended.length === 0 && full.length === 0) {
        const waitingList = cooldown.map(r => {
            const sid = (r.serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            return '  ' + escapeMd(r.user) + ' / `' + sid + '`: 剩余 ' + escapeMd(r.remaining || '?');
        }).join('\n');
        await sendTelegramMessage('⏳ *续时冷却中*\n暂无可用续时\n\n当前剩余:\n' + waitingList);
    }

    console.log('\n完成。');
    await browser.close();
    process.exit(0);
})();
