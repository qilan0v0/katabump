#!/usr/bin/env python3
"""
TheRose Cloud (client.therose.cloud) 续期脚本
基于可执行参考脚本改造，支持多用户 JSON 配置
"""

import os, re, sys, time, json, requests
from seleniumbase import SB

# ==================== 配置 ====================
BASE_URL = "https://client.therose.cloud"
LOGIN_URL = BASE_URL + "/login"
SERVERS_URL = BASE_URL + "/panel?routeName=servers"

TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "")
PROJECT = os.environ.get("PROJECT_NAME", "TheRose")

KV_ADMIN_URL = os.environ.get("KV_ADMIN_URL", "")
KV_ADMIN_PASS = os.environ.get("KV_ADMIN_PASS", "")
KV_ENABLED = bool(KV_ADMIN_URL and KV_ADMIN_PASS)


# ==================== KV Cookie 缓存 ====================
def kv_get(key):
    if not KV_ENABLED:
        return None
    try:
        r = requests.post(KV_ADMIN_URL + "/api/get", json={"key": key},
            headers={"X-Admin-Pass": KV_ADMIN_PASS, "Content-Type": "application/json"}, timeout=15)
        if r.status_code == 200 and r.json().get("ok") and r.json().get("value") is not None:
            val = r.json()["value"]
            print("[KV] 读取成功，长度:", len(str(val)))
            return str(val) if not isinstance(val, str) else val
        print("[KV] 暂无已存 cookie")
        return None
    except Exception as e:
        print("[KV] 读取失败:", e)
        return None


def kv_set(key, val):
    if not KV_ENABLED:
        return False
    try:
        r = requests.post(KV_ADMIN_URL + "/api/set", json={"key": key, "value": str(val)},
            headers={"X-Admin-Pass": KV_ADMIN_PASS, "Content-Type": "application/json"}, timeout=15)
        if r.status_code == 200:
            print("[KV] cookie 已保存")
            return True
        return False
    except Exception as e:
        print("[KV] 写入失败:", e)
        return False


# ==================== Telegram 通知 ====================
def send_tg(msg):
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    text = f"\U0001F4CC *{PROJECT}*\n{msg}"
    try:
        r = requests.post(f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
            json={"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "Markdown"}, timeout=10)
        if r.status_code == 200:
            print("📨 Telegram 通知已发送")
        else:
            print(f"❌ Telegram 发送失败: {r.text[:200]}")
            requests.post(f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
                json={"chat_id": TG_CHAT_ID, "text": text}, timeout=10)
    except Exception as e:
        print(f"❌ Telegram 发送异常: {e}")


# ==================== 登录 ====================
def login(sb, email, password):
    print("🌐 打开登录页面...")
    sb.open(LOGIN_URL)
    sb.wait_for_ready_state_complete()
    sb.sleep(1)
    print("📧 填写邮箱...")
    sb.type('#login_form_email', email, timeout=10)
    print("🔑 填写密码...")
    sb.type('#login_form_password', password, timeout=10)
    time.sleep(1)

    # 处理 Turnstile - 策略: 尝试多种方法
    print("🛡 处理 Turnstile...")
    turnstile_ok = False

    # 方法1: uc_click_captcha (如果存在)
    try:
        if hasattr(sb, 'uc_click_captcha'):
            sb.uc_click_captcha()
            print("✅ uc_click_captcha 成功")
            turnstile_ok = True
    except Exception as e:
        print(f"⚠️ uc_click_captcha 失败: {e}")

    # 方法2: 用 JavaScript 执行 Turnstile
    if not turnstile_ok:
        try:
            token = sb.execute_script("""
                return new Promise(function(resolve) {
                    var inp = document.querySelector('input[name="cf-turnstile-response"]');
                    if (inp && inp.value && inp.value.length > 20) {
                        resolve(inp.value);
                        return;
                    }
                    if (typeof window.turnstile !== 'undefined' && window.turnstile.execute) {
                        var wid = inp && inp.id ? inp.id.replace('_response', '') : null;
                        window.turnstile.execute(wid, {
                            callback: function(t) { resolve(t); },
                            'error-callback': function() { resolve(null); }
                        });
                        setTimeout(function() { resolve(null); }, 15000);
                    } else {
                        resolve(null);
                    }
                });
            """)
            if token:
                print(f"✅ turnstile.execute() 获取到 token (长度 {len(token)})")
                turnstile_ok = True
            else:
                print("⚠️ turnstile.execute() 未获取到 token")
        except Exception as e:
            print(f"⚠️ turnstile.execute() 异常: {e}")

    # 方法3: iframe 内点击复选框
    if not turnstile_ok:
        try:
            for attempt in range(10):
                frames = sb.driver.find_elements("xpath", '//iframe[contains(@src, "challenges.cloudflare.com")]')
                if frames:
                    sb.driver.switch_to.frame(frames[0])
                    cbs = sb.driver.find_elements("xpath", '//input[@type="checkbox"]')
                    if cbs:
                        cbs[0].click()
                        print(f"✅ iframe 内点击复选框 (第 {attempt+1} 次)")
                        sb.driver.switch_to.default_content()
                        turnstile_ok = True
                        break
                    sb.driver.switch_to.default_content()
                time.sleep(1)
        except Exception as e2:
            print(f"⚠️ iframe 点击失败: {e2}")

    if not turnstile_ok:
        print("⚠️ 所有 Turnstile 处理方法均失败，尝试直接登录...")

    print("🔑 点击登录按钮...")
    sb.uc_click('button:contains("Sign in")')
    sb.sleep(3)
    for _ in range(30):
        cur = sb.get_current_url()
        if "panel" in cur or "login" not in cur:
            print(f"✅ 登录成功，已跳转到: {cur}")
            return True, cur
        time.sleep(1)
    print(f"❌ 登录失败，当前 URL: {sb.get_current_url()}")
    sb.save_screenshot("login_failed.png")
    return False, sb.get_current_url()
def click_extend_button(sb):
    selectors = [
        'span:contains("Extend")',
        'button:contains(title="Extend")',
    ]
    for sel in selectors:
        try:
            if sb.find_element(sel, timeout=2):
                print(f"✅ 找到按钮，选择器: {sel}")
                sb.uc_click(sel, timeout=5)
                print("✅ 点击成功")
                return True, {}
        except:
            continue
    try:
        btn = sb.find_element('button:contains("Extend")', timeout=2)
        sb.driver.execute_script("arguments[0].click();", btn)
        print("✅ 通过 JavaScript 点击成功")
        return True, {}
    except Exception as e:
        return False, {"error": str(e)}


def check_renewal_success(sb):
    success_selectors = [
        '.alert-success',
        '.alert.alert-success',
        'div[role="alert"].alert-success',
        'div.alert-success',
        'span:contains("successfully purchased")',
        'div:contains("successfully purchased")'
    ]
    print("⏳ 等待5秒检查续期结果...")
    time.sleep(5)
    for selector in success_selectors:
        try:
            element = sb.find_element(selector, timeout=2)
            if element:
                text = element.text
                print(f"✅ 发现成功提示！选择器: {selector}")
                print(f"📝 提示内容: {text}")
                return True, text
        except:
            continue
    try:
        page_source = sb.get_page_source()
        if "successfully purchased" in page_source.lower():
            print("✅ 页面源码中发现 'successfully purchased' 关键词")
            return True, "服务器已成功续期"
    except:
        pass
    return False, "未检测到续期成功提示"


# ==================== 主流程 ====================
def main():
    print("🚀 TheRose Cloud 续期脚本")

    # 读取用户配置
    users_json = os.environ.get("THEROSE_USERS_JSON", "")
    if not users_json:
        print("❌ 请设置环境变量 THEROSE_USERS_JSON")
        sys.exit(1)
    try:
        users = json.loads(users_json)
        if not isinstance(users, list) or len(users) == 0:
            raise ValueError("空数组")
    except Exception as e:
        print(f"❌ THEROSE_USERS_JSON 格式无效: {e}")
        sys.exit(1)
    print(f"共 {len(users)} 个用户")

    for i, user in enumerate(users):
        email = user.get("email") or user.get("username") or user.get("user", "")
        password = user.get("password") or user.get("pass") or user.get("pwd", "")
        if not email or not password:
            print(f"❌ 用户 {i+1} 缺少 email 或 password，跳过")
            continue

        print(f"\n=== 正在处理用户 {i+1}/{len(users)}: {email} ===")

        safe_user = re.sub(r'[^a-z0-9]', '_', email.lower())
        cookie_key = f"therose_cookie_{safe_user}"

        with SB(uc=True, headless=True) as sb:
            logged_in = False

            # 尝试 KV cookie 免登录
            saved = kv_get(cookie_key)
            if saved:
                try:
                    cookies = json.loads(saved)
                    for c in cookies:
                        try:
                            sb.driver.add_cookie(c)
                        except:
                            pass
                    print(f"✅ 已注入 {len(cookies)} 条 cookie")
                except Exception as e:
                    print(f"⚠️ cookie 解析失败: {e}")
                sb.open(SERVERS_URL)
                sb.sleep(3)
                logged_in = "/login" not in sb.get_current_url()
                print(f"  >> cookie {'有效' if logged_in else '无效'} ({sb.get_current_url()})")

            # 完整登录
            if not logged_in:
                ok, url = login(sb, email, password)
                if not ok:
                    send_tg(f"❌ 登录失败\n用户: {email}")
                    continue
                logged_in = True
                # 保存 cookie
                if KV_ENABLED:
                    try:
                        cookies = sb.driver.get_cookies()
           
                        if cookies:
                            kv_set(cookie_key, json.dumps(cookies))
                    except Exception as e:
                        print(f"⚠️ 保存 cookie 失败: {e}")

            # 确保在服务器面板
            if "/panel" not in sb.get_current_url():
                sb.open(SERVERS_URL)
                sb.sleep(3)
            if "/login" in sb.get_current_url():
                print("❌ cookie 失效，无法访问面板")
                send_tg(f"❌ Cookie 失效\n用户: {email}")
                continue

            # 执行续期
            print("📄 开始续期流程...")
            ok, info = click_extend_button(sb)
            if not ok:
                msg = f"❌ 点击 Extend 按钮失败: {info.get('error')}"
                print(msg)
                send_tg(f"❌ 续期失败\n用户: {email}\n原因: {info.get('error')}")
                continue

            time.sleep(1)

            # 点击 Order now
            try:
                button = sb.find_element('button:contains("Order now")', timeout=5)
                if button:
                    print("🛒 点击 Order now 按钮...")
                    sb.uc_click('button:contains("Order now")')
                    print("✅ 已点击 Order now 按钮")
                else:
                    msg = "❌ 未找到 Order now 按钮"
                    print(msg)
                    send_tg(f"❌ 续期失败\n用户: {email}\n原因: 未找到 Order now 按钮")
                    continue
            except Exception as e:
                msg = f"❌ 点击 Order now 失败: {e}"
                print(msg)
                send_tg(f"❌ 续期失败\n用户: {email}\n原因: {e}")
                continue

            # 检查续期结果
            print("🔍 检查续期结果...")
            renewal_success, renewal_msg = check_renewal_success(sb)

            if renewal_success:
                msg = f"✅ 续期成功！{renewal_msg}"
                print(msg)
                sb.save_screenshot("renewal_success.png")
            else:
                msg = f"❌ 续期可能失败: {renewal_msg}"
                print(msg)
                sb.save_screenshot("renewal_failed.png")

            send_tg(f"{'✅' if renewal_success else '❌'} 续期{'成功' if renewal_success else '失败'}\n用户: {email}\n{renewal_msg}")

    print("🏁 脚本执行完毕")


if __name__ == "__main__":
    main()
