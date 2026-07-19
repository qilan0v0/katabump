// Rustix.me 机器状态检测与开机脚本 —— 纯 API 版 (无需 Playwright)
// 流程: POST /auth/login → 获取 XSRF token → 轮询服务器状态 → 离线时 POST /power 开机
// 账号来源: Secret RUSTIX_USERS_JSON (与 rustix_renew.js 共用)
//   [{"username":"xxx@gmail.com","password":"xxx","V2":"vless://...","YC_CLIENT_KEY":"..."}]
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

// 全局 HTTP 代理 (回退用)
const HTTP_PROXY = process.env.HTTP_PROXY;

// ===== Telegram 通知 =====
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

// ===== sing-box 管理 =====
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
        cfgPath = path.join(process.cwd(), `singbox-machine-${socksPort}.json`);
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
        try { fs.unlinkSync(path.join(process.cwd(), `singbox-machine-${port}.json`)); } catch (e) { }
    }
    singboxProcs.length = 0;
}

process.on('exit', () => cleanupSingbox());
process.on('SIGINT', () => { cleanupSingbox(); process.exit(0); });
process.on('SIGTERM', () => { cleanupSingbox(); process.exit(0); });

// ===== 解析用户代理配置 =====
async function resolveProxyForUser(user) {
    const v2Link = user.V2 || user.v2;
    if (v2Link) {
        console.log(`[代理] 用户有 V2 链接，启动独立 sing-box...`);
        const result = await startSingboxForLink(v2Link);
        if (result) return result;
        console.warn('[代理] sing-box 启动失败，回退');
    }
    if (HTTP_PROXY) {
        console.log(`[代理] 使用全局 HTTP 代理: ${HTTP_PROXY}`);
        return { port: null, url: HTTP_PROXY };
    }
    console.log('[代理] 直连');
    return null;
}

// 创建 axios 实例（带代理支持）
function createAxiosInstance(proxyInfo) {
    const cfg = {
        timeout: 30000,
        maxRedirects: 0, // 不自动跟随重定向，手动处理
        withCredentials: true,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
    };
    if (proxyInfo) {
        if (proxyInfo.url.startsWith('socks5://')) {
            // socks5 代理需要 socks-proxy-agent
            try {
                const { SocksProxyAgent } = require('socks-proxy-agent');
                cfg.httpsAgent = new SocksProxyAgent(proxyInfo.url);
                cfg.httpAgent = new SocksProxyAgent(proxyInfo.url);
            } catch (e) {
                console.warn('[代理] socks-proxy-agent 加载失败，尝试直连:', e.message);
            }
        } else if (proxyInfo.url.startsWith('http://') || proxyInfo.url.startsWith('https://')) {
            const purl = new URL(proxyInfo.url);
            cfg.proxy = { host: purl.hostname, port: parseInt(purl.port), protocol: purl.protocol.replace(':', '') };
        }
    }
    return axios.create(cfg);
}

// ===== API 客户端 =====
class ApiClient {
    constructor(axiosInstance) {
        this.ax = axiosInstance;
        this.cookies = {};
        this.xsrfToken = '';
    }

    // 解析 set-cookie 并存储
    _parseCookies(setCookieHeaders) {
        if (!setCookieHeaders) {
            console.log('   >> [cookie] 无 set-cookie 头');
            return;
        }
        const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        for (const raw of arr) {
            const parts = raw.split(';')[0];
            const eqIdx = parts.indexOf('=');
            if (eqIdx > 0) {
                const name = parts.substring(0, eqIdx).trim();
                const value = parts.substring(eqIdx + 1).trim();
                this.cookies[name] = value;
                if (name === 'XSRF-TOKEN') {
                    this.xsrfToken = decodeURIComponent(value);
                }
                console.log('   >> [cookie] 已存储: ' + name + '=' + value.substring(0, 30) + '...');
            }
        }
    }

    // 构建 cookie 请求头
    _cookieHeader() {
        const entries = Object.entries(this.cookies);
        if (entries.length === 0) return '';
        return entries.map(([k, v]) => `${k}=${v}`).join('; ');
    }

    // GET 请求，自动管理 cookie
    async get(url, extraHeaders = {}) {
        const headers = {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': MY_RUSTIX_URL + '/',
            ...extraHeaders,
        };
        if (this.xsrfToken) headers['X-XSRF-TOKEN'] = this.xsrfToken;

        const resp = await this.ax.get(url, {
            headers: { ...headers, Cookie: this._cookieHeader() },
            validateStatus: () => true,
        });
        this._parseCookies(resp.headers['set-cookie']);
        return resp;
    }

    // POST 请求，自动管理 cookie
    async post(url, data, extraHeaders = {}) {
        const headers = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': MY_RUSTIX_URL + '/auth/login',
            ...extraHeaders,
        };
        if (this.xsrfToken) headers['X-XSRF-TOKEN'] = this.xsrfToken;

        const resp = await this.ax.post(url, data, {
            headers: { ...headers, Cookie: this._cookieHeader() },
            validateStatus: () => true,
        });
        this._parseCookies(resp.headers['set-cookie']);
        return resp;
    }

    // 登录：先尝试直接 POST，失败再获取 XSRF token
    async login(username, password) {
        // 尝试直接 POST 登录（如果 CSRF 保护已排除此端点）
        console.log('   >> [登录] 尝试直接 POST 登录...');
        const directResp = await this.post(MY_RUSTIX_URL + '/auth/login', {
            user: username,
            password: password,
            'g-recaptcha-response': '',
        });

        // 200 = 成功（空响应体），302 = 重定向到主页（成功）
        if (directResp.status === 200 || directResp.status === 302) {
            console.log('   >> [登录] ✅ 直接 POST 登录成功');
            if (directResp.status === 302) {
                const loc = directResp.headers['location'];
                if (loc) {
                    try {
                        await this.ax.get(loc, {
                            headers: { Cookie: this._cookieHeader() },
                            validateStatus: () => true,
                            maxRedirects: 0,
                        });
                    } catch (e) { }
                }
            }
            return true;
        }

        // 419 = CSRF token mismatch → 需要获取 XSRF token 重试
        if (directResp.status === 419) {
            console.log('   >> [登录] 需要 XSRF token，获取中...');
            const loginPageResp = await this.ax.get(MY_RUSTIX_URL + '/auth/login', {
                headers: { Cookie: this._cookieHeader() },
                validateStatus: () => true,
                maxRedirects: 0,
                responseType: 'text',
            });
            this._parseCookies(loginPageResp.headers['set-cookie']);

            // 尝试从 meta 标签提取
            if (!this.xsrfToken && typeof loginPageResp.data === 'string') {
                const match = loginPageResp.data.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
                if (match && match[1]) {
                    this.xsrfToken = match[1];
                    console.log('   >> [登录] ✅ 从 meta 标签获取到 XSRF token');
                }
            }
            // 兜底：从 cookie 解码
            if (!this.xsrfToken) {
                const rawCookie = this.cookies['XSRF-TOKEN'];
                if (rawCookie) {
                    try {
                        this.xsrfToken = decodeURIComponent(rawCookie);
                        console.log('   >> [登录] ✅ 从 cookie 解码获取到 XSRF token');
                    } catch (e) {
                        this.xsrfToken = rawCookie;
                    }
                }
            }

            if (!this.xsrfToken) {
                throw new Error('无法获取 XSRF token');
            }
            console.log('   >> [登录] XSRF token 已获取，带 token 重试登录...');

            const retryResp = await this.post(MY_RUSTIX_URL + '/auth/login', {
                user: username,
                password: password,
                'g-recaptcha-response': '',
            });

            if (retryResp.status === 200 || retryResp.status === 302) {
                console.log('   >> [登录] ✅ 带 XSRF token 登录成功');
                if (retryResp.status === 302) {
                    const loc = retryResp.headers['location'];
                    if (loc) {
                        try {
                            await this.ax.get(loc, {
                                headers: { Cookie: this._cookieHeader() },
                                validateStatus: () => true,
                                maxRedirects: 0,
                            });
                        } catch (e) { }
                    }
                }
                return true;
            }
            console.error('   >> [登录] 带 XSRF token 登录仍失败: ' + retryResp.status);
            return false;
        }

        // 其他错误
        console.error('   >> [登录] 登录失败: ' + directResp.status + ' ' + (directResp.data && directResp.data.error ? directResp.data.error : ''));
        return false;
    }

    // 获取服务器列表
    async getServers() {
        console.log('   >> [API] 获取服务器列表...');
        console.log('   >> [API] 当前 cookie: ' + Object.keys(this.cookies).join(', ') || '(空)');
        const resp = await this.get(MY_RUSTIX_URL + '/api/client?page=1');
        console.log('   >> [API] 响应状态: ' + resp.status);
        if (resp.status === 302) {
            console.warn('   >> [API] 被重定向，可能未认证: ' + (resp.headers['location'] || '?'));
            return [];
        }
        if (resp.status !== 200) {
            console.warn('   >> [API] 获取服务器列表失败: ' + resp.status + ' ' + JSON.stringify(resp.data || '').substring(0, 200));
            return [];
        }
        const data = resp.data;
        if (!data || !data.data) {
            console.warn('   >> [API] 响应格式异常: ' + JSON.stringify(data).substring(0, 300));
            return [];
        }
        return data.data.map(s => {
            const attr = s.attributes || s;
            return {
                identifier: attr.identifier,
                name: attr.name,
                status: attr.status, // null = offline, 'running' = running
                uuid: attr.uuid,
                node: attr.node,
            };
        });
    }

    // 获取服务器资源/状态
    async getServerResources(identifier) {
        const resp = await this.get(MY_RUSTIX_URL + '/api/client/servers/' + identifier + '/resources');
        if (resp.status !== 200) return null;
        return resp.data && resp.data.attributes ? resp.data.attributes : null;
    }

    // 开机
    async powerOn(identifier) {
        console.log('   >> [API] 发送开机信号: ' + identifier);
        const resp = await this.post(MY_RUSTIX_URL + '/api/client/servers/' + identifier + '/power', {
            signal: 'start',
        });
        if (resp.status === 204) {
            console.log('   >> [API] ✅ 开机信号已发送');
            return true;
        }
        console.warn('   >> [API] 开机失败: ' + resp.status + ' ' + JSON.stringify(resp.data || '').substring(0, 200));
        return false;
    }
}

function getUsers() {
    try {
        if (process.env.RUSTIX_USERS_JSON) {
            const raw = process.env.RUSTIX_USERS_JSON.trim();
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (parsed.users) return parsed.users;
        }
    } catch (e) {
        console.error('[配置] 解析 RUSTIX_USERS_JSON 环境变量错误:', e.message);
    }
    if (process.env.RUSTIX_USER && process.env.RUSTIX_PASS) {
        const obj = { username: process.env.RUSTIX_USER, password: process.env.RUSTIX_PASS };
        return [obj];
    }
    return [];
}

// ===== 处理单个用户 =====
async function processUser(user) {
    const proxyInfo = await resolveProxyForUser(user);
    const ax = createAxiosInstance(proxyInfo);
    const client = new ApiClient(ax);

    // 构造带 cookie 的 axios 实例（用于初始 GET 获取 XSRF）
    const loginOk = await client.login(user.username, user.password);
    if (!loginOk) {
        // 如果登录失败，尝试用 Playwright 方式登录（rustix.me 的 Turnstile 登录）
        console.log('   >> [登录] 纯 API 登录失败，尝试 Playwright 浏览器登录...');
        return await processUserPlaywright(user, proxyInfo);
    }

    // 获取服务器列表
    const servers = await client.getServers();
    if (servers.length === 0) {
        console.log('   >> [检测] 该账号下没有服务器');
        await sendTelegramMessage('ℹ️ *无服务器*\n用户: ' + user.username);
        return;
    }

    console.log('   >> [检测] 发现 ' + servers.length + ' 个服务器:');
    for (const srv of servers) {
        const statusText = srv.status === 'running' ? '运行中' : (srv.status === 'starting' ? '启动中' : '离线');
        console.log('       - ' + srv.name + ' [' + statusText + ']');
    }

    // 检测离线服务器并开机
    const offlineServers = servers.filter(s => !s.status || s.status === null || s.status === 'off');
    const startingServers = servers.filter(s => s.status === 'starting');

    if (offlineServers.length === 0) {
        console.log('   >> [开机] ✅ 所有服务器正常运行');
        let msg = '✅ *服务器状态正常*\n用户: ' + user.username;
        if (startingServers.length > 0) {
            msg += '\n⚠️ ' + startingServers.length + ' 个服务器正在启动中';
        }
        await sendTelegramMessage(msg);
        return;
    }

    // 开机
    let startedCount = 0;
    let failCount = 0;
    for (const srv of offlineServers) {
        console.log('   >> [开机] 处理: ' + srv.name + ' (' + srv.identifier + ')');
        try {
            const ok = await client.powerOn(srv.identifier);
            if (ok) {
                startedCount++;
                // 等待一会儿验证状态
                await new Promise(r => setTimeout(r, 3000));
                const resources = await client.getServerResources(srv.identifier);
                if (resources) {
                    console.log('   >> [开机] 新状态: ' + resources.current_state);
                }
            } else {
                failCount++;
            }
        } catch (e) {
            console.warn('   >> [开机] 开机失败: ' + e.message);
            failCount++;
        }
    }

    // 发送通知
    let msg = '';
    if (startedCount > 0) {
        msg = '✅ *开机操作完成*\n用户: ' + user.username + '\n已启动: ' + startedCount + '/' + offlineServers.length;
    } else {
        msg = '❌ *开机失败*\n用户: ' + user.username + '\n失败: ' + failCount + '/' + offlineServers.length;
    }
    for (const srv of offlineServers) {
        msg += '\n  - ' + srv.name;
    }
    await sendTelegramMessage(msg);
}

// ===== Playwright 兜底登录（当 API 登录失败时） =====
async function processUserPlaywright(user, proxyInfo) {
    const { chromium } = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    chromium.use(stealth);

    const proxyArgs = [];
    if (proxyInfo) proxyArgs.push('--proxy-server=' + proxyInfo.url);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900'].concat(proxyArgs),
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'ru-RU',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    try {
        console.log('   >> [浏览器] 登录 my.rustix.me...');
        await page.goto(MY_RUSTIX_URL + '/auth/login', { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(2000);

        // 填写表单
        await page.locator('input[type="text"]').first().fill(user.username);
        await page.locator('input[type="password"]').first().fill(user.password);
        await page.waitForTimeout(500);

        // 点击登录
        await page.locator('button:has-text("Войти")').first().click();
        await page.waitForTimeout(3000);

        // 检查是否登录成功
        const currentUrl = page.url();
        if (currentUrl.includes('/auth/login')) {
            console.error('   >> [浏览器] 登录失败');
            throw new Error('浏览器登录失败');
        }
        console.log('   >> [浏览器] 登录成功');

        // 从浏览器获取 cookie 和 XSRF token
        const cookies = await context.cookies();
        const xsrfCookie = cookies.find(c => c.name === 'XSRF-TOKEN');
        if (!xsrfCookie) throw new Error('未获取到 XSRF token');

        // 使用浏览器 API 调用获取服务器列表
        console.log('   >> [浏览器] 获取服务器列表...');
        const servers = await page.evaluate(async () => {
            const resp = await fetch('https://my.rustix.me/api/client?page=1', {
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                credentials: 'include',
            });
            const data = await resp.json();
            return (data.data || []).map(s => ({
                identifier: s.attributes.identifier,
                name: s.attributes.name,
                status: s.attributes.status,
            }));
        });

        console.log('   >> [检测] 发现 ' + servers.length + ' 个服务器');

        const offlineServers = servers.filter(s => !s.status || s.status === null || s.status === 'off');
        if (offlineServers.length === 0) {
            console.log('   >> [开机] ✅ 所有服务器正常运行');
            await sendTelegramMessage('✅ *服务器状态正常*\n用户: ' + user.username);
            return;
        }

        let startedCount = 0;
        for (const srv of offlineServers) {
            console.log('   >> [开机] 处理: ' + srv.name);
            const result = await page.evaluate(async (id) => {
                try {
                    const resp = await fetch('https://my.rustix.me/api/client/servers/' + id + '/power', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                        credentials: 'include',
                        body: JSON.stringify({ signal: 'start' }),
                    });
                    return { ok: resp.status === 204, status: resp.status };
                } catch (e) { return { error: e.message }; }
            }, srv.identifier);
            if (result.ok) { startedCount++; console.log('   >> [开机] ✅ 已发送开机信号'); }
            else { console.warn('   >> [开机] 开机失败: ' + JSON.stringify(result)); }
            await page.waitForTimeout(2000);
        }

        let msg = startedCount > 0
            ? '✅ *开机完成*\n用户: ' + user.username + '\n已启动: ' + startedCount + '/' + offlineServers.length
            : '❌ *开机失败*\n用户: ' + user.username;
        await sendTelegramMessage(msg);

    } finally {
        await context.close();
        await browser.close().catch(() => {});
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