// Zampto (zampto.net) 续期保活脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: cookie 免登录 (KV) → 打开配置的 serverUrl → 点续期按钮
// cookie 失效时自动尝试邮箱+密码登录，需要验证码时使用 LOGIN_CODE 环境变量
// 账号来源: Secret ZAMPTO_USERS_JSON =
//   [{"username":"a@b.com","password":"pwd","serverUrl":"https://...","v2":"vless://..."}]
//   v2 字段可选: 代理链接 (vless:// vmess:// trojan:// hysteria2:// tuic:// anytls:// socks5://),
//   脚本会启动 sing-box 作为本地 SOCKS5 代理, 覆盖全局 HTTP_PROXY。
//   不带 v2 的用户回退到全局 HTTP_PROXY。
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');
const net = require('net');
const { buildConfig: buildSingboxConfig } = require('./.github/scripts/gen-singbox-config');

const LOGIN_URL = 'https://dash.zampto.net/auth/login';

// --- Turnstile CDP Bypass 注入脚本 ---
// 劫持 attachShadow 捕获 Turnstile checkbox，计算位置比例存入 window.__turnstile_data
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(m,n){return Math.floor(Math.random()*(n-m+1))+m}
        let screenX = getRandomInt(800,1200), screenY = getRandomInt(400,600);
        Object.defineProperty(MouseEvent.prototype,'screenX',{value:screenX});
        Object.defineProperty(MouseEvent.prototype,'screenY',{value:screenY});
    } catch(e){}
    try {
        const o=Element.prototype.attachShadow;
        Element.prototype.attachShadow=function(i){
            const s=o.call(this,i);
            if(s){const c=()=>{
                const cb=s.querySelector('input[type="checkbox"]');
                if(cb){const r=cb.getBoundingClientRect();
                if(r.width>0&&r.height>0&&window.innerWidth>0&&window.innerHeight>0){
                    window.__turnstile_data={xRatio:(r.left+r.width/2)/window.innerWidth,yRatio:(r.top+r.height/2)/window.innerHeight};
                    return true;
                }}
                return false;
            };if(!c()){const m=new MutationObserver(()=>{if(c())m.disconnect()});m.observe(s,{childList:true,subtree:true});}}
            return s;
        };
    } catch(e){}
})();
`;

// --- Per-user sing-box 进程管理 ---
// 每个不同的 v2 链接 → 一个独立 sing-box 实例, 本地 SOCKS5 端口从 10810 起递增。
const SINGBOX_BIN = process.env.SINGBOX_BIN || `${process.env.HOME}/sing-box/sing-box`;
const PER_USER_PROXY_BASE_PORT = 10810;
const singboxProcs = [];        // 已启动的 { proc, port, link } 列表, 退出时统一清理
const singboxByLink = new Map(); // link → 本地 socks5 代理 url (复用同一链接的实例)
let nextProxyPort = PER_USER_PROXY_BASE_PORT;

function waitProxyReady(port, tries = 15) {
    return new Promise((resolve) => {
        let n = 0;
        const tick = () => {
            const req = http.get({
                host: '127.0.0.1', port, path: '/', timeout: 3000,
                // 通过本地 http 代理请求一个轻量目标, 能连上即视为就绪
                headers: {}
            }, () => resolve(true));
            req.on('error', () => {
                if (++n >= tries) return resolve(false);
                setTimeout(tick, 2000);
            });
            req.on('timeout', () => { req.destroy(); if (++n >= tries) return resolve(false); else setTimeout(tick, 2000); });
            req.end();
        };
        tick();
    });
}

// 为某个代理链接启动 sing-box, 返回本地 socks5 代理 url。失败返回 null。
async function startSingboxForLink(link) {
    if (singboxByLink.has(link)) return singboxByLink.get(link);
    if (!fs.existsSync(SINGBOX_BIN)) {
        console.error(`[sing-box] 未找到 sing-box 二进制 (${SINGBOX_BIN})，无法为用户启动代理。`);
        return null;
    }
    const socksPort = nextProxyPort++;
    const httpPort = nextProxyPort++; // HTTP 入站用于就绪检测
    let cfgPath;
    try {
        const cfg = buildSingboxConfig(link, socksPort, httpPort);
        cfgPath = path.join(process.cwd(), `singbox-user-${socksPort}.json`);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error(`[sing-box] 解析 v2 链接失败: ${e.message}`);
        return null;
    }
    console.log(`[sing-box] 为用户代理启动实例 (SOCKS5 端口 ${socksPort}, HTTP 端口 ${httpPort})...`);
    const proc = spawn(SINGBOX_BIN, ['run', '-c', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
    singboxProcs.push({ proc, port: socksPort, link });
    // 通过 HTTP 入站检测就绪
    const ready = await waitProxyReady(httpPort);
    if (!ready) {
        console.error(`[sing-box] 代理端口未就绪。stderr 末尾:\n${stderr.slice(-400)}`);
        return null;
    }
    const url = `socks5://127.0.0.1:${socksPort}`;
    singboxByLink.set(link, url);
    console.log(`[sing-box] 用户代理就绪: ${url}`);
    return url;
}

function stopAllSingbox() {
    for (const { proc, port } of singboxProcs) {
        try { process.kill(-proc.pid); } catch (e) { try { proc.kill(); } catch (e2) { } }
        try { fs.unlinkSync(path.join(process.cwd(), `singbox-user-${port}.json`)); } catch (e) { }
    }
}

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID; // 可选：超级群话题(Topic)的 message_thread_id
const PROJECT = process.env.PROJECT_NAME || 'Zampto';

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
// 全局 HTTP_PROXY (workflow 用 V2RAY_VMESS 启动的 127.0.0.1:10809) 作为回退代理。
// 把一个 http://[user:pass@]host:port 形式的代理 url 解析为 { server, username, password }。
// 解析失败返回 null。
function parseProxyUrl(httpProxy) {
    if (!httpProxy) return null;
    // 标准格式: socks5://user:pass@host:port
    try {
        const proxyUrl = new URL(httpProxy);
        if (proxyUrl.hostname) {
            const hasAuth = !!(proxyUrl.username && proxyUrl.password);
            const protocol = proxyUrl.protocol;
            const hostPort = `${proxyUrl.hostname}:${proxyUrl.port}`;
            let server;
            if (hasAuth && /^socks/i.test(protocol)) {
                // SOCKS5 认证必须嵌在 URL 里传给 Chrome
                server = `${protocol}//${encodeURIComponent(proxyUrl.username)}:${encodeURIComponent(proxyUrl.password)}@${hostPort}`;
            } else {
                server = `${protocol}//${hostPort}`;
            }
            return {
                server,
                username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
                password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
            };
        }
    } catch (e) { /* 尝试非标准格式 */ }

    // 非标准格式: socks5://host:port:user:pass (如 CliProxy)
    try {
        const rest = httpProxy.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
        const parts = rest.split(':');
        if (parts.length === 4) {
            const [host, port, username, password] = parts;
            return {
                server: `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
                username: decodeURIComponent(username),
                password: decodeURIComponent(password)
            };
        }
    } catch (e2) { /* 放弃 */ }

    console.error(`[代理] 代理 url 格式无效 (${httpProxy})。期望: socks5://user:pass@host:port 或 socks5://host:port:user:pass`);
    return null;
}

// 全局回退代理 (来自 HTTP_PROXY 环境变量)
const GLOBAL_PROXY_CONFIG = parseProxyUrl(process.env.HTTP_PROXY);
if (GLOBAL_PROXY_CONFIG) {
    console.log(`[代理] 全局回退代理: 服务器=${GLOBAL_PROXY_CONFIG.server}, 认证=${GLOBAL_PROXY_CONFIG.username ? '是' : '否'}`);
} else if (process.env.HTTP_PROXY) {
    console.error('[代理] HTTP_PROXY 解析失败，将以直连方式运行。');
}

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


// 规范化 cookie 数组为 Playwright addCookies 接受的格式 (兼容浏览器扩展导出的 expirationDate/sameSite 等)


// 规范化 cookie 数组为 Playwright addCookies 接受的格式 (兼容浏览器扩展导出的 expirationDate/sameSite 等)
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

// 验证某个代理配置能否连通 (proxyConfig 为 null 表示直连, 直接返回 true)
async function checkProxy(proxyConfig) {
    if (!proxyConfig) return true;
    console.log('[代理] 正在验证代理连接...');
    const proxyUrl = new URL(proxyConfig.server);
    const isSocks = /^socks/i.test(proxyUrl.protocol);

    if (isSocks) {
        // SOCKS5: 只用 TCP 连通性测试（axios 不支持 socks），Chrome 原生支持 socks5://
        console.log(`[代理] SOCKS5 代理, 测试 TCP 连通性 ${proxyUrl.hostname}:${proxyUrl.port}...`);
        try {
            await new Promise((resolve, reject) => {
                const sock = require('net').createConnection(proxyUrl.port, proxyUrl.hostname, () => {
                    sock.destroy();
                    resolve();
                });
                sock.on('error', reject);
                sock.setTimeout(10000, () => { sock.destroy(); reject(new Error('超时')); });
            });
            console.log('[代理] TCP 连接成功！(SOCKS5)');
            return true;
        } catch (error) {
            console.error(`[代理] TCP 连接失败: ${error.message}`);
            return false;
        }
    }

    // HTTP/HTTPS 代理: 用 axios 通过代理访问 Google 验证
    try {
        const axiosConfig = {
            proxy: {
                protocol: proxyUrl.protocol.replace(/:$/, ''),
                host: proxyUrl.hostname,
                port: proxyUrl.port,
            },
            timeout: 10000
        };
        if (proxyConfig.username && proxyConfig.password) {
            axiosConfig.proxy.auth = { username: proxyConfig.username, password: proxyConfig.password };
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

// --- SOCKS5 认证中继 ---
// Chrome 的 --proxy-server 不支持 socks5://user:pass@host:port,
// 所以需要创建一个本地 HTTP 代理，把 CONNECT 请求中继到带认证的 SOCKS5 代理。
// 返回 { server, close }，server 是 http://127.0.0.1:PORT，close 用于关闭监听。
function startSocksRelay(socksHost, socksPort, username, password) {
    const server = http.createServer();
    server.on('connect', (req, clientSocket, head) => {
        const [targetHost, targetPort] = req.url.split(':');

        const socks = net.createConnection(socksPort, socksHost, () => {
            // 1. SOCKS5 握手：认证方法协商
            socks.write(Buffer.from([0x05, 0x01, 0x02])); // SOCKS5, 1 method, username/pass
        });

        // 统一错误处理：任一 socket 出错，两边都关闭
        function cleanup() {
            try { socks.destroy(); } catch (e) {}
            try { clientSocket.destroy(); } catch (e) {}
        }
        socks.on('error', cleanup);
        clientSocket.on('error', cleanup);

        // 2. 读取 SOCKS5 认证方法响应
        socks.once('data', resp => {
            if (resp[0] !== 0x05 || (resp[1] !== 0x02 && resp[1] !== 0x00)) {
                if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                return cleanup();
            }

            if (resp[1] === 0x02) {
                // 3. 服务器要求 username/password 认证 (RFC 1929)
                const u = Buffer.from(username || '');
                const p = Buffer.from(password || '');
                socks.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
                // 4. 读取认证响应
                socks.once('data', authResp => {
                    if (authResp[0] !== 0x01 || authResp[1] !== 0x00) {
                        if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Proxy Auth Failed\r\n\r\n');
                        return cleanup();
                    }
                    doConnect();
                });
            } else {
                // 无认证
                doConnect();
            }
        });

        function doConnect() {
            // 5. SOCKS5 CONNECT 请求
            const hostBuf = Buffer.from(targetHost);
            const portNum = parseInt(targetPort, 10);
            socks.write(Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                hostBuf,
                Buffer.from([(portNum >> 8) & 0xff, portNum & 0xff])
            ]));
            // 6. 读取 CONNECT 响应
            socks.once('data', connectResp => {
                if (connectResp[0] !== 0x05 || connectResp[1] !== 0x00) {
                    if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Proxy Connect Failed\r\n\r\n');
                    return cleanup();
                }
                // 7. 通知客户端 CONNECT 成功
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                // 8. 转发可能已收到的 head 数据
                if (head && head.length > 0) socks.unshift(head);
                // 9. 双向中继
                clientSocket.pipe(socks).pipe(clientSocket);
            });
        }
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            console.log(`[中继] 本地 SOCKS5 中继已启动: http://127.0.0.1:${port}`);
            resolve({
                server: `http://127.0.0.1:${port}`,
                close: () => { try { server.close(); } catch (e) {} }
            });
        });
    });
}

const socksRelays = []; // 启动的中继列表，退出时统一清理

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

let chromeProc = null; // 当前 Chrome 进程句柄, 供重启时杀掉旧实例

// 杀掉当前 Chrome 并清掉用户数据目录, 以便用不同代理重新启动
async function stopChrome() {
    if (chromeProc) {
        try { process.kill(-chromeProc.pid); } catch (e) { try { chromeProc.kill(); } catch (e2) { } }
        chromeProc = null;
    }
    try { fs.rmSync('/tmp/chrome_user_data', { recursive: true, force: true }); } catch (e) { }
    // 等端口释放, 避免新实例抢不到 DEBUG_PORT
    for (let i = 0; i < 10; i++) {
        if (!(await checkPort(DEBUG_PORT))) break;
        await new Promise(r => setTimeout(r, 500));
    }
}

// 启动 Chrome; proxyConfig 为 null 表示直连, 否则把 server 写进 --proxy-server。
async function launchChrome(proxyConfig) {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已开启。'); return; }
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-blink-features=AutomationControlled',
        '--user-data-dir=/tmp/chrome_user_data'
    ];
    if (proxyConfig) {
        args.push(`--proxy-server=${proxyConfig.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`正在启动 Chrome (路径: ${CHROME_PATH}, 第 ${attempt} 次)...`);
        let stderr = '';
        const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        if (chrome.stderr) chrome.stderr.on('data', d => { stderr += d.toString(); });
        chrome.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
        chrome.unref();
        chromeProc = chrome;
        console.log('正在等待 Chrome 初始化...');
        for (let i = 0; i < 40; i++) {
            if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已就绪。'); return; }
            await new Promise(r => setTimeout(r, 1000));
        }
        console.error(`Chrome 第 ${attempt} 次未在端口 ${DEBUG_PORT} 起来。stderr 末尾:\n` + stderr.slice(-800));
        try { process.kill(-chrome.pid); } catch (e) { }
        chromeProc = null;
        try { fs.rmSync('/tmp/chrome_user_data', { recursive: true, force: true }); } catch (e) { }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Chrome 启动失败');
}

function getUsers() {
    try {
        if (process.env.ZAMPTO_USERS_JSON) {
            // 清除字符串中的控制字符（如换行），GitHub Secrets 粘贴多行时容易带入
            const raw = process.env.ZAMPTO_USERS_JSON.replace(/[\x00-\x1f]/g, '');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 ZAMPTO_USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function gotoWithRetry(page, url, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // 检查是否为 Cloudflare 错误页（522/521/520 等），是则视为失败重试
            const bodyText = await page.locator('body').innerText().catch(() => '');
            if (/error code (52[0-9]|403)|connection timed out/i.test(bodyText)) {
                const match = bodyText.match(/Error code (52[0-9]|403)/i);
                console.warn(`[导航] Cloudflare ${match ? match[1] : '错误'}: 连接源服务器超时，第 ${i}/${retries} 次重试...`);
                if (i === retries) throw new Error(`Cloudflare 错误 (${match ? match[1] : '未知'})：源服务器不可达`);
                await page.waitForTimeout(10000); // 服务器端问题，多等一会
                continue;
            }
            return;
        } catch (e) {
            if (e.message.startsWith('Cloudflare')) throw e; // 已达最大重试，直接抛出
            console.warn(`[导航] 打开 ${url} 失败 (第 ${i}/${retries} 次): ${e.message}`);
            if (i === retries) throw e;
            await page.waitForTimeout(3000);
        }
    }
}

// 遍历所有 Frames，查找被注入脚本标记的 Turnstile 坐标，用 CDP 发送原生鼠标点击
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('   >> 在 Frame 中找到 Turnstile:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`   >> CDP 点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                console.log('   >> CDP 点击发送成功。');
                await client.detach();
                return true;
            }
        } catch (e) { /* 忽略跨域 Frame 错误 */ }
    }
    return false;
}

// 登录单个账号（支持验证码流程）：返回 true/false
async function loginOnce(page, user) {
    await gotoWithRetry(page, LOGIN_URL);
    await page.waitForTimeout(2000);

    console.log('输入邮箱...');
    const emailInput = page.locator('input#email, input[type="email"], input[name="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    await emailInput.fill(user.username);
    await page.waitForTimeout(400);

    console.log('输入密码...');
    const pwdInput = page.locator('input#password, input[type="password"], input[name="password"]').first();
    await pwdInput.waitFor({ state: 'visible', timeout: 30000 });
    await pwdInput.fill(user.password);
    await page.waitForTimeout(400);

    console.log('点击 Login...');
    const loginBtn = page.locator('button[type="submit"]').or(page.getByRole('button', { name: /login|sign\\s?in/i })).first();
    await loginBtn.click();
    await page.waitForTimeout(3000);

    // 检测是否需要邮箱验证码
    const pageText = await page.locator('body').innerText().catch(() => '');
    if (/verification code|6-digit|login code|verify code|sent to your email/i.test(pageText)) {
        console.log('   >> 需要邮箱验证码...');
        const loginCode = process.env.LOGIN_CODE;
        if (loginCode && loginCode.length === 6) {
            console.log('   >> 使用 LOGIN_CODE 环境变量中的验证码');
            const codeInput = page.locator('input[placeholder*="000000"], input[maxlength="6"], input[type="text"]').first();
            try {
                await codeInput.waitFor({ state: 'visible', timeout: 5000 });
                await codeInput.fill(loginCode);
                await page.waitForTimeout(400);
                const verifyBtn = page.locator('button').filter({ hasText: /verify|confirm|submit/i }).first();
                await verifyBtn.click();
                await page.waitForTimeout(3000);
            } catch (e) {
                console.warn('   >> 验证码输入失败:', e.message);
            }
        } else {
            console.log('   >> 需要验证码但未配置 LOGIN_CODE，请设置后重试');
            return false;
        }
    }

    // 等待离开登录页 = 登录成功
    for (let s = 0; s < 25; s++) {
        await page.waitForTimeout(1000);
        if (!/sign-in|\\/login/i.test(page.url())) return true;
        const err = await page.getByText(/invalid|incorrect|wrong|failed|error|not found/i)
            .first().isVisible().catch(() => false);
        if (err) return false;
    }
    return !/sign-in|\\/login/i.test(page.url());
}

// 解析每个用户应使用的代理:
//   v2 = vless:// vmess:// trojan:// hysteria2:// tuic:// anytls:// socks5://...
//        → 启动 per-user sing-box (本地 socks5), 覆盖全局 HTTP_PROXY
//   不带 v2 → 回退到全局 HTTP_PROXY
// 返回 { config, label } (config 为 null 表示直连)
async function resolveUserProxy(user) {
    if (user.v2 && typeof user.v2 === 'string' && user.v2.trim()) {
        const link = user.v2.trim();
        const localUrl = await startSingboxForLink(link);
        if (localUrl) {
            const cfg = parseProxyUrl(localUrl);
            return { config: cfg, label: `sing-box (${localUrl})` };
        }
        console.warn(`   >> v2 代理启动失败，回退到全局代理。`);
    }
    return {
        config: GLOBAL_PROXY_CONFIG,
        label: GLOBAL_PROXY_CONFIG ? `全局代理 (${GLOBAL_PROXY_CONFIG.server})` : '直连 (无代理)'
    };
}

// 处理单个用户的完整续期流程 (在已就绪的 context/page 上)。
async function processUser(context, page, user, photoDir) {
    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
    const cookieKey = `zampto_cookie_${safeUser}`;
    try {
        if (page.isClosed()) { page = await context.newPage(); await page.addInitScript(INJECTED_SCRIPT); }
        try { await context.clearCookies(); } catch (e) { }

            // 1. 先注入 KV 里的 cookie，尝试免登录
            const saved = await kvGet(cookieKey);
            if (saved) {
                try {
                    const cks = normalizeCookies(JSON.parse(saved));
                    if (cks.length) { await context.addCookies(cks); console.log(`   >> 已注入 KV cookie (${cks.length} 条)`); }
                } catch (e) { console.warn('   >> cookie 解析失败:', e.message); }
            }

            // 2. 用 cookie 直接打开服务器页(无 serverUrl 则打开登录页)，判断 cookie 是否有效
            let loggedIn = false;
            if (saved) {
                const probeUrl = user.serverUrl || LOGIN_URL;
                await gotoWithRetry(page, probeUrl);
                await page.waitForTimeout(2500);
                // 没被跳回登录页 = cookie 有效
                loggedIn = !/sign-in|\/login/i.test(page.url());
                console.log(`   >> cookie ${loggedIn ? '有效，免登录' : '无效/已过期'} (当前: ${page.url()})`);
            }

            // 3. cookie 失效 → 尝试登录
            if (!loggedIn) {
                console.log('   >> 尝试手动登录...');
                const loginOk = await loginOnce(page, user);
                if (loginOk) {
                    console.log('   >> ✅ 登录成功!');
                    loggedIn = true;
                    // 保存新 cookie 到 KV
                    try {
                        const cookies = await context.cookies();
                        await kvPut(cookieKey, JSON.stringify(cookies));
                    } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }
                } else {
                    const shot = path.join(photoDir, `zampto_${safeUser}_loginfail.png`);
                    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                    console.log(`   >> ❌ 登录失败，停留在: ${page.url()}`);
                    await sendTelegramMessage(`❌ *登录失败*
用户: ${user.username}
停留在: ${page.url()}`, shot);
                    console.log('用户处理完成');
                    return;
                }
            }

            if (!user.serverUrl) {
                const shot = path.join(photoDir, `zampto_${safeUser}.png`);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`✅ *Cookie 有效*\n用户: ${user.username}\n(未配置 serverUrl，跳过续期)`, shot);
                console.log('用户处理完成');
                return;
            }

            // 打开服务器页并点续期
            console.log(`打开续费页: ${user.serverUrl}`);
            await gotoWithRetry(page, user.serverUrl);
            await page.waitForTimeout(3000);

            // 检测 Ad Blocker / VPN 检测等拦截页面，点击 "Refresh Page" 或 "Check Again"
            const blockedText = await page.locator('body').innerText().catch(() => '');
            if (/ad blocker|disable.*ad|refresh\s*page|check\s*again/i.test(blockedText)) {
                console.log('   >> 检测到拦截页面 (Ad Blocker/VPN)，尝试点击刷新...');
                const refreshBtn = page.getByRole('button', { name: /refresh\s*page|check\s*again/i })
                    .or(page.locator('button, a, [role="button"]').filter({ hasText: /refresh|check again/i }))
                    .first();
                try {
                    await refreshBtn.waitFor({ state: 'visible', timeout: 5000 });
                    await refreshBtn.click();
                    await page.waitForTimeout(5000);
                    console.log('   >> 已点击刷新，等待页面加载...');
                } catch (e) {
                    console.log('   >> 未找到刷新按钮，尝试页面刷新...');
                    await page.reload();
                    await page.waitForTimeout(5000);
                }
            }

            // 续期按钮：精确匹配 "Renew Server"（绿色按钮），兼容 button/a/[role=button] 及其它续期文案
            const renewBtn = page.locator('button, a, [role="button"]')
                .filter({ hasText: /renew\s*server|renew|extend|add\s?time|续期|延长/i })
                .first();
            const shot = path.join(photoDir, `zampto_${safeUser}_renew.png`);
            try {
                await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
            } catch (e) {
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e2) { }
                await sendTelegramMessage(`⚠️ *未找到续期按钮*\n用户: ${user.username}\n详见截图`, shot);
                console.log('用户处理完成');
                return;
            }

            // 抓取续期前的时间信息
            async function getRenewTimes() {
                try {
                    const last = await page.locator('#lastRenewalTime').innerText().catch(() => '未知');
                    const next = await page.locator('#nextRenewalTime').innerText().catch(() => '未知');
                    return { last, next };
                } catch (e) { return { last: '未知', next: '未知' }; }
            }

            const disabled = await renewBtn.isDisabled().catch(() => false);
            const beforeTimes = await getRenewTimes();
            const beforeInfo = `上次续期: ${beforeTimes.last}\n到期: ${beforeTimes.next}`;

            if (disabled) {
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                console.log('   >> ⏳ 暂不可续期 (按钮禁用)。');
                await sendTelegramMessage(`⏳ *暂不可续期*\n用户: ${user.username}\n${beforeInfo}\n原因: 续期按钮禁用 (可能未到时间)`, shot);
            } else {
                console.log('   >> 点击续期...');
                try { await renewBtn.click({ timeout: 8000 }); } catch (e) { await renewBtn.click({ force: true }); }

                // --- 等待弹窗出现 + CF Turnstile 处理 ---
                await page.waitForTimeout(3000);
                console.log('   >> 等待 Turnstile 弹窗...');
                let cdpClicked = false;
                for (let findAttempt = 0; findAttempt < 20; findAttempt++) {
                    cdpClicked = await attemptTurnstileCdp(page);
                    if (cdpClicked) break;
                    await page.waitForTimeout(1000);
                }
                if (cdpClicked) {
                    console.log('   >> CDP 点击成功，等待验证结果...');
                    for (let waitSec = 0; waitSec < 15; waitSec++) {
                        let isSuccess = false;
                        for (const f of page.frames()) {
                            if (f.url().includes('cloudflare')) {
                                try { if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) { isSuccess = true; break; } } catch (e) { }
                            }
                        }
                        if (isSuccess) { console.log('   >> ✅ Turnstile 验证成功！'); break; }
                        await page.waitForTimeout(1000);
                    }
                } else {
                    console.log('   >> ⚠️ 未找到 Turnstile，继续...');
                }
                // 弹窗确认按钮
                const confirmBtn = page.locator('#renew-modal button, #renew-modal [role="button"], button, a, [role="button"]')
                    .filter({ hasText: /renew|confirm|续期|确定/i }).first();
                if (await confirmBtn.isVisible().catch(() => false)) {
                    console.log('   >> 点击弹窗确认按钮...');
                    await confirmBtn.click({ timeout: 8000, force: true }).catch(() => confirmBtn.click({ force: true, timeout: 8000 }));
                    try {
                        if (await page.getByText('Please complete the captcha').isVisible({ timeout: 3000 })) {
                            console.log('   >> ⚠️ Captcha 未通过，刷新重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            console.log('用户处理完成（需重试）');
                            return;
                        }
                    } catch (e) { }
                }
                // 等待弹窗消失 + 页面更新（重试 3 轮）
                let renewalDone = false;
                for (let r = 0; r < 3; r++) {
                    await page.waitForTimeout(3000);
                    // 检查是否有成功消息
                    const bodyText = await page.locator('body').innerText().catch(() => '');
                    if (/renew(ed)?\s*success|successfully\s*renew|续期成功|时间已更新/i.test(bodyText)) {
                        console.log('   >> ✅ 续期成功消息已出现');
                        renewalDone = true;
                        break;
                    }
                    // 如果弹窗确认按钮还在，再点一次
                    if (await confirmBtn.isVisible().catch(() => false)) {
                        console.log(`   >> 弹窗仍在，第 ${r+1} 次点击确认...`);
                        await confirmBtn.click({ timeout: 5000, force: true }).catch(() => {});
                    }
                    // 检查弹窗是否已关闭（确认按钮不可见）
                    if (!(await confirmBtn.isVisible().catch(() => false))) {
                        console.log('   >> 弹窗已关闭');
                        await page.waitForTimeout(2000);
                        break;
                    }
                }
                // 等待页面刷新或更新
                await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => page.waitForTimeout(5000));
                await page.waitForTimeout(2000);
                // 抓取续期后的时间信息
                const afterTimes = await getRenewTimes();
                const afterInfo = `上次续期: ${afterTimes.last}\n到期: ${afterTimes.next}`;
                const timeChanged = beforeTimes.last !== afterTimes.last || beforeTimes.next !== afterTimes.next;
                const detailInfo = `📋 *续期信息*\n${timeChanged ? afterInfo : `(时间未变)\n${afterInfo}`}`;

                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                if (timeChanged) {
                    console.log(`   >> ✅ 续期成功！(时间已更新: ${beforeTimes.last} → ${afterTimes.last})`);
                    await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n${detailInfo}`, shot);
                } else {
                    console.log('   >> ⚠️ 已点击续期，但时间未变化。');
                    await sendTelegramMessage(`⚠️ *续期结果未知*\n用户: ${user.username}\n${detailInfo}\n时间未发生变化，详见截图`, shot);
                }
            }
        } catch (err) {
            console.error('处理用户出错:', err.message);
            const shot = path.join(photoDir, `zampto_${safeUser}_error.png`);
            try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`❌ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, shot);
        }
        console.log('用户处理完成');
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 ZAMPTO_USERS_JSON 中找到用户');
        process.exit(1);
    }

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    let lastProxyConfig = undefined;

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        const { config: proxyConfig, label: proxyLabel } = await resolveUserProxy(user);
        console.log(`   >> 使用代理: ${proxyLabel}`);

        const proxyChanged = JSON.stringify(proxyConfig) !== JSON.stringify(lastProxyConfig);
        if (proxyChanged) {
            await stopChrome();
            if (proxyConfig) {
                const ok = await checkProxy(proxyConfig);
                if (!ok) {
                    console.error('[代理] 代理无效，跳过该用户。');
                    continue;
                }
            }
            await launchChrome(proxyConfig);
            lastProxyConfig = proxyConfig;
        }

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
        if (!browser) { console.error('连接失败，跳过该用户。'); continue; }

        const context = browser.contexts()[0];
        let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        page.setDefaultTimeout(60000);
        await page.addInitScript(INJECTED_SCRIPT);

        if (proxyConfig && proxyConfig.username) {
            await context.setHTTPCredentials({ username: proxyConfig.username, password: proxyConfig.password });
        } else {
            await context.setHTTPCredentials(null);
        }

        await processUser(context, page, user, photoDir);
        await browser.close();
    }

    stopAllSingbox();
    for (const r of socksRelays) r.close();
    console.log('完成。');
    process.exit(0);
})();
