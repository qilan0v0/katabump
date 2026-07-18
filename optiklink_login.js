/**
 * OptikLink — Discord OAuth 登录 + 控制面板登录
 * ==================================================
 * 流程:
 *   1. 通过 Discord Token 授权登录 optiklink.net
 *   2. 通过 用户名/密码 登录 control.optiklink.net
 *   3. 每个账号可独立设置 sing-box 代理 (V2 链接)
 *
 * 环境变量:
 *   OPTIKLINK_USERS_JSON = [{"Discord-token":"MTM3...","username":"xxx@gmail.com","password":"xxx","V2":"vless://..."}]
 *   KV_ADMIN_URL / KV_ADMIN_PASS
 *   TG_BOT_TOKEN / TG_CHAT_ID / TG_THREAD_ID
 */
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// 确保 127.0.0.1/localhost 不走外部代理
process.env.NO_PROXY = 'localhost,127.0.0.1,::1';


// ========== 常量 ==========
const OPTIKLINK_BASE = 'https://optiklink.net';
const LOGIN_URL = `${OPTIKLINK_BASE}/login`;
const CONTROL_BASE = 'https://control.optiklink.net';
const CONTROL_LOGIN = `${CONTROL_BASE}/auth/login`;

// Discord OAuth 配置 (从 /login 重定向获取)
const DISCORD_CLIENT_ID = '933437142254887052';
const REDIRECT_URI = 'https://optiklink.com/login';
const SCOPES = 'guilds guilds.join identify email';
const DISCORD_API = 'https://discord.com/api/v10/oauth2/authorize';

// ========== Telegram 通知 ==========
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = 'OptikLink';

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

// ========== 日志 & 截图 ==========
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function screenshot(page, name) {
    try {
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${safeName}.png`), fullPage: true });
    } catch (e) {
        console.warn('[截图] 失败:', e.message);
    }
}

// 带重试的页面导航
async function gotoWithRetry(page, url, options = {}) {
    const maxRetries = 3;
    const opts = { waitUntil: 'networkidle', timeout: 30000, ...options };
    for (let i = 0; i < maxRetries; i++) {
        try {
            await page.goto(url, opts);
            return;
        } catch (e) {
            if (i === maxRetries - 1) throw e;
            log(`  导航重试 ${i + 1}/${maxRetries}: ${e.message.slice(0, 60)}`);
            await page.waitForTimeout(2000);
        }
    }
}

// ========== KV Cookie 存储 ==========
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
        if (r.data.ok && r.data.value != null) return r.data.value;
        return null;
    } catch (e) {
        if (e.response?.status === 404) return null;
        console.warn('[KV] 读取失败:', e.message);
        return null;
    }
}

async function kvPut(key, value) {
    if (!KV_ENABLED) return;
    try {
        await axios.post(KV_ADMIN_URL + '/api/set', { key, value: String(value) }, {
            headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
            timeout: 15000, proxy: false,
        });
    } catch (e) {
        console.warn('[KV] 写入失败:', e.message);
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

// ========== sing-box 代理管理（每个账号独立） ==========
const { buildConfig: buildSingboxConfig } = require('./.github/scripts/gen-singbox-config');
const SINGBOX_BIN = process.env.SINGBOX_BIN || `${process.env.HOME}/sing-box/sing-box`;
const singboxProcs = [];
let nextSocksPort = 10810;

async function startSingboxForLink(link) {
    if (!fs.existsSync(SINGBOX_BIN)) {
        console.error(`[sing-box] 未找到 sing-box 二进制 (${SINGBOX_BIN})`);
        return null;
    }
    const socksPort = nextSocksPort++;
    const httpPort = nextSocksPort++;
    let cfgPath;
    try {
        const cfg = buildSingboxConfig(link, socksPort, httpPort);
        cfgPath = path.join(process.cwd(), `singbox-optiklink-${socksPort}.json`);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error(`[sing-box] 解析 V2 链接失败: ${e.message}`);
        return null;
    }
    console.log(`[sing-box] 启动实例 (SOCKS5 ${socksPort}, HTTP ${httpPort})...`);
    const proc = spawn(SINGBOX_BIN, ['run', '-c', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
    singboxProcs.push({ proc, port: socksPort });

    const ready = await new Promise((resolve) => {
        let n = 0;
        const tick = () => {
            const req = http.get({ host: '127.0.0.1', port: httpPort, path: '/', timeout: 3000 }, () => resolve(true));
            req.on('error', () => { if (++n >= 15) return resolve(false); setTimeout(tick, 2000); });
            req.on('timeout', () => { req.destroy(); if (++n >= 15) return resolve(false); else setTimeout(tick, 2000); });
            req.end();
        };
        tick();
    });
    if (!ready) {
        console.error(`[sing-box] 代理端口未就绪。stderr:\n${stderr.slice(-400)}`);
        return null;
    }
    const url = `socks5://127.0.0.1:${socksPort}`;
    console.log(`[sing-box] 代理就绪 → ${url}`);
    return { port: socksPort, url };
}

function cleanupSingbox() {
    for (const { proc, port } of singboxProcs) {
        try { proc.kill('SIGTERM'); } catch (e) { }
        try { fs.unlinkSync(path.join(process.cwd(), `singbox-optiklink-${port}.json`)); } catch (e) { }
    }
    singboxProcs.length = 0;
}

process.on('exit', () => cleanupSingbox());
process.on('SIGINT', () => { cleanupSingbox(); process.exit(0); });
process.on('SIGTERM', () => { cleanupSingbox(); process.exit(0); });

// ========== 解析用户代理配置 ==========
async function resolveProxyForUser(user) {
    const v2Link = user.V2 || user.v2;
    if (v2Link) {
        console.log(`[代理] 用户有 V2 链接，启动独立 sing-box...`);
        const result = await startSingboxForLink(v2Link);
        if (result) return result;
        console.warn('[代理] sing-box 启动失败，回退');
    }
    if (process.env.HTTP_PROXY) {
        console.log(`[代理] 使用全局 HTTP 代理: ${process.env.HTTP_PROXY}`);
        return { port: null, url: process.env.HTTP_PROXY };
    }
    console.log('[代理] 直连');
    return null;
}

// ========== Discord OAuth 登录 (optiklink.net) ==========
/**
 * 通过 Discord Token 授权登录 optiklink.net
 * 流程:
 *   1. 访问 /login 触发 Discord OAuth 重定向
 *   2. 从 URL 提取 state 参数
 *   3. 用 Discord API v10 进行 OAuth 授权
 *   4. 访问回调 URL 完成登录
 */
async function discordLogin(page, context, token) {
    log('[Discord] 通过 Discord OAuth 登录 optiklink.net...');

    try {
        // Step 1: 访问 /login 触发 Discord 重定向
        log('  访问 /login 触发 Discord OAuth...');
        await gotoWithRetry(page, LOGIN_URL);
        await page.waitForTimeout(3000);

        let currentUrl = page.url();
        log(`  当前 URL: ${currentUrl}`);

        // 如果已经在 optiklink.net 首页（非 Discord 页面），说明已登录
        if (currentUrl.includes(OPTIKLINK_BASE) && !currentUrl.includes('discord')) {
            log('  ✅ 似乎已登录 optiklink.net');
            return true;
        }

        // 如果不在 Discord OAuth 页面，尝试重新导航
        if (!currentUrl.includes('discord.com/oauth2/authorize')) {
            log('  未跳转到 Discord，尝试再次导航...');
            await gotoWithRetry(page, LOGIN_URL);
            await page.waitForTimeout(3000);
            currentUrl = page.url();
            log(`  重试后 URL: ${currentUrl}`);
            if (!currentUrl.includes('discord.com/oauth2/authorize')) {
                log('  ❌ 无法触发 Discord OAuth 重定向');
                return false;
            }
        }

        // Step 2: 从 URL 提取 state
        const stateMatch = currentUrl.match(/[?&]state=([^&]+)/);
        let state = stateMatch ? decodeURIComponent(stateMatch[1]) : null;
        if (!state) {
            log('  ❌ 无法提取 state 参数');
            return false;
        }
        log(`  ✅ 提取到 state: ${state.substring(0, 20)}...`);

        // Step 3: 用 Discord Token 调用 OAuth2 authorize API
        log('  调用 Discord API 授权...');
        const queryParams = {
            client_id: DISCORD_CLIENT_ID,
            response_type: 'code',
            redirect_uri: REDIRECT_URI,
            scope: SCOPES,
            state: state,
        };
        const authorizeUrl = `${DISCORD_API}?${new URLSearchParams(queryParams).toString()}`;

        const axiosConfig = {
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
                'Origin': 'https://discord.com',
                'referer': `https://discord.com/oauth2/authorize?${new URLSearchParams(queryParams).toString()}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            timeout: 20000,
        };

        const discordApiPayload = {
            permissions: '0',
            authorize: true,
            integration_type: 0,
            location_context: {
                guild_id: '10000',
                channel_id: '10000',
                channel_type: 10000,
            },
        };

        let resp;
        try {
            resp = await axios.post(authorizeUrl, discordApiPayload, { ...axiosConfig, proxy: false });
            log('  Discord API 请求成功');
        } catch (directErr) {
            log(`  Discord API 直连失败: ${directErr.message.slice(0, 80)}`);
            // 如果有 HTTP_PROXY 则尝试走代理
            if (process.env.HTTP_PROXY) {
                try {
                    const proxyUrl = new URL(process.env.HTTP_PROXY);
                    resp = await axios.post(authorizeUrl, discordApiPayload, {
                        ...axiosConfig,
                        proxy: {
                            protocol: 'http',
                            host: proxyUrl.hostname,
                            port: proxyUrl.port,
                            ...(proxyUrl.username ? { auth: { username: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) } } : {}),
                        },
                    });
                    log('  Discord API 请求（代理）成功');
                } catch (proxyErr) {
                    log(`  ❌ Discord 授权失败（直连和代理均失败）`);
                    return false;
                }
            } else {
                return false;
            }
        }

        if (resp.status !== 200) {
            log(`  ❌ Discord 授权失败: HTTP ${resp.status}`);
            return false;
        }

        const location = resp.data.location;
        if (!location) {
            log('  ❌ 授权响应中未找到 location 字段');
            return false;
        }

        const masked = location.replace(/code=[^&]+/, 'code=***');
        log(`  ✅ 拿到回调 URL: ${masked}`);

        // Step 4: 访问回调 URL 完成登录
        log('  ↩️ 携带授权码打开回调链接...');
        await gotoWithRetry(page, location);
        await page.waitForTimeout(3000);

        const finalUrl = page.url();
        log(`  回调后 URL: ${finalUrl}`);

        // 如果还在 Discord 页面，等自动跳转
        if (finalUrl.includes('discord.com')) {
            log('  等待 Discord 跳转...');
            await page.waitForTimeout(5000);
        }

        // 检查是否成功登录到 optiklink.net
        for (let w = 0; w < 20; w++) {
            const url = page.url();
            if (url.includes(OPTIKLINK_BASE) && !url.includes('discord') && !url.includes('login')) {
                log('  ✅ Discord OAuth 登录成功！');
                return true;
            }
            await page.waitForTimeout(500);
        }

        log(`  ❌ 登录超时，最终 URL: ${page.url()}`);
        await screenshot(page, `optiklink_discord_timeout`);
        return false;
    } catch (e) {
        log(`  ❌ Discord OAuth 异常: ${e.message}`);
        await screenshot(page, `optiklink_discord_error`);
        return false;
    }
}

// ========== 控制面板登录 (control.optiklink.net) ==========
/**
 * 通过用户名/密码登录 control.optiklink.net
 */
async function controlPanelLogin(page, context, username, password) {
    log('[控制面板] 登录 control.optiklink.net...');

    try {
        log(`  打开控制面板登录页...`);
        await gotoWithRetry(page, CONTROL_LOGIN);
        await page.waitForTimeout(2000);

        log(`  当前 URL: ${page.url()}`);

        // 如果已经在控制面板首页，说明已登录
        if (page.url().includes(CONTROL_BASE) && !page.url().includes('/auth/login')) {
            log('  ✅ 似乎已登录控制面板');
            return true;
        }

        // 检查是否在登录页
        if (!page.url().includes('/auth/login')) {
            log('  ⚠️ 不在登录页，尝试重新导航...');
            await gotoWithRetry(page, CONTROL_LOGIN);
            await page.waitForTimeout(2000);
        }

        // 填写表单
        log('  填写用户名...');
        const usernameInput = page.locator('input[name="username"]');
        await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
        await usernameInput.fill(username);

        log('  填写密码...');
        const passwordInput = page.locator('input[name="password"]');
        await passwordInput.fill(password);

        await screenshot(page, `control_panel_before_login`);

        log('  点击登录按钮...');
        const loginBtn = page.locator('button[type="submit"]');
        await loginBtn.click();

        // 等待登录完成
        await page.waitForTimeout(5000);

        const afterUrl = page.url();
        log(`  登录后 URL: ${afterUrl}`);

        // 检查是否登录成功（不在登录页）
        if (!afterUrl.includes('/auth/login')) {
            log('  ✅ 控制面板登录成功！');
            await screenshot(page, `control_panel_login_success`);
            return true;
        }

        // 等待一段时间看是否跳转
        for (let w = 0; w < 20; w++) {
            const url = page.url();
            if (!url.includes('/auth/login')) {
                log('  ✅ 控制面板登录成功！');
                await screenshot(page, `control_panel_login_success`);
                return true;
            }
            await page.waitForTimeout(500);
        }

        log(`  ❌ 控制面板登录失败，仍在登录页`);
        await screenshot(page, `control_panel_login_failed`);
        return false;
    } catch (e) {
        log(`  ❌ 控制面板登录异常: ${e.message}`);
        await screenshot(page, `control_panel_error`);
        return false;
    }
}

// ========== 主流程 ==========
(async () => {
    const usersJson = process.env.OPTIKLINK_USERS_JSON;
    if (!usersJson) {
        console.error('❌ 未设置 OPTIKLINK_USERS_JSON 环境变量');
        process.exit(1);
    }

    let users;
    try {
        users = JSON.parse(usersJson);
        if (!Array.isArray(users)) users = [users];
    } catch (e) {
        console.error('❌ OPTIKLINK_USERS_JSON 解析失败:', e.message);
        process.exit(1);
    }

    log(`找到 ${users.length} 个用户`);

    const results = [];

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const userLabel = user.username || `用户${i + 1}`;
        console.log(`\n${'='.repeat(60)}`);
        console.log(`  处理用户 ${i + 1}/${users.length}: ${userLabel}`);
        console.log(`${'='.repeat(60)}`);

        // 启动独立代理（如果有 V2 链接）
        let proxyConfig = null;
        try {
            proxyConfig = await resolveProxyForUser(user);
        } catch (e) {
            console.warn('[代理] 启动失败:', e.message);
        }

        let proxyCleanupGuard = false;

        const browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });

        let context;
        try {
            const ctxOptions = {
                viewport: { width: 1280, height: 720 },
                locale: 'zh-CN',
            };

            // 如果开启了代理，给浏览器配置 socks5 代理
            if (proxyConfig && proxyConfig.port) {
                ctxOptions.proxy = { server: `socks5://127.0.0.1:${proxyConfig.port}` };
            }

            context = await browser.newContext(ctxOptions);
            const page = await context.newPage();

            // 注入反检测脚本
            await page.addInitScript(() => {
                try {
                    const dp = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
                    if (dp) {
                        Object.defineProperty(Navigator.prototype, 'webdriver', {
                            configurable: true, enumerable: true, get: () => undefined
                        });
                    }
                } catch (e) { }
            });

            const userResults = { user: userLabel, optiklink: false, control: false };

            // ===== 1. 尝试恢复 cookie =====
            if (KV_ENABLED) {
                const cookieKey = `optiklink_${userLabel.replace(/[^a-zA-Z0-9]/g, '_')}`;
                const savedCookies = await kvGet(cookieKey);
                if (savedCookies) {
                    try {
                        const cookies = normalizeCookies(JSON.parse(savedCookies));
                        if (cookies.length > 0) {
                            await context.addCookies(cookies);
                            log('[Cookie] 已恢复缓存 cookie');
                        }
                    } catch (e) {
                        console.warn('[Cookie] 解析失败:', e.message);
                    }
                }
            }

            // ===== 2. Discord OAuth 登录 optiklink.net =====
            console.log(`\n[步骤 1/2] Discord OAuth 登录 optiklink.net...`);
            if (user['Discord-token']) {
                userResults.optiklink = await discordLogin(page, context, user['Discord-token']);
            } else {
                log('  ⚠️ 未提供 Discord-token，跳过 optiklink.net 登录');
            }

            // ===== 3. 登录控制面板 =====
            console.log(`\n[步骤 2/2] 登录控制面板 control.optiklink.net...`);
            if (user.username && user.password) {
                userResults.control = await controlPanelLogin(page, context, user.username, user.password);
            } else {
                log('  ⚠️ 未提供 username/password，跳过控制面板登录');
            }

            // ===== 4. 保存 cookie =====
            if (KV_ENABLED) {
                const cookies = await context.cookies();
                const optiklinkCookies = cookies.filter(c =>
                    c.domain.includes('optiklink.net') || c.domain.includes('optiklink.com') ||
                    c.domain.includes('control.optiklink.net')
                );
                if (optiklinkCookies.length > 0) {
                    const cookieKey = `optiklink_${userLabel.replace(/[^a-zA-Z0-9]/g, '_')}`;
                    await kvPut(cookieKey, JSON.stringify(optiklinkCookies));
                    log(`[Cookie] 已保存 ${optiklinkCookies.length} 个 cookie`);
                }
            }

            results.push(userResults);

        } catch (e) {
            log(`❌ 用户 ${userLabel} 处理异常: ${e.message}`);
            results.push({ user: userLabel, optiklink: false, control: false, error: e.message });
        } finally {
            if (context) await context.close();
            if (browser) await browser.close();
            // 清理该用户的代理
            cleanupSingbox();
            proxyCleanupGuard = true;
        }

        // 兜底清理（如果 finally 执行异常未到达）
        if (!proxyCleanupGuard) cleanupSingbox();
    }

    // ========== 输出结果汇总 ==========
    console.log(`\n${'='.repeat(60)}`);
    console.log('  结果汇总');
    console.log(`${'='.repeat(60)}`);
    let summary = '';
    for (const r of results) {
        const optik = r.optiklink ? '✅' : '❌';
        const ctrl = r.control ? '✅' : '❌';
        const line = `  ${r.user}: OptikLink ${optik} | 控制面板 ${ctrl}`;
        console.log(line);
        summary += `${line}\n`;
    }

    await sendTelegramMessage(summary);

    // 检查是否有失败
    const allOk = results.every(r => r.optiklink && r.control);
    if (!allOk) {
        console.log('\n⚠️ 部分登录失败，请检查截图。');
        process.exit(1);
    } else {
        console.log('\n✅ 全部登录成功！');
    }
})();