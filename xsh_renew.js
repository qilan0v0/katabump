/**
 * X Systems Hosting — Discord Token 登录 + Web 服务器续期（添加时间）
 * ============================================================
 * 流程:
 *   1. Discord OAuth 登录（同 xsh_login.js）
 *   2. 导航到 /dashboard/web 获取服务器列表
 *   3. 对每个服务器：检查剩余时间，若不足则用积分添加时间
 *   4. KV Cookie 持久化 + Telegram 通知
 *
 * 环境变量:
 *   XSH_USERS_JSON = [{"Discord-token":"MTM3..."}]
 *   KV_ADMIN_URL / KV_ADMIN_PASS
 *   TG_BOT_TOKEN / TG_CHAT_ID / TG_THREAD_ID
 */

const { chromium } = require('playwright');
const axios = require('axios');

const XSH_BASE = 'https://xsystemshosting.com';
const DISCORD_CLIENT_ID = '1472320867060023540';
const REDIRECT_URI = `${XSH_BASE}/auth/discord/callback`;
const SCOPES = 'identify email';

// 续期阈值：剩余时间少于此天数时触发续期
const RENEW_THRESHOLD_DAYS = 1;
// 每次续期添加的天数
const RENEW_DAYS = 3;
// 每天消耗的积分
const CREDITS_PER_DAY = 5;

// ---------- KV Cookie 存储 ----------
const KV_ADMIN_URL = process.env.KV_ADMIN_URL;
const KV_ADMIN_PASS = process.env.KV_ADMIN_PASS;
const KV_ENABLED = !!(KV_ADMIN_URL && KV_ADMIN_PASS);

async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await axios.post(KV_ADMIN_URL + '/api/get', { key }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 15000, proxy: false,
    });
    if (r.data.ok && r.data.value != null) return r.data.value;
    return null;
  } catch (e) {
    if (e.response?.status === 404) return null;
    console.warn('[KV] 读取失败:', e.message);
    return null;
  }
}

async function kvPut(key, value) {
  if (!KV_ENABLED) return;
  try {
    await axios.post(KV_ADMIN_URL + '/api/set', { key, value: String(value) }, {
      headers: { 'X-Admin-Pass': KV_ADMIN_PASS, 'Content-Type': 'application/json' },
      timeout: 15000, proxy: false,
    });
    console.log('[KV] CK 已保存');
  } catch (e) {
    console.warn('[KV] 写入失败:', e.message);
  }
}

// ---------- 工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg, label = '') {
  const p = label ? `[${label}]` : '[xsh-renew]';
  console.log(`${p} ${msg}`);
}

// ---------- Telegram ----------
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;

async function sendTelegram(msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: 'Markdown' };
    if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
  } catch { try {
    const payload = { chat_id: TG_CHAT_ID, text: msg };
    if (TG_THREAD_ID) payload.message_thread_id = Number(TG_THREAD_ID);
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload, { timeout: 10000 });
  } catch {} }
}

// ===================================================================
//  Discord OAuth API 授权
// ===================================================================
async function discordAuthorize(token) {
  log('  Discord API 授权...');

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });

  const authUrl = `https://discord.com/api/v10/oauth2/authorize?${params}`;

  const headers = {
    'Authorization': token,
    'Content-Type': 'application/json',
    'Origin': 'https://discord.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  const body = {
    authorize: true,
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    permissions: '0',
    integration_type: 0,
  };

  const res = await axios.post(authUrl, body, {
    headers,
    timeout: 30000,
    maxRedirects: 0,
    validateStatus: (s) => true,
  });

  // 响应可能是 JSON 或重定向
  const location = res.headers['location'] || (res.data && res.data.location) || '';
  if (!location.includes('code=')) {
    throw new Error(`Discord 授权失败: ${res.status} ${JSON.stringify(res.data || '').substring(0, 200)}`);
  }

  const code = new URL(location).searchParams.get('code');
  log(`  ✅ 获取到授权码: ${code.substring(0, 20)}...`);
  return code;
}

// ===================================================================
//  解析服务器列表
// ===================================================================
async function getServerList(page) {
  // 从 /dashboard/web 页面提取服务器信息
  const servers = await page.evaluate(() => {
    const results = [];
    // 查找所有 Manage 连接
    const manageLinks = document.querySelectorAll('a[href*="/dashboard/web/server/"]');
    for (const link of manageLinks) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const idMatch = href.match(/\/server\/(\d+)/);
      if (!idMatch) continue;
      const serverId = idMatch[1];

      // 找到包含此 Manage 链接的最近卡片容器
      const card = link.closest('[class*="rounded-2xl"]') || link.closest('[class*="rounded-3xl"]') || link.parentElement;
      if (!card) {
        results.push({ id: serverId, name: 'unknown', type: 'unknown', cost: 5 });
        continue;
      }

      const text = card.textContent || '';
      const nameEl = card.querySelector('.font-semibold');
      const name = nameEl ? nameEl.textContent.trim() : 'unknown';

      // 提取类型标签（如 Python, Node.js）
      const typeSpans = card.querySelectorAll('span');
      let type = 'unknown';
      for (const span of typeSpans) {
        const t = span.textContent.trim();
        if (t.endsWith('/day')) {
          // This is the cost, skip
          continue;
        }
        if (t !== name && !t.includes('MB') && !t.includes('%') && !t.includes('day')) {
          type = t;
        }
      }

      // 提取每日消耗
      let cost = 5;
      const costMatch = text.match(/(\d+)\/day/);
      if (costMatch) cost = parseInt(costMatch[1]);

      results.push({ id: serverId, name, type, cost });
    }
    return results;
  });
  return servers;
}

// ===================================================================
//  解析服务器页面剩余时间
// ===================================================================
async function getServerTimeLeft(page) {
  const text = await page.evaluate(() => document.body.innerText);
  log(`  页面文本片段: ${text.substring(0, 300).replace(/\n/g, '\\n')}`);

  // 方式1: 找 "Runtime left" 或 "Time left" 标签后的内容
  const labelMatch = text.match(/(?:Time left|Runtime left)\s*\n\s*([^\n]+)/i);
  if (labelMatch) {
    const timeStr = labelMatch[1].trim();
    log(`  标签后时间文本: "${timeStr}"`);
    // 尝试匹配 "Xd Yh" 或 "Yh" 或 "Xd"
    const dhMatch = timeStr.match(/^(\d+)\s*d[a-z]*[,\s]*(\d+)\s*h[a-z]*$/i);
    if (dhMatch) {
      const days = parseInt(dhMatch[1]);
      const hours = parseInt(dhMatch[2]);
      log(`  匹配到: ${days}d ${hours}h`);
      return { days, hours, totalHours: days * 24 + hours, text: `${days}d ${hours}h` };
    }
    const hMatch = timeStr.match(/^(\d+)\s*h[a-z]*$/i);
    if (hMatch) {
      const hours = parseInt(hMatch[1]);
      log(`  匹配到: 0d ${hours}h`);
      return { days: 0, hours, totalHours: hours, text: `0d ${hours}h` };
    }
    const dMatch = timeStr.match(/^(\d+)\s*d[a-z]*$/i);
    if (dMatch) {
      const days = parseInt(dMatch[1]);
      log(`  匹配到: ${days}d 0h`);
      return { days, hours: 0, totalHours: days * 24, text: `${days}d 0h` };
    }
  }

  // 方式2: 直接全文搜索 "Xd Yh" 或 "Yh" 格式（但排除按钮文本）
  // 先找 "Xd Yh" 格式
  const dhMatch = text.match(/(\d+)\s*d[a-z]*[,\s]*(\d+)\s*h[a-z]*/i);
  if (dhMatch) {
    const days = parseInt(dhMatch[1]);
    const hours = parseInt(dhMatch[2]);
    if (days < 100 && hours < 24) { // 合理范围检查
      log(`  全文匹配到: ${days}d ${hours}h`);
      return { days, hours, totalHours: days * 24 + hours, text: `${days}d ${hours}h` };
    }
  }

  // 找 "Yh" 格式（只有小时）
  const hMatch = text.match(/(?:^|\n)\s*(\d+)\s*h[a-z]*\s*$/im);
  if (hMatch) {
    const hours = parseInt(hMatch[1]);
    if (hours < 100) {
      log(`  全文匹配到小时: 0d ${hours}h`);
      return { days: 0, hours, totalHours: hours, text: `0d ${hours}h` };
    }
  }

  log('  ⚠️ 未匹配到任何时间格式');
  return null;
}

// ===================================================================
//  获取 CSRF token
// ===================================================================
async function getCsrfToken(page) {
  return await page.evaluate(() => {
    const input = document.querySelector('input[name="csrf"]');
    return input ? input.value : null;
  });
}

// ===================================================================
//  续期一个服务器（添加时间）
// ===================================================================
async function renewServer(page, server, daysToAdd = RENEW_DAYS) {
  const serverUrl = `${XSH_BASE}/dashboard/web/server/${server.id}`;
  log(`  导航到服务器页面: ${serverUrl}`);
  await page.goto(serverUrl, { waitUntil: 'networkidle', timeout: 30000 });

  // 检查页面是否加载成功
  if (page.url().includes('/login')) {
    log('  ❌ 会话已过期，需要重新登录');
    return { success: false, error: 'session_expired' };
  }

  // 检查剩余时间
  const timeLeft = await getServerTimeLeft(page);
  if (!timeLeft) {
    log('  ⚠️ 无法解析剩余时间，尝试继续续期...');
  } else {
    log(`  剩余时间: ${timeLeft.text}`);
    // 如果剩余时间大于阈值，跳过续期
    if (timeLeft.days > RENEW_THRESHOLD_DAYS) {
      log(`  ⏳ 剩余 ${timeLeft.days} 天 > 阈值 ${RENEW_THRESHOLD_DAYS} 天，无需续期`);
      return { success: true, skipped: true, timeLeft: timeLeft.text, server: server.name };
    }
  }

  // 获取 CSRF token
  const csrf = await getCsrfToken(page);
  if (!csrf) {
    log('  ❌ 无法获取 CSRF token');
    return { success: false, error: 'no_csrf_token' };
  }

  // 点击 "Add X day(s) for X credits" 按钮
  // 按钮是 form 内的 submit 按钮
  const creditsNeeded = daysToAdd * server.cost;
  log(`  尝试添加 ${daysToAdd} 天 (${creditsNeeded} 积分)...`);

  // 通过表单提交来添加时间
  const added = await page.evaluate(({ serverId, days, credits }) => {
    // 找到对应天数的表单
    const forms = document.querySelectorAll('form[action*="add-hours"]');
    for (const form of forms) {
      const daysInput = form.querySelector('input[name="days"]');
      if (daysInput && daysInput.value === String(days)) {
        // 验证 credits_to_use
        const creditsInput = form.querySelector('input[name="credits_to_use"]');
        if (creditsInput && creditsInput.value === String(credits)) {
          form.querySelector('button[type="submit"]').click();
          return true;
        }
      }
    }
    return false;
  }, { serverId: server.id, days: daysToAdd, credits: creditsNeeded });

  if (!added) {
    log('  ⚠️ 未找到匹配的添加时间表单，尝试点击第一个可用按钮...');
    // 兜底：点击第一个 "Add" 按钮
    const clicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent || '';
        if (text.includes('Add') && text.includes('day') && text.includes('credit')) {
          const form = btn.closest('form');
          if (form && form.action.includes('add-hours')) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });

    if (!clicked) {
      log('  ❌ 未找到 Add time 按钮');
      return { success: false, error: 'no_add_time_button' };
    }
  }

  // 等待提交结果
  await sleep(5000);

  // 检查是否成功
  const currentUrl = page.url();
  log(`  提交后 URL: ${currentUrl}`);

  // 如果还在同一页面，检查是否有错误提示
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (bodyText.includes('insufficient') || bodyText.includes('not enough') || bodyText.includes('Insufficient credits')) {
    log('  ❌ 积分不足，无法续期');
    return { success: false, error: 'insufficient_credits' };
  }

  // 检查页面是否包含续期成功提示
  if (bodyText.includes('success') || bodyText.includes('Success') || bodyText.includes('added')) {
    log('  ✅ 续期成功！');
    // 获取新剩余时间
    const newTimeLeft = await getServerTimeLeft(page);
    return { success: true, skipped: false, daysAdded: daysToAdd, server: server.name, timeLeft: newTimeLeft?.text || timeLeft?.text };
  }

  // 如果跳转到了 /dashboard/web，说明提交成功
  if (currentUrl.includes('/dashboard/web')) {
    log('  ✅ 表单提交成功，跳转回服务器列表页');
    return { success: true, skipped: false, daysAdded: daysToAdd, server: server.name, timeLeft: '已续期' };
  }

  // 重新获取剩余时间来判断
  const newTimeLeft = await getServerTimeLeft(page);
  if (newTimeLeft) {
    log(`  续期后剩余时间: ${newTimeLeft.text}`);
    if (timeLeft && newTimeLeft.totalHours > timeLeft.totalHours) {
      log('  ✅ 时间已增加，续期成功！');
      return { success: true, skipped: false, daysAdded: daysToAdd, newTimeLeft: newTimeLeft.text, server: server.name, timeLeft: newTimeLeft.text };
    }
  }

  // 如果没有明确错误，视为成功
  log('  ✅ 续期操作已完成（无明确错误）');
  return { success: true, skipped: false, daysAdded: daysToAdd, server: server.name, timeLeft: timeLeft?.text };
}

// ===================================================================
//  完整浏览器流程：登录 + 续期
// ===================================================================
async function runUser(token) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  const results = [];
  const cookieKey = `xsh_${token.slice(0, 20)}`;

  try {
    // ===== 0. 尝试从 KV 读取已保存的 cookie =====
    log('[0] 尝试从 KV 读取已保存的 cookie...');
    const saved = await kvGet(cookieKey);
    if (saved) {
      try {
        const cks = JSON.parse(saved);
        if (Array.isArray(cks) && cks.length > 0) {
          await context.addCookies(cks);
          log(`  ✅ 已注入 ${cks.length} 个 KV cookie`);
        }
      } catch (e) {
        log(`  ⚠️ cookie 解析失败: ${e.message}`);
      }
    } else {
      log('  KV 中无已保存的 cookie，需要 Discord 登录');
    }

    // ===== 1. 打开 xsystemshosting =====
    log('[1] 打开 xsystemshosting...');
    await page.goto(`${XSH_BASE}/dashboard/web`, { waitUntil: 'networkidle', timeout: 30000 });
    log(`    URL: ${page.url()}`);

    // 如果未登录，执行 Discord 登录
    if (!page.url().includes('/dashboard')) {
      // ===== 2. Discord API 授权 =====
      log('[2] 通过 Discord API 授权...');
      const code = await discordAuthorize(token);

      // ===== 3. 访问回调 URL 完成登录 =====
      log('[3] 访问回调 URL 完成登录...');
      const callbackUrl = `${REDIRECT_URI}?code=${encodeURIComponent(code)}`;
      await page.goto(callbackUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      log(`    URL: ${page.url()}`);

      // 如果还在 Discord 页面，等自动跳转
      if (page.url().includes('discord.com')) {
        await page.waitForTimeout(5000);
        log(`    等待后 URL: ${page.url()}`);
      }

      // 如果还没到 dashboard，再手动导航
      if (!page.url().includes('/dashboard')) {
        log('   → 手动导航到 dashboard...');
        await page.goto(`${XSH_BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
      }
    }

    log(`  登录后 URL: ${page.url()}`);

    // ===== 保存 session cookie 到 KV =====
    const cookies = await context.cookies();
    const xshCookies = cookies.filter(c =>
      c.domain === 'xsystemshosting.com' || c.domain === '.xsystemshosting.com'
    );
    if (xshCookies.length > 0) {
      await kvPut(cookieKey, JSON.stringify(xshCookies));
      log(`  🍪 已保存 ${xshCookies.length} 个 cookie`);
    }

    // ===== 4. 导航到 Web 服务器管理页 =====
    log('[4] 导航到 Web 服务器管理页...');
    await page.goto(`${XSH_BASE}/dashboard/web`, { waitUntil: 'networkidle', timeout: 30000 });
    log(`    URL: ${page.url()}`);

    // ===== 5. 获取服务器列表 =====
    log('[5] 获取服务器列表...');
    const servers = await getServerList(page);
    log(`  找到 ${servers.length} 个 Web 服务器`);

    if (servers.length === 0) {
      log('  没有 Web 服务器需要续期');
      await browser.close();
      return { success: true, results: [] };
    }

    // 输出服务器信息
    console.log('');
    for (const s of servers) {
      console.log(`  📦 ${s.name} (${s.type}) | ID: ${s.id} | 💰 ${s.cost} 积分/天`);
    }

    // ===== 6. 对每个服务器执行续期检查 =====
    log('[6] 检查服务器续期状态...');
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      log(`\n  [服务器 ${i + 1}/${servers.length}] ${server.name} (${server.type})`);

      const r = await renewServer(page, server);
      results.push({ server: server.name, ...r });

      if (r.error === 'session_expired') {
        log('  会话已过期，尝试重新登录...');
        // 尝试重新登录
        try {
          const code = await discordAuthorize(token);
          const callbackUrl = `${REDIRECT_URI}?code=${encodeURIComponent(code)}`;
          await page.goto(callbackUrl, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(3000);
          // 重试当前服务器
          const r2 = await renewServer(page, server);
          results[results.length - 1] = { server: server.name, ...r2 };
        } catch (loginErr) {
          log(`  重新登录失败: ${loginErr.message}`);
        }
      }
    }

    log(`\n[完成] 处理了 ${results.length} 个服务器`);
    await browser.close();
    return { success: true, results };
  } catch (err) {
    log(`❌ 错误: ${err.message}`);
    await page.screenshot({ path: 'xsh-renew-error.png' }).catch(() => {});
    await browser.close();
    return { success: false, error: err.message, results };
  }
}

// ===================================================================
//  入口
// ===================================================================
async function main() {
  console.log('🚀 X Systems Hosting Web 服务器续期');
  console.log('='.repeat(50));
  if (!KV_ENABLED) console.log('⚠️ 未配置 KV，CK 不会持久化');

  const usersJson = process.env.XSH_USERS_JSON;
  if (!usersJson) { console.error('❌ 缺少 XSH_USERS_JSON'); process.exit(1); }
  let users;
  try {
    users = JSON.parse(usersJson);
    if (!Array.isArray(users) || users.length === 0) throw new Error('需要非空数组');
  } catch (e) { console.error('❌ 解析失败:', e.message); process.exit(1); }

  console.log(`📋 共 ${users.length} 个用户\n`);

  const allResults = [];
  for (let i = 0; i < users.length; i++) {
    const token = users[i]['Discord-token'] || users[i].token;
    console.log(`\n======= 用户 ${i + 1}/${users.length} =======`);
    const r = await runUser(token);
    allResults.push(r);
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 汇总');
  console.log('='.repeat(50));

  let totalRenewed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const lines = [];

  allResults.forEach((r, i) => {
    if (r.results) {
      r.results.forEach(sr => {
        const s = sr.success ? (sr.skipped ? '⏳' : '✅') : '❌';
        const timeInfo = sr.timeLeft ? ` (剩余 ${sr.timeLeft})` : '';
        const msg = sr.skipped
          ? `${sr.server}: 无需续期${timeInfo}`
          : sr.success
            ? `${sr.server}: 续期成功${sr.daysAdded ? ` (+${sr.daysAdded}天)` : ''}${timeInfo}`
            : `${sr.server}: 失败 (${sr.error || '未知错误'})`;
        console.log(`  ${s} ${msg}`);
        lines.push(`${s} ${msg}`);
        if (sr.skipped) totalSkipped++;
        else if (sr.success) totalRenewed++;
        else totalFailed++;
      });
    } else {
      const s = r.success ? '✅' : '❌';
      const msg = `用户${i + 1}: ${r.error || '无服务器'}`;
      console.log(`  ${s} ${msg}`);
      lines.push(`${s} ${msg}`);
    }
  });

  const summary = `📊 续期: ${totalRenewed} 个 | ⏳ 跳过: ${totalSkipped} 个 | ❌ 失败: ${totalFailed} 个`;
  console.log(`\n${summary}`);
  await sendTelegram(`*X Systems Hosting Web 续期*\n${lines.join('\n')}\n\n${summary}`);
}

main().catch(err => {
  console.error(`\n❌ 严重错误: ${err.message}`);
  process.exit(1);
});