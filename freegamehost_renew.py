#!/usr/bin/env python3
"""
FreeGameHost (panel.freegamehost.xyz) 续期保活脚本
使用 SeleniumBase UC 模式绕过 Cloudflare Turnstile
流程: 登录 → 打开服务器页 → 点击 "+8 Hours" 续期 → 处理 Turnstile → TG 通知
账号来源: Secret FGH_ACCOUNT = JSON数组 或 "邮箱,密码"
  格式: [{"username":"xxx","password":"xxx","serverUrl":"...","V2":"vless://..."}]
"""

import os
import sys
import json
import time
import re
import subprocess
import signal
import requests
import shutil
from datetime import datetime

# ==================== 配置 ====================
LOGIN_URL = 'https://panel.freegamehost.xyz/auth/login'
DASHBOARD_URL = 'https://panel.freegamehost.xyz/'
BASE_SERVER_URL = 'https://panel.freegamehost.xyz/server/01647891'

# 从环境变量读取（兼容两种变量名）
RAW_ACCOUNT = os.environ.get('FREEGAMEHOST_USERS_JSON', '')
TG_BOT = os.environ.get('TG_BOT', '')  # chat_id,bot_token
GOST_PROXY = os.environ.get('GOST_PROXY', '')  # socks5://user:pass@host:port

# v2ray 路径
V2RAY_BIN = os.environ.get('V2RAY_BIN') or os.path.expanduser('~/v2ray/v2ray')
V2RAY_CONFIG_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    '.github', 'scripts', 'gen-v2ray-config.js')

# 全局进程跟踪
v2ray_processes = []


# ==================== Telegram 通知 ====================
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


# ==================== 账号解析 ====================
def parse_account(account_str):
    """解析 FREEGAMEHOST_USERS_JSON JSON 数组"""
    account_str = account_str.strip()
    if not account_str.startswith('['):
        return []
    try:
        accounts = json.loads(account_str)
        if isinstance(accounts, list) and len(accounts) > 0:
            return accounts
    except json.JSONDecodeError:
        pass
    return []


# ==================== V2ray 代理管理 ====================
def start_v2ray_for_link(link, port):
    """启动 v2ray 实例，返回是否成功"""
    if not os.path.exists(V2RAY_BIN):
        print(f'[v2ray] 未找到 v2ray 二进制 ({V2RAY_BIN})')
        return False

    # 用 Node.js 生成 v2ray 配置
    cfg_path = os.path.join(os.getcwd(), f'v2ray-fgh-{port}.json')
    try:
        result = subprocess.run(
            ['node', '-e', f'''
                const {{ buildConfig }} = require("{V2RAY_CONFIG_SCRIPT}");
                const cfg = buildConfig("{link}", {port});
                require("fs").writeFileSync("{cfg_path}", JSON.stringify(cfg));
                console.log("OK");
            '''],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            print(f'[v2ray] 生成配置失败: {result.stderr[:200]}')
            return False
    except Exception as e:
        print(f'[v2ray] 生成配置异常: {e}')
        return False

    print(f'[v2ray] 启动实例 (HTTP 127.0.0.1:{port})...')
    try:
        proc = subprocess.Popen(
            [V2RAY_BIN, 'run', '-config', cfg_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        )
        v2ray_processes.append(proc)

        # 等待端口就绪
        for _ in range(15):
            time.sleep(2)
            try:
                import socket
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(2)
                result = s.connect_ex(('127.0.0.1', port))
                s.close()
                if result == 0:
                    print(f'[v2ray] 代理就绪 → http://127.0.0.1:{port}')
                    return True
            except Exception:
                pass
        print(f'[v2ray] 端口 {port} 未就绪')
        return False
    except Exception as e:
        print(f'[v2ray] 启动失败: {e}')
        return False


def cleanup_v2ray():
    """清理所有 v2ray 进程"""
    for proc in v2ray_processes:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    v2ray_processes.clear()


# ==================== 主流程 ====================
def main():
    # 注册退出清理
    import atexit
    atexit.register(cleanup_v2ray)

    # ==================== 解析账号 ====================
    users = parse_account(RAW_ACCOUNT)
    if not users:
        print('[错误] 未找到有效账号，请设置 FREEGAMEHOST_USERS_JSON')
        send_tg_message('❌ *配置错误*\n未设置账号信息')
        sys.exit(1)

    for user_idx, user in enumerate(users):
        username = user.get('username', '')
        password = user.get('password', '')
        server_url = user.get('serverUrl', BASE_SERVER_URL)
        v2_link = user.get('V2') or user.get('v2', '')

        print(f'\n=== 正在处理用户 {user_idx + 1}/{len(users)}: {username} ===')
        print(f'[服务器] {server_url}')

        # ==================== 解析代理 ====================
        proxy_url = None
        if v2_link and v2_link.strip():
            print(f'[代理] 检测到用户专属 V2 链接，启动独立 v2ray...')
            port = 11080 + user_idx
            if start_v2ray_for_link(v2_link.strip(), port):
                proxy_url = f'http://127.0.0.1:{port}'
                print(f'[代理] 使用 v2ray: {proxy_url}')
            else:
                print('[代理] v2ray 启动失败，回退到全局代理')

        if not proxy_url and GOST_PROXY:
            proxy_url = GOST_PROXY
            print(f'[代理] 使用全局代理: {proxy_url}')

        # ==================== 初始化浏览器 ====================
        print('[浏览器] 启动 SeleniumBase UC 模式...')
        from seleniumbase import Driver

        driver_kwargs = dict(
            uc=True,
            headless=False,
            headed=True,
            browser='chrome',
            window_size="1440,900",
            disable_csp=True,
            user_data_dir=f'/tmp/fgh_chrome_data_{user_idx}',
        )

        # 代理通过 Chrome 参数设置，避免影响 WebDriver 连接
        if proxy_url:
            driver_kwargs['proxy'] = proxy_url

        # 清理旧用户数据
        import shutil
        user_data_dir = driver_kwargs['user_data_dir']
        if os.path.exists(user_data_dir):
            shutil.rmtree(user_data_dir, ignore_errors=True)

        driver = Driver(**driver_kwargs)
        driver.implicitly_wait(10)

        try:
            # ==================== 登录 ====================
            print('[登录] 打开登录页...')
            try:
                driver.get(LOGIN_URL)
            except Exception as e:
                if proxy_url:
                    print(f'[代理] 代理连接失败 ({e}), 降级直连...')
                    cleanup_v2ray()
                    driver.quit()
                    proxy_url = None
                    driver_kwargs.pop('proxy', None)
                    driver = Driver(**driver_kwargs)
                    driver.implicitly_wait(10)
                    driver.get(LOGIN_URL)
                else:
                    raise
            time.sleep(2)

            if '/auth/login' in driver.current_url:
                print('[登录] 输入凭据...')
                try:
                    driver.type('input[type="text"]', username, timeout=10)
                    driver.type('input[type="password"]', password, timeout=10)
                    time.sleep(0.5)
                except Exception as e:
                    print(f'[登录] 填写表单失败: {e}')
                    driver.execute_script(
                        "document.querySelector('input[type=\"text\"]').value = arguments[0];", username)
                    driver.execute_script(
                        "document.querySelector('input[type=\"password\"]').value = arguments[0];", password)
                    time.sleep(0.5)

                try:
                    driver.click('button:contains("Login")', timeout=10)
                except Exception:
                    driver.execute_script("document.querySelector('button').click()")

                print('[登录] 等待登录完成...')
                for _ in range(30):
                    time.sleep(1)
                    if '/auth/login' not in driver.current_url:
                        print(f'[登录] ✅ 成功: {driver.current_url}')
                        break
                else:
                    driver.save_screenshot(f'screenshots/login_failed_{user_idx}.png')
                    print('[登录] ❌ 失败')
                    send_tg_message('❌ *登录失败*', f'screenshots/login_failed_{user_idx}.png')
                    driver.quit()
                    continue
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

            # ==================== 点击续期 ====================
            print('[续期] 查找续期按钮...')

            # 冷却状态检测
            try:
                cooldown_btn = driver.find_element('button:contains("renewal cooldown")')
                cooldown_text = cooldown_btn.text
                print(f'[续期] ⏳ 冷却中: {cooldown_text}')
                send_tg_message(
                    f'⏳ *冷却中，暂不可续期*\n'
                    f'用户: {username}\n'
                    f'冷却: {cooldown_text}\n'
                    f'服务器到期: {timer_text or "?"}'
                )
                driver.quit()
                continue
            except Exception:
                pass

            # 查找续期按钮
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
                driver.save_screenshot(f'screenshots/no_button_{user_idx}.png')
                send_tg_message(f'⚠️ *未找到续期按钮*\n用户: {username}\n到期: {timer_text or "?"}',
                               f'screenshots/no_button_{user_idx}.png')
                driver.quit()
                continue

            if not renew_btn.is_enabled():
                print('[续期] ⏳ 按钮禁用')
                send_tg_message(f'⏳ *续期按钮禁用*\n用户: {username}\n到期: {timer_text or "?"}')
                driver.quit()
                continue

            # 点击续期
            print('[续期] 点击 Renew +8 Hours...')
            try:
                renew_btn.click()
            except Exception:
                driver.execute_script("arguments[0].click()", renew_btn)

            time.sleep(2)

            # ==================== 处理 Turnstile ====================
            print('[续期] 等待 Turnstile 验证...')
            turnstile_start = time.time()

            for i in range(60):
                time.sleep(1)

                # 检查 Turnstile 是否已通过
                try:
                    security_check = driver.find_elements(
                        'xpath', '//*[contains(text(), "Complete security check")]')
                    if not security_check:
                        print('[续期] ✅ Turnstile 已通过')
                        break
                except Exception:
                    print('[续期] ✅ Turnstile 已通过')
                    break

                # 尝试点击 Turnstile checkbox
                if i % 5 == 0:
                    try:
                        frames = driver.find_elements(
                            'xpath', '//iframe[contains(@src, "challenges.cloudflare.com")]')
                        if frames:
                            driver.switch_to.frame(frames[0])
                            checkboxes = driver.find_elements('xpath', '//input[@type="checkbox"]')
                            if checkboxes:
                                checkboxes[0].click()
                                print(f'[续期] 点击 Turnstile checkbox (第 {i//5 + 1} 次)')
                            driver.switch_to.default_content()
                    except Exception:
                        driver.switch_to.default_content()

                if time.time() - turnstile_start > 55:
                    print('[续期] ⚠️ Turnstile 超时')
                    break

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
            screenshot = f'screenshots/renew_result_{user_idx}.png'
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
                driver.save_screenshot(f'screenshots/error_{user_idx}.png')
                send_tg_message(f'❌ *处理异常*\n用户: {username}\n错误: {str(e)[:200]}',
                               f'screenshots/error_{user_idx}.png')
            except Exception:
                pass

        finally:
            print('[浏览器] 关闭...')
            try:
                driver.quit()
            except Exception:
                pass

    # 清理 v2ray
    cleanup_v2ray()
    print('完成。')


if __name__ == '__main__':
    main()