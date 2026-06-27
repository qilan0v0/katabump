#!/usr/bin/env node
/**
 * EpicHost.pl 免费服务器自动续期脚本
 *
 * 流程: 加载 KV cookie（如果配置）→ 直接打开服务器页点 "ADD 4 HOUR(S)"
 *       或登录后打开服务器页续期 → 截图通知
 *
 * 增强功能:
 *   - 两连击 "ADD 4 HOUR(S)" （第一次续期，第二次解除暂停）
 *   - 离线检测 → 文件管理器检查 server.jar
 *   - 缺失 server.jar → 从 GitHub release 下载并上传
 *   - 点击 Uruchom 启动服务器
 *
 * 环境变量:
 *   EPICHOST_USERS_JSON - 用户配置 (必需)
 *     格式: [{"username":"...","password":"...","serverUrl":"https://...","javamc":"https://github.com/.../server.jar"}]
 *   KV_ADMIN_URL        - KV Admin Worker URL (推荐，用于 cookie 持久化)
 *   KV_ADMIN_PASS       - KV Admin Worker 密码
 *   HTTP_PROXY          - HTTP 代理 (可选)
 *   TG_BOT_TOKEN        - Telegram Bot Token (可选)
 *   TG_CHAT_ID          - Telegram Chat ID (可选)
 *   TG_THREAD_ID        - Telegram Thread ID (可选)
 *   CHROME_PATH         - Chrome 路径 (默认 /usr/bin/google-chrome)
 */

const { chromium } = require("playwright");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");
const http = require("http");

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

// ===================== 获取用户配置 =====================

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
  "9f995d9c": "9f995d9c-a222-4185-bea2-86ec19c8ef28",
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

// ===================== 续期 + 检查 + 上传 + 启动 =====================

async function renewSingleServer(page, context, shortUuid, javamc, photoDir) {
  const sid = shortUuid || "unknown";
  const fullUuid = await resolveFullUuid(page, shortUuid);
  const shot = path.join(photoDir, `epichost_${sid}.png`);
  const serverPageUrl = `${PANEL_URL}/server/${shortUuid}`;

  console.log(`  打开服务器页: ${serverPageUrl}`);
  await gotoWithRetry(page, serverPageUrl);
  await page.waitForTimeout(3000);

  // ===== 1. 续期：两连击 ADD 4 HOUR(S) =====
  console.log(`  [续期] 检查 "ADD 4 HOUR(S)" 按钮...`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const renewBtn = page.locator('button:has-text("ADD 4 HOUR(S)")');
    const btnVisible = await renewBtn.isVisible().catch(() => false);

    if (!btnVisible) {
      console.log(`  [续期] 未找到按钮，尝试 API 方式...`);
      const apiResult = await renewViaApi(page, fullUuid, shot);
      if (apiResult) return apiResult;
      // API 也不可用, 继续
      break;
    }

    console.log(`  [续期] 第 ${attempt} 次点击 "ADD 4 HOUR(S)"...`);
    try {
      await _race(renewBtn.click({ force: true }), 10000);
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log(`  [续期] 点击失败: ${e.message}`);
      break;
    }

    // 检查页面反馈
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (pageText.includes("You've successfully renew") || pageText.includes("successfully renew")) {
      console.log(`  ✅ 第 ${attempt} 次续期成功！`);
      // 如果是第一次成功, 等一下再点第二次
      if (attempt === 1) {
        console.log(`  [续期] 等待后尝试第 2 次点击...`);
        await page.waitForTimeout(2000);
      }
    } else if (pageText.includes("can only once")) {
      console.log(`  ⏳ 第 ${attempt} 次: 已续期过 (只能一次), 继续下一步`);
      break;
    } else if (pageText.includes("Failed to unsuspend")) {
      console.log(`  ⚠️ 续期成功但解除暂停失败, 再试一次...`);
      await page.waitForTimeout(2000);
    }
  }

  // 刷新页面看看状态
  await gotoWithRetry(page, serverPageUrl);
  await page.waitForTimeout(3000);

  // ===== 2. 判断服务器是否离线 =====
  const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const isSuspended = pageText.includes("Server Suspended");
  const isOffline = pageText.includes("Offline") || pageText.includes("Uruchamianie") || isSuspended;

  if (!isOffline) {
    console.log(`  ✅ 服务器已在运行, 无需更多操作`);
    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
    return { status: "success", message: "服务器已在运行", shot };
  }

  console.log(`  [离线] 服务器处于离线${isSuspended ? "/暂停" : ""}状态, 检查/上传 server.jar...`);

  // ===== 3. 检查文件管理器 =====
  const hasJar = await checkServerJar(page, shortUuid);
  console.log(`  [文件] server.jar 是否存在: ${hasJar}`);

  if (!hasJar && javamc) {
    console.log(`  [上传] 从 ${javamc} 下载并上传 server.jar...`);
    const uploadOk = await downloadAndUploadJar(page, context, shortUuid, javamc);
    if (!uploadOk) {
      console.log(`  ⚠️ 上传失败, 尝试继续启动...`);
    }
  } else if (!hasJar && !javamc) {
    console.log(`  ⚠️ 无 server.jar 且未配置 javamc 链接, 跳过上传`);
  } else {
    console.log(`  ✅ server.jar 已存在`);
  }

  // ===== 4. 启动服务器 =====
  console.log(`  [启动] 导航到控制台并点击 Uruchom...`);
  await gotoWithRetry(page, serverPageUrl);
  await page.waitForTimeout(3000);

  const startBtn = page.locator('button:has-text("Uruchom")').first();
  const startVisible = await startBtn.isVisible().catch(() => false);
  const startEnabled = await startBtn.isEnabled().catch(() => false);

  if (startVisible && startEnabled) {
    try {
      await _race(startBtn.click({ force: true }), 10000);
      await page.waitForTimeout(5000);
      console.log(`  ✅ 已点击 Uruchom, 服务器正在启动`);
    } catch (e) {
      console.log(`  ⚠️ 点击 Uruchom 失败: ${e.message}`);
    }
  } else {
    console.log(`  ⚠️ Uruchom 按钮不可用 (可见: ${startVisible}, 可用: ${startEnabled})`);
  }

  // 最终截图
  try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}

  const finalText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const nowRunning = finalText.includes("Running") || finalText.includes("Starting");
  const status = nowRunning ? "success" : "partial";

  return {
    status,
    message: nowRunning ? "服务器已启动" : "续期完成, 需手动检查启动",
    shot,
  };
}

// ===== API 续期（按钮不可用时） =====
async function renewViaApi(page, fullUuid, shot) {
  const csrfToken = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : null;
  });

  if (!csrfToken) {
    console.log(`  ❌ 未找到 CSRF token`);
    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
    return null;
  }

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

  console.log(`  API 续期响应: ${JSON.stringify(result)}`);

  if (result.ok && result.data?.success) {
    const newInfo = await page.evaluate(async (uuid) => {
      try {
        const resp = await fetch(`/api/client/freeservers/${uuid}/info`);
        return await resp.json();
      } catch (e) {
        return { error: e.message };
      }
    }, fullUuid).catch(() => ({}));
    const newExpiry = newInfo?.data?.expire || "未知";
    console.log(`  ✅ API 续期成功！新到期: ${newExpiry}`);
    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
    return { status: "success", message: `API 续期成功, 到期: ${newExpiry}`, shot };
  }

  if (result.data?.data?.includes("can't renew")) {
    console.log(`  ⏳ 已续期过, 无需再次操作`);
    return null;
  }

  return null;
}

// ===== 检查文件管理器是否有 server.jar =====
async function checkServerJar(page, shortUuid) {
  console.log(`  [文件管理器] 检查 server.jar...`);
  await gotoWithRetry(page, `${PANEL_URL}/server/${shortUuid}/files`);
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const hasJar = bodyText.includes("server.jar");
  console.log(`  [文件管理器] 结果: ${hasJar ? "✅ 存在" : "❌ 不存在"}`);
  return hasJar;
}

// ===== 下载并上传 server.jar =====
async function downloadAndUploadJar(page, context, shortUuid, javamcUrl) {
  console.log(`  [下载] 开始下载 ${javamcUrl}...`);

  // 打开新标签下载
  const downloadPage = await context.newPage();
  let downloadPath = null;

  try {
    downloadPage.on("download", (download) => {
      downloadPath = path.join(__dirname, "screenshots", `server_${shortUuid}.jar`);
      download.saveAs(downloadPath);
      console.log(`  [下载] 保存到 ${downloadPath}`);
    });

    await downloadPage.goto(javamcUrl, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(5000);
    await downloadPage.close();

    if (!downloadPath || !fs.existsSync(downloadPath)) {
      console.log(`  [下载] 下载可能未完成, 尝试 curl 备用...`);
      // curl 备用
      const { execSync } = require("child_process");
      downloadPath = path.join(__dirname, "screenshots", `server_${shortUuid}.jar`);
      try {
        execSync(`curl -fsSL -o "${downloadPath}" "${javamcUrl}"`, { timeout: 120000 });
      } catch (e) {
        console.log(`  [下载] curl 也失败: ${e.message}`);
        return false;
      }
    }

    const stats = fs.statSync(downloadPath);
    if (stats.size < 1000) {
      console.log(`  [下载] 文件太小 (${stats.size} bytes), 可能不是有效的 jar`);
      fs.unlinkSync(downloadPath);
      return false;
    }
    console.log(`  [下载] 成功 (${(stats.size / 1024 / 1024).toFixed(2)} MiB)`);
  } catch (e) {
    console.log(`  [下载] 失败: ${e.message}`);
    if (downloadPage && !downloadPage.isClosed()) await downloadPage.close().catch(() => {});
    return false;
  }

  // 回到文件管理器上传
  console.log(`  [上传] 导航到文件管理器...`);
  await gotoWithRetry(page, `${PANEL_URL}/server/${shortUuid}/files`);
  await page.waitForTimeout(3000);

  // 点击上传按钮并选择文件
  try {
    const uploadBtn = page.locator('button:has-text("Prześlij")').first();
    await uploadBtn.waitFor({ state: "visible", timeout: 10000 });

    // 用 file chooser 上传
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10000 }),
      uploadBtn.click(),
    ]);
    await fileChooser.setFiles([downloadPath]);
    console.log(`  [上传] 文件已选择, 等待上传完成...`);
    await page.waitForTimeout(5000);

    // 清理本地临时文件
    try { fs.unlinkSync(downloadPath); } catch (e) {}

    // 验证上传成功
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (bodyText.includes("server.jar")) {
      console.log(`  ✅ server.jar 上传成功！`);
      return true;
    }
    console.log(`  ⚠️ 上传后未检测到 server.jar, 可能还在上传中`);
    return true;
  } catch (e) {
    console.log(`  [上传] 失败: ${e.message}`);
    return false;
  }
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
          const cks = normalizeCookies(JSON.parse(saved));
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
          const emailInput = page.locator('input[name="username"]');
          await emailInput.waitFor({ state: "visible", timeout: 10000 });
          await emailInput.fill(email);

          const pwdInput = page.locator('input[name="password"]');
          await pwdInput.fill(password);
          await page.waitForTimeout(500);

          // 尝试点击登录按钮
          await page.locator('button[type="submit"]').first().click();
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

      // 3. 续期 + 检查 + 上传 + 启动
      const javamc = user.javamc || user.javaMc || "";
      const result = await renewSingleServer(page, context, shortUuid, javamc, photoDir);
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
