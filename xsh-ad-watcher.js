/**
 * X Systems Hosting — 自动观看广告获取积分脚本
 * 
 * 用法: node xsh-ad-watcher.js <DISCORD_TOKEN>
 * 
 * 注意: 使用此脚本前请确保已重置 Discord 令牌
 *       自动化观看广告可能违反网站服务条款，后果自负
 */

const { chromium } = require('playwright');

const XSH_BASE = 'https://xsystemshosting.com';
const DISCORD_API = 'https://discord.com/api/v10';
const CLIENT_ID = '1472320867060023540';
const REDIRECT_URI = `${XSH_BASE}/auth/discord/callback`;
const SCOPES = 'identify email';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getDiscordUserInfo(token) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Discord token无效: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * 通过 Discord 用户令牌完成 OAuth 授权
 * 返回 authorization code
 */
async function authorizeDiscordApp(token) {
  // 第一步: 先获取fingerprint (有些版本的Discord需要)
  const authorizeUrl = `${DISCORD_API}/oauth2/authorize`;
  
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });

  // 发起授权请求，模拟用户点击"Authorize"
  const res = await fetch(`${authorizeUrl}?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      authorize: true,
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      permissions: '0',
      integration_type: 0,
    }),
    redirect: 'manual', // 不自动跟随重定向，我们需要捕获 Location header
  });

  // 检查重定向
  const location = res.headers.get('location');
  if (location) {
    console.log(`[OK] 授权成功，重定向到: ${location.substring(0, 80)}...`);
    const url = new URL(location);
    const code = url.searchParams.get('code');
    if (code) {
      return { code, redirectUrl: location };
    }
  }

  // 如果没重定向，检查响应内容
  const text = await res.text();
  console.log(`[!] 授权响应: ${text.substring(0, 200)}`);
  
  // 尝试解析JSON
  try {
    const data = JSON.parse(text);
    if (data.location) {
      const url = new URL(data.location);
      const code = url.searchParams.get('code');
      if (code) return { code, redirectUrl: data.location };
    }
  } catch {}

  throw new Error(`Discord授权失败: ${text.substring(0, 200)}`);
}

/**
 * 主流程
 */
async function main() {
  const token = process.argv[2];
  if (!token) {
    console.error('用法: node xsh-ad-watcher.js <DISCORD_TOKEN>');
    process.exit(1);
  }

  console.log('=== X Systems Hosting 自动广告观看脚本 ===\n');

  // 1. 验证 Discord 令牌
  console.log('[1] 验证 Discord 令牌...');
  const user = await getDiscordUserInfo(token);
  console.log(`    ✅ 已登录 Discord: ${user.username}#${user.discriminator || user.discriminator === 0 ? user.discriminator : ''} (ID: ${user.id})`);

  // 2. 完成 Discord OAuth 授权
  console.log('\n[2] 授权 xsystemshosting 应用...');
  let { code, redirectUrl } = await authorizeDiscordApp(token);
  console.log(`    ✅ 获取到授权码: ${code.substring(0, 20)}...`);

  // 3. 启动浏览器，完成登录流程
  console.log('\n[3] 启动浏览器完成登录...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 导航到 callback URL 完成登录
    console.log(`    → 正在访问 callback URL...`);
    await page.goto(redirectUrl, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`    ✅ 登录成功! 当前页面: ${page.url()}`);

    // 4. 前往 dashboard
    console.log('\n[4] 前往 Dashboard...');
    await page.goto(`${XSH_BASE}/dashboard/discord`, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`    ✅ 当前页面: ${page.url()}`);

    // 5. 截图看看当前页面
    await page.screenshot({ path: 'dashboard.png' });
    console.log(`    📸 已保存 dashboard.png`);

    // 6. 寻找"Watch ads"按钮
    console.log('\n[5] 寻找广告观看入口...');
    
    // 尝试多种选择器
    const watchAdSelectors = [
      'text=Watch ads',
      'text=watch ads',
      'text=观看广告',
      'button:has-text("Watch ads")',
      'a:has-text("Watch ads")',
      '[href*="watch"]',
      '[href*="ad"]',
    ];

    let watchAdClicked = false;
    for (const selector of watchAdSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        console.log(`    → 找到按钮: "${selector}"，正在点击...`);
        await btn.click();
        watchAdClicked = true;
        await sleep(2000);
        break;
      }
    }

    if (!watchAdClicked) {
      // 打印页面内容帮助调试
      const content = await page.textContent('body');
      console.log(`    [!] 未找到 Watch ads 按钮，页面内容预览:\n${content.substring(0, 500)}`);
      
      // 尝试点击所有可能的 Quest 相关区域
      const questBtns = await page.$$('button, a, [role="button"]');
      for (const btn of questBtns) {
        const text = await btn.textContent();
        if (text && (text.toLowerCase().includes('ad') || text.toLowerCase().includes('quest') || text.toLowerCase().includes('quick'))) {
          console.log(`    → 尝试点击: "${text.trim()}"`);
          await btn.click();
          await sleep(2000);
          break;
        }
      }
    }

    // 7. 截图看看当前状态
    await page.screenshot({ path: 'ad-page.png' });
    console.log(`    📸 已保存 ad-page.png`);

    // 8. 等待广告加载和计时
    console.log('\n[6] 等待广告加载...');
    await sleep(3000);

    // 获取当前页面内容
    const adContent = await page.textContent('body');
    console.log(`    → 页面内容预览:\n${adContent.substring(0, 300)}`);

    // 9. 等待并点击 Claim
    console.log('\n[7] 等待 Claim 按钮出现...');
    const claimSelectors = [
      'text=Claim',
      'text=claim',
      'button:has-text("Claim")',
      'text=领取',
      '[data-action="claim"]',
    ];

    // 等待最多 30 秒让 Claim 按钮出现
    let claimed = false;
    for (let i = 0; i < 30; i++) {
      for (const selector of claimSelectors) {
        const btn = await page.$(selector);
        if (btn) {
          const text = await btn.textContent();
          if (text && text.trim() !== '') {
            console.log(`    ✅ 找到按钮: "${text.trim()}" (选择器: ${selector})`);
            await btn.click();
            console.log(`    ✅ 已点击! 积分已领取!`);
            claimed = true;
            break;
          }
        }
      }
      if (claimed) break;
      // 打印倒计时状态
      const countdownEl = await page.$('[class*="countdown"], [class*="timer"], [class*="time"]');
      if (countdownEl) {
        const countdownText = await countdownEl.textContent();
        console.log(`    ⏱ 等待中... ${countdownText?.trim() || ''}`);
      }
      await sleep(1000);
    }

    if (!claimed) {
      console.log(`    [!] 未找到 Claim 按钮，页面内容:\n${adContent.substring(0, 500)}`);
    }

    // 10. 尝试点击 Discord 邀请
    console.log('\n[8] 尝试领取 Discord 邀请奖励...');
    const inviteSelectors = [
      'text=Open Discord',
      'text=Discord invite',
      'text=加入 Discord',
      'button:has-text("Discord")',
      'a:has-text("Discord")',
    ];
    for (const selector of inviteSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        const text = await btn.textContent();
        console.log(`    → 找到: "${text?.trim()}"，正在点击...`);
        await btn.click();
        await sleep(1000);
        console.log(`    ✅ Discord 邀请奖励已领取!`);
        break;
      }
    }

    // 最终截图
    await page.screenshot({ path: 'final.png' });
    console.log(`\n    📸 最终状态已保存到 final.png`);

    console.log('\n=== 完成! ===');
    console.log('脚本已执行完毕。浏览器保持打开以便你查看结果。');
    console.log('按 Ctrl+C 退出。');

    // 保持浏览器打开
    await new Promise(() => {});

  } catch (err) {
    console.error(`\n❌ 错误: ${err.message}`);
    await page.screenshot({ path: 'error.png' });
    console.log('📸 错误截图已保存到 error.png');
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(`\n❌ 执行失败: ${err.message}`);
  process.exit(1);
});