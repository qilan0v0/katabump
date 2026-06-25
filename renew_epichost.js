#!/usr/bin/env node
/**
 * EpicHost.pl 免费服务器自动续期脚本
 *
 * 自动登录 EpicHost.pl 面板并续期免费服务器（每次续期 +4 小时，每 4 小时可续一次）
 *
 * 依赖: system Chrome/Chromium (Ubuntu: sudo apt install google-chrome-stable)
 *        npm install playwright
 *
 * 账号来源: Secret EPICHOST_USERS_JSON =
 *   [{"username":"ql@282820.xyz","password":"qilan123A.","serverUrl":"https://panel.epichost.pl/server/66d97cd5"}]
 *
 * 运行: node renew_epichost.js
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { exec } = require("child_process");

const PANEL_URL = "https://panel.epichost.pl";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const DEBUG_PORT = 9222;

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;
const PROJECT = process.env.PROJECT_NAME || "EpicHost";

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

// 从 serverUrl 提取短 UUID (如 https://panel.epichost.pl/server/66d97cd5 → 66d97cd5)
function extractShortUuid(serverUrl) {
  const m = (serverUrl || "").match(/\/server\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

// 短 UUID → 完整 UUID (已知映射，后续可从页面获取)
// 当前已知: 66d97cd5 → 66d97cd5-ae9c-4b72-8aed-c3ef163a5acb
const SHORT_TO_FULL = {
  "66d97cd5": "66d97cd5-ae9c-4b72-8aed-c3ef163a5acb",
};

async function resolveFullUuid(page, shortUuid) {
  // 优先查已知映射
  if (SHORT_TO_FULL[shortUuid]) return SHORT_TO_FULL[shortUuid];
  // 尝试从页面抓取: 服务器页顶部的 UUID 显示
  const el = await page.locator('[class*="identifier"], [class*="uuid"], code').first().textContent().catch(() => null);
  if (el && el.includes("-")) return el.trim();
  // 尝试从页面 localStorage 或全局变量获取
  const fromPage = await page.evaluate((sid) => {
    // Pterodactyl 有时在 dataset 或 URL 中有完整 UUID
    const links = Array.from(document.querySelectorAll("a[href*='/server/']"));
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (href.includes(sid)) {
        // 检查链接文字或附近元素是否包含完整 UUID
        const txt = link.textContent || "";
        if (txt.includes("-")) return txt.trim();
      }
    }
    return null;
  }, shortUuid).catch(() => null);
  if (fromPage) return fromPage;
  // 兜底: 用短 UUID 尝试 info API（可能失败）
  return shortUuid;
}

// ===================== 浏览器工具 =====================

const http = require("http");

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/version`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function launchChrome() {
  console.log(`  启动 Chrome (${CHROME_PATH})...`);
  if (await checkPort(DEBUG_PORT)) {
    console.log("  Chrome 已在运行");
    return;
  }
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1280,720",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--user-data-dir=/tmp/chrome_user_data_epichost",
  ];
  const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  chrome.unref();
  for (let i = 0; i < 40; i++) {
    if (await checkPort(DEBUG_PORT)) {
      console.log("  Chrome 已就绪");
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Chrome 启动失败");
}

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

// ===================== 登录流程 =====================

async function login(page, email, password) {
  console.log(`  登录 ${email}...`);

  // 访问登录页
  await gotoWithRetry(page, `${PANEL_URL}/auth/login`);
  await page.waitForTimeout(2000);

  // 如果已经登录（Cookie 跳转），直接返回
  if (!page.url().includes("/auth/login")) {
    console.log("  ✅ 已有登录会话");
    return true;
  }

  // 填写表单
  await page.fill('input[name="username"]', email);
  await page.fill('input[name="password"]', password);

  // 获取 CSRF token
  const csrfToken = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : null;
  });

  if (!csrfToken) {
    console.log("  → 未找到 CSRF token，尝试表单提交...");
    // 尝试处理 reCAPTCHA 并提交表单
    for (let i = 0; i < 10; i++) {
      for (const frame of page.frames()) {
        try {
          const btn = await frame.$('button:has-text("跳过")');
          if (btn) { await btn.click(); await page.waitForTimeout(800); }
        } catch { /* ignore */ }
      }
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (form) {
        let ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (!ta) {
          ta = document.createElement("textarea");
          ta.name = "g-recaptcha-response";
          ta.style.display = "none";
          document.body.appendChild(ta);
        }
        ta.value = "skip";
        form.submit();
      }
    });
    await page.waitForTimeout(5000);
  } else {
    // 尝试 fetch JSON 登录
    const loginResult = await page.evaluate(async (args) => {
      const { email, password, csrf } = args;
      try {
        const resp = await fetch("/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": csrf,
            Accept: "application/json",
          },
          body: JSON.stringify({ user: email, password }),
        });
        return { ok: resp.ok, status: resp.status };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, { email, password, csrf: csrfToken });

    if (loginResult.ok) {
      await page.waitForTimeout(3000);
    } else {
      // 尝试 URL-encoded 格式
      console.log(`  → fetch JSON 登录返回 ${loginResult.status}，尝试 form 格式...`);
      const loginResult2 = await page.evaluate(async (args) => {
        const { email, password, csrf } = args;
        try {
          const resp = await fetch("/auth/login", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "X-Requested-With": "XMLHttpRequest",
              "X-CSRF-TOKEN": csrf,
              Accept: "application/json",
            },
            body: `user=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
          });
          return { ok: resp.ok, status: resp.status };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }, { email, password, csrf: csrfToken });

      if (!loginResult2.ok) {
        console.log(`  → fetch Form 登录返回 ${loginResult2.status}，尝试表单提交...`);
        // 尝试处理 reCAPTCHA 并提交表单
        for (let i = 0; i < 10; i++) {
          for (const frame of page.frames()) {
            try {
              const btn = await frame.$('button:has-text("跳过")');
              if (btn) { await btn.click(); await page.waitForTimeout(800); }
            } catch { /* ignore */ }
          }
          await page.waitForTimeout(500);
        }
        await page.evaluate(() => {
          const form = document.querySelector("form");
          if (form) {
            let ta = document.querySelector('textarea[name="g-recaptcha-response"]');
            if (!ta) {
              ta = document.createElement("textarea");
              ta.name = "g-recaptcha-response";
              ta.style.display = "none";
              document.body.appendChild(ta);
            }
            ta.value = "skip";
            form.submit();
          }
        });
        await page.waitForTimeout(5000);
      } else {
        await page.waitForTimeout(3000);
      }
    }
  }

  // 验证登录结果
  await gotoWithRetry(page, PANEL_URL);
  const loggedIn = !page.url().includes("/auth/login");
  if (loggedIn) {
    console.log("  ✅ 登录成功");
  } else {
    console.log("  ❌ 登录失败");
  }
  return loggedIn;
}

// ===================== 续期单个服务器 =====================

async function renewSingleServer(page, shortUuid, photoDir) {
  const sid = shortUuid || "unknown";
  const fullUuid = await resolveFullUuid(page, shortUuid);
  const shot = path.join(photoDir, `epichost_${sid}.png`);

  console.log(`  打开服务器页: ${PANEL_URL}/server/${shortUuid}`);
  await gotoWithRetry(page, `${PANEL_URL}/server/${shortUuid}`);
  await page.waitForTimeout(2000);

  // 检查页面是否有 "ADD 4 HOUR(S)" 按钮
  const renewBtn = page.locator('button:has-text("ADD 4 HOUR(S)")');
  const btnVisible = await renewBtn.isVisible().catch(() => false);

  if (!btnVisible) {
    // 尝试 API 方式
    console.log(`  未找到续期按钮，尝试 API 续期...`);

    // 获取 CSRF token
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
      // 重新获取过期时间
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

    // 检查是否提示 "can't renew"（已续过）
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
    await renewBtn.click({ force: true });
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`  点击按钮失败: ${e.message}`);
    try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}
    return { status: "error", message: `按钮点击失败: ${e.message}`, shot };
  }

  // 等续期生效（等待页面刷新或 API 调用）
  await page.waitForTimeout(3000);

  // 截图保存
  try { await page.screenshot({ path: shot, fullPage: true }); } catch (e) {}

  // 重新读取过期时间
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
  if (!TG_BOT_TOKEN || !TG_CHAT_ID || !imagePath || !fs.existsSync(imagePath)) {
    return;
  }
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

  await launchChrome();

  // 连接 Chrome DevTools（带重试，同其他脚本模式）
  let browser;
  for (let k = 0; k < 5; k++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
      console.log("  连接 Chrome 成功！");
      break;
    } catch (e) {
      console.log(`  连接尝试 ${k + 1}/5 失败: ${e.message.slice(0, 80)}... 2秒后重试`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!browser) {
    console.error("❌ 连接 Chrome 失败，退出");
    process.exit(1);
  }

  const photoDir = path.join(__dirname, "screenshots");
  fs.mkdirSync(photoDir, { recursive: true });

  const allResults = [];

  try {
    for (const user of users) {
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

      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
      const page = await context.newPage();

      try {
        // 登录
        const ok = await login(page, email, password);
        if (!ok) {
          console.log(`  ❌ 用户 ${email} 登录失败`);
          allResults.push({ user: email, uuid: shortUuid, status: "error", message: "登录失败" });
          await context.close();
          continue;
        }

        // 续期
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
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
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
  const summaryLines = allResults.map(r => {
    const icon = r.status === "success" ? "✅" : r.status === "wait" ? "⏳" : "❌";
    return `${icon} ${r.user}: ${r.message}`;
  });
  await sendTelegramMessage(
    `EpicHost 续期完成\n成功: ${successCount}/${allResults.length}\n` +
    summaryLines.join("\n")
  );

  process.exit(successCount > 0 ? 0 : 1);
})();
