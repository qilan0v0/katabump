#!/usr/bin/env python3
"""
TheRose Cloud - 自动续期 (SeleniumBase uc 模式 + KV cookie 缓存)
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

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

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

def login(sb, email, password):
    log("访问根 URL 触发 CF 挑战...")
    sb.open(BASE_URL)
    sb.wait_for_ready_state_complete()
    sb.sleep(3)

    cookies = sb.driver.get_cookies()
    cf_cookie = [c for c in cookies if c['name'] == 'cf_clearance']
    log(f"cf_clearance: {'已设置' if cf_cookie else '未设置'}")

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
        log("uc_gui_click_captcha 已执行")
    except Exception as e:
        log(f"uc_gui_click_captcha 跳过: {e}")

    ts_state = sb.execute_script("var el=document.querySelector('input[name=\"cf-turnstile-response\"]');var frame=document.querySelector('.cf-turnstile iframe');var ts=typeof turnstile;JSON.stringify({token:el?el.value:'',hasFrame:!!frame,turnstileType:ts})")
    log(f"Turnstile 状态: {ts_state}")

    token = sb.execute_script("var el=document.querySelector('input[name=\"cf-turnstile-response\"]'); el ? el.value : ''")

    if not token or len(token) < 10:
        log("Token 未生成，尝试 turnstile.execute()...")
        sb.execute_script("if(typeof turnstile!=='undefined'){turnstile.execute()}")
        sb.sleep(3)
        token = sb.execute_script("var el=document.querySelector('input[name=\"cf-turnstile-response\"]'); el ? el.value : ''")

    if not token or len(token) < 10:
        log("execute() 失败，尝试 turnstile.render() + 轮询...")
        sb.execute_script("var c=document.querySelector('.cf-turnstile');if(c&&typeof turnstile!=='undefined'){try{turnstile.remove()}catch(e){}turnstile.render(c,{sitekey:'0x4AAAAAADT5H9rlFdzDFH6e'})}")
        for i in range(10):
            sb.sleep(1)
            token = sb.execute_script("var el=document.querySelector('input[name=\"cf-turnstile-response\"]'); el ? el.value : ''")
            if token and len(token) > 10:
                log(f"render() 轮询成功 ({i+1}s)")
                break
        if not token or len(token) < 10:
            log("render() 轮询超时")
    sb.sleep(2)

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
        if not email or not password:
            continue

        log(f"\n========== {email} ==========")

        cookie_key = "therose_cookie_" + re.sub(r'[^a-z0-9]', '_', email.lower())
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
                        log("缓存 cookie 已过期，重新登录")
            except Exception as e:
                log(f"缓存 cookie 异常: {e}，重新登录")

        try:
            with SB(uc=True, headless=False) as sb:
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
                    all_results.append(f"提示: 请先在本地浏览器手动登录 {BASE_URL}/login")
                    all_results.append(f"然后将 cookie 存入 KV (key: {cookie_key})")
                    sb.save_screenshot("error.png")
                    err_screenshot = "error.png"
        except Exception as e:
            log(f"异常: {e}")
            all_results.append(f"{email}: [FAIL] 异常 - {e}")

    log("\n===== 结果 =====")
    summary = "\n".join(all_results)
    print(summary, flush=True)
    send_tg(summary, err_screenshot)
    log("===== 完毕 =====")

if __name__ == "__main__":
    main()