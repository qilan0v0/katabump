#!/usr/bin/env python3
"""
TheRose Cloud - 自动续期 (SeleniumBase uc 模式)
使用 seleniumbase 的 undetected 模式绕过 Cloudflare Turnstile
"""
import os, sys, json, time
from seleniumbase import SB

# ===== 环境变量 =====
USERS_JSON = os.environ.get("THEROSE_USERS_JSON", "[]")
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "")
TG_THREAD_ID = os.environ.get("TG_THREAD_ID", "")
PROJECT = os.environ.get("PROJECT_NAME", "TheRose")
HTTP_PROXY = os.environ.get("HTTP_PROXY", "")

BASE_URL = "https://client.therose.cloud"

def log(msg):
    t = time.strftime("%H:%M:%S")
    # 移除 emoji 避免 Windows GBK 编码问题
    clean = msg.replace('\u2705', '[OK]').replace('\u274c', '[FAIL]').replace('\u2757', '[!]')
    print(f"[{t}] {clean}", flush=True)

# ===== Telegram 通知 =====
def send_tg(message, image_path=None):
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    import requests
    text = f"*{PROJECT}*\n{message}"
    try:
        if image_path and os.path.exists(image_path):
            with open(image_path, "rb") as f:
                files = {"photo": f}
                data = {"chat_id": TG_CHAT_ID, "caption": text[:1000], "parse_mode": "Markdown"}
                if TG_THREAD_ID:
                    data["message_thread_id"] = int(TG_THREAD_ID)
                resp = requests.post(f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendPhoto",
                                     data=data, files=files, timeout=30)
                if resp.status_code != 200:
                    log(f"[TG] 图文发送失败: {resp.text[:200]}")
                else:
                    log("[TG] 图文消息已发送")
        else:
            data = {"chat_id": TG_CHAT_ID, "text": text[:3000], "parse_mode": "Markdown"}
            if TG_THREAD_ID:
                data["message_thread_id"] = int(TG_THREAD_ID)
            resp = requests.post(f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
                                 json=data, timeout=30)
            if resp.status_code == 200:
                log("[TG] 消息已发送")
            else:
                log(f"[TG] 发送失败: {resp.text[:200]}")
    except Exception as e:
        log(f"[TG] 异常: {e}")

# ===== 登录 =====
def login(sb, email, password):
    log("打开登录页...")
    sb.open(BASE_URL + "/login")
    sb.wait_for_ready_state_complete()
    sb.sleep(2)

    log("填写邮箱...")
    sb.type('#login_form_email', email, timeout=10)
    log("填写密码...")
    sb.type('#login_form_password', password, timeout=10)
    sb.sleep(1)

    log("处理 Turnstile...")
    try:
        sb.uc_gui_click_captcha()
        log("Turnstile 已处理")
    except Exception as e:
        log(f"Turnstile 跳过: {e}")
    sb.sleep(3)

    log("点击登录...")
    sb.uc_click('button:contains("Sign in")')
    sb.sleep(5)

    for i in range(30):
        url = sb.get_current_url()
        log(f"[{i}] URL: {url}")
        if "panel" in url:
            log("[OK] 登录成功！")
            return True, url
        time.sleep(1)

    log("[FAIL] 登录失败")
    sb.save_screenshot("login_failed.png")
    return False, sb.get_current_url()

# ===== 续期 =====
def renew_servers(sb):
    log("访问服务器列表...")
    sb.open(BASE_URL + "/panel?routeName=servers")
    sb.sleep(3)

    extend_links = sb.find_elements('a[href*="cart_renew"]')
    log(f"发现 {len(extend_links)} 个需要续期的服务器")

    if len(extend_links) == 0:
        log("没有需要续期的服务器")
        return ["无需续期"]

    results = []
    for link in extend_links:
        try:
            href = link.get_attribute("href")
            text = link.text.strip() or "Unknown"
            log(f"续期: {text}")

            # 点击 Extend 链接
            try:
                link.click()
            except:
                sb.driver.execute_script("arguments[0].click()", link)
            sb.sleep(2)

            try:
                order_btn = sb.find_element('button:contains("Order now")', timeout=5)
                if order_btn:
                    log("点击 Order now...")
                    sb.uc_click('button:contains("Order now")')
                    sb.sleep(3)
                    log(f"[OK] 服务器 {text} 续期成功")
                    results.append(f"{text}: 成功")
                else:
                    results.append(f"{text}: 已处理")
            except:
                results.append(f"{text}: 已处理")
        except Exception as e:
            log(f"续期失败: {e}")
            results.append(f"{text}: 失败")

    return results

# ===== 主流程 =====
def main():
    log("===== TheRose Cloud Auto Renew =====")

    try:
        users = json.loads(USERS_JSON)
    except:
        users = []
    if not users:
        log("未找到用户配置，请设置 THEROSE_USERS_JSON")
        sys.exit(1)
    log(f"共 {len(users)} 个用户")

    all_results = []
    error_screenshot = None

    for user in users:
        email = user.get("email", "")
        password = user.get("password", "")
        v2 = user.get("V2", "")
        if not email or not password:
            log("跳过：用户缺少 email 或 password")
            continue

        log(f"\n========== {email} ==========")

        proxy = HTTP_PROXY
        if v2:
            log("用户有独立 V2 节点")

        try:
            with SB(uc=True, headless2=False, browser="chrome", proxy=proxy if proxy else None) as sb:
                if proxy:
                    log(f"使用代理: {proxy}")
                ok, url = login(sb, email, password)
                if ok:
                    sb.save_screenshot("login_success.png")
                    results = renew_servers(sb)
                    all_results.append(f"{email}: [OK] 登录成功 | 续期: {', '.join(results)}")
                else:
                    all_results.append(f"{email}: [FAIL] 登录失败")
                    sb.save_screenshot("error.png")
                    error_screenshot = "error.png"
        except Exception as e:
            log(f"处理用户出错: {e}")
            all_results.append(f"{email}: [FAIL] 异常 - {e}")

    # 汇总
    log("\n===== 执行结果 =====")
    summary = "\n".join(all_results)
    print(summary, flush=True)
    send_tg(summary, error_screenshot)
    log("===== 执行完毕 =====")

if __name__ == "__main__":
    main()