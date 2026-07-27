// Gaming4Free (control.gaming4free.net) 服务器续时脚本 —— 循环点 +90 min 直到满格
// 流程: 加载 KV cookie → 打开 serverUrl → 循环(读进度→满格则停→点+90min→等冷却→刷新) → 满格发通知
// Cookie 获取: 与 gaming4free_checkin.js 共用

// 单次续时尝试（点一次 +90 min 并确认生效）
// 返回: { ok, newRemaining, capInfo }
async function extendOnce(page, extendBtn, shot, oldSeconds) {
    // 找 +90 min 按钮（已由调用方判断可见性）
    const btnText = await extendBtn.innerText().catch(() => '');
    console.log(`   >> 按钮文字: "${btnText}"`);

    if (/cd|wait/i.test(btnText) && !/90|min/i.test(btnText)) {
        console.log(`   >> 冷却中: ${btnText}`);
        return { ok: false, cooldown: true, btnText };
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

    // === Turnstile 验证 + 续时生效 合并循环 ===
    console.log('   >> 等待 Turnstile 验证 + 续时生效...');

    let extendOk = false;
    let cooldownText = '';

    for (let t = 0; t < 40; t++) {
        await page.evaluate(() => {
            const overlayIds = ['__g4f_adblock_overlay', 'adblock-overlay', 'overlay', 'modal-overlay'];
            for (const id of overlayIds) {
                const el = document.getElementById(id);
                if (el) el.remove();
            }
        }).catch(() => {});

        // 1. 检查按钮是否已冷却
        const curBtnText = await extendBtn.innerText().catch(() => '');
        if (/cd|wait|loading/i.test(curBtnText) && !/90|min/i.test(curBtnText)) {
            cooldownText = curBtnText;
            console.log('   >> ✅ Turnstile 验证通过，按钮已冷却，续时成功');
            extendOk = true;
            break;
        }

        // 2. 剩余时间增加
        const curTimeText = await page.locator('.time span, [class*="time"] span').first().innerText().catch(() => '');
        const curSeconds = parseTime(curTimeText);
        if (curSeconds > oldSeconds + 30) {
            console.log('   >> ✅ 剩余时间已增加，续时成功 (' + formatTime(oldSeconds) + ' → ' + curTimeText + ')');
            extendOk = true;
            break;
        }

        // 3. CDP 点 Turnstile
        const cdpOk = await attemptTurnstileCdp(page);
        if (cdpOk) {
            console.log('   >> ✅ CDP 已点击 Turnstile 复选框，等 Cloudflare 验证...');
            await page.waitForTimeout(4000);
        } else {
            await page.waitForTimeout(2000);
        }
    }

    if (extendOk) {
        console.log('   >> ✅ 续时已生效');
    } else {
        console.log('   >> ⚠️ 续时在超时内未确认生效');
    }

    let newRemaining = '';
    for (let w = 0; w < 5; w++) {
        const timeEl = page.locator('.time span, [class*="time"] span').first();
        newRemaining = await timeEl.innerText().catch(() => '');
        if (newRemaining && /\d{2}:\d{2}:\d{2}/.test(newRemaining)) break;
        await page.waitForTimeout(1000);
    }
    console.log('   >> 续时后剩余: ' + (newRemaining || '未知'));

    return { ok: extendOk, newRemaining, cooldownText };
}

// 解析剩余时间 → 秒数
function parseTime(str) {
    if (!str) return 0;
    const m = str.match(/(\d{2}):(\d{2}):(\d{2})/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
    // 也兼容 MM:SS 形式（冷却倒计时）
    const m2 = str.match(/(\d{1,2}):(\d{2})/);
    if (m2) return parseInt(m2[1]) * 60 + parseInt(m2[2]);
    return 0;
}

// 秒数 → HH:MM:SS
function formatTime(sec) {
    if (!sec || sec < 0) return '00:00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

// 解析按钮冷却文字 → 秒数（用于等待）
function parseCooldown(btnText) {
    if (!btnText) return 0;
    // HH:MM:SS
    let m = btnText.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
    // MM:SS
    m = btnText.match(/(\d{1,2}):(\d{2})/);
    if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
    // 纯数字秒
    m = btnText.match(/(\d+)\s*s/i);
    if (m) return parseInt(m[1]);
    return 0;
}

// 读取当前进度与剩余时间
async function readStatus(page) {
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
    return { remainingTime, capInfo };
}

// === CDP Turnstile Bypass: 劫持 attachShadow 捕获 checkbox 坐标 ===
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        const orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const sr = orig.call(this, init);
            if (sr) {
                const check = () => {
                    const cb = sr.querySelector('input[type="checkbox"]');
                    if (cb) {
                        const r = cb.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            window.__turnstile_data = {
                                xRatio: (r.left + r.width / 2) / window.innerWidth,
                                yRatio: (r.top + r.height / 2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                    return false;
                };
                if (!check()) {
                    const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
                    mo.observe(sr, { childList: true, subtree: true });
                }
            }
            return sr;
        };
    } catch(e) {}
})();
`;
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

// 支持 G4F_USER_INDEX 环境变量指定运行第几个用户（1-indexed）
const userIndex = parseInt(process.env.G4F_USER_INDEX || '', 10);
if (userIndex > 0 && userIndex <= G4F_USERS.length) {
    G4F_USERS = [G4F_USERS[userIndex - 1]];
    console.log('仅运行第 ' + userIndex + ' 个用户: ' + G4F_USERS[0].username);
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

// 等待冷却结束：原地轮询按钮文字直到按钮恢复可点（不再显示冷却倒计时）
// 返回 true 表示按钮已恢复可点，false 表示超时
async function waitForCooldownEnd(page, extendBtn, maxWaitMs = 300000) {
    const start = Date.now();
    let lastText = '';
    while (Date.now() - start < maxWaitMs) {
        const btnText = await extendBtn.innerText().catch(() => '');
        // 按钮恢复可点：不再含 cd/wait/loading 倒计时，或重新出现 90/min
        if (btnText && !/cd|wait|loading/i.test(btnText)) {
            console.log('   >> 按钮已恢复可点: "' + btnText + '"');
            return true;
        }
        // 每 10s 报告一次当前冷却状态
        if (btnText !== lastText) {
            lastText = btnText;
            console.log('   >> 冷却中: "' + btnText + '"');
        }
        await page.waitForTimeout(5000);
    }
    console.log('   >> 等待冷却超时(' + (maxWaitMs/1000) + 's)，强制进入下一轮');
    return false;
}

// 处理单个服务器的续时 —— 循环点 +90 min 直到满格
async function extendServer(page, serverUrl, photoDir) {
    const sid = (serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || 'srv';
    const shot = path.join(photoDir, `g4f_extend_${sid}.png`);
    console.log(`\n--- 服务器 ${sid} ---`);
    console.log(`打开: ${serverUrl}`);

    const MAX_ROUNDS = parseInt(process.env.MAX_ROUNDS || '10', 10);
    let rounds = 0;
    let lastCapInfo = { total: 0, on: 0, cap: '' };
    let lastRemaining = '';
    let successRounds = 0; // 成功续时次数
    let finalStatus = 'partial';

    while (rounds < MAX_ROUNDS) {
        rounds++;
        console.log(`\n=== 第 ${rounds}/${MAX_ROUNDS} 轮 ===`);

        await gotoWithRetry(page, serverUrl);
        await page.waitForTimeout(4000);
        await dismissAdblockPopup(page);

        const { remainingTime, capInfo } = await readStatus(page);
        lastCapInfo = capInfo;
        lastRemaining = remainingTime;
        console.log('   >> 剩余时间: ' + (remainingTime || '未知'));
        console.log('   >> 进度: ' + capInfo.on + '/' + capInfo.total + ' 格 | ' + capInfo.cap);

        // 满格判断
        if (capInfo.total > 0 && capInfo.on >= capInfo.total) {
            console.log('   >> ✅ 续时已满 (' + capInfo.cap + ')，停止循环');
            finalStatus = 'full';
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
            break;
        }

        const oldSeconds = parseTime(remainingTime);

        // 找 +90 min 按钮
        const extendBtn = page.locator('button.rt-btn-free:not(.disabled)').first();
        const btnVisible = await extendBtn.isVisible({ timeout: 5000 }).catch(() => false);

        if (!btnVisible) {
            console.log('   >> +90 min 按钮不可见，等待后重试...');
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
            await page.waitForTimeout(30000); // 30s 后重试
            continue;
        }

        // 尝试续时一次
        const once = await extendOnce(page, extendBtn, shot, oldSeconds);
        if (once.ok) successRounds++;

        // 续时后重新读取进度
        await page.waitForTimeout(1500);
        const after = await readStatus(page);
        lastCapInfo = after.capInfo;
        lastRemaining = after.remainingTime || once.newRemaining || remainingTime;
        console.log('   >> 本轮后进度: ' + after.capInfo.on + '/' + after.capInfo.total + ' 格 | 剩余 ' + (lastRemaining || '未知'));

        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}

        // 满格则停
        if (after.capInfo.total > 0 && after.capInfo.on >= after.capInfo.total) {
            console.log('   >> ✅ 已满格，停止循环');
            finalStatus = 'full';
            break;
        }

        // 等待冷却结束进入下一轮（原地轮询按钮，不刷新页面）
        if (once.ok) {
            // 续时成功后按钮会进入冷却，原地轮询直到恢复可点
            console.log('   >> 原地等待冷却结束...');
            await waitForCooldownEnd(page, extendBtn, 300000); // 最多等 5min
        } else if (once.cooldown && once.cooldownText) {
            // 按钮一开始就冷却中，解析倒计时等待
            const cdSec = parseCooldown(once.cooldownText);
            if (cdSec > 0) {
                const waitSec = Math.min(cdSec + 5, 600);
                console.log('   >> 等待冷却 ' + waitSec + 's (' + once.cooldownText + ')...');
                await page.waitForTimeout(waitSec * 1000);
            } else {
                console.log('   >> 冷却时间解析失败，原地轮询按钮...');
                await waitForCooldownEnd(page, extendBtn, 300000);
            }
        } else {
            // 续时未确认生效，等 30s 重试
            console.log('   >> 等待 30s 后重试...');
            await page.waitForTimeout(30000);
        }
    }

    if (finalStatus !== 'full' && rounds >= MAX_ROUNDS) {
        console.log('   >> ⚠️ 达到最大轮次 ' + MAX_ROUNDS + '，未满格');
        finalStatus = successRounds > 0 ? 'partial' : 'failed';
    }

    return { status: finalStatus, remaining: lastRemaining, capInfo: lastCapInfo, shot, rounds, successRounds };
}

// === 通过 CDP 点击 Turnstile 复选框（穿透 Shadow DOM / 跨域 iframe） ===
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('   >> 在 Frame 中找到 Turnstile:', data);
                const iframeEl = await frame.frameElement();
                if (!iframeEl) continue;
                const box = await iframeEl.boundingBox();
                if (!box) continue;
                const cx = box.x + box.width * data.xRatio;
                const cy = box.y + box.height * data.yRatio;
                console.log(`   >> CDP 坐标: (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
                const client = await page.context().newCDPSession(page);
                // 1. 先移动鼠标到复选框上（Cloudflare 需要 mouseover 前置事件）
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
                await new Promise(r => setTimeout(r, 100 + Math.random() * 150));
                // 2. mousePressed
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                // 3. mouseReleased
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                await client.detach();
                return true;
            }
        } catch (_) {}
    }
    return false;
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
    await page.addInitScript(INJECTED_SCRIPT).catch(() => {});
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
            const r = await withTimeout(extendServer(page, serverUrl, photoDir), 45 * 60 * 1000, '续时 ' + safeUser);
            results.push({ serverUrl, user: safeUser, ...r });

            // 立即 TG 推送（每个服务器循环完成后发汇总）
            const sid = (serverUrl.match(/\/server\/([^/?#]+)/) || [])[1] || '';
            const prog = r.capInfo ? `${r.capInfo.on}/${r.capInfo.total}` : '';
            const capStr = r.capInfo && r.capInfo.cap ? r.capInfo.cap : '48h cap';
            const roundsInfo = r.rounds ? `\n轮次: ${r.rounds} (成功 ${r.successRounds})` : '';

            if (r.status === 'full') {
                const msg = '✅ *续时已满格*\n用户: ' + escapeMd(r.user) + '\n服务器: `' + sid + '`\n进度: ' + prog + ' 格 | ' + escapeMd(capStr) + '\n剩余: ' + escapeMd(r.remaining || '?') + roundsInfo + '\n时间: ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                await sendTelegramMessage(msg, r.shot);
            } else if (r.status === 'partial') {
                const msg = '⚠️ *续时部分完成*\n用户: ' + escapeMd(r.user) + '\n服务器: `' + sid + '`\n进度: ' + prog + ' 格 | ' + escapeMd(capStr) + '\n剩余: ' + escapeMd(r.remaining || '?') + roundsInfo + '\n时间: ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                await sendTelegramMessage(msg, r.shot);
            } else if (r.status === 'failed') {
                const msg = '❌ *续时失败*\n用户: ' + escapeMd(r.user) + '\n服务器: `' + sid + '`\n进度: ' + prog + ' 格 | ' + escapeMd(capStr) + '\n剩余: ' + escapeMd(r.remaining || '?') + roundsInfo;
                await sendTelegramMessage(msg, r.shot);
            }

        } catch (e) {
            console.error('用户 ' + safeUser + ' 出错:', e.message);
            results.push({ serverUrl, user: safeUser, status: 'error', shot: '' });
        }
        await page.waitForTimeout(1000);
    }

    console.log('\n完成。');
    await browser.close();
    process.exit(0);
})();
