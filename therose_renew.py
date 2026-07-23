#!/usr/bin/env python3
"""
TheRose Cloud - 自动续期 (SeleniumBase uc 模式 + 根 URL 优先 + 独立 V2 节点)
"""
import os, sys, json, time, subprocess, signal, atexit
from seleniumbase import SB

USERS_JSON = os.environ.get("THEROSE_USERS_JSON", "[]")
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "")
TG_THREAD_ID = os.environ.get("TG_THREAD_ID", "")
PROJECT = os.environ.get("PROJECT_NAME", "TheRose")
HTTP_PROXY = os.environ.get("HTTP_PROXY", "")
BASE_URL = "https://client.therose.cloud"
V2RAY_BIN = os.environ.get("V2RAY_BIN", os.path.expanduser("~/v2ray/v2ray"))

# v2ray 进程管理
v2ray_procs = []
next_port = 10810

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def cleanup_v2ray():
    for proc, port, cfg in v2ray_procs:
        try:
            proc.kill()
            proc.wait(timeout=3)
        except:
            pass
        try:
            os.unlink(cfg)
        except:
            pass
    v2ray_procs.clear()

atexit.register(cleanup_v2ray)

def start_v2ray(v2_link):
    global next_port
    port = next_port
    next_port += 1
    cfg_path = f"v2ray-therose-{port}.json"

    # 调用 Node.js 脚本生成配置
    result = subprocess.run(
        ["node", ".github/scripts/gen-v2ray-config.js", v2_link, str(port), cfg_path],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode != 0:
        log(f"[v2ray] 配置生成失败: {result.stderr}")
        return None

    log(f"[v2ray] 启动实例 (HTTP 127.0.0.1:{port})...")
    proc = subprocess.Popen(
        [V2RAY_BIN, "run", "-config", cfg_path],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
    )
    v2ray_procs.append((proc, port, cfg_path))

    # 等待就绪
    for i in range(15):
        if proc.poll() is not None:
            err = proc.stderr.read().decode() if proc.stderr else ""
            log(f"[v2ray] 进程异常退出: {err[:200]}")
            return None
        try:
            import urllib.request
            urllib.request.urlopen(f"http://127.0.0.1:{port}", timeout=2)
            log(f"[v2ray] 代理就绪 -> http://127.0.0.1:{port}")
            return f"http://127.0.0.1:{port}"
        except:
            time.sleep(2)
    log(f"[v2ray] 启动失败")
    return None

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
                requests.post(f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendPhoto", data=data, files=files, timeout=30)
        else:
            data = {"chat_id": TG_CHAT_ID, "text": text[:3000], "parse_mode": "Markdown"}
            if TG_THREAD_ID:
                data["message_thread_id"] = int(TG_THREAD_ID)
            requests.post(f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage", json=data, timeout=30)
        log("[TG] 已发送")
    except:
        pass

def login(sb, email, password):
    log("访问根 URL 触发 CF 挑战...")
    sb.open(BASE_URL)
    sb.wait_for_ready_state_complete()
    sb.sleep(3)

    if "/login" not in sb.get_current_url():
        log("手动导航到 /login...")
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
        if "panel" in url:
            log("[OK] 登录成功")
            return True, url
        time.sleep(1)

    log("[FAIL] 登录失败")
    sb.save_screenshot("login_failed.png")
    return False, sb.get_current_url()

def renew_servers(sb):
    log("访问服务器列表...")
    sb.open(BASE_URL + "/panel?routeName=servers")
    sb.sleep(3)

    links = sb.find_elements('a[href*="cart_renew"]')
    log(f"发现 {len(links)} 个服务器")

    if len(links) == 0:
        return ["无需续期"]

    results = []
    for link in links:
        try:
            href = link.get_attribute("href")
            text = link.text.strip() or "Unknown"
            log(f"续期: {text}")
            sb.open(href)
            sb.sleep(2)
            try:
                btn = sb.find_element('button:contains("Order now")', timeout=5)
                if btn:
                    log("点击 Order now...")
                    sb.uc_click('button:contains("Order now")')
                    sb.sleep(3)
                    log(f"[OK] {text} 续期成功")
                    results.append(f"{text}: 成功")
                else:
                    results.append(f"{text}: 已处理")
            except:
                results.append(f"{text}: 已处理")
        except Exception as e:
            log(f"续期失败: {e}")
            results.append(f"{text}: 失败")
    return results

def main():
    log("===== TheRose Cloud Auto Renew =====")

    try:
        users = json.loads(USERS_JSON)
    except:
        users = []
    if not users:
        log("请设置 THEROSE_USERS_JSON")
        sys.exit(1)

    all_results = []
    err_screenshot = None

    for user in users:
        email = user.get("email", "")
        password = user.get("password", "")
        v2 = user.get("V2", "")
        if not email or not password:
            continue

        log(f"\n========== {email} ==========")

        # 解析代理：优先用户 V2 节点，其次全局 HTTP_PROXY
        proxy = HTTP_PROXY or None
        if v2:
            log("用户有独立 V2 节点，启动 v2ray...")
            v2proxy = start_v2ray(v2)
            if v2proxy:
                proxy = v2proxy
            else:
                log("[v2ray] 启动失败，回退到全局代理")

        try:
            with SB(uc=True, headless=False, browser="chrome", proxy=proxy) as sb:
                if proxy:
                    log(f"使用代理: {proxy}")
                ok, url = login(sb, email, password)
                if not ok:
                    log("重试登录...")
                    sb.sleep(2)
                    ok, url = login(sb, email, password)
                if ok:
                    results = renew_servers(sb)
                    all_results.append(f"{email}: [OK] 登录成功 | 续期: {', '.join(results)}")
                else:
                    all_results.append(f"{email}: [FAIL] 登录失败")
                    sb.save_screenshot("error.png")
                    err_screenshot = "error.png"
        except Exception as e:
            log(f"异常: {e}")
            all_results.append(f"{email}: [FAIL] 异常 - {e}")

    cleanup_v2ray()
    log("\n===== 结果 =====")
    summary = "\n".join(all_results)
    print(summary, flush=True)
    send_tg(summary, err_screenshot)
    log("===== 完毕 =====")

if __name__ == "__main__":
    main()