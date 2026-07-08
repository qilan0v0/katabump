/**
 * X Systems Hosting — Discord Token 一键登录工作流 (GitHub Actions 版)
 * ===================================================================
 *
 * 环境变量:
 *   XSH_USERS_JSON = [{"Discord-token":"MTM3..."}]
 *
 * 工作流:
 *   1. 打开 xsystemshosting.com/login
 *   2. 点击 "Continue with Discord"
 *   3. 用 Discord Token 登录（localStorage iframe 注入法）
 *   4. 回到 OAuth 授权页，点击 "授权"
 *   5. 成功跳转到 /dashboard
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ---------- 读取用户配置 ----------
const usersJson = process.env.XSH_USERS_JSON;
if (!usersJson) {
  console.error('❌ 缺少环境变量 XSH_USERS_JSON');
  process.exit(1);
}

let users;
try {
  users = JSON.parse(usersJson);
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error('XSH_USERS_JSON 必须是非空数组');
  }
} catch (e) {
  console.error('❌ XSH_USERS_JSON 解析失败:', e.message);
  process.exit(1);
}

const isCI = process.env.CI === 'true';
const SCREENSHOT_DIR = path.resolve('screenshots');

// ---------- 工具函数 ----------
async function screenshot(page, name) {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
  const filePath = path.join(SCREENSHOT_DIR, `xsh-${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`  📸 截图已保存: ${filePath}`);
}

// ---------- 登录单个用户 ----------
async function loginUser(browser, user, index) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  const token = user['Discord-token'] || user.token;
  const label = `${index + 1}/${users.length}`;

  console.log(`\n===== 用户 ${label} =====`);

  try {
    // ===== Step 1: 打开 xsystemshosting =====
    console.log(`  [${label}] Step 1: 打开 xsystemshosting...`);
    await page.goto('https://xsystemshosting.com/dashboard/discord', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    console.log(`  URL: ${page.url()}`);
    if (page.url().includes('/dashboard')) {
      console.log(`  ✅ [${label}] 已登录，跳过登录流程`);
      await context.close();
      return { success: true, user: token.slice(0, 20) + '...' };
    }

    // ===== Step 2: 点击 "Continue with Discord" =====
    console.log(`  [${label}] Step 2: 点击 "Continue with Discord"...`);
    await page.click('text="Continue with Discord"');
    await page.waitForTimeout(3000);
    console.log(`  URL: ${page.url()}`);

    // 如果已经登录了 Discord，可能直接跳过了
    if (page.url().includes('authorize')) {
      console.log(`  [${label}] 已在 Discord 登录状态，直接处理授权...`);
    } else {
      // ===== Step 3: 用 Token 登录 Discord =====
      console.log(`  [${label}] Step 3: 注入 Discord Token...`);

      // 方法: 通过 iframe 写入 localStorage token
      await page.evaluate((t) => {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        const iframeWindow = iframe.contentWindow;
        iframeWindow.localStorage.setItem('token', JSON.stringify(t));
        document.body.removeChild(iframe);
      }, token);

      // 跳转到 Discord 频道页以触发 token 认证
      await page.goto('https://discord.com/channels/@me', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
      console.log(`  Discord 登录后 URL: ${page.url()}`);
    }

    // ===== Step 4: 导航到 OAuth 授权页 =====
    console.log(`  [${label}] Step 4: 导航到 OAuth 授权页...`);
    await page.goto(
      'https://discord.com/oauth2/authorize?client_id=1472320867060023540&redirect_uri=https%3A%2F%2Fxsystemshosting.com%2Fauth%2Fdiscord%2Fcallback&response_type=code&scope=identify%20email',
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await page.waitForTimeout(2000);
    console.log(`  OAuth URL: ${page.url()}`);

    // 检查是否已经授权成功被重定向
    if (page.url().includes('xsystemshosting.com')) {
      console.log(`  ✅ [${label}] 已授权并跳转回 xsystemshosting`);
      await screenshot(page, `user${index + 1}-done`);
      await context.close();
      return { success: true, user: token.slice(0, 20) + '...' };
    }

    // ===== Step 5: 点击 "授权" =====
    console.log(`  [${label}] Step 5: 点击 "授权"...`);

    // 等待 "授权" 按钮出现
    try {
      await page.waitForSelector('button:has-text("授权")', { timeout: 10000 });
      await page.click('button:has-text("授权")');
    } catch {
      // 可能按钮文本不同，尝试英文
      try {
        await page.waitForSelector('button:has-text("Authorize")', { timeout: 5000 });
        await page.click('button:has-text("Authorize")');
      } catch {
        console.log(`  ⚠️ [${label}] 未找到授权按钮，尝试通用点击...`);
        // 截图留存
        await screenshot(page, `user${index + 1}-no-auth-btn`);
        await context.close();
        return { success: false, user: token.slice(0, 20) + '...', error: '找不到授权按钮' };
      }
    }

    // 等待重定向回 xsystemshosting
    await page.waitForTimeout(5000);
    console.log(`  授权后 URL: ${page.url()}`);

    // ===== 验证 =====
    if (page.url().includes('/dashboard')) {
      console.log(`  ✅ [${label}] 登录成功！`);
      await screenshot(page, `user${index + 1}-success`);
      await context.close();
      return { success: true, user: token.slice(0, 20) + '...' };
    }

    // 等待最终跳转（可能有点慢）
    try {
      await page.waitForURL('**/dashboard**', { timeout: 15000 });
      console.log(`  ✅ [${label}] 最终跳转成功！`);
      await screenshot(page, `user${index + 1}-success`);
      await context.close();
      return { success: true, user: token.slice(0, 20) + '...' };
    } catch {
      console.log(`  ⚠️ [${label}] 可能未完全跳转，当前 URL: ${page.url()}`);
      await screenshot(page, `user${index + 1}-final`);
      await context.close();
      return { success: false, user: token.slice(0, 20) + '...', error: '未跳转到 dashboard' };
    }
  } catch (err) {
    console.error(`  ❌ [${label}] 错误: ${err.message}`);
    await screenshot(page, `user${index + 1}-error`).catch(() => {});
    await context.close();
    return { success: false, user: token.slice(0, 20) + '...', error: err.message };
  }
}

// ---------- 主函数 ----------
(async () => {
  console.log(`🚀 X Systems Hosting 登录工作流启动`);
  console.log(`   共 ${users.length} 个用户`);

  const browser = await chromium.launch({
    headless: !isCI,     // CI 下 headless，本地可见
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  for (let i = 0; i < users.length; i++) {
    const r = await loginUser(browser, users[i], i);
    results.push(r);
  }

  await browser.close();

  // ---------- 汇总 ----------
  console.log('\n========== 汇总 ==========');
  const successCount = results.filter((r) => r.success).length;
  console.log(`  成功: ${successCount}/${results.length}`);
  results.forEach((r, i) => {
    const status = r.success ? '✅' : '❌';
    console.log(`  ${status} 用户${i + 1}: ${r.user}${r.error ? ` — ${r.error}` : ''}`);
  });

  if (successCount < results.length) {
    console.log('\n⚠️  部分用户登录失败，请检查截图');
    process.exit(1);
  } else {
    console.log('\n🎉 所有用户登录成功！');
  }
})();