// FreeCloudPanel (panel.freecloud.ltd) 每日签到
// 流程: Playwright 浏览器 → 登录页 → 填邮箱/密码 → 登录 → 每日签到
// 支持 KV Cookie 缓存: 先尝试缓存的 cookie 免登录，失败再完整登录并回存
// 代理: 每个用户可携带自己的 V2 (vless://) 链接走独立 v2ray 代理，或回退到全局 HTTP_PROXY/直连
// 账号来源: FREECLOUD_USERS_JSON = [{"username":"xxx","password":"xxx","V2":"vless://..."}]
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const BASE_URL = 'https://panel.freecloud.ltd';
const LOGIN_URL = BASE_URL + '/index.php?rp=/login';
const DASHBOARD_URL = BASE_URL + '/clientarea.php';
const CHECKIN_URL = DASHBOARD_URL + '?action=dailycheckin';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'FreeCloud';

// --- KV Cookie 缓存 ---
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

// 全局 HTTP 代理 (由 workflow 启动的 v2ray 全局代理，或用户设置的 HTTP_PROXY)
const HTTP_PROXY = process.env.HTTP_PROXY;

// v2ray 二进制路径
const V2RAY_BIN = process.env.V2RAY_BIN || `${process.env.HOME}/v2ray/v2ray`;

// 管理所有启动的 v2ray 子进程
const v2rayProcs = []; // 当前用户的（用完就清）
const allV2rayProcs = []; // 全局管理的（进程退出时统一清理）
let nextV2rayPort = 10810;

chromium.use(stealth);

// ===== Telegram 通知 =====
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.warn('[Telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }
    const msgText = `📌 *${PROJECT}*\n${message}`;

    async function tgExec(args) {
        return new Promise((resolve) => {
            const proc = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            proc.stdout.on('data', d => { stdout += d.toString(); });
            proc.on('close', () => resolve(stdout));
            proc.on('error', e => resolve(`{error: ${e.message}}`));
        });
    }

    const baseArgs = ['-s', '-X', 'POST', `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
        '-d', `chat_id=${TG_CHAT_ID}`,
    ];
    if (TG_THREAD_ID) baseArgs.push('-d', `message_thread_id=${TG_THREAD_ID}`);

    if (imagePath && fs.existsSync(imagePath)) {
        const capFile = `${imagePath}.tg_caption.txt`;
        try { fs.writeFileSync(capFile, msgText.slice(0, 1000)); } catch (e) { }
        const photoArgs = ['-s', '-X', 'POST', `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`,
            '-F', `chat_id=${TG_CHAT_ID}`,
        ];
        if (TG_THREAD_ID) photoArgs.push('-F', `message_thread_id=${TG_THREAD_ID}`);
        photoArgs.push('-F', `caption=<${capFile}`, '-F', 'parse_mode=Markdown', '-F', `photo=@${imagePath}`);
        const stdout = await tgExec(photoArgs);
        if (stdout.includes('"ok":true')) {
            console.log('[Telegram] 图文消息已发送。');
        } else {
            console.warn('[Telegram] 图文(Markdown)发送失败，改纯文本重试:', stdout.slice(0, 200));
            const idx = photoArgs.indexOf('parse_mode=Markdown');
            if (idx >= 0) { photoArgs.splice(idx, 1); photoArgs.splice(idx - 1, 1); }
            const stdout2 = await tgExec(photoArgs);
            if (stdout2.includes('"ok":true')) {
                console.log('[Telegram] 图文消息(纯文本)已发送。');
            } else {
                console.error('[Telegram] 图文消息发送失败:', stdout2.slice(0, 200));
            }
        }
        try { fs.unlinkSync(capFile); } catch (e) { }
    } else {
        baseArgs.push('-d', 'parse_mode=Markdown', '--data-urlencode', `text=${msgText.slice(0, 3000)}`);
        const stdout = await tgExec(baseArgs);
        if (stdout.includes('"ok":true')) {
            console.log('[Telegram] 消息已发送。');
        } else {
            console.warn('[Telegram] 发送失败:', stdout.slice(0, 200));
        }
    }
}

// ===== v2ray 管理 =====
async function startV2rayForLink(link) {
    if (!fs.existsSync(V2RAY_BIN)) {
        console.error(`[v2ray] 未找到 v2ray 二进制 (${V2RAY_BIN})`);
        return null;
    }
    const port = nextV2rayPort++;
    let cfgPath;
    try {
        const { buildConfig } = require('./.github/scripts/gen-v2ray-config');
        const cfg = buildConfig(link, port);
        cfgPath = path.join(process.cwd(), `v2ray-freecloud-${port}.json`);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error(`[v2ray] 解析 V2 链接失败: ${e.message}`);
        return null;
    }
    console.log(`[v2ray] 启动实例 (HTTP 127.0.0.1:${port})...`);
    const proc = spawn(V2RAY_BIN, ['run', '-config', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
    v2rayProcs.push({ proc, port, link });
    allV2rayProcs.push({ proc, port });

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
        return null;
    }
    console.log(`[v2ray] 代理就绪 → http://127.0.0.1:${port}`);
    return { port, url: `http://127.0.0.1:${port}` };
}

function cleanupV2ray(procs = allV2rayProcs) {
    for (const { proc, port } of procs) {
        try { proc.kill('SIGTERM'); } catch (e) { }
        try { fs.unlinkSync(path.join(process.cwd(), `v2ray-freecloud-${port}.json`)); } catch (e) { }
    }
    procs.length = 0;
}

function cleanupCurrentUserV2ray() {
    cleanupV2ray(v2rayProcs);
}
process.on('exit', () => cleanupV2ray());
process.on('SIGINT', () => { cleanupV2ray(); process.exit(0); });
process.on('SIGTERM', () => { cleanupV2ray(); process.exit(0); });

// ===== 解析用户代理配置 =====
async function resolveProxyForUser(user) {
    if (user.V2 || user.v2) {
        const link = user.V2 || user.v2;
        console.log(`[代理] 用户有 V2 链接，启动独立 v2ray...`);
        const result = await startV2rayForLink(link);
        if (result) return result;
        console.warn('[代理] 独立 v2ray 启动失败，回退');
    }

    if (HTTP_PROXY) {
        try {
            const url = new URL(HTTP_PROXY);
            console.log(`[代理] 使用全局 HTTP 代理: ${url.hostname}:${url.port}`);
            return null;
        } catch (e) {
            console.warn(`[代理] HTTP_PROXY 格式无效: ${HTTP_PROXY}`);
        }
    }

    console.log('[代理] 直连');
    return null;
}

// ===== 浏览器签到 =====
async function checkin(user) {
    const photoDir = 'screenshots';
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    const safeUser = user.username.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const cookieKey = 'freecloud_cookie_' + safeUser.replace(/[^a-z0-9]/gi, '_');

    // 解析该用户的代理
    const v2rayInfo = await resolveProxyForUser(user);

    // 构造 launch 参数
    const launchArgs = [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
    ];

    if (v2rayInfo) {
        launchArgs.push(`--proxy-server=http://127.0.0.1:${v2rayInfo.port}`);
        launchArgs.push('--proxy-bypass-list=<-loopback>');
    } else if (HTTP_PROXY) {
        try {
            const url = new URL(HTTP_PROXY);
            const serverStr = `${url.protocol}//${url.hostname}:${url.port}`;
            launchArgs.push(`--proxy-server=${serverStr}`);
            launchArgs.push('--proxy-bypass-list=<-loopback>');
        } catch (e) {
            console.warn('[代理] HTTP_PROXY 格式无效，直连');
        }
    }

    console.log(`[${user.username}] 启动浏览器...`);
    const browser = await chromium.launch({
        headless: true,
        args: launchArgs
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    try {
        // ===== Step 1: 尝试 KV 缓存的 cookie 直接去 dashboard =====
        let loggedIn = false;
        const cachedRaw = await kvGet(cookieKey);

        if (cachedRaw) {
            console.log(`[${user.username}] 发现缓存的 cookie，尝试注入...`);
            try {
                const ckPairs = cachedRaw.split(/;\s*/).map(p => {
                    const eq = p.indexOf('=');
                    return eq > 0 ? { name: p.slice(0, eq), value: p.slice(eq + 1), domain: '.freecloud.ltd', path: '/' } : null;
                }).filter(Boolean);
                await context.addCookies(ckPairs);
                console.log(`[${user.username}] 已注入 ${ckPairs.length} 条 cookie`);

                await page.goto(DASHBOARD_URL, { waitUntil: 'load', timeout: 30000 });
                await page.waitForTimeout(2000);

                if (!page.url().includes('/login')) {
                    console.log(`[${user.username}] ✅ cookie 有效，跳过登录`);
                    loggedIn = true;
                } else {
                    console.log(`[${user.username}] cookie 已过期，需要重新登录`);
                    try { await context.clearCookies(); } catch (e) { }
                }
            } catch (e) {
                console.log(`[${user.username}] cookie 注入失败，重新登录:`, e.message);
                try { await context.clearCookies(); } catch (e2) { }
            }
        }

        // ===== Step 2: 需要完整登录 =====
        if (!loggedIn) {
            console.log(`[${user.username}] 打开登录页...`);
            await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30000 });

            // 等待 Cloudflare 验证通过，页面出现登录输入框（最长等 60 秒）
            console.log(`[${user.username}] 等待页面就绪（Cloudflare 验证）...`);
            const emailInput = page.locator('#inputEmail, input[name="username"], input[type="text"]').first();
            try {
                await emailInput.waitFor({ state: 'visible', timeout: 60000 });
            } catch (e) {
                const pageUrl = page.url();
                const pageBody = await page.locator('body').innerText().catch(() => '');
                console.error(`[${user.username}] 页面未就绪，URL=${pageUrl}，内容片段=${pageBody.slice(0, 200)}`);
                throw new Error(`等待登录表单超时，可能被 Cloudflare 拦截（${pageUrl}）`);
            }

            console.log(`[${user.username}] 填写凭据...`);
            await emailInput.fill(user.username);

            const pwdInput = page.locator('#inputPassword, input[name="password"], input[type="password"]').first();
            await pwdInput.fill(user.password);
            await page.waitForTimeout(500);

            console.log(`[${user.username}] 点击登录...`);
            const loginBtn = page.locator('button:has-text("登录"), input[type="submit"][value="登录"]').first();
            await loginBtn.click();

            const navResult = await page.waitForURL('**/clientarea.php', { timeout: 20000 })
                .then(() => 'ok')
                .catch(e => `timeout: ${e.message}`);
            await page.waitForTimeout(2000);
            const currentUrl = page.url();
            console.log(`[${user.username}] 当前 URL: ${currentUrl}`);

            if (currentUrl.includes('/login')) {
                throw new Error(`登录失败 — 仍停留在登录页（可能凭据错误或验证码拦截），waitForURL 状态: ${navResult}`);
            } else if (!currentUrl.includes('clientarea')) {
                console.warn(`[${user.username}] 登录后不在用户中心（${currentUrl}），尝试跳转`);
                await page.goto(DASHBOARD_URL, { waitUntil: 'load', timeout: 30000 });
                await page.waitForTimeout(2000);
            }

            // 登录成功 → 保存 cookie 到 KV
            try {
                const cookies = await context.cookies();
                const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                await kvPut(cookieKey, cookieStr);
            } catch (e) {
                console.warn(`[${user.username}] 保存 cookie 失败:`, e.message);
            }
        }

        // ===== Step 3: 执行签到 =====
        console.log(`[${user.username}] 执行签到...`);
        await page.goto(CHECKIN_URL, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(2000);

        // 解析签到结果
        const pageText = await page.locator('body').innerText().catch(() => '');
        let success = false;
        let msg = '';
        let balance = '';

        if (pageText.includes('签到成功')) {
            success = true;
            const balMatch = pageText.match(/(\d+[\.,]?\d*)\s*积分/);
            balance = balMatch ? `${balMatch[1]} 积分` : '';
            msg = '✅ 签到成功！' + (balance ? `余额: ${balance}` : '');
            console.log(`[${user.username}] ✅ ${msg}`);
        } else if (pageText.includes('已签到') || pageText.includes('今天已经签到')) {
            success = true;
            const balMatch = pageText.match(/(\d+[\.,]?\d*)\s*积分/);
            balance = balMatch ? `${balMatch[1]} 积分` : '';
            msg = 'ℹ️ 今日已签到。' + (balance ? `余额: ${balance}` : '');
            console.log(`[${user.username}] ℹ️ ${msg}`);
        } else {
            msg = '❓ 签到状态未知';
            success = pageText.includes('签到') || pageText.includes('积分');
            console.log(`[${user.username}] ${msg}`);
        }

        // 截图
        const shotPath = path.join(photoDir, `freecloud_${safeUser}.png`);
        try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }

        // TG 通知
        const icon = success ? '✅' : '❌';
        await sendTelegramMessage(
            `${icon} *FreeCloud 签到* — ${user.username}\n${msg}`,
            shotPath
        );

        return { success, msg, balance };

    } catch (err) {
        console.error(`[${user.username}] 出错:`, err.message);
        const shotPath = path.join(photoDir, `freecloud_${safeUser}_error.png`);
        try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
        await sendTelegramMessage(
            `❌ *FreeCloud 签到失败* — ${user.username}\n错误: ${err.message}`,
            shotPath
        );
        throw err;
    } finally {
        await browser.close();
        cleanupCurrentUserV2ray();
    }
}

// ========== 主流程 ==========
(async () => {
    let users = [];
    try {
        if (process.env['FREECLOUD_USERS_JSON']) {
            const parsed = JSON.parse(process.env['FREECLOUD_USERS_JSON']);
            users = Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 FREECLOUD_USERS_JSON 环境变量错误:', e);
    }

    if (users.length === 0 && process.env['FREECLOUD_USER'] && process.env['FREECLOUD_PASS']) {
        users = [{ username: process.env['FREECLOUD_USER'], password: process.env['FREECLOUD_PASS'] }];
    }

    if (users.length === 0) {
        console.log('未在 FREECLOUD_USERS_JSON 或 FREECLOUD_USER/FREECLOUD_PASS 中找到用户');
        process.exit(1);
    }

    let allSuccess = true;
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 处理用户 ${i + 1}/${users.length}: ${user.username} ===`);
        try {
            const result = await checkin(user);
            console.log(`[${user.username}] 完成: ${result.msg}`);
        } catch (err) {
            console.error(`[${user.username}] 失败: ${err.message}`);
            allSuccess = false;
        }
    }

    cleanupV2ray(allV2rayProcs);
    console.log(`\n=== 全部完成 === ${allSuccess ? '✅ 全部成功' : '⚠️ 部分失败'}`);
    process.exit(allSuccess ? 0 : 1);
})();
