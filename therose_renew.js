#!/usr/bin/env node
/**
 * TheRose Cloud (client.therose.cloud) 免费服务器自动续期脚本
 *
 * 流程: 加载 KV cookie → 尝试免登录进入服务器面板
 *       → 失败则完整登录（带 Cloudflare Turnstile CDP 绕过）
 *       → 遍历服务器列表，点击续期按钮 → 截图通知 Telegram
 *
 * 环境变量:
 *   THEROSE_USERS_JSON   - 用户配置 (必需)
 *     格式: [{"email":"xxx@xxx.xyz","password":"xxx"}]
 *   KV_ADMIN_URL          - KV Admin Worker URL (推荐，用于 cookie 持久化)
 *   KV_ADMIN_PASS         - KV Admin Worker 密码
 *   HTTP_PROXY            - HTTP 代理 (可选)
 *   TG_BOT_TOKEN          - Telegram Bot Token (可选)
 *   TG_CHAT_ID            - Telegram Chat ID (可选)
 *   TG_THREAD_ID          - Telegram Thread ID (可选)
 *   CHROME_PATH           - Chrome 路径 (默认 /usr/bin/google-chrome)
 */

const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");
const http = require("http");

const BASE_URL = "https://client.therose.cloud";
const LOGIN_URL = BASE_URL + "/login";
const SERVERS_URL = BASE_URL + "/panel?routeName=servers";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || "TheRose";

const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);

const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const DEBUG_PORT = 9222;

// 确保 localhost 不走代理
process.env.NO_PROXY = "localhost,127.0.0.1";

// 注入脚本：hook 子 frame 里的 attachShadow，定位 Cloudflare Turnstile 复选框
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { console.error('[注入] Hook attachShadow 失败:', e); }
})();
`;

// ===================== Telegram 通知 =====================

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.warn("[Telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。");
        return;
    }
    const text = `\u{1F4CC} *${PROJECT}*\n${message}`;
    const tgErr = (e) =>
        (e.response && e.response.data && e.response.data.description)
            ? `${e.response.data.error_code} ${e.response.data.description}`
            : e.message;
    const threadArg = TG_THREAD_ID ? ` -F message_thread_id="${TG_THREAD_ID}"` : "";

    if (imagePath && fs.existsSync(imagePath)) {
        const captionFile = `${imagePath}.caption.txt`;
        try { fs.writeFileSync(captionFile, text.slice(0, 1000)); } catch (e) { }
        const sendPhoto = (withMd) =>
            new Promise((resolve) => {
                const md = withMd ? ' -F parse_mode="Markdown"' : "";
                const cmd =
                    `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto"` +
                    ` -F chat_id="${TG_CHAT_ID}"${threadArg}` +
                    ` -F "caption=<${captionFile}"${md} -F photo="@${imagePath}"`;
                exec(cmd, (err, stdout) => resolve({ err, stdout: stdout || "" }));
            });
        let r = await sendPhoto(true);
        if (!r.err && r.stdout.includes('"ok":true')) {
            console.log("[Telegram] 图文消息已发送。");
        } else {
            console.warn(
                "[Telegram] 图文(Markdown)发送失败，改纯文本重试:",
                (r.stdout || (r.err && r.err.message) || "").slice(0, 200)
            );
            r = await sendPhoto(false);
            if (!r.err && r.stdout.includes('"ok":true')) console.log("[Telegram] 图文消息(纯文本)已发送。");
            else console.error("[Telegram] 图文消息发送失败:", (r.stdout || "").slice(0, 300));
        }
        try { fs.unlinkSync(captionFile); } catch (e) { }
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        const base = { chat_id: TG_CHAT_ID };
        if (TG_THREAD_ID) base.message_thread_id = Number(TG_THREAD_ID);
        try {
            await axios.post(url, { ...base, text, parse_mode: "Markdown" });
            console.log("[Telegram] Message sent.");
        } catch (e) {
            console.warn("[Telegram] Markdown 发送失败，改用纯文本重试:", tgErr(e));
            await axios.post(url, { ...base, text });
            console.log("[Telegram] Message sent (plain text).");
        }
    } catch (e) {
        console.error(
            "[Telegram] 文字推送失败:", tgErr(e),
            '\n   >> 提示: "chat not found" 通常表示 TG_CHAT_ID 填错，或你还没主动给该 bot 发过一条消息。'
        );
    }
}

// ===================== KV Admin Worker =====================

async function kvGet(key) {
    if (!KV_ENABLED) return null;
    try {
        const r = await axios.post(KV_ADMIN_URL + "/api/get", { key }, {
            headers: { "X-Admin-Pass": KV_ADMIN_PASS, "Content-Type": "application/json" },
            timeout: 15000,
            proxy: false,
        });
        if (r.data.ok && r.data.value != null) {
            console.log("[KV] 读取成功，长度:", String(r.data.value).length);
            return typeof r.data.value === "string" ? r.data.value : JSON.stringify(r.data.value);
        }
        console.log("[KV] 暂无已存 cookie");
        return null;
    } catch (e) {
        if (e.response && e.response.status === 404) { console.log("[KV] 暂无已存 cookie"); return null; }
        console.warn("[KV] 读取失败:", e.message);
        return null;
    }
}

async function kvSet(key, value) {
    if (!KV_ENABLED) return false;
    try {
        await axios.post(KV_ADMIN_URL + "/api/set", { key, value: String(value) }, {
            headers: { "X-Admin-Pass": KV_ADMIN_PASS, "Content-Type": "application/json" },
            timeout: 15000,
            proxy: false,
        });
        console.log("[KV] cookie 已保存");
        return true;
    } catch (e) {
        console.warn("[KV] 写入失败:", e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
        return false;
    }
}

// ===================== Cookie 处理 =====================

function normalizeCookies(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .map((c) => {
            const out = { name: c.name, value: String(c.value != null ? c.value : "") };
            if (c.domain) out.domain = c.domain;
            out.path = c.path || "/";
            const exp = typeof c.expires === "number" ? c.expires : c.expirationDate;
            if (typeof exp === "number" && exp > 0) out.expires = Math.floor(exp);
            out.httpOnly = !!c.httpOnly;
            out.secure = !!c.secure;
            const ss = (c.sameSite || "").toString().toLowerCase();
            out.sameSite = ss === "strict" ? "Strict" : ss === "none" ? "None" : "Lax";
            return out;
        })
        .filter((c) => c.name && c.domain);
}

// ===================== 辅助函数 =====================

function _race(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("t/o")), ms))]);
}

// Cloudflare Turnstile CDP 点击绕过
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        const fu = frame.url() || "";
        if (fu && !/cloudflare|turnstile|challenges|hcaptcha|^about:|^$/i.test(fu)) {
            if (frame !== page.mainFrame()) continue;
        }
        try {
            const data = await _race(frame.evaluate(() => window.__turnstile_data), 3000).catch(() => null);
            if (data) {
                console.log(">> 在 frame 中发现 Turnstile。比例:", data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + box.width * data.xRatio;
                const clickY = box.y + box.height * data.yRatio;
                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                const client = await page.context().newCDPSession(page);
                // mouseMoved (mouseover 前置事件)
                await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: clickX, y: clickY });
                await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
                // mousePressed
                await client.send("Input.dispatchMouseEvent", {
                    type: "mousePressed", x: clickX, y: clickY, button: "left", clickCount: 1,
                });
                await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
                // mouseReleased
                await client.send("Input.dispatchMouseEvent", {
                    type: "mouseReleased", x: clickX, y: clickY, button: "left", clickCount: 1,
                });
                console.log(">> CDP 点击已发送。");
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

async function gotoWithRetry(page, url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await page.goto(url, { waitUntil: "load", timeout: 20000 });
            return;
        } catch (e) {
            console.warn(`   >> goto 重试 ${i + 1}/${retries}: ${e.message}`);
            await page.waitForTimeout(2000);
        }
    }
}

// ===================== 主流程 =====================

async function main() {
    console.log("=== TheRose Cloud 续期脚本 ===");

    // 读取用户配置
    const usersJson = process.env.THEROSE_USERS_JSON;
    if (!usersJson) {
        console.error("缺少 THEROSE_USERS_JSON 环境变量");
        process.exit(1);
    }
    let users;
    try {
        users = JSON.parse(usersJson);
        if (!Array.isArray(users) || users.length === 0) throw new Error("空数组");
    } catch (e) {
        console.error("THEROSE_USERS_JSON 格式无效:", e.message);
        process.exit(1);
    }
    console.log(`共 ${users.length} 个用户`);

    // 启用 stealth 插件
    chromium.use(stealth);

    // 启动浏览器
    const browser = await chromium.launch({
        headless: true,
        executablePath: CHROME_PATH,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
            `--remote-debugging-port=${DEBUG_PORT}`,
            "--window-size=1280,720",
        ],
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        locale: "en-US",
        timezoneId: "America/New_York",
        permissions: [],
    });

    // 代理设置
    const HTTP_PROXY = process.env.HTTP_PROXY;
    if (HTTP_PROXY) {
        try {
            const proxyUrl = new URL(HTTP_PROXY);
            await context.setHTTPCredentials({
                username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : "",
                password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : "",
            });
        } catch (e) {
            console.warn("[代理] HTTP_PROXY 格式异常:", e.message);
        }
    }

    const page = await context.newPage();
    await page.addInitScript(INJECTED_SCRIPT);
    console.log("注入脚本已添加。");

    if (!KV_ENABLED) {
        console.log("[KV] 未配置 KV_ADMIN_URL/KV_ADMIN_PASS，跳过 cookie 缓存");
    }

    // 处理每个用户
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const email = user.email || user.username || user.user;
        const password = user.password || user.pass || user.pwd;
        if (!email || !password) {
            console.error(`用户 ${i + 1} 缺少 email 或 password，跳过`);
            continue;
        }

        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length}: ${email} ===`);

        // 创建截图目录
        const photoDir = path.join(process.cwd(), "screenshots");
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const safeUser = email.replace(/[^a-z0-9]/gi, "_");

        // 清掉上一个账号的 cookie
        try { await context.clearCookies(); } catch (e) { }

        const cookieKey = `therose_cookie_${safeUser}`;

        // ===== 1. 尝试注入 KV cookie 免登录 =====
        let loggedIn = false;
        const saved = await kvGet(cookieKey);
        if (saved) {
            try {
                const cks = normalizeCookies(JSON.parse(saved));
                if (cks.length) {
                    await context.addCookies(cks);
                    console.log(`   >> 已注入 KV cookie (${cks.length} 条)`);
                }
            } catch (e) {
                console.warn("   >> cookie 解析失败:", e.message);
            }
            // 打开服务器面板探测 cookie 是否有效
            await gotoWithRetry(page, SERVERS_URL);
            await page.waitForTimeout(3000);
            loggedIn = !page.url().includes("/login");
            if (page.url().includes("chrome-error")) loggedIn = false;
            console.log(`   >> cookie ${loggedIn ? "有效，免登录" : "无效/已过期"} (${page.url()})`);
        }

        // ===== 2. cookie 无效 → 完整登录 =====
        if (!loggedIn) {
            let loginFinalSucceeded = false;

            for (let loginRetry = 1; loginRetry <= 2; loginRetry++) {
                if (loginRetry > 1) {
                    console.log(`   >> 重新尝试登录 (第 ${loginRetry} 次)...`);
                }

                // 导航到登录页
                if (page.url().includes("chrome-error") || page.url().includes("chromewebdata")) {
                    await page.goto("about:blank").catch(() => {});
                    await page.waitForTimeout(1000);
                }
                await gotoWithRetry(page, LOGIN_URL);
                await page.waitForTimeout(2000);

                // 如果已经登录成功（被重定向到面板）
                if (!page.url().includes("/login")) {
                    console.log("   >> 已登录，无需再次输入凭据");
                    loginFinalSucceeded = true;
                    break;
                }

                console.log("正在输入凭据...");
                try {
                    // 填写表单
                    const emailInput = page.locator('input[name="login_form[email]"]');
                    await emailInput.waitFor({ state: "visible", timeout: 5000 });
                    await emailInput.fill(email);

                    const pwdInput = page.locator('input[name="login_form[password]"]');
                    await pwdInput.fill(password);

                    await page.waitForTimeout(500);

                    // 处理 Cloudflare Turnstile
                    console.log("   >> 正在处理 Cloudflare Turnstile (CDP 绕过)...");
                    let cdpClickResult = false;
                    for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                        cdpClickResult = await attemptTurnstileCdp(page);
                        if (cdpClickResult) {
                            console.log(`   >> Turnstile CDP 点击成功 (第 ${findAttempt + 1} 次尝试)`);
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }

                    if (cdpClickResult) {
                        console.log("   >> 等待 Cloudflare 验证完成...");
                        for (let waitSec = 0; waitSec < 10; waitSec++) {
                            const frames = page.frames();
                            let isSuccess = false;
                            for (const f of frames) {
                                if (f.url().includes("cloudflare")) {
                                    try {
                                        if (await f.getByText("Success!", { exact: false }).isVisible({ timeout: 500 })) {
                                            isSuccess = true;
                                            break;
                                        }
                                    } catch (e) { }
                                }
                            }
                            if (isSuccess) {
                                console.log("   >> Turnstile 验证成功。");
                                break;
                            }
                            await page.waitForTimeout(1000);
                        }
                    } else {
                        console.log("   >> 未检测到或无法点击 Turnstile，继续尝试提交...");
                    }

                    // 点击 Sign in 按钮
                    const signInBtn = page.locator('button[type="submit"]');
                    if (await signInBtn.isVisible()) {
                        await signInBtn.click();
                    } else {
                        // 后备：通过 form submit
                        await page.evaluate(() => {
                            const form = document.querySelector("form");
                            if (form) form.submit();
                        });
                    }

                    // 等待登录结果
                    for (let w = 0; w < 30; w++) {
                        await page.waitForTimeout(500);
                        const currentUrl = page.url();
                        if (!currentUrl.includes("/login")) {
                            loginFinalSucceeded = true;
                            break;
                        }
                        // 检查是否有错误提示
                        try {
                            const errorText = page.locator(".alert, .error, .invalid-feedback, .text-danger").first();
                            if (await errorText.isVisible({ timeout: 500 })) {
                                const msg = await errorText.innerText();
                                if (msg.includes("incorrect") || msg.includes("invalid") || msg.includes("error")) {
                                    console.error(`   >> ❌ 登录失败: ${msg}`);
                                    break;
                                }
                            }
                        } catch (e) { }
                    }

                    if (loginFinalSucceeded) {
                        console.log("   >> 登录成功，已跳离登录页");
                        break;
                    } else {
                        console.log("   >> ⚠️ 登录可能未完成，尝试继续...");
                        // 尝试手动导航到服务器面板
                        await gotoWithRetry(page, SERVERS_URL);
                        await page.waitForTimeout(3000);
                        if (!page.url().includes("/login")) {
                            loginFinalSucceeded = true;
                            break;
                        }
                    }
                } catch (e) {
                    console.log(`登录错误 (第 ${loginRetry} 次):`, e.message);
                }
            }

            if (!loginFinalSucceeded) {
                console.error(`   >> ❌ 登录失败: 用户 ${email} 多次尝试后仍无法完成登录`);
                const failShot = path.join(photoDir, `${safeUser}_login_fail.png`);
                try { await page.screenshot({ path: failShot, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`❌ *登录失败*\n用户: ${email}\n原因: 多次尝试后仍无法登录`, failShot);
                continue;
            }

            // 登录成功，保存 cookie 到 KV
            if (KV_ENABLED) {
                const cookies = await context.cookies();
                if (cookies.length > 0) {
                    await kvSet(cookieKey, JSON.stringify(cookies));
                }
            }
        }

        // ===== 3. 进入服务器面板，执行续期 =====
        console.log("正在进入服务器面板...");
        await gotoWithRetry(page, SERVERS_URL);
        await page.waitForTimeout(3000);

        // 如果又被重定向到登录页，说明 cookie 失效
        if (page.url().includes("/login")) {
            console.error("   >> cookie 已失效，无法进入服务器面板");
            await sendTelegramMessage(`❌ *Cookie 失效*\n用户: ${email}\n原因: 已保存的 cookie 无法访问服务器面板`);
            continue;
        }

        // 截图面板现状
        const panelShot = path.join(photoDir, `${safeUser}_panel.png`);
        try { await page.screenshot({ path: panelShot, fullPage: true }); } catch (e) { }
        console.log("   >> 面板页面已截图");

        // 查找续期按钮
        // PteroCA 面板的续期按钮可能是 "Renew"、"续期"、"延长" 等
        console.log("正在查找续期按钮...");

        let renewCount = 0;
        let renewErrors = 0;

        // 尝试多种续期按钮选择器
        const renewSelectors = [
            // 按钮
            'button:has-text("Renew")',
            'button:has-text("renew")',
            'button:has-text("续期")',
            'button:has-text("延长")',
            'a:has-text("Renew")',
            'a:has-text("renew")',
            'a:has-text("续期")',
            // 通用
            '[class*="renew"]',
            '[class*="Renew"]',
            '[id*="renew"]',
            '[data-action*="renew"]',
            // 表格操作列
            'td:last-child button, td:last-child a',
        ];

        let foundRenew = false;
        for (const selector of renewSelectors) {
            const buttons = page.locator(selector);
            const count = await buttons.count();
            if (count > 0) {
                console.log(`   >> 找到 ${count} 个续期按钮 (选择器: ${selector})`);
                foundRenew = true;

                for (let idx = 0; idx < count; idx++) {
                    const btn = buttons.nth(idx);
                    try {
                        await btn.scrollIntoViewIfNeeded();
                        await page.waitForTimeout(500);
                        const btnText = await btn.innerText().catch(() => "");
                        console.log(`   >> 点击续期按钮 #${idx + 1}: "${btnText.trim().slice(0, 50)}"`);

                        await btn.click();
                        await page.waitForTimeout(2000);

                        // 检查是否有弹窗（续期确认）
                        try {
                            const modal = page.locator('[role="dialog"], .modal, .swal2-popup, [class*="modal"]').first();
                            if (await modal.isVisible({ timeout: 3000 })) {
                                console.log("   >> 检测到续期弹窗");

                                // 处理弹窗中的验证码（如果有 Turnstile）
                                let cdpDone = false;
                                for (let findAttempt = 0; findAttempt < 8; findAttempt++) {
                                    cdpDone = await attemptTurnstileCdp(page);
                                    if (cdpDone) {
                                        console.log("   >> 弹窗中 Turnstile 已点击");
                                        break;
                                    }
                                    await page.waitForTimeout(1000);
                                }

                                // 点击弹窗中的确认按钮
                                const confirmBtn = modal.locator('button:has-text("Renew"), button:has-text("确认"), button:has-text("Confirm"), button:has-text("续期"), button[type="submit"]').first();
                                if (await confirmBtn.isVisible({ timeout: 2000 })) {
                                    await confirmBtn.click();
                                    console.log("   >> 已点击确认续期按钮");
                                    await page.waitForTimeout(3000);
                                }
                            }
                        } catch (e) {
                            console.log("   >> 无续期弹窗，可能已直接续期");
                        }

                        // 检查续期结果
                        const bodyText = await page.locator("body").innerText().catch(() => "");
                        const isError = /error while renewing|failed|erreur|échou/i.test(bodyText);
                        const isSuccess = !isError && /renewed successfully|successfully renewed|server renewed|renewal success|renewed!/i.test(bodyText);

                        if (isSuccess) {
                            console.log(`   >> ✅ 续期成功 #${idx + 1}`);
                            renewCount++;
                        } else if (isError) {
                            console.log(`   >> ❌ 续期失败 #${idx + 1}`);
                            renewErrors++;
                        } else {
                            console.log(`   >> ⚠️ 续期结果未知 #${idx + 1}`);
                            renewCount++; // 乐观处理
                        }

                        await page.waitForTimeout(1000);
                    } catch (e) {
                        console.log(`   >> 点击续期按钮 #${idx + 1} 失败:`, e.message);
                        renewErrors++;
                    }
                }
                break;
            }
        }

        if (!foundRenew) {
            console.log("   >> 未找到续期按钮，可能所有服务器已续期或无需续期");
            // 保存页面快照用于分析
            const bodyHtml = await page.locator("body").innerText().catch(() => "");
            console.log("   >> 页面内容摘要:", bodyHtml.replace(/\n/g, " ").slice(0, 300));
        }

        // 发送结果通知
        const resultShot = path.join(photoDir, `${safeUser}_result.png`);
        try { await page.screenshot({ path: resultShot, fullPage: true }); } catch (e) { }

        let resultMsg;
        if (foundRenew) {
            resultMsg = `✅ *续期完成*\n用户: ${email}\n成功: ${renewCount} 台\n失败: ${renewErrors} 台`;
        } else {
            resultMsg = `ℹ️ *无需续期*\n用户: ${email}\n所有服务器已续期或未到续期时间`;
        }
        await sendTelegramMessage(resultMsg, resultShot);
    }

    // 清理
    await browser.close();
    console.log("\n=== 所有用户处理完成 ===");
}

main().catch((e) => {
    console.error("脚本异常:", e);
    process.exit(1);
});