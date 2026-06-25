#!/usr/bin/env node
/**
 * EpicHost.pl 免费服务器自动续期脚本
 *
 * 流程: 加载 KV cookie（如果配置）→ 直接打开服务器页点 "ADD 4 HOUR(S)"
 *       或登录后打开服务器页续期 → 截图通知
 *
 * 环境变量:
 *   EPICHOST_USERS_JSON - 用户配置 (必需)
 *   KV_ADMIN_URL        - KV Admin Worker URL (推荐，用于 cookie 持久化)
 *   KV_ADMIN_PASS       - KV Admin Worker 密码
 *   HTTP_PROXY          - HTTP 代理 (可选)
 *   TG_BOT_TOKEN        - Telegram Bot Token (可选)
 *   TG_CHAT_ID          - Telegram Chat ID (可选)
 *   TG_THREAD_ID        - Telegram Thread ID (可选)
 *   CHROME_PATH         - Chrome 路径 (默认 /usr/bin/google-chrome)
 *
 * 账号格式:
 *   [{"username":"ql@282820.xyz","password":"qilan123A.","serverUrl":"https://panel.epichost.pl/server/66d97cd5"}]
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");
const http = require("http");
const https = require("https");

const PANEL_URL = "https://panel.epichost.pl";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const DEBUG_PORT = 9222;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || "EpicHost";

const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);

// 确保 localhost 不走代理
process.env.NO_PROXY = "localhost,127.0.0.1";

// ===================== KV Admin Worker =====================

async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const url = new URL(KV_ADMIN_URL);
    url.searchParams.set("key", key);
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${KV_ADMIN_PASS}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.value || null;
  } catch (e) {
    console.warn(`[KV] 读取失败: ${e.message}`);
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_ENABLED) return false;
  try {
    const resp = await fetch(KV_ADMIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KV_ADMIN_PASS}`,
      },
      body: JSON.stringify({ key, value }),
    });
    return resp.ok;
  } catch (e) {
    console.warn(`[KV] 写入失败: ${e.message}`);
    return false;
  }
}

// ===================== 获取用户配置 =====================

function getUsers() {
  try {
    if (process.env.EPICHOST_USERS_JSON) {
      const parsed = JSON.parse(process.env.EPICHOST_USERS_JSON);
      return Array.isArray(parsed) ? parsed : (parsed.users || []);
    }
  } catch (e) {
    console.error("解析 EPICHOST_USERS_JSON 环境变量错误:", e);
  }
  return [];
}

function extractShortUuid(serverUrl) {
  const m = (serverUrl || "").match(/\/server\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

// 短 UUID → 完整 UUID
const SHORT_TO_FULL = {
  "66d97cd5": "66d97cd5-ae9c-4b72-8aed-c3ef163a5acb",
};

async function resolveFullUuid(page, shortUuid) {
  if (SHORT_TO_FULL[shortUuid]) return SHORT_TO_FULL[shortUuid];
  return shortUuid;
}

// ===================== Chrome 启动 =====================

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function launchChrome() {
  console.log(`启动 Chrome (${CHROME_PATH})...`);
  if (await checkPort(DEBUG_PORT)) {
    console.log("Chrome 已开启。");
    return;
  }
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1280,720",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--user-data-dir=/tmp/chrome_user_data_epichost",
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`正在启动 Chrome (第 ${attempt} 次)...`);
    let stderr = "";
    const chrome = spawn(CHROME_PATH, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, TZ: "Asia/Shanghai" },
    });
    if (chrome.stderr) chrome.stderr.on("data", (d) => { stderr += d.toString(); });
    chrome.on("error", (e) => { stderr += `spawn error: ${e.message}\n`; });
    chrome.unref();

    console.log("正在等待 Chrome 初始化...");
    for (let i = 0; i < 40; i++) {
      if (await checkPort(DEBUG_PORT)) {
        console.log("Chrome 已就绪。");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.error(`Chrome 第 ${attempt} 次未在端口 ${DEBUG_PORT} 起来。stderr 末尾:\n${stderr.slice(-500)}`);
    try { process.kill(-chrome.pid); } catch (e) {}
    try { fs.rmSync("/tmp/chrome_user_data_epichost", { recursive: true, force: true }); } catch (e) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Chrome 启动失败");
}

// ===================== 浏览器工具 =====================

async function gotoWithRetry(page, url, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return;
    } catch (e) {
      console.warn(`  [导航] 打开 ${url} 失败 (第 ${i}/${retries} 次): ${e.message}`);
      if (i === retries) throw e;
      await page.waitForTimeout(3000);
    }
  }
}

function _race(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("t/o")), ms))]);
}

// ===================== 续期单个服务器 =====================

async function renewSingleServer(page, shortUuid, photoDir) {
  const sid = shortUuid || "unknown";
  const fullUuid = await resolveFullUuid(page, shortUuid);
  const shot = path.join(photoDir, `epichost_${sid}.png`);

  console.log(`  打开服务器页: ${PANEL_URL}/server/${shortUuid}`);
  await gotoWithRetry(page, `${PANEL_URL}/server/${shortUuid}`);
  await page.waitForTimeout(3000);

  // 检查页面是否有 "ADD 4 HOUR(S)" 按钮
  const renewBtn = page.locator('button:has-text("ADD 4 HOUR(S)")');
  const btnVisible = await renewBtn.isVisible().catch(() => false);

  if (!btnVisible) {
    // 尝试 API 方式
    console.log(`  未找到续期按钮，尝试 API 续期...`);

    const csrfToken = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute("content") : null;
    });

    if (!csrfToken) {
      console.log(`  ❌ 未找到 CSRF token`);
      try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
      return { status: "error", message: "未找到 CSRF token", shot };
    }

    // 读取当前过期时间
    const info = await page.evaluate(async (uuid) => {
      try {
        const resp = await fetch(`/api/client/freeservers/${uuid}/info`);
        return await resp.json();
      } catch (e) {
        return { error: e.message };
      }
    }, fullUuid).catch(() => ({}));
    const currentExpiry = info?.data?.expire || "未知";
    console.log(`  当前过期: ${currentExpiry}`);

    // 调用续期 API
    const result = await page.evaluate(async ({ uuid, csrf }) => {
      try {
        const resp = await fetch(`/api/client/freeservers/${uuid}/renew`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": csrf,
            Accept: "application/json",
          },
        });
        const data = await resp.json();
        return { ok: resp.ok, status: resp.status, data };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, { uuid: fullUuid, csrf: csrfToken });

    console.log(`  API 响应: ${JSON.stringify(result)}`);

    if (result.ok && result.data?.success) {
      const newInfo = await page.evaluate(async (uuid) => {
        try {
          const resp = await fetch(`/api/client/freeservers/${uuid}/info`);
          return await resp.json();
        } catch (e) {
          return { error: e.message };
        }
      }, fullUuid).catch(() => ({}));
      const newExpiry = newInfo?.data?.expire || currentExpiry;
      console.log(`  ✅ 续期成功！新过期: ${newExpiry}`);
      try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
      return { status: "success", message: `到期: ${newExpiry}`, shot };
    }

    if (result.data?.data?.includes("can't renew")) {
      console.log(`  ⏳ 已续期过，无需再次操作`);
      try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
      return { status: "wait", message: `已续期过\n当前到期: ${currentExpiry}`, shot };
    }

    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
    return { status: "error", message: `API 错误: ${JSON.stringify(result.data)}`, shot };
  }

  // 点击 "ADD 4 HOUR(S)" 按钮
  console.log(`  点击续期按钮 "ADD 4 HOUR(S)"...`);
  try {
    await _race(renewBtn.click({ force: true }), 10000);
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`  点击按钮失败: ${e.message}`);
    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
    return { status: "error", message: `按钮点击失败: ${e.message}`, shot };
  }

  // 等续期生效
  await page.waitForTimeout(3000);
  try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}

  // 读取新过期时间
  const csrfToken = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : null;
  }).catch(() => null);

  if (csrfToken) {
    const newInfo = await page.evaluate(async (uuid) => {
      try {
        const resp = await fetch(`/api/client/freeservers/${uuid}/info`);
        return await resp.json();
      } catch (e) {
        return { error: e.message };
      }
    }, fullUuid).catch(() => ({}));
    const newExpiry = newInfo?.data?.expire || "未知";
    console.log(`  新过期: ${newExpiry}`);
    return { status: "success", message: `到期: ${newExpiry}`, shot };
  }

  return { status: "success", message: "已点击续期按钮，详情见截图", shot };
}

// ===================== Telegram 通知 =====================

async function sendTelegramMessage(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log("[Telegram] 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。");
    return;
  }
  const fullText = `📌 *${PROJECT}*\n${text}`;
  const threadArg = TG_THREAD_ID ? ` -F message_thread_id="${TG_THREAD_ID}"` : "";
  return new Promise((resolve) => {
    exec(
      `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage"` +
      ` -F chat_id="${TG_CHAT_ID}"${threadArg}` +
      ` -F parse_mode="Markdown" -F text="${fullText.replace(/"/g, '\\"')}"`,
      (err, stdout) => resolve({ err, stdout })
    );
  });
}

async function sendTelegramPhoto(text, imagePath) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID || !imagePath || !fs.existsSync(imagePath)) return;
  const fullText = `📌 *${PROJECT}*\n${text}`.slice(0, 1000);
  const threadArg = TG_THREAD_ID ? ` -F message_thread_id="${TG_THREAD_ID}"` : "";
  const captionFile = `${imagePath}.caption.txt`;
  try { fs.writeFileSync(captionFile, fullText); } catch (e) {}
  return new Promise((resolve) => {
    exec(
      `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto"` +
      ` -F chat_id="${TG_CHAT_ID}"${threadArg}` +
      ` -F "caption=<${captionFile}" -F parse_mode="Markdown" -F photo="@${imagePath}"`,
      (err, stdout) => resolve({ err, stdout })
    );
  });
}

// ===================== 主流程 =====================

(async () => {
  const users = getUsers();
  if (users.length === 0) {
    console.log("未在 EPICHOST_USERS_JSON 中找到用户");
    process.exit(1);
  }

  const startTime = new Date();
  console.log(`\n[${startTime.toISOString()}] 🚀 EpicHost 续期脚本 — ${users.length} 个用户`);

  if (KV_ENABLED) {
    console.log("[KV] KV Admin Worker 已启用，将缓存登录 cookie 避免重复登录。");
  }

  await launchChrome();

  let browser;
  for (let k = 0; k < 5; k++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
      console.log("连接 Chrome 成功！");
      break;
    } catch (e) {
      console.log(`连接尝试 ${k + 1}/5 失败: ${e.message.slice(0, 60)}... 2秒后重试`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!browser) {
    console.error("❌ 连接 Chrome 失败，退出");
    process.exit(1);
  }

  const context = browser.contexts()[0];
  let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  page.setDefaultTimeout(60000);

  const photoDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(photoDir, { recursive: true });

  const allResults = [];

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const email = user.username || user.email;
    const password = user.password;
    const serverUrl = user.serverUrl;
    const shortUuid = extractShortUuid(serverUrl);

    if (!email || !password) {
      console.log(`\n⚠️ 跳过无效用户配置（缺少 username/password）`);
      continue;
    }

    if (!shortUuid) {
      console.log(`\n⚠️ 用户 ${email} 未配置 serverUrl 或格式无效，跳过`);
      allResults.push({ user: email, status: "skip", message: "缺少 serverUrl" });
      continue;
    }

    console.log(`\n━━━ 处理用户: ${email} (服务器: ${shortUuid}) ━━━`);

    try {
      if (page.isClosed()) {
        page = await context.newPage();
      }

      // 清掉上一个账号的 cookie，防止跨账号污染
      try { await context.clearCookies(); } catch (e) {}

      const cookieKey = `epichost_cookie_${email.replace(/[^a-z0-9]/gi, "_")}`;

      // 1. 尝试注入 KV cookie 免登录
      let loggedIn = false;
      const saved = await kvGet(cookieKey);
      if (saved) {
        try {
          const cks = JSON.parse(saved);
          if (cks.length) {
            await context.addCookies(cks);
            console.log(`  >> 已注入 KV cookie (${cks.length} 条)`);
          }
        } catch (e) {
          console.warn(`  >> cookie 解析失败: ${e.message}`);
        }
        // 用 cookie 直接打开 panel 探测是否有效
        await page.goto(PANEL_URL, { waitUntil: "load", timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
        loggedIn = !page.url().includes("/auth/login");
        if (page.url().includes("chrome-error")) loggedIn = false;
        console.log(`  >> cookie ${loggedIn ? "有效，免登录" : "无效/已过期"} (${page.url()})`);
      }

      // 2. cookie 无效或没有 → 完整登录
      if (!loggedIn) {
        if (page.url().includes("chrome-error") || page.url().includes("chromewebdata")) {
          await page.goto("about:blank").catch(() => {});
          await page.waitForTimeout(1000);
        }
        if (page.url().includes("dashboard")) {
          await gotoWithRetry(page, `${PANEL_URL}/auth/logout`);
          await page.waitForTimeout(2000);
        }
        await gotoWithRetry(page, `${PANEL_URL}/auth/login`);
        await page.waitForTimeout(2000);
        if (page.url().includes("dashboard")) {
          await gotoWithRetry(page, `${PANEL_URL}/auth/logout`);
          await page.waitForTimeout(2000);
          await gotoWithRetry(page, `${PANEL_URL}/auth/login`);
        }

        console.log("  正在输入凭据...");
        try {
          const emailInput = page.getByRole("textbox", { name: /nazwa|email|user/i });
          await emailInput.waitFor({ state: "visible", timeout: 5000 });
          await emailInput.fill(email);

          const pwdInput = page.getByRole("textbox", { name: /hasło|password/i });
          await pwdInput.fill(password);
          await page.waitForTimeout(500);

          // 尝试点击登录按钮
          await page.getByRole("button", { name: /logowanie|log in|sign in/i }).first().click();
          await page.waitForTimeout(5000);

          // 验证是否登录成功
          await gotoWithRetry(page, PANEL_URL);
          loggedIn = !page.url().includes("/auth/login");
          if (loggedIn) {
            console.log("  ✅ 登录成功！");
            // 保存 cookie 到 KV
            const cookies = await context.cookies();
            const panelCookies = cookies.filter((c) => c.domain.includes("epichost.pl"));
            await kvSet(cookieKey, JSON.stringify(panelCookies));
            console.log(`  >> Cookie 已保存到 KV (${panelCookies.length} 条)`);
          } else {
            console.log("  ❌ 登录失败 (可能 reCAPTCHA Enterprise 配额超限)");
          }
        } catch (e) {
          console.log("  登录错误:", e.message);
        }
      }

      if (!loggedIn) {
        console.log(`  ❌ 用户 ${email} 无法登录`);
        allResults.push({
          user: email,
          uuid: shortUuid,
          status: "error",
          message: "登录失败 - 请手动登录一次生成 KV cookie 后重试",
        });
        continue;
      }

      // 3. 续期
      const result = await renewSingleServer(page, shortUuid, photoDir);
      console.log(`  → 结果: [${result.status}] ${result.message}`);
      allResults.push({ user: email, uuid: shortUuid, ...result });

      // 发送带截图的 TG 通知
      if (result.shot && fs.existsSync(result.shot)) {
        const statusIcon = result.status === "success" ? "✅" : result.status === "wait" ? "⏳" : "❌";
        const tgMsg = `${statusIcon} *${email}*\n服务器: \`${shortUuid}\`\n${result.message}`;
        await sendTelegramPhoto(tgMsg, result.shot);
      }
    } catch (err) {
      console.error(`  ❌ 用户 ${email} 出错: ${err.message}`);
      allResults.push({ user: email, uuid: shortUuid, status: "error", message: err.message });
    }
  }

  // ===== 汇总 =====
  console.log(`\n═══════════════════════════════════`);
  console.log(`📊 汇总 (${allResults.length}/${users.length})`);
  let successCount = 0;
  for (const r of allResults) {
    const icon = r.status === "success" ? "✅" : r.status === "wait" ? "⏳" : "❌";
    console.log(`  ${icon} ${r.user} (${r.uuid || "?"}): ${r.message}`);
    if (r.status === "success" || r.status === "wait") successCount++;
  }
  console.log(`═══════════════════════════════════\n`);

  // 发送汇总 TG
  const summaryLines = allResults.map((r) => {
    const icon = r.status === "success" ? "✅" : r.status === "wait" ? "⏳" : "❌";
    return `${icon} ${r.user}: ${r.message}`;
  });
  await sendTelegramMessage(
    `EpicHost 续期完成\n成功: ${successCount}/${allResults.length}\n` + summaryLines.join("\n")
  );

  try { await browser.close(); } catch (e) {}
  process.exit(successCount > 0 ? 0 : 1);
})();
