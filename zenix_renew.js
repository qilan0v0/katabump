// Zenix.sg (dash.zenix.sg) 免费面板签到 + 续期脚本 —— 专用于 GitHub Actions (Linux/Headless)
// 流程: 加载 KV cookie → 打开 /dashboard/earn 签到领金币 → 打开 /dashboard/afk 挂机赚金币
//       → 打开 /dashboard/renew 续期 → 截图通知（含总金币、签到、AFK、续期结果）
// 账号来源: Secret ZENIX_USERS_JSON =
//   [{"email":"xxx","password":"xxx"}]
// cookie 通过 KV Admin Worker 存取，key = zenix_cookie_<email>
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const EARN_URL = 'https://dash.zenix.sg/dashboard/earn';
const RENEW_URL = 'https://dash.zenix.sg/dashboard/renew';
const AFK_URL = 'https://dash.zenix.sg/dashboard/afk';
const LOGIN_URL = 'https://dash.zenix.sg/login';

// AFK 持续时长（分钟），默认 30 分钟
const AFK_DURATION_MINUTES = parseInt(process.env.AFK_DURATION_MINUTES || '30', 10);

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || 'Zenix';

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

// --- KV Cookie Admin Worker ---
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

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: { protocol: 'http', host: new URL(PROXY_CONFIG.server).hostname, port: parseInt(new URL(PROXY_CONFIG.server).port) },
            timeout: 15000
        };
        if (PROXY_CONFIG.username) {
            axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        const r = await axios.get('https://api.ipify.org?format=json', axiosConfig);
        if (r.data && r.data.ip) {
            console.log('[代理] 代理出口 IP:', r.data.ip);
            return true;
        }
    } catch (e) {
        console.warn('[代理] 验证失败:', e.message);
        return false;
    }
}

function getUsers() {
    try {
        if (process.env.ZENIX_USERS_JSON) {
            const parsed = JSON.parse(process.env.ZENIX_USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 ZENIX_USERS_JSON 环境变量错误:', e);
    }
    return [];
}

// 从页面文本中提取余额（侧边栏显示 "XXX coins available"）
function extractBalance(pageText) {
    const match = pageText.match(/(\d+)\s*coins?\s*available/i);
    return match ? parseInt(match[1], 10) : null;
}

// 从页面文本中提取 AFK 信息
function extractAfkInfo(pageText) {
    const timerMatch = pageText.match(/(\d{2}:\d{2})/);
    const earnedMatch = pageText.match(/Earned\s+([\d.]+)\s+coins/i);
    const rateMatch = pageText.match(/Rate\s+([\d.]+)\s+coins/i);
    const statusMatch = pageText.match(/Active session.*?(Running|Stopped)/i);
    return {
        timer: timerMatch ? timerMatch[1] : '?',
        earned: earnedMatch ? parseFloat(earnedMatch[1]) : 0,
        rate: rateMatch ? parseFloat(rateMatch[1]) : 0,
        status: statusMatch ? statusMatch[1] : '?'
    };
}

// ===================== 主流程 =====================

async function processUser(browser, user, index) {
    const { email, password } = user;
    const logPrefix = `[用户 ${index + 1}] ${email}`;
    console.log(`\n========== ${logPrefix} ==========`);

    const kvKey = `zenix_cookie_${email}`;
    const screenshotDir = 'screenshots';
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `zenix_${email.replace(/[@.]/g, '_')}.png`);

    let context;
    let page;
    try {
        // 创建浏览器上下文
        context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            locale: 'en-US',
            ...(PROXY_CONFIG ? { proxy: PROXY_CONFIG } : {})
        });

        // 加载缓存的 cookie
        const savedCookies = await kvGet(kvKey);
        if (savedCookies) {
            try {
                const parsed = JSON.parse(savedCookies);
                const normalized = normalizeCookies(parsed);
                if (normalized.length > 0) {
                    await context.addCookies(normalized);
                    console.log('[Cookie] 已加载', normalized.length, '个 cookie');
                }
            } catch (e) {
                console.warn('[Cookie] 解析失败:', e.message);
            }
        }

        page = await context.newPage();

        // 注入抗检测脚本
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });

        // ==================== 登录 ====================
        console.log('[步骤1] 检查登录状态...');
        await page.goto(RENEW_URL, { waitUntil: 'networkidle', timeout: 30000 });
        let currentUrl = page.url();
        console.log('[当前URL]', currentUrl);

        if (currentUrl.includes('/login')) {
            console.log('[登录] 需要登录，正在填写登录表单...');
            await page.getByPlaceholder('you@example.com').fill(email);
            await page.getByPlaceholder('••••••••').fill(password);
            await page.getByRole('button', { name: 'Sign In' }).click();
            try {
                await page.waitForURL('**/dashboard/**', { timeout: 15000 });
                console.log('[登录] 登录成功！');
            } catch (e) {
                const afterUrl = page.url();
                console.log('[登录后URL]', afterUrl);
                if (afterUrl.includes('/login')) {
                    await page.screenshot({ path: screenshotPath });
                    throw new Error('登录失败，可能凭据不正确');
                }
                console.log('[登录] 可能已成功，当前URL:', afterUrl);
            }
        } else {
            console.log('[登录] 已有有效 session，跳过登录');
        }

        await page.waitForTimeout(2000);

        // ==================== 签到领金币 ====================
        console.log('\n[步骤2] 前往签到页 /dashboard/earn ...');
        await page.goto(EARN_URL, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);

        // 截图签到前状态
        await page.screenshot({ path: screenshotPath });

        // 获取签到前余额
        const earnPageText = await page.locator('main').textContent();
        let balanceBefore = extractBalance(earnPageText);
        console.log('[签到] 当前余额:', balanceBefore != null ? balanceBefore + ' coins' : '未知');

        // 找签到按钮
        const claimBtn = page.getByRole('button', { name: 'Claim Daily Reward' });
        const claimExists = await claimBtn.count();

        let earnAmount = 0;
        let claimSuccess = false;
        let claimMessage = '';

        if (claimExists > 0) {
            console.log('[签到] 找到 "Claim Daily Reward" 按钮，正在签到...');
            await claimBtn.click();
            // 等待签到完成
            await page.waitForTimeout(3000);

            // 重新读取页面文本获取结果
            const afterClaimText = await page.locator('main').textContent();
            // 提取新余额
            const balanceAfter = extractBalance(afterClaimText);
            console.log('[签到] 签到后余额:', balanceAfter != null ? balanceAfter + ' coins' : '未知');

            // 计算获得的金币
            if (balanceBefore != null && balanceAfter != null) {
                earnAmount = balanceAfter - balanceBefore;
            }

            // 检查按钮是否变为禁用状态
            const afterBtn = page.getByRole('button', { name: /Come back|Available/i });
            const afterBtnCount = await afterBtn.count();
            if (afterBtnCount > 0 || earnAmount > 0) {
                claimSuccess = true;
                claimMessage = `✅ 签到成功 +${earnAmount} coins`;
                console.log(`[签到] ✅ 成功！获得 ${earnAmount} coins，当前余额 ${balanceAfter != null ? balanceAfter : '?'} coins`);
            } else {
                // 检查是否已经签过到（按钮是 "Come back in 24h"）
                const disabledBtn = page.getByRole('button', { name: /Come back in/i });
                if (await disabledBtn.count() > 0) {
                    claimMessage = '⏭️ 今日已签到';
                    console.log('[签到] ⏭️ 今日已签到过');
                } else {
                    claimMessage = '⚠️ 签到结果未知';
                    console.log('[签到] ⚠️ 签到结果未知');
                }
            }

            // 更新截图
            await page.screenshot({ path: screenshotPath });
        } else {
            // 检查是否已经签到（按钮是 "Come back in 24h"）
            const disabledBtn = page.getByRole('button', { name: /Come back in/i });
            if (await disabledBtn.count() > 0) {
                claimMessage = '⏭️ 今日已签到';
                console.log('[签到] ⏭️ 今日已签到过');
            } else {
                claimMessage = '⚠️ 未找到签到按钮';
                console.log('[签到] ⚠️ 未找到签到按钮');
            }
        }

        // 确保拿到最新余额
        const finalEarnText = await page.locator('main').textContent();
        const currentBalance = extractBalance(finalEarnText);
        console.log('[签到] 最终余额:', currentBalance != null ? currentBalance + ' coins' : '未知');

        // ==================== AFK 挂机赚金币 ====================
        console.log(`\n[步骤3] 前往 AFK 挂机页，将挂机 ${AFK_DURATION_MINUTES} 分钟...`);
        await page.goto(AFK_URL, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        // 获取 AFK 开始前的余额
        const afkStartText = await page.locator('main').textContent();
        const balanceBeforeAfk = extractBalance(afkStartText);
        const afkStartInfo = extractAfkInfo(afkStartText);
        console.log('[AFK] 开始状态:', afkStartInfo, '余额:', balanceBeforeAfk);

        // 等待 AFK 挂机
        const startTime = Date.now();
        const afkDurationMs = AFK_DURATION_MINUTES * 60 * 1000;
        let afkEarned = 0;

        while (Date.now() - startTime < afkDurationMs) {
            const elapsed = Date.now() - startTime;
            const remaining = Math.max(0, Math.ceil((afkDurationMs - elapsed) / 1000));
            const remainingMin = Math.floor(remaining / 60);
            const remainingSec = remaining % 60;

            // 每 60 秒检查一次进度
            const checkInterval = Math.min(60 * 1000, afkDurationMs - elapsed);
            await page.waitForTimeout(checkInterval);

            // 读取当前 AFK 状态
            const currentText = await page.locator('main').textContent();
            const currentAfk = extractAfkInfo(currentText);
            const currentBalance = extractBalance(currentText);

            if (currentAfk.earned > afkEarned) {
                console.log(`[AFK] 进度 ${remainingMin}m${remainingSec}s - 已赚 ${currentAfk.earned} coins, 定时 ${currentAfk.timer}, 余额 ${currentBalance} coins`);
                afkEarned = currentAfk.earned;
            }

            // 检查 AFK 是否意外停止
            if (currentAfk.status === 'Stopped') {
                console.log('[AFK] ⚠️ 会话已停止，尝试刷新页面重新开始...');
                await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
                await page.waitForTimeout(2000);
            }
        }

        // AFK 结束，获取最终状态
        const afkEndText = await page.locator('main').textContent();
        const afkEndInfo = extractAfkInfo(afkEndText);
        const balanceAfterAfk = extractBalance(afkEndText);
        const afkCoinsEarned = balanceBeforeAfk != null && balanceAfterAfk != null
            ? balanceAfterAfk - balanceBeforeAfk
            : afkEndInfo.earned;

        console.log(`[AFK] ✅ 挂机结束！共 ${AFK_DURATION_MINUTES} 分钟，赚取 ${afkCoinsEarned} coins`);
        console.log('[AFK] 最终状态:', afkEndInfo, '余额:', balanceAfterAfk);

        // 截图 AFK 结束状态
        await page.screenshot({ path: screenshotPath });

        // ==================== 续期 ====================
        console.log('\n[步骤4] 前往续期页 /dashboard/renew ...');
        await page.goto(RENEW_URL, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);

        // 截图续期前状态
        await page.screenshot({ path: screenshotPath });

        const renewButton = page.getByRole('button', { name: /^Renew Account/i });
        const buttonExists = await renewButton.count();

        let renewSuccess = false;
        let renewMessage = '';

        if (buttonExists === 0) {
            console.log('[续期] 未找到续期按钮');
            renewMessage = '❌ 未找到续期按钮';
        } else {
            const buttonText = await renewButton.textContent();
            console.log('[续期] 按钮文本:', buttonText);

            // 点击续期按钮
            await renewButton.click();
            await page.waitForTimeout(3000);

            // 检查续期结果
            const renewPageText = await page.locator('main').textContent();
            const lastRenewMatch = renewPageText.match(/Last renewed:\s*([^\n]+)/);
            const lastRenew = lastRenewMatch ? lastRenewMatch[1].trim() : '未知';
            const daysMatch = renewPageText.match(/(\d+\.?\d*)\s*days?/);
            const days = daysMatch ? daysMatch[1] : '?';

            // 再次检查按钮文本
            const newButtonText = await renewButton.textContent();
            const costMatch = newButtonText.match(/\((\d+)\s*coins?\)/);
            const cost = costMatch ? costMatch[1] : '0';

            // 如果还在计算中，再点一次
            if (newButtonText.includes('Calculating') || newButtonText.includes('0 coins')) {
                console.log('[续期] 按钮文本:', newButtonText, '，尝试再次点击...');
                await renewButton.click();
                await page.waitForTimeout(3000);
            }

            // 检查冷却
            const finalRenewText = await page.locator('main').textContent();
            const finalLastRenewMatch = finalRenewText.match(/Last renewed:\s*([^\n]+)/);
            const finalLastRenew = finalLastRenewMatch ? finalLastRenewMatch[1].trim() : lastRenew;

            if (finalRenewText.includes('Please wait')) {
                const waitMatch = finalRenewText.match(/Please wait\s+([^\.]+)/);
                const waitTime = waitMatch ? waitMatch[1] : '冷却中';
                renewMessage = `⏳ 续期等待中 (${waitTime})`;
                console.log('[续期] 冷却中:', waitTime);
            } else {
                renewMessage = `✅ 续期完成\n上次续期: ${finalLastRenew}\n可用天数: ${days}\n费用: ${cost} coins`;
                console.log('[续期] 成功！');
                renewSuccess = true;
            }
        }

        // 最终截图
        await page.screenshot({ path: screenshotPath });

        // ==================== 推送 ====================
        const finalBalance = balanceAfterAfk != null ? balanceAfterAfk : (currentBalance != null ? currentBalance : null);
        const balanceInfo = finalBalance != null ? `💰 总金币: ${finalBalance} coins` : '';
        const earnInfo = claimMessage;
        const afkInfo = `⏰ AFK挂机 ${AFK_DURATION_MINUTES}分钟: +${afkCoinsEarned} coins`;
        const renewInfo = `📋 续期: ${renewMessage}`;

        const resultMessage = [
            `👤 *${email}*`,
            balanceInfo,
            `🎁 签到: ${earnInfo}`,
            afkInfo,
            renewInfo,
        ].join('\n');

        console.log(`\n========== 推送消息 ==========\n${resultMessage}\n==============================`);
        await sendTelegramMessage(resultMessage, screenshotPath);

        // 保存 cookie 供下次使用
        const cookies = await context.cookies();
        const zenixCookies = cookies.filter(c => c.domain.includes('zenix.sg'));
        if (zenixCookies.length > 0) {
            await kvPut(kvKey, JSON.stringify(zenixCookies));
            console.log('[Cookie] 已保存', zenixCookies.length, '个 cookie');
        }

        console.log(`========== ${logPrefix} 完成 ==========\n`);
        return { success: claimSuccess || renewSuccess, email, result: resultMessage };

    } catch (e) {
        console.error(`[${logPrefix}] 错误:`, e.message);
        try {
            if (page) await page.screenshot({ path: screenshotPath });
        } catch (ssErr) { }
        await sendTelegramMessage(`❌ *${email}* 执行异常\n${e.message}`, screenshotPath);
        return { success: false, email, error: e.message };
    } finally {
        if (context) await context.close();
    }
}

async function main() {
    console.log('=== Zenix.sg 自动签到 + AFK + 续期脚本 ===');
    console.log('时间:', new Date().toISOString());

    const users = getUsers();
    if (users.length === 0) {
        console.error('错误: 未找到用户配置。请设置 ZENIX_USERS_JSON 环境变量');
        process.exit(1);
    }
    console.log('共', users.length, '个用户');

    if (PROXY_CONFIG) {
        const proxyOk = await checkProxy();
        if (!proxyOk) {
            console.warn('[代理] 代理不可用，跳过代理继续...');
        }
    }

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            executablePath: CHROME_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
            ],
            ...(PROXY_CONFIG ? { proxy: PROXY_CONFIG } : {})
        });
        console.log('[浏览器] 已启动');

        const results = [];
        for (let i = 0; i < users.length; i++) {
            const result = await processUser(browser, users[i], i);
            results.push(result);
        }

        console.log('\n========== 执行汇总 ==========');
        for (const r of results) {
            if (r) {
                console.log(`${r.success ? '✅' : '❌'} ${r.email}: ${r.result || r.error || '未知'}`);
            }
        }
        console.log('===============================');

    } catch (e) {
        console.error('全局错误:', e.message);
        await sendTelegramMessage(`❌ *${PROJECT}* 全局异常\n${e.message}`);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
        console.log('[浏览器] 已关闭');
    }
}

main();