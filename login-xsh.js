/**
 * X Systems Hosting — Discord Token 一键登录工作流
 * ================================================
 * 使用 Discord Token 登录 xsystemshosting.com
 *
 * 用法:
 *   1. 将你的 Discord Token 填入下方
 *   2. 运行: node login-xsh.js
 *
 * 工作流:
 *   1. 打开 xsystemshosting.com/dashboard/discord
 *   2. 点击 "Continue with Discord"
 *   3. 用 token 登录 Discord（通过 localStorage iframe 注入法）
 *   4. 回到 OAuth 授权页，点击 "授权"
 *   5. 成功跳转到 dashboard
 */

const { chromium } = require('playwright');

// ⚠️ 在这里填入你的 Discord Token
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_DISCORD_TOKEN_HERE';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ===== 第 1 步：打开 xsystemshosting 登录页 =====
    console.log('➡️  Step 1: 打开 xsystemshosting...');
    await page.goto('https://xsystemshosting.com/dashboard/discord', {
      waitUntil: 'networkidle',
    });
    // 会被重定向到 /login
    console.log(`  URL: ${page.url()}`);

    // ===== 第 2 步：点击 "Continue with Discord" =====
    console.log('➡️  Step 2: 点击 "Continue with Discord"...');
    await page.click('text="Continue with Discord"');
    await page.waitForTimeout(2000);
    console.log(`  URL: ${page.url()}`);

    // ===== 第 3 步：用 Discord Token 登录 =====
    console.log('➡️  Step 3: 注入 Discord Token...');

    // 注入 token 到 localStorage（标准 iframe 法）
    await page.evaluate((token) => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      const iframeWindow = iframe.contentWindow;
      iframeWindow.localStorage.setItem('token', JSON.stringify(token));
      document.body.removeChild(iframe);
    }, DISCORD_TOKEN);

    // 导航到 Discord 首页触发 token 认证
    await page.goto('https://discord.com/channels/@me', {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(3000);
    console.log(`  Discord 登录后 URL: ${page.url()}`);

    // ===== 第 4 步：回到 OAuth 授权页 =====
    console.log('➡️  Step 4: 导航到 OAuth 授权页...');
    await page.goto(
      'https://discord.com/oauth2/authorize?client_id=1472320867060023540&redirect_uri=https%3A%2F%2Fxsystemshosting.com%2Fauth%2Fdiscord%2Fcallback&response_type=code&scope=identify%20email',
      { waitUntil: 'networkidle' }
    );
    await page.waitForTimeout(2000);
    console.log(`  OAuth URL: ${page.url()}`);

    // ===== 第 5 步：点击 "授权" =====
    console.log('➡️  Step 5: 点击 "授权"...');
    await page.click('button:has-text("授权")');
    await page.waitForTimeout(3000);

    // ===== 验证结果 =====
    console.log(`\n✅ 最终 URL: ${page.url()}`);
    const pageTitle = await page.title();
    console.log(`✅ 页面标题: ${pageTitle}`);

    if (page.url().includes('/dashboard')) {
      console.log('🎉 登录成功！现在已进入 xsystemshosting 仪表板！');
    } else {
      console.log('⚠️  可能需要手动检查登录状态');
    }

    // 保持浏览器打开 30 秒以便查看
    console.log('\n👀 浏览器将保持打开 30 秒...');
    await page.waitForTimeout(30000);
  } catch (err) {
    console.error('❌ 错误:', err.message);
  } finally {
    await browser.close();
  }
})();