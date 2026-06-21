// Zampto (zampto.net) 续期保活脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 打开登录页 → 输邮箱点继续 → 输密码点登录 → 登录成功
//       → 打开配置的 serverUrl → 点续期按钮
// 账号来源: Secret ZAMPTO_USERS_JSON =
//   [{"username":"a@b.com","password":"pwd","serverUrl":"https://...","proxy":"vmess://..."}]
//   proxy 字段可选: 每个用户可带自己的 vmess:// / vless:// 分享链接, 脚本会为其
//   启动独立的本地 v2ray 实例并让该用户的浏览器走它; 不带 proxy 的用户回退到
//   全局 HTTP_PROXY (workflow 用 V2RAY_VMESS 启动的 127.0.0.1:10809)。
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');
const net = require('net');
const { buildConfig } = require('./.github/scripts/gen-v2ray-config');

const LOGIN_URL = 'https://auth.zampto.net/sign-in';

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

// --- Per-user v2ray 进程管理 ---
// 每个不同的 proxy 分享链接 → 一个独立 v2ray 实例, 本地 HTTP 端口从 10810 起递增。
const V2RAY_BIN = process.env.V2RAY_BIN || `${process.env.HOME}/v2ray/v2ray`;
const PER_USER_PROXY_BASE_PORT = 10810;
const v2rayProcs = [];        // 已启动的 { proc, port, link } 列表, 退出时统一清理
const v2rayByLink = new Map(); // link → 本地 http 代理 url (复用同一链接的实例)
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

// 为某个分享链接启动 v2ray, 返回本地 http 代理 url (http://127.0.0.1:port)。失败返回 null。
async function startV2rayForLink(link) {
    if (v2rayByLink.has(link)) return v2rayByLink.get(link);
    if (!fs.existsSync(V2RAY_BIN)) {
        console.error(`[v2ray] 未找到 v2ray 二进制 (${V2RAY_BIN})，无法为用户启动专属代理。`);
        return null;
    }
    const port = nextProxyPort++;
    let cfgPath;
    try {
        const cfg = buildConfig(link, port);
        cfgPath = path.join(process.cwd(), `v2ray-user-${port}.json`);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    } catch (e) {
        console.error(`[v2ray] 解析用户 proxy 链接失败: ${e.message}`);
        return null;
    }
    console.log(`[v2ray] 为用户代理启动实例 (端口 ${port})...`);
    const proc = spawn(V2RAY_BIN, ['run', '-config', cfgPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => { stderr += `spawn error: ${e.message}\n`; });
    v2rayProcs.push({ proc, port, link });
    const ready = await waitProxyReady(port);
    if (!ready) {
        console.error(`[v2ray] 端口 ${port} 未就绪。stderr 末尾:\n${stderr.slice(-400)}`);
        return null;
    }
    const url = `http://127.0.0.1:${port}`;
    v2rayByLink.set(link, url);
    console.log(`[v2ray] 用户代理就绪: ${url}`);
    return url;
}

function stopAllV2ray() {
    for (const { proc, port } of v2rayProcs) {
        try { process.kill(-proc.pid); } catch (e) { try { proc.kill(); } catch (e2) { } }
        try { fs.unlinkSync(path.join(process.cwd(), `v2ray-user-${port}.json`)); } catch (e) { }
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

// --- Cloudflare KV：存取登录 cookie，避免每次都登录 ---
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const KV_ENABLED = !!(CF_ACCOUNT_ID && CF_KV_NAMESPACE_ID && CF_API_TOKEN);

function kvUrl(key) {
    return `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`
        + `/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
}
// 直连 (proxy:false)，不走 v2ray，避免被节点干扰
async function kvGet(key) {
    if (!KV_ENABLED) return null;
    try {
        const r = await axios.get(kvUrl(key), {
            headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
            timeout: 15000, proxy: false, transformResponse: [(d) => d]
        });
        return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    } catch (e) {
        if (e.response && e.response.status === 404) { console.log('[KV] 暂无已存 cookie'); return null; }
        console.warn('[KV] 读取失败:', e.message);
        return null;
    }
}
async function kvPut(key, value) {
    if (!KV_ENABLED) return false;
    try {
        await axios.put(kvUrl(key), value, {
            headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' },
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
            const parsed = JSON.parse(process.env.ZAMPTO_USERS_JSON);
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
            return;
        } catch (e) {
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

// 登录单个账号（两步：先邮箱后密码）：返回 true/false
async function loginOnce(page, user) {
    await gotoWithRetry(page, LOGIN_URL);
    await page.waitForTimeout(2000);

    // 第 1 步：输入邮箱 → 点继续
    console.log('输入邮箱...');
    const emailInput = page.locator('input[type="email"], input[name="email"], input[name="identifier"], input[placeholder*="email" i]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(user.username);
    await page.waitForTimeout(400);
    const contBtn = page.getByRole('button', { name: /continue|next|sign\s?in|log\s?in/i })
        .or(page.locator('button[type="submit"]'))
        .first();
    await contBtn.click();
    await page.waitForTimeout(2500);

    // 第 2 步：输入密码 → 点登录
    console.log('输入密码...');
    const pwdInput = page.locator('input[type="password"], input[name="password"], input[placeholder*="password" i]').first();
    await pwdInput.waitFor({ state: 'visible', timeout: 15000 });
    await pwdInput.fill(user.password);
    await page.waitForTimeout(400);
    const signInBtn = page.getByRole('button', { name: /sign\s?in|log\s?in|continue/i })
        .or(page.locator('button[type="submit"]'))
        .first();
    await signInBtn.click();

    // 等待离开登录页 = 登录成功
    for (let s = 0; s < 25; s++) {
        await page.waitForTimeout(1000);
        if (!/sign-in|\/login/i.test(page.url())) return true;
        const err = await page.getByText(/invalid|incorrect|wrong|failed|error|not found/i)
            .first().isVisible().catch(() => false);
        if (err) return false;
    }
    return !/sign-in|\/login/i.test(page.url());
}

// 解析每个用户应使用的代理:
//   proxy = http(s)://... 或 socks5:// → 直接用该代理，不启 v2ray
//   proxy = vmess:// / vless://       → 为其启动 per-user v2ray (本地 http url)
//   不带 proxy                        → 回退到全局 HTTP_PROXY
// 返回 { config, label } (config 为 null 表示直连)
async function resolveUserProxy(user) {
    if (user.proxy && typeof user.proxy === 'string' && user.proxy.trim()) {
        const link = user.proxy.trim();
        // http(s):// 或 socks5:// → 直接解析，不走 v2ray
        if (/^(https?|socks5?):\/\//i.test(link)) {
            const cfg = parseProxyUrl(link);
            if (!cfg) {
                console.warn(`   >> proxy 格式无效，回退到全局代理。`);
            } else if (cfg.username && /^socks5/i.test(cfg.server)) {
                // SOCKS5 + 认证：Chrome 不支持 --proxy-server 直接带认证，
                // 启动本地 HTTP 中继来转发
                const url = new URL(cfg.server);
                const relay = await startSocksRelay(url.hostname, url.port, cfg.username, cfg.password);
                socksRelays.push(relay);
                const localCfg = parseProxyUrl(relay.server);
                return { config: localCfg, label: `本地中继 → SOCKS5 (${url.hostname}:${url.port})` };
            } else {
                return { config: cfg, label: `直连代理 (${cfg.server})` };
            }
        } else {
            // vmess:// / vless:// → 启动 per-user v2ray
            const localUrl = await startV2rayForLink(link);
            if (localUrl) {
                return { config: parseProxyUrl(localUrl), label: `专属 v2ray (${localUrl})` };
            }
            console.warn(`   >> 用户专属 proxy 启动失败，回退到全局代理。`);
        }
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

            // 3. cookie 失效 → 完整登录 → 存新 cookie
            if (!loggedIn) {
                loggedIn = await loginOnce(page, user);
                if (!loggedIn) {
                    const shot = path.join(photoDir, `zampto_${safeUser}_loginfail.png`);
                    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                    console.log(`   >> ❌ 登录失败，停留在: ${page.url()}`);
                    await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n停留在: ${page.url()}`, shot);
                    console.log('用户处理完成');
                    return;
                }
                console.log(`   >> ✅ 登录成功: ${page.url()}`);
                // 保存新 cookie 到 KV
                try {
                    const cookies = await context.cookies();
                    await kvPut(cookieKey, JSON.stringify(cookies));
                } catch (e) { console.warn('   >> 保存 cookie 失败:', e.message); }
            }

            if (!user.serverUrl) {
                const shot = path.join(photoDir, `zampto_${safeUser}.png`);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`✅ *登录成功*\n用户: ${user.username}\n(未配置 serverUrl，跳过续期)`, shot);
                console.log('用户处理完成');
                return;
            }

            // 打开服务器页并点续期
            console.log(`打开续费页: ${user.serverUrl}`);
            await gotoWithRetry(page, user.serverUrl);
            await page.waitForTimeout(3000);

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

            const disabled = await renewBtn.isDisabled().catch(() => false);
            if (disabled) {
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                console.log('   >> ⏳ 暂不可续期 (按钮禁用)。');
                await sendTelegramMessage(`⏳ *暂不可续期*\n用户: ${user.username}\n原因: 续期按钮禁用 (可能未到时间)`, shot);
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
                    // Google Ad iframe 可能遮挡按钮，先 force: true 绕过
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
                // 检查结果
                await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => page.waitForTimeout(5000));
                const after = await page.locator('body').innerText().catch(() => '');
                const ok = /success|renewed|successfully|extended/i.test(after);
                try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) { }
                if (ok) {
                    console.log('   >> ✅ 续期成功。');
                    await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n服务器已续期！`, shot);
                } else {
                    console.log('   >> ⚠️ 已点击续期，结果未知。');
                    await sendTelegramMessage(`⚠️ *续期结果未知*\n用户: ${user.username}\n已点击续期，详见截图`, shot);
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

    stopAllV2ray();
    for (const r of socksRelays) r.close();
    console.log('完成。');
    process.exit(0);
})();
