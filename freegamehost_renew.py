#!/usr/bin/env python3
"""
FreeGameHost (panel.freegamehost.xyz) 续期保活脚本
使用 SeleniumBase UC 模式绕过 Cloudflare Turnstile
流程: 登录 → 打开服务器页 → 点击 "+8 Hours" 续期 → 处理 Turnstile → TG 通知
账号来源: Secret FGH_ACCOUNT = "邮箱,密码"
"""

import os
import sys
import json
import time
import re
import requests
from datetime import datetime

# ==================== 配置 ====================
LOGIN_URL = 'https://panel.freegamehost.xyz/auth/login'
DASHBOARD_URL = 'https://panel.freegamehost.xyz/'
SERVER_URL = 'https://panel.freegamehost.xyz/server/01647891'

# 从环境变量读取
FGH_ACCOUNT = os.environ.get('FGH_ACCOUNT', '')
TG_BOT = os.environ.get('TG_BOT', '')  # chat_id,bot_token

# Telegram 通知
def send_tg_message(msg, photo_path=None):
    if not TG_BOT or ',' not in TG_BOT:
        return
    parts = TG_BOT.split(',', 1)
    chat_id, bot_token = parts[0].strip(), parts[1].strip()
    if not chat_id or not bot_token:
        return
    text = f"📌 *FreeGameHost*\n{msg}"
    try:
        if photo_path and os.path.exists(photo_path):
            with open(photo_path, 'rb') as f:
                requests.post(
                    f'https://api.telegram.org/bot{bot_token}/sendPhoto',
                    data={'chat_id': chat_id, 'parse_mode': 'Markdown', 'caption': text[:1000]},
                    files={'photo': f},
                    timeout=30
                )
        else:
            requests.post(
                f'https://api.telegram.org/bot{bot_token}/sendMessage',
                json={'chat_id': chat_id, 'text': text, 'parse_mode': 'Markdown'},
                timeout=30
            )
    except Exception as e:
        print(f'[Telegram] 发送失败: {e}')


def parse_account(account_str):
    """解析账号: 支持邮箱,密码 或 JSON 格式"""
    account_str = account_str.strip()
    # 尝试 JSON 解析
    if account_str.startswith('['):
        try:
            accounts = json.loads(account_str)
            if isinstance(accounts, list) and len(accounts) > 0:
                return accounts
        except json.JSONDecodeError:
            pass
    # 尝试 邮箱,密码 格式
    if ',' in account_str:
        parts = account_str.split(',', 1)
        return [{'username': parts[0].strip(), 'password': parts[1].strip(),
                 'serverUrl': SERVER_URL}]
    return []


def get_server_uuid(server_url):
    """从服务器 URL 提取 UUID"""
    # URL 格式: https://panel.freegamehost.xyz/server/01647891
    # 但 API 需要完整 UUID: 01647891-1a85-441d-b154-7189f2074c84
    # 先尝试从 URL 获取短 ID
    match = re.search(r'/server/([0-9a-f]+)', server_url)
    if match:
        return match.group(1)
    return None


def main():
    # ==================== 解析账号 ====================
    users = parse_account(FGH_ACCOUNT)
    if not users:
        print('[错误] 未找到有效账号，请设置 FGH_ACCOUNT')
        send_tg_message('❌ *配置错误*\n未设置 FGH_ACCOUNT')
        sys.exit(1)

    user = users[0]
    username = user.get('username', '')
    password = user.get('password', '')
    server_url = user.get('serverUrl', SERVER_URL)
    print(f'[账号] {username}')
    print(f'[服务器] {server_url}')

    # ==================== 初始化浏览器 ====================
    print('[浏览器] 启动 SeleniumBase UC 模式...')
    from seleniumbase import Driver

    driver = Driver(
        uc=True,  # Undetected Chromium 模式
        headless=False,  # GitHub Actions 用 xvfb-run
        headed=True,
        browser='chrome',
        # 窗口大小
        window_size=(1440, 900),
        # 禁用自动化标志
        disable_csp=True,
        disable_images=False,
        # 用户数据目录（持久化 cookie）
        user_data_dir='/tmp/fgh_chrome_data',
    )

    # 设置隐式等待
    driver.implicitly_wait(10)

    try:
        # ==================== 登录 ====================
        print('[登录] 打开登录页...')
        driver.get(LOGIN_URL)
        time.sleep(2)

        # 检查是否已登录（cookie 有效）
        if '/auth/login' in driver.current_url:
            print('[登录] 输入凭据...')
            # 使用 SeleniumBase 的填写方法
            try:
                driver.type('input[type="text"]', username, timeout=10)
                driver.type('input[type="password"]', password, timeout=10)
                time.sleep(0.5)
            except Exception as e:
                print(f'[登录] 填写表单失败: {e}')
                # 尝试 JS 方式
                driver.execute_script("document.querySelector('input[type=\"text\"]').value = arguments[0];", username)
                driver.execute_script("document.querySelector('input[type=\"password\"]').value = arguments[0];", password)
                time.sleep(0.5)

            # 点击 Login 按钮
            try:
                driver.click('button:contains("Login")', timeout=10)
            except Exception:
                try:
                    driver.click('button[type="submit"]', timeout=10)
                except Exception:
                    driver.execute_script("document.querySelector('button').click()")

            # 等待登录成功
            print('[登录] 等待登录完成...')
            for _ in range(30):
                time.sleep(1)
                if '/auth/login' not in driver.current_url:
                    print(f'[登录] ✅ 成功: {driver.current_url}')
                    break
            else:
                # 截图保存
                driver.save_screenshot('screenshots/login_failed.png')
                print('[登录] ❌ 失败')
                send_tg_message('❌ *登录失败*', 'screenshots/login_failed.png')
                return
        else:
            print('[登录] ✅ Cookie 有效，跳过登录')

        # ==================== 打开服务器页 ====================
        print(f'[续期] 打开服务器页: {server_url}')
        driver.get(server_url)
        time.sleep(3)

        # 读取到期时间
        try:
            timer_text = driver.execute_script("""
                const all = document.querySelectorAll('div, span, p, section');
                for (const el of all) {
                    const text = (el.textContent || '').trim();
                    if (/^\\d{1,2}:\\d{2}:\\d{2}$/.test(text) && !text.includes('renewal')) return text;
                }
                for (const el of all) {
                    const text = (el.textContent || '').trim();
                    if (text === 'Time remaining' && el.nextElementSibling) {
                        const val = (el.nextElementSibling.textContent || '').trim();
                        if (/^\\d{1,2}:\\d{2}:\\d{2}$/.test(val)) return val;
                    }
                }
                return '';
            """)
            print(f'[续期] 到期时间: {timer_text or "?"}')
        except Exception:
            timer_text = ''
            print('[续期] 到期时间: ?')

        # ==================== 点击续期 ====================
        print('[续期] 查找续期按钮...')

        # 先检查冷却状态
        try:
            cooldown_btn = driver.find_element('button:contains("renewal cooldown")')
            if cooldown_btn:
                cooldown_text = cooldown_btn.text
                print(f'[续期] ⏳ 冷却中: {cooldown_text}')
                send_tg_message(
                    f'⏳ *冷却中，暂不可续期*\n'
                    f'用户: {username}\n'
                    f'冷却: {cooldown_text}\n'
                    f'服务器到期: {timer_text or "?"}'
                )
                return
        except Exception:
            pass

        # 查找 +8 Hours 按钮
        renew_btn = None
        try:
            renew_btn = driver.find_element('button:contains("Renew +8 Hours")')
        except Exception:
            try:
                renew_btn = driver.find_element('button:contains("+8 Hours")')
            except Exception:
                pass

        if not renew_btn:
            print('[续期] ⚠️ 未找到续期按钮')
            driver.save_screenshot('screenshots/no_button.png')
            send_tg_message(f'⚠️ *未找到续期按钮*\n用户: {username}\n到期: {timer_text or "?"}',
                           'screenshots/no_button.png')
            return

        # 检查按钮是否禁用
        if not renew_btn.is_enabled():
            print('[续期] ⏳ 按钮禁用')
            send_tg_message(f'⏳ *续期按钮禁用*\n用户: {username}\n到期: {timer_text or "?"}')
            return

        # 点击续期按钮
        print('[续期] 点击 Renew +8 Hours...')
        try:
            renew_btn.click()
        except Exception:
            driver.execute_script("arguments[0].click()", renew_btn)

        time.sleep(2)

        # ==================== 处理 Turnstile ====================
        # SeleniumBase UC 模式会自动处理 Cloudflare 验证
        # 等待 Turnstile 自动通过或超时
        print('[续期] 等待 Turnstile 验证...')
        turnstile_start = time.time()

        # 等待 Turnstile 完成（最多 60 秒）
        for i in range(60):
            time.sleep(1)

            # 检查 Turnstile 是否已通过（页面变化）
            try:
                # 检查 "Complete security check" 是否还在
                security_check = driver.find_elements('xpath', '//*[contains(text(), "Complete security check")]')
                if not security_check:
                    print('[续期] ✅ Turnstile 已通过')
                    break
            except Exception:
                print('[续期] ✅ Turnstile 已通过')
                break

            # 每 5 秒尝试点击 Turnstile checkbox（如果存在）
            if i % 5 == 0:
                try:
                    # 在 iframe 中找 Turnstile checkbox
                    driver.switch_to.frame(driver.find_element('xpath', '//iframe[contains(@src, "challenges.cloudflare.com")]'))
                    checkbox = driver.find_elements('xpath', '//input[@type="checkbox"]')
                    if checkbox:
                        checkbox[0].click()
                        print(f'[续期] 点击 Turnstile checkbox (第 {i//5 + 1} 次)')
                    driver.switch_to.default_content()
                except Exception:
                    driver.switch_to.default_content()

            # 超时处理
            if time.time() - turnstile_start > 55:
                print('[续期] ⚠️ Turnstile 超时')
                break

        # 等待续期结果
        time.sleep(3)

        # ==================== 读取结果 ====================
        try:
            after_timer = driver.execute_script("""
                const all = document.querySelectorAll('div, span, p, section');
                for (const el of all) {
                    const text = (el.textContent || '').trim();
                    if (/^\\d{1,2}:\\d{2}:\\d{2}$/.test(text) && !text.includes('renewal')) return text;
                }
                return '';
            """)
            print(f'[续期] 续期后到期: {after_timer or "?"}')
        except Exception:
            after_timer = ''

        # 截图
        os.makedirs('screenshots', exist_ok=True)
        screenshot = 'screenshots/renew_result.png'
        driver.save_screenshot(screenshot)

        # ==================== 发送通知 ====================
        if timer_text and after_timer and timer_text != after_timer:
            print('[续期] ✅ 续期成功')
            send_tg_message(
                f'✅ *续期成功*\n'
                f'用户: {username}\n'
                f'到期: {timer_text} → {after_timer}',
                screenshot
            )
        else:
            print('[续期] ✅ 已点击续期')
            send_tg_message(
                f'✅ *续期操作已完成*\n'
                f'用户: {username}\n'
                f'到期: {after_timer or timer_text or "?"}',
                screenshot
            )

    except Exception as e:
        print(f'[错误] {e}')
        import traceback
        traceback.print_exc()
        try:
            driver.save_screenshot('screenshots/error.png')
            send_tg_message(f'❌ *处理异常*\n用户: {username}\n错误: {str(e)[:200]}',
                           'screenshots/error.png')
        except Exception:
            pass

    finally:
        print('[浏览器] 关闭...')
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == '__main__':
    main()