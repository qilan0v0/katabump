// Rustix.me 机器状态检测与开机脚本 —— Playwright 版
// 流程: 浏览器登录 my.rustix.me → page.evaluate API 调用 → 离线时 POST /power 开机
// 账号来源: Secret RUSTIX_USERS_JSON (与 rustix_renew.js 共用)
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const MY_RUSTIX_URL = 'https://my.rustix.me';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'RustixMachine';
const HTTP_PROXY = process.env.HTTP_PROXY;

// ===== Telegram 通知 =====
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.warn('[Telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }
    const text = '📌 *' + PROJECT + '*\n' + message;
    const tgErr = (e) => (e.response && e.response.data && e.response.data.description)
        ? e.response.data.error_code + ' ' + e.response.data.description
        : e.message;
    const threadArg = TG_THREAD_ID ? ' -F message_thread_id="' + TG_THREAD_ID + '"' : '';

    if (imagePath && fs.existsSync(imagePath)) {
        const captionFile = imagePath + '.caption.txt';
        try { fs.writeFileSync(captionFile, text.slice(0, 1000)); } catch (e) { }
        const sendPhoto = (withMd) => new Promise(function(resolve) {
            const md = withMd ? ' -F parse_mode="Markdown"' : '';
            const cmd = 'curl -s -X POST "https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendPhoto"'
                + ' -F chat_id="' + TG_CHAT_ID + '"' + threadArg
                + ' -F "caption=<' + captionFile + '"' + md + ' -F photo="@' + imagePath + '"';
            exec(cmd, function(err, stdout) { resolve({ err: err, stdout: stdout || '' }); });
        });
        var r = await sendPhoto(true);
        if (!r.err && r.stdout.indexOf('"ok":true') !== -1) {
            console.log('[Telegram] 图文消息已发送。');
        } else {
            console.warn('[Telegram] 图文(Markdown)发送失败，改纯文本重试:', (r.stdout || (r.err && r.err.message) || '').slice(0, 200));
            r = await sendPhoto(false);
            if (!r.err && r.stdout.indexOf('"ok":true') !== -1) console.log('[Telegram] 图文消息已发送 (纯文本)。');
            else console.error('[Telegram] 图文消息发送失败:', (r.stdout || '').slice(0, 300));
        }
        try { fs.unlinkSync(captionFile); } catch (e) { }
        return;
    }

    try {
        var url = 'https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage';
        var base = { chat_id: TG_CHAT_ID };
        if (TG_THREAD_ID) base.message_thread_id = Number(TG_THREAD_ID);
        try {
            await axios.post(url, Object.assign({}, base, { text: text, parse_mode: 'Markdown' }));
            console.log('[Telegram] Message sent.');
        } catch (e) {
            console.warn('[Telegram] Markdown 发送失败，改用纯文本重试:', tgErr(e));
            await axios.post(url, Object.assign({}, base, { text: text }));
            console.log('[Telegram] Message sent (plain text).');
        }
    } catch (e) {
        console.error('[Telegram] 文字推送失败:', tgErr(e));
    }
}

// ===== sing-box 管理 =====
var { buildConfig: buildSingboxConfig } = require('./.github/scripts/gen-singbox-config');
var SINGBOX_BIN = process.env.SINGBOX_BIN || process.env.HOME + '/sing-box/sing-box';
var singboxProcs = [];
var nextSocksPort = 10810;

async function startSingboxForLink(link) {
    if (!fs.existsSync(SINGBOX_BIN)) {
        console.error('[sing-box] 未找到 sing-box 二进制 (' + SINGBOX_BIN + ')');
        return null;
    }
    var socksPort = nextSocksPort++;
    var httpPort = nextSocksPort++;
    var cfgPath;
    try {
        var cfg = buildSingboxConfig(link, socksPort, httpPort);
        cfgPath = path.join(process.cwd(), 'singbox-machine-' + socksPort + '.json');
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error('[sing-box] 解析 V2 链接失败: ' + e.message);
        return null;
    }
    console.log('[sing-box] 启动实例 (SOCKS5 ' + socksPort + ', HTTP ' + httpPort + ')...');
    var proc = spawn(SINGBOX_BIN, ['run', '-c', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    var stderr = '';
    if (proc.stderr) proc.stderr.on('data', function(d) { stderr += d.toString(); });
    proc.on('error', function(e) { stderr += 'spawn error: ' + e.message + '\n'; });
    singboxProcs.push({ proc: proc, port: socksPort });

    var ready = await new Promise(function(resolve) {
        var n = 0;
        var tick = function() {
            var req = http.get({ host: '127.0.0.1', port: httpPort, path: '/', timeout: 3000 }, function() { resolve(true); });
            req.on('error', function() { if (++n >= 15) { resolve(false); } else { setTimeout(tick, 2000); } });
            req.on('timeout', function() { req.destroy(); if (++n >= 15) { resolve(false); } else { setTimeout(tick, 2000); } });
            req.end();
        };
        tick();
    });
    if (!ready) {
        console.error('[sing-box] 代理端口未就绪。stderr:\n' + stderr.slice(-400));
        return null;
    }
    var url = 'socks5://127.0.0.1:' + socksPort;
    console.log('[sing-box] 代理就绪 -> ' + url);
    return { port: socksPort, url: url };
}

function cleanupSingbox() {
    for (var i = 0; i < singboxProcs.length; i++) {
        var entry = singboxProcs[i];
        try { entry.proc.kill('SIGTERM'); } catch (e) { }
        try { fs.unlinkSync(path.join(process.cwd(), 'singbox-machine-' + entry.port + '.json')); } catch (e) { }
    }
    singboxProcs.length = 0;
}

process.on('exit', function() { cleanupSingbox(); });
process.on('SIGINT', function() { cleanupSingbox(); process.exit(0); });
process.on('SIGTERM', function() { cleanupSingbox(); process.exit(0); });

// ===== 解析用户代理配置 =====
async function resolveProxyForUser(user) {
    var v2Link = user.V2 || user.v2;
    if (v2Link) {
        console.log('[代理] 用户有 V2 链接，启动独立 sing-box...');
        var result = await startSingboxForLink(v2Link);
        if (result) return result;
        console.warn('[代理] sing-box 启动失败，回退');
    }
    if (HTTP_PROXY) {
        console.log('[代理] 使用全局 HTTP 代理: ' + HTTP_PROXY);
        return { port: null, url: HTTP_PROXY };
    }
    console.log('[代理] 直连');
    return null;
}

function getUsers() {
    try {
        if (process.env.RUSTIX_USERS_JSON) {
            var raw = process.env.RUSTIX_USERS_JSON.trim();
            var parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (parsed.users) return parsed.users;
        }
    } catch (e) {
        console.error('[配置] 解析 RUSTIX_USERS_JSON 环境变量错误: ' + e.message);
    }
    if (process.env.RUSTIX_USER && process.env.RUSTIX_PASS) {
        return [{ username: process.env.RUSTIX_USER, password: process.env.RUSTIX_PASS }];
    }
    return [];
}

// ===== 处理单个用户 =====
async function processUser(user) {
    var proxyInfo = await resolveProxyForUser(user);
    chromium.use(stealth);

    var proxyArgs = [];
    if (proxyInfo) proxyArgs.push('--proxy-server=' + proxyInfo.url);

    var browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900'].concat(proxyArgs),
    });
    var context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'ru-RU',
    });
    var page = await context.newPage();
    page.setDefaultTimeout(60000);

    var photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    var safeUser = user.username.replace(/[^a-z0-9]/gi, '_');

    try {
        // Step 1: 登录
        console.log('   >> [登录] 打开登录页...');
        await page.goto(MY_RUSTIX_URL + '/auth/login', { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(2000);

        // 检查是否已登录
        var currentUrl = page.url();
        if (currentUrl.indexOf('/auth/login') === -1) {
            console.log('   >> [登录] 已有有效 session');
        } else {
            console.log('   >> [登录] 填写凭据...');
            await page.locator('input[type="text"]').first().fill(user.username);
            await page.locator('input[type="password"]').first().fill(user.password);
            await page.waitForTimeout(500);

            console.log('   >> [登录] 点击登录...');
            await page.locator('button:has-text("Войти")').first().click();
            await page.waitForTimeout(3000);

            currentUrl = page.url();
            if (currentUrl.indexOf('/auth/login') !== -1) {
                console.error('   >> [登录] 登录失败');
                throw new Error('登录失败');
            }
            console.log('   >> [登录] 登录成功');
        }

        // Step 2: 获取服务器列表
        console.log('   >> [API] 获取服务器列表...');
        var servers = await page.evaluate(async function() {
            try {
                var resp = await fetch('https://my.rustix.me/api/client?page=1', {
                    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    credentials: 'include',
                });
                var data = await resp.json();
                if (!data || !data.data) return [];
                return data.data.map(function(s) {
                    var attr = s.attributes || s;
                    return {
                        identifier: attr.identifier,
                        name: attr.name || '',
                        status: attr.status,
                    };
                });
            } catch (e) { return []; }
        });

        if (servers.length === 0) {
            console.log('   >> [检测] 该账号下没有服务器');
            await sendTelegramMessage('ℹ️ *无服务器*\n用户: ' + user.username);
            return;
        }

        console.log('   >> [检测] 发现 ' + servers.length + ' 个服务器:');
        for (var si = 0; si < servers.length; si++) {
            var st = servers[si].status === 'running' ? '运行中' : (servers[si].status === 'starting' ? '启动中' : '离线');
            console.log('       - ' + servers[si].name + ' [' + st + ']');
        }

        // Step 3: 检测离线服务器并开机
        var offlineServers = [];
        for (var si = 0; si < servers.length; si++) {
            if (!servers[si].status || servers[si].status === null || servers[si].status === 'off') {
                offlineServers.push(servers[si]);
            }
        }

        if (offlineServers.length === 0) {
            console.log('   >> [开机] 所有服务器正常运行');
            var msg = '✅ *服务器状态正常*\n用户: ' + user.username;
            await sendTelegramMessage(msg);
            return;
        }

        console.log('   >> [开机] 发现 ' + offlineServers.length + ' 个离线服务器');
        // 获取 XSRF token（用于 POST 请求的 CSRF 保护）
        var xsrfToken = await page.evaluate(function() {
            // 从 meta 标签获取
            var meta = document.querySelector('meta[name="csrf-token"]');
            if (meta) return meta.getAttribute('content');
            // 从 cookie 获取
            var match = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
            if (match) return decodeURIComponent(match[1]);
            return null;
        });
        console.log('   >> [开机] XSRF token: ' + (xsrfToken ? '已获取' : '未获取'));

        var startedCount = 0;
        for (var si = 0; si < offlineServers.length; si++) {
            var srv = offlineServers[si];
            console.log('   >> [开机] 处理: ' + srv.name + ' (' + srv.identifier + ')');
            try {
                var result = await page.evaluate(async function(params) {
                    try {
                        var headers = {
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                        };
                        if (params.xsrf) headers['X-XSRF-TOKEN'] = params.xsrf;
                        var resp = await fetch('https://my.rustix.me/api/client/servers/' + params.id + '/power', {
                            method: 'POST',
                            headers: headers,
                            credentials: 'include',
                            body: JSON.stringify({ signal: 'start' }),
                        });
                        return { ok: resp.status === 204, status: resp.status };
                    } catch (e) { return { error: e.message }; }
                }, { id: srv.identifier, xsrf: xsrfToken });
                if (result.ok) {
                    startedCount++;
                    console.log('   >> [开机] 已发送开机信号');
                } else {
                    console.warn('   >> [开机] 开机失败: ' + JSON.stringify(result));
                }
                await page.waitForTimeout(2000);
            } catch (e) {
                console.warn('   >> [开机] 出错: ' + e.message);
            }
        }

        // 截图
        var shot = path.join(photoDir, 'machine_' + safeUser + '.png');
        try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }

        // 发送通知
        var msg = '';
        if (startedCount > 0) {
            msg = '✅ *开机完成*\n用户: ' + user.username + '\n已启动: ' + startedCount + '/' + offlineServers.length;
        } else {
            msg = '❌ *开机失败*\n用户: ' + user.username;
        }
        await sendTelegramMessage(msg, shot);

    } catch (err) {
        console.error('[' + user.username + '] 出错: ' + err.message);
        var shotPath = path.join(photoDir, 'machine_' + safeUser + '_error.png');
        try { await page.screenshot({ path: shotPath, fullPage: true }); } catch (e) { }
        await sendTelegramMessage('❌ *处理异常*\n用户: ' + user.username + '\n错误: ' + err.message, shotPath);
        throw err;
    } finally {
        await context.close();
        await browser.close().catch(function() {});
    }
}

// === 主流程 ===
(async function() {
    var users = getUsers();
    if (users.length === 0) {
        console.log('未在 RUSTIX_USERS_JSON 中找到用户');
        process.exit(1);
    }

    var allSuccess = true;
    for (var i = 0; i < users.length; i++) {
        var user = users[i];
        console.log('\n=== 处理用户 ' + (i + 1) + '/' + users.length + ': ' + user.username + ' ===');
        try {
            await processUser(user);
            console.log('[' + user.username + '] 完成');
        } catch (err) {
            console.error('[' + user.username + '] 失败: ' + err.message);
            allSuccess = false;
        }
    }

    cleanupSingbox();
    console.log('\n=== 全部完成 === ' + (allSuccess ? '全部成功' : '部分失败'));
    process.exit(allSuccess ? 0 : 1);
})();