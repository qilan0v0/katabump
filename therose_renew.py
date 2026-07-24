#!/usr/bin/env python3
"""
TheRose Cloud - 自动续期 (基于用户参考脚本)
"""
import os, sys, json, time, subprocess, atexit, re
from seleniumbase import SB

USERS_JSON = os.environ.get("THEROSE_USERS_JSON", "[]")
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "")
TG_THREAD_ID = os.environ.get("TG_THREAD_ID", "")
PROJECT = os.environ.get("PROJECT_NAME", "TheRose")
HTTP_PROXY = os.environ.get("HTTP_PROXY", "")
BASE_URL = "https://client.therose.cloud"
KV_ADMIN_URL = os.environ.get("KV_ADMIN_URL", "")
KV_ADMIN_PASS = os.environ.get("KV_ADMIN_PASS", "")
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
    for i in range(5):
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

# ===== KV 存储 =====
def kv_get(key):
    if not KV_ADMIN_URL or not KV_ADMIN_PASS:
        return None
    try:
        import requests
        r = requests.post(KV_ADMIN_URL + "/api/get", json={"key": key},
            headers={"X-Admin-Pass": KV_ADMIN_PASS, "Content-Type": "application/json"}, timeout=10)
        if r.ok and r.json().get("ok") and r.json().get("value"):
            return r.json()["value"]
    except:
        pass
    return None

def kv_set(key, value):
    if not KV_ADMIN_URL or not KV_ADMIN_PASS:
        return
    try:
        import requests
        requests.post(KV_ADMIN_URL + "/api/set", json={"key": key, "value": str(value)},
            headers={"X-Admin-Pass": KV_ADMIN_PASS, "Content-Type": "application/json"}, timeout=10)
    except:
        pass

def cookies_to_str(cookies):
    return ";".join(f"{c['name']}={c['value']}" for c in cookies if c.get('name') and c.get('value'))

def str_to_cookies(s):
    if not s:
        return []
    result = []
    for p in s.split(";"):
        if "=" in p:
            n, v = p.split("=", 1)
            result.append({"name": n, "value": v, "domain": ".therose.cloud", "path": "/"})
    return result

def send_tg(msg, img=None):
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    import requests
    text = f"*{PROJECT}*\n{msg}"
    try:
        if img and os.path.exists(img):
            with open(img, "rb") as f:
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

# ===== 登录（基于用户参考脚本）=====
def login(sb, email, password):
    log("打开登录页...")
    sb.open(BASE_URL + "/login")
    sb.wait_for_ready_state_complete()
    sb.sleep(1)

    log("填写邮箱...")
    sb.type('#login_form_email', email, timeout=10)
    log("填写密码...")
    sb.type('#login_form_password', password, timeout=10)
    time.sleep(1)

    log("处理 Turnstile...")
    try:
        sb.uc_gui_click_captcha()
        log("Turnstile 已处理")
    except Exception as e:
        log(f"Turnstile 跳过: {e}")

    log("点击登录...")
    sb.uc_click('button:contains("Sign in")')
    sb.sleep(3)

    for _ in range(30):
        url = sb.get_current_url()
        log(f"URL: {url}")
        if "panel" in url:
            log("[OK] 登录成功")
            return True, url
        time.sleep(1)

    log("[FAIL] 登录失败")
    sb.save_screenshot("login_failed.png")
    return False, sb.get_current_url()

# ===== 续期（基于用户参考脚本）=====
def renew_servers(sb):
    log("开始续期流程...")

    # 点击 Extend 按钮
    selectors = [
        'span:contains("Extend")',
        'button:contains(title="Extend")',
    ]
    clicked = False
    for sel in selectors:
        try:
            if sb.find_element(sel, timeout=2):
                log(f"找到 Extend 按钮: {sel}")
                sb.uc_click(sel, timeout=5)
                log("点击成功")
                clicked = True
                break
        except:
            continue
    if not clicked:
        try:
            btn = sb.find_element('a[href*="cart_renew"]', timeout=2)
            sb.driver.execute_script("arguments[0].click();", btn)
            log("通过 JS 点击 Extend 成功")
            clicked = True
        except Exception as e:
            log(f"未找到 Extend 按钮: {e}")
            return ["未找到续期按钮"]

    time.sleep(2)

    # 点击 Order now 按钮
    try:
        button = sb.find_element('button:contains("Order now")', timeout=5)
        if button:
            log("点击 Order now...")
            sb.uc_click('button:contains("Order now")')
            log("已点击 Order now")
            time.sleep(3)
            # 检查续期是否成功
            page_source = sb.get_page_source()
            if "successfully purchased" in page_source.lower():
                log("[OK] 续期成功")
                return ["续期成功"]
            else:
                log("续期可能已提交")
                return ["已提交续期"]
        else:
            log("未找到 Order now 按钮")
            return ["无 Order now"]
    except Exception as e:
        log(f"点击 Order now 失败: {e}")
        return [f"续期失败: {e}"]

# ===== 主流程 =====
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

        cookie_key = "therose_cookie_" + re.sub(r'[^a-z0-9]', '_', email.lower())

        # 检查缓存 cookie
        cached = kv_get(cookie_key)
        if cached:
            log("使用缓存 cookie...")
            try:
                with SB(uc=True, headless=False) as sb:
                    for c in str_to_cookies(cached):
                        sb.driver.execute_cdp_cmd("Network.setCookie", c)
                    sb.open(BASE_URL + "/panel?routeName=servers")
                    sb.sleep(3)
                    text = sb.get_page_source()
                    if email in text:
                        log("缓存 cookie 有效，直接续期")
                        results = renew_servers(sb)
                        all_results.append(f"{email}: [OK] 续期: {', '.join(results)}")
                        continue
                    else:
                        log("缓存 cookie 已过期")
            except Exception as e:
                log(f"缓存 cookie 异常: {e}")

        # 设置代理
        proxy = HTTP_PROXY or None
        if v2:
            log("启动 v2ray...")
            v2proxy = start_v2ray(v2)
            if v2proxy:
                proxy = v2proxy
            else:
                log("v2ray 启动失败")

        try:
            with SB(uc=True, headless=False, proxy=proxy) as sb:
                ok, url = login(sb, email, password)
                if not ok:
                    log("重试登录...")
                    sb.sleep(2)
                    ok, url = login(sb, email, password)
                if ok:
                    # 保存 cookie
                    cookies = sb.driver.get_cookies()
                    therose = [c for c in cookies if c['name'] in ('PHPSESSID', 'REMEMBERME', 'cf_clearance')]
                    if therose:
                        kv_set(cookie_key, cookies_to_str(therose))
                    results = renew_servers(sb)
                    all_results.append(f"{email}: [OK] 登录成功 | 续期: {', '.join(results)}")
                else:
                    all_results.append(f"{email}: [FAIL] 登录失败")
                    all_results.append(f"提示: 手动登录后存 cookie 到 KV (key: {cookie_key})")
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