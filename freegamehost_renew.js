// FreeGameHost (panel.freegamehost.xyz) 续期保活脚本 —— 重写版
//
// 根因: 旧版用 playwright-extra + 手动 Chrome，Cloudflare Turnstile 检测到自动化
//       后 auto_timeout，widget iframe 根本不渲染，永远拿不到 token。
//
// 解法: 改用 cloakbrowser (项目内 rustix_renew.js / gaming4free_extend.js 已验证
//       可过 Turnstile managed 验证)。cloakbrowser 自带指纹修补，Turnstile 会
//       自动通过并把 token 写入 hidden input (cf-turnstile-response)，读取后
//       直接 POST /api/client/freeservers/{uuid}/renew 完成续期。
//
// 账号来源 (Secret FREEGAMEHOST_USERS_JSON):
//   [{"username":"a@b.com","password":"pwd",
//     "serverUrl":"https://panel.freegamehost.xyz/server/xxxx",
//     "V2":"vless://..."}]
//
// 续期 API (从 bundle.js renewFreeServer.ts 逆向):
//   POST /api/client/freeservers/{uuid}/renew  body: {"turnstile_token": "<token>"}
//   Turnstile sitekey: 0x4AAAAAACDTIXgWIwkgvLBp (size=compact)
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn, exec } = require('child_process');
const http = require('http');

const BASE_URL = 'https://panel.freegamehost.xyz';
const LOGIN_URL = `${BASE_URL}/auth/login`;
const TURNSTILE_SITEKEY = '0x4AAAAAACDTIXgWIwkgvLBp';
const PROJECT = process.env.PROJECT_NAME || 'FreeGameHost';

// --- v2ray per-user 代理管理 (移植自旧版，cloakbrowser 仍需代理时用) ---
const V2RAY_BIN = process.env.V2RAY_BIN || `${process.env.HOME}/v2ray/v2ray`;
let nextV2rayPort = 11080;
const v2rayProcs = [];
const allV2rayProcs = [];

function cleanupV2ray(procs = allV2rayProcs) {
    for (const { proc } of procs) {
        try { proc.kill('SIGTERM'); } catch (e) { }
        try { proc.kill('SIGKILL'); } catch (e) { }
    }
    procs.length = 0;
}

async function startV2rayForLink(link) {
    if (!fs.existsSync(V2RAY_BIN)) {
        console.error(`[v2ray] 未找到二进制 (${V2RAY_BIN})`);
        return null;
    }
    const port = nextV2rayPort++;
    let cfgPath;
    try {
        const { buildConfig } = require('./.github/scripts/gen-v2ray-config');
        const cfg = buildConfig(link, port);
        cfgPath = path.join(process.cwd(), `v2ray-freegamehost-${port}.json`);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error(`[v2ray] 解析 V2 链接失败: ${e.message}`);
        return null;
    }
    console.log(`[v2ray] 启动实例 (HTTP 127.0.0.1:${port})...`);
    const proc = spawn(V2RAY_BIN, ['run', '-config', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
    const entry = { proc, port, link };
    v2rayProcs.push(entry);
    allV2rayProcs.push(entry);

    const ready = await new Promise((resolve) => {
        let n = 0;
        const tick = () => {
            const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, () => resolve(true));
            req.on('error', () => { if (++n >= 15) return resolve(false); setTimeout(tick, 2000); });
            req.on('timeout', () => { req.destroy(); if (++n >= 15) return resolve(false); else setTimeout(tick, 2000); });
            req.end();
        };
        tick();
    });
    if (!ready) {
        console.error(`[v2ray] 端口 ${port} 未就绪。stderr:\n${stderr.slice(-400)}`);
        cleanupV2ray(v2rayProcs);
        return null;
    }
    console.log(`[v2ray] 代理就绪 → http://127.0.0.1:${port}`);
    return { port, url: `http://127.0.0.1:${port}` };
}

// 解析该用户的代理: user.V2 → per-user v2ray; 否则回退全局 HTTP_PROXY
async function resolveUserProxy(user, skipV2 = false) {
    cleanupV2ray(v2rayProcs);
    if (!skipV2 && (user.V2 || user.v2)) {
        const link = (user.V2 || user.v2).trim();
        console.log('   >> 检测到用户专属 V2 链接，启动独立 v2ray...');
        const local = await startV2rayForLink(link);
        if (local) return { url: local.url, label: `v2ray (${local.url})` };
        console.warn('   >> 专属 v2ray 启动失败，回退到全局代理。');
    } else if (skipV2 && (user.V2 || user.v2)) {
        console.log('   >> 跳过 V2 (已降级)，回退到全局代理/直连。');
    }
    if (process.env.HTTP_PROXY) {
        try {
            new URL(process.env.HTTP_PROXY); // 校验
            return { url: process.env.HTTP_PROXY, label: `全局代理 (${process.env.HTTP_PROXY})` };
        } catch (e) { console.warn('   >> HTTP_PROXY 格式无效'); }
    }
    return { url: null, label: '直连 (无代理)' };
}

process.on('exit', () => cleanupV2ray());
process.on('SIGINT', () => { cleanupV2ray(); process.exit(0); });
process.on('SIGTERM', () => { cleanupV2ray(); process.exit(0); });

// --- Telegram 推送 (沿用旧版) ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.warn('[Telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }
    const text = `📌 *${PROJECT}*\n${message}`;
    const tgErr = (e) => (e.response && e.response.data && e.response.data.description)
        ? `${e.response.data.error_code} ${e.response.data.description}` : e.message;
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
        if (!r.err && r.stdout.includes('"ok":true')) console.log('[Telegram] 图文消息已发送。');
        else {
            console.warn('[Telegram] 图文(MD)失败，纯文本重试:', (r.stdout || '').slice(0, 200));
            r = await sendPhoto(false);
            if (!r.err && r.stdout.includes('"ok":true')) console.log('[Telegram] 图文消息已发送 (纯文本)。');
            else console.error('[Telegram] 图文失败:', (r.stdout || '').slice(0, 300));
        }
        try { fs.unlinkSync(captionFile); } catch (e) { }
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        const base = { chat_id: TG_CHAT_ID };
        if (TG_THREAD_ID) base.message_thread_id = Number(TG_THREAD_ID);
        try { await axios.post(url, { ...base, text, parse_mode: 'Markdown' }); console.log('[Telegram] Message sent.'); }
        catch (e) {
            console.warn('[Telegram] Markdown 失败，纯文本重试:', tgErr(e));
            await axios.post(url, { ...base, text });
            console.log('[Telegram] Message sent (plain).');
        }
    } catch (e) {
        console.error('[Telegram] 推送失败:', tgErr(e));
    }
}

// --- KV Cookie 缓存 (可选，沿用旧版) ---
const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);

async function kvGet(key) {
    if (!KV_ENABLED) return null;
    try {
        const r = await axios.post(KV_ADMIN_URL + '/api/get', { key }, {
            headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
            timeout: 15000, proxy: false,
        });
        if (r.data.ok && r.data.value != null) {
            console.log('[KV] 读取成功，长度:', String(r.data.value).length);
            return typeof r.data.value === 'string' ? r.data.value : JSON.stringify(r.data.value);
        }
        return null;
    } catch (e) { return e.response && e.response.status === 404 ? null : (console.warn('[KV] 读取失败:', e.message), null); }
}

async function kvPut(key, value) {
    if (!KV_ENABLED) return false;
    try {
        await axios.post(KV_ADMIN_URL + '/api/set', { key, value: String(value) }, {
            headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
            timeout: 15000, proxy: false,
        });
        console.log('[KV] cookie 已保存');
        return true;
    } catch (e) { console.warn('[KV] 写入失败:', e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message); return false; }
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

// --- 用户配置解析 ---
function getUsers() {
    try {
        if (process.env.FREEGAMEHOST_USERS_JSON) {
            const cleaned = process.env.FREEGAMEHOST_USERS_JSON.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
            const parsed = JSON.parse(cleaned);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) { console.error('解析 FREEGAMEHOST_USERS_JSON 错误:', e); }
    return [];
}

// --- 从 serverUrl 提取 server id (短 id 如 01647891) ---
function parseServerId(serverUrl) {
    const m = String(serverUrl || '').match(/\/server\/([A-Za-z0-9]+)/);
    return m ? m[1] : '';
}

// --- 页面内: 获取当前 Turnstile token (hidden input + getResponse) ---
// 在 page.evaluate 上下文中运行
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

// --- 页面内: 从服务器页提取 uuid (调用 info 接口) ---
// RenewBox 里显示的短 id (01647891) 对应 pterodactyl uuid; 通过 /api/client/servers/{id} 拿 uuid
async function getServerUuid(page, serverId) {
    return await page.evaluate(async (id) => {
        const r = await fetch(`/api/client/servers/${id}`, { credentials: 'include' });
        if (!r.ok) return null;
        const j = await r.json();
        return (j && j.attributes && j.attributes.uuid) ? j.attributes.uuid : null;
    }, serverId).catch(() => null);
}

// --- 页面内: 获取续期前信息 ---
async function getRenewInfo(page, uuid) {
    return await page.evaluate(async (u) => {
        try {
            const r = await fetch(`/api/client/freeservers/${u}/info`, { credentials: 'include' });
            if (!r.ok) return null;
            const j = await r.json();
            return j.success ? j.data : null;
        } catch (e) { return null; }
    }, uuid).catch(() => null);
}

// --- 页面内: 调用续期 API ---
// 续期 API 调用：从 Node.js 进程用 axios 直接请求（不依赖页面上下文，避免 Turnstile 弹窗导致 evaluate 失败）
// 从 context 取页面 cookie 注入到请求头，X-CSRF-Token 从 meta 标签读取
async function callRenewApi(context, page, uuid, token) {
    try {
        const cookies = await context.cookies();
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const url = `${BASE_URL}/api/client/freeservers/${uuid}/renew`;
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Cookie': cookieStr,
        };
        // Pterodactyl 用 X-CSRF-TOKEN (meta 标签)；尝试从页面读取，读不到则跳过
        const csrf = await page.evaluate(() => {
            const m = document.querySelector('meta[name="csrf-token"]');
            return m ? m.getAttribute('content') : null;
        }).catch(() => null);
        if (csrf) headers['X-CSRF-TOKEN'] = csrf;

        const resp = await axios.post(url, { turnstile_token: token }, {
            headers, timeout: 20000, maxRedirects: 0, proxy: false,
            validateStatus: () => true,
        });
        const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, data: resp.data, raw: (raw || '').slice(0, 400) };
    } catch (e) {
        const status = e.response ? e.response.status : 0;
        const data = e.response ? e.response.data : null;
        const raw = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : e.message;
        return { ok: false, status, data, raw: (raw || '').slice(0, 400) };
    }
}

async function gotoWithRetry(page, url, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            return;
        } catch (e) {
            console.warn(`[导航] 打开 ${url} 失败 (第 ${i}/${retries} 次): ${e.message}`);
            if (i === retries) throw e;
            await page.waitForTimeout(3000);
        }
    }
}

// 代理连通性检测：用 axios 通过 HTTP 代理访问目标 URL，能在超时内拿到任意 HTTP 响应即视为可用
async function checkProxyCanReach(proxyUrl, targetUrl) {
    try {
        const u = new URL(proxyUrl);
        const resp = await axios.get(targetUrl, {
            proxy: {
                protocol: u.protocol,
                host: u.hostname,
                port: u.port,
                auth: (u.username || u.password) ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined,
            },
            timeout: 15000,
            // 只要有响应即可，不关心状态码 (401/403/200 都算代理可达)
            validateStatus: () => true,
            // 不跟随重定向，避免被登录跳转拖慢
            maxRedirects: 0,
        });
        console.log(`   >> [代理检测] ${proxyUrl} → HTTP ${resp.status} (代理可用)`);
        return true;
    } catch (e) {
        // ECONNREFUSED / ETIMEDOUT / ERR_CONNECTION_CLOSED 等都算不可用
        console.warn(`   >> [代理检测] ${proxyUrl} 访问 ${targetUrl} 失败: ${e.code || e.message}`);
        return false;
    }
}

// 注入脚本：隐藏自动化痕迹 + hook Turnstile 复选框坐标 (移植自 rustix_renew.js)
// 在 iframe 内劫持 attachShadow，找到 checkbox 后计算相对视口坐标比例，存入 window.__turnstile_data
const INJECTED_SCRIPT = `
(function() {
    try {
        const dp = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
        if (dp) {
            Object.defineProperty(Navigator.prototype, 'webdriver', {
                configurable: true, enumerable: true, get: () => undefined
            });
        }
    } catch (e) { }
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
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
                            window.__turnstile_data = { xRatio: (r.left + r.width/2) / window.innerWidth, yRatio: (r.top + r.height/2) / window.innerHeight };
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
    } catch (e) { }
})();
`;

// Promise 超时辅助
function _race(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), ms))]);
}

// Cloudflare Turnstile (iframe 内复选框) 的 CDP 点击绕过 (移植自 rustix_renew.js)
// 遍历页面所有 frame，读取注入脚本设置的 __turnstile_data，
// 通过 iframeElement.boundingBox() 计算绝对坐标，用 CDP 发送真实鼠标事件
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
                console.log('   >> 在 frame 中发现 Turnstile。比例:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`   >> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                const client = await page.context().newCDPSession(page);
                // mouseMoved (mouseover 前置事件，Cloudflare 需要)
                await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
                await new Promise(r => setTimeout(r, 100));
                // mousePressed
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 80));
                // mouseReleased
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await client.detach();
                console.log('   >> Turnstile CDP 点击已发送');
                return true;
            }
        } catch (e) {
            // 静默跳过不可访问的 frame
        }
    }
    return false;
}

// 登录: 返回 true/false
async function loginOnce(page, user) {
    await gotoWithRetry(page, LOGIN_URL);
    await page.waitForTimeout(2500);

    console.log('   >> 输入凭据...');
    const emailInput = page.locator('input[type="text"], input[placeholder*="email" i], input[name="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(user.username);
    const pwdInput = page.locator('input[type="password"], input[placeholder*="password" i], input[name="password"]').first();
    await pwdInput.fill(user.password);
    await page.waitForTimeout(500);

    console.log('   >> 点击 Login...');
    const loginBtn = page.getByRole('button', { name: /log\s?in|sign\s?in/i }).or(page.locator('button[type="submit"]')).first();
    await loginBtn.click();

    // Pterodactyl 登录页本身用 Turnstile? 实测登录无 Turnstile (仅续期有)
    for (let s = 0; s < 30; s++) {
        await page.waitForTimeout(1000);
        if (!/\/auth\/login/i.test(page.url())) return true;
        const err = await page.getByText(/invalid|incorrect|wrong|failed|error|not found/i)
            .first().isVisible().catch(() => false);
        if (err) return false;
    }
    return !/\/auth\/login/i.test(page.url());
}

// 核心: 点击 Renew +8 Hours → 等 Turnstile 自动出 token → (兜底 turnstile.render) → 调 API
async function renewServer(page, context, user, serverId) {
    // 拿 uuid
    let uuid = await getServerUuid(page, serverId);
    if (!uuid) {
        // 退化: 某些版本 /api/client/servers/{id} 不返回 uuid，尝试从页面 DOM / websocket url 取
        uuid = await page.evaluate(() => {
            // RenewBox 里调用的 freeservers API 路径含完整 uuid，监听不到则回退到 serverId
            const m = (document.body.innerHTML.match(/freeservers\/([0-9a-f-]{36})/) || [])[1];
            return m || null;
        }).catch(() => null);
    }
    if (!uuid) {
        console.warn('   >> 未能解析 server uuid，尝试用 serverId 作为 uuid');
        uuid = serverId;
    }
    console.log(`   >> server uuid = ${uuid}`);

    // 续期前信息
    const before = await getRenewInfo(page, uuid);
    const beforeExpire = before ? new Date(before.expire).toISOString() : '?';
    const beforeRemain = before ? `${before.currentRemainingHours}h` : '?';
    console.log(`   >> 续期前: 到期 ${beforeExpire}, 剩余 ${beforeRemain}, isAtMax=${before ? before.isAtMaxLifetime : '?'}`);

    // 若已达 24h 上限，跳过
    if (before && before.isAtMaxLifetime) {
        return { status: 'max', before, msg: `已达 ${before.maxLifetimeHours}h 上限，无需续期` };
    }

    // 点击 Renew +8 Hours
    console.log('   >> 查找 Renew +8 Hours 按钮...');
    const renewBtn = page.getByRole('button', { name: /Renew.*\+8.*Hours/i }).first();
    const btnVisible = await renewBtn.isVisible({ timeout: 10000 }).catch(() => false);
    if (!btnVisible) {
        // 可能冷却中
        const cooldownBtn = page.locator('button:has-text("renewal cooldown")').first();
        const cdVisible = await cooldownBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (cdVisible) {
            const cdText = await cooldownBtn.innerText().catch(() => 'cooldown');
            return { status: 'cooldown', before, msg: `冷却中: ${cdText}` };
        }
        return { status: 'no_button', before, msg: '未找到续期按钮' };
    }

    await renewBtn.click();
    console.log('   >> 已点击 Renew +8 Hours，等待 Turnstile 弹出...');
    await page.waitForTimeout(1500);

    // 等待 Turnstile 自动通过 (cloakbrowser 下 managed challenge 可能自动过)
    let token = null;
    console.log('   >> 等待 Turnstile 自动验证 (最多 15s)...');
    for (let w = 0; w < 5; w++) {
        token = await getPageToken(page);
        if (token) {
            console.log(`   >> ✅ Turnstile 自动验证成功 (≈${w * 3}s)，token 长度 ${token.length}`);
            break;
        }
        await page.waitForTimeout(3000);
    }

    // 兜底 1: CDP 真实点击 Turnstile 复选框 (移植自 rustix_renew.js，稳定方案)
    // 通过注入的 INJECTED_SCRIPT 捕获 checkbox 坐标，用 CDP 发真实鼠标事件
    if (!token) {
        console.log('   >> 自动验证超时，尝试 CDP 点击 Turnstile (最多 10 次)...');
        for (let attempt = 0; attempt < 10; attempt++) {
            const clicked = await attemptTurnstileCdp(page);
            if (clicked) {
                console.log(`   >> CDP 点击已发送 (第 ${attempt + 1}/10 次)，等待验证...`);
                // 点击后多次检查 token
                for (let c = 0; c < 5; c++) {
                    await page.waitForTimeout(1500);
                    token = await getPageToken(page);
                    if (token) {
                        console.log(`   >> ✅ CDP 点击后获取到 token (长度 ${token.length})`);
                        break;
                    }
                }
                if (token) break;
            } else {
                await page.waitForTimeout(1500);
            }
            // 每轮也检查一次自动是否已过
            token = await getPageToken(page);
            if (token) { console.log('   >> ✅ CDP 循环中检测到 token'); break; }
        }
    }

    // 兜底 2: 手动 turnstile.render() 触发 (用页面已有的 widget 容器)
    if (!token) {
        console.log('   >> 尝试 turnstile.render()...');
        token = await page.evaluate(async (sk) => {
            if (typeof window.turnstile === 'undefined') return null;
            // 找到 RenewBox 里的 150px 容器
            let container = document.querySelector('div[style*="width: 150px"]')
                || document.querySelector('[class*="TurnstileBox"] div div')
                || document.querySelector('[class*="TurnstileBox"]');
            if (!container) return null;
            // 优先用已存在的 widget id 渲染容器(避免重复)
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
        if (token) console.log('   >> ✅ turnstile.render() 获取到 token');
        else console.log('   >> ⚠️ turnstile.render() 未获取到 token');
    }

    // 兜底 3: 直接用 window.turnstile.execute()
    if (!token) {
        console.log('   >> 尝试 turnstile.execute()...');
        token = await page.evaluate(() => {
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
        if (token) console.log('   >> ✅ turnstile.execute() 获取到 token');
    }

    if (!token) {
        return { status: 'turnstile_fail', before, msg: 'Turnstile 验证未通过 (无 token)' };
    }

    // 调用续期 API
    console.log('   >> 调用 POST /api/client/freeservers/{uuid}/renew...');
    const result = await callRenewApi(context, page, uuid, token);
    console.log(`   >> API 响应: status=${result.status} ok=${result.ok} raw=${(result.raw || '').slice(0, 200)}`);

    if (result.ok) {
        // 取续期后信息
        const after = await getRenewInfo(page, uuid);
        return { status: 'renewed', before, after, msg: '续期成功 (+8h)', apiRaw: result.raw };
    }
    return { status: 'api_fail', before, msg: `续期 API 失败: ${result.status} ${result.raw || ''}` };
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 FREEGAMEHOST_USERS_JSON 中找到用户');
        process.exit(1);
    }

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    console.log(`[CloakBrowser] 模块加载中...`);
    const cloak = await import('cloakbrowser');
    const launch = cloak.launch || cloak.launchPersistentContext || cloak.default?.launch;
    if (!launch) {
        console.error('[CloakBrowser] 未找到 launch 方法，请检查 cloakbrowser 版本');
        process.exit(1);
    }

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 用户 ${i + 1}/${users.length}: ${user.username} ===`);

        if (!user.serverUrl) {
            console.warn('   >> 未配置 serverUrl，跳过');
            continue;
        }
        const serverId = parseServerId(user.serverUrl);
        console.log(`   >> serverId = ${serverId}`);

        // 解析代理
        let { url: proxyUrl, label: proxyLabel } = await resolveUserProxy(user);
        console.log(`   >> 代理: ${proxyLabel}`);

        // 代理连通性检测：通过代理访问目标面板，失败则降级直连（避免 ERR_CONNECTION_CLOSED）
        if (proxyUrl) {
            const proxyOk = await checkProxyCanReach(proxyUrl, BASE_URL + '/');
            if (!proxyOk) {
                console.warn(`   >> ⚠️ 代理无法访问面板，降级直连 (跳过代理 ${proxyUrl})`);
                cleanupV2ray(v2rayProcs);
                proxyUrl = null;
                proxyLabel = '直连 (代理失效降级)';
                console.log(`   >> 降级后代理: ${proxyLabel}`);
            }
        }

        // 启动 cloakbrowser (每用户独立 context，避免 cookie/代理串台)
        const launchOpts = { headless: true, humanize: true };
        if (proxyUrl) launchOpts.proxy = proxyUrl;
        let browser;
        try {
            console.log('[CloakBrowser] 启动中...');
            browser = await launch(launchOpts);
            console.log('[CloakBrowser] 启动成功');
        } catch (e) {
            console.error('[CloakBrowser] 启动失败:', e.message);
            cleanupV2ray(v2rayProcs);
            continue;
        }

        const page = await browser.newPage();
        page.setDefaultTimeout(60000);
        // 注入 Turnstile hook 脚本 (必须在导航前注入，以拦截 attachShadow)
        await page.addInitScript(INJECTED_SCRIPT).catch(() => {});
        // CloakBrowser launch() 返回的是 Browser; context 通过 page.context() 获取
        // (参照 gaming4free_extend.js，不可用 browser.contexts())
        const context = page.context();

        try {
            // 1. KV cookie 免登录
            const cookieKey = `freegamehost_cookie_${safeUser}`;
            let loggedIn = false;
            const saved = await kvGet(cookieKey);
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    if (cks.length) {
                        try { await context.clearCookies(); } catch (e) { }
                        await context.addCookies(cks);
                        console.log(`   >> 已注入 KV cookie (${cks.length} 条)`);
                    }
                } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }
                await gotoWithRetry(page, BASE_URL + '/');
                await page.waitForTimeout(2500);
                loggedIn = !/\/auth\/login/i.test(page.url());
                console.log(`   >> cookie ${loggedIn ? '有效，免登录' : '无效/已过期'} (url: ${page.url()})`);
            }

            // 2. cookie 失效 → 登录
            if (!loggedIn) {
                loggedIn = await loginOnce(page, user);
                if (!loggedIn) {
                    const shot = path.join(photoDir, `freegamehost_${safeUser}_loginfail.png`);
                    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                    console.log('   >> ❌ 登录失败，停留在: ' + page.url());
                    await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n停留: ${page.url()}`, shot);
                    continue;
                }
                console.log('   >> ✅ 登录成功: ' + page.url());
                // 保存 cookie
                try {
                    const cookies = await context.cookies();
                    await kvPut(cookieKey, JSON.stringify(cookies));
                } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }
            }

            // 3. 打开服务器页 → 续期
            console.log('   >> 打开服务器页: ' + user.serverUrl);
            await gotoWithRetry(page, user.serverUrl);
            await page.waitForTimeout(3000);

            const result = await renewServer(page, context, user, serverId);
            const shot = path.join(photoDir, `freegamehost_${safeUser}_renew.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }

            // 4. 通知
            const beforeRemain = result.before ? `${result.before.currentRemainingHours}h` : '?';
            const afterRemain = result.after ? `${result.after.currentRemainingHours}h` : '?';
            if (result.status === 'renewed') {
                console.log(`   >> ✅ 续期成功 (${beforeRemain} → ${afterRemain})`);
                await sendTelegramMessage(
                    `✅ *续期成功 (+8h)*\n用户: ${user.username}\n服务器: ${serverId}\n剩余: ${beforeRemain} → ${afterRemain}`, shot);
            } else if (result.status === 'max') {
                console.log(`   >> ⏳ 已达上限 (${beforeRemain})`);
                await sendTelegramMessage(`⏳ *已达 24h 上限*\n用户: ${user.username}\n剩余: ${beforeRemain}`, shot);
            } else if (result.status === 'cooldown') {
                console.log('   >> ⏳ ' + result.msg);
                await sendTelegramMessage(`⏳ *冷却中*\n用户: ${user.username}\n${result.msg}\n剩余: ${beforeRemain}`, shot);
            } else {
                console.log(`   >> ⚠️ ${result.status}: ${result.msg}`);
                await sendTelegramMessage(`⚠️ *${result.status}*\n用户: ${user.username}\n${result.msg}\n剩余: ${beforeRemain}`, shot);
            }
        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shot = path.join(photoDir, `freegamehost_${safeUser}_error.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, shot);
        } finally {
            try { await browser.close(); } catch (e) { }
            cleanupV2ray(v2rayProcs);
        }
    }

    cleanupV2ray();
    console.log('\n完成。');
    process.exit(0);
})();
