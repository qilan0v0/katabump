#!/usr/bin/env python3
"""TheRose Cloud (client.therose.cloud) Renewal Script - seleniumbase version"""
import os, sys, json, time, re, requests
from seleniumbase import SB

BASE_URL = "https://client.therose.cloud"
LOGIN_URL = BASE_URL + "/login"
SERVERS_URL = BASE_URL + "/panel?routeName=servers"

TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "")
PROJECT = os.environ.get("PROJECT_NAME", "TheRose")

KV_ADMIN_URL = os.environ.get("KV_ADMIN_URL", "")
KV_ADMIN_PASS = os.environ.get("KV_ADMIN_PASS", "")
KV_ENABLED = bool(KV_ADMIN_URL and KV_ADMIN_PASS)

def send_tg(msg):
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    text = "\U0001F4CC *" + PROJECT + "*\n" + msg
    try:
        r = requests.post(
            "https://api.telegram.org/bot" + TG_BOT_TOKEN + "/sendMessage",
            json={"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "Markdown"},
            timeout=10,
        )
        if r.status_code == 200:
            print("[TG] sent")
        else:
            print("[TG] fail:", r.text[:200])
            requests.post(
                "https://api.telegram.org/bot" + TG_BOT_TOKEN + "/sendMessage",
                json={"chat_id": TG_CHAT_ID, "text": text},
                timeout=10,
            )
    except Exception as e:
        print("[TG] error:", e)

def kv_get(key):
    if not KV_ENABLED:
        return None
    try:
        r = requests.post(
            KV_ADMIN_URL + "/api/get",
            json={"key": key},
            headers={"X-Admin-Pass": KV_ADMIN_PASS, "Content-Type": "application/json"},
            timeout=15,
        )
        if r.status_code == 200 and r.json().get("ok") and r.json().get("value") is not None:
            val = r.json()["value"]
            print("[KV] read ok, len:", len(str(val)))
            return str(val) if not isinstance(val, str) else val
        print("[KV] no cookie")
        return None
    except Exception as e:
        print("[KV] read fail:", e)
        return None


def kv_set(key, val):
    if not KV_ENABLED:
        return False
    try:
        r = requests.post(
            KV_ADMIN_URL + "/api/set",
            json={"key": key, "value": str(val)},
            headers={"X-Admin-Pass": KV_ADMIN_PASS, "Content-Type": "application/json"},
            timeout=15,
        )
        if r.status_code == 200:
            print("[KV] saved")
            return True
        return False
    except Exception as e:
        print("[KV] save fail:", e)
        return False

def login(sb, email, password):
    print("  >> Open login page...")
    sb.open(LOGIN_URL)
    sb.wait_for_ready_state_complete()
    sb.sleep(2)
    print("  >> Fill email...")
    sb.type("#login_form_email", email, timeout=10)
    print("  >> Fill password...")
    sb.type("#login_form_password", password, timeout=10)
    time.sleep(1)
    print("  >> Handle Turnstile...")
    try:
        sb.uc_gui_click_captcha()
        print("  >> Turnstile done")
    except Exception as e:
        print("  >> Turnstile error:", e)
    print("  >> Click Sign in...")
    sb.uc_click('button:contains("Sign in")')
    sb.sleep(3)
    for _ in range(30):
        cur = sb.get_current_url()
        if "/login" not in cur:
            print("  >> Login success:", cur)
            return True, cur
        time.sleep(1)
    print("  >> Login failed:", sb.get_current_url())
    sb.save_screenshot("login_failed.png")
    return False, sb.get_current_url()

def do_renew(sb):
    print("  >> Find Extend button...")
    selectors = [
        'span:contains("Extend")',
        'button:contains("Extend")',
        '[class*="extend"]',
        '[class*="Extend"]',
    ]
    found = False
    for sel in selectors:
        try:
            if sb.find_element(sel, timeout=2):
                print("  >> Found Extend:", sel)
                sb.uc_click(sel, timeout=5)
                print("  >> Clicked Extend")
                found = True
                break
        except:
            continue
    if not found:
        try:
            btn = sb.find_element('button:contains("Extend")', timeout=2)
            sb.driver.execute_script("arguments[0].click();", btn)
            print("  >> JS clicked Extend")
            found = True
        except Exception as e:
            print("  >> No Extend button:", e)
            return False, "No Extend button"
    time.sleep(1)
    print("  >> Find Order now...")
    try:
        btn = sb.find_element('button:contains("Order now")', timeout=5)
        if btn:
            sb.uc_click('button:contains("Order now")')
            print("  >> Clicked Order now")
    except:
        print("  >> No Order now, try alt renew buttons...")
        for sel in ['button:contains("Renew")', 'button:contains("renew")',
                     'button:contains("续期")', 'a:contains("Renew")']:
            try:
                if sb.find_element(sel, timeout=2):
                    sb.uc_click(sel, timeout=5)
                    print("  >> Clicked", sel)
                    break
            except:
                continue
    time.sleep(5)
    for sel in [".alert-success", "div[role=alert].alert-success",
                'span:contains("successfully purchased")']:
        try:
            el = sb.find_element(sel, timeout=2)
            if el:
                print("  >> Renew success:", el.text[:100])
                return True, el.text[:200]
        except:
            continue
    try:
        src = sb.get_page_source()
        if "successfully purchased" in src.lower():
            print("  >> Renew success (keyword)")
            return True, "Server renewed"
    except:
        pass
    return False, "No success message detected"

def main():
    print("=== TheRose Cloud Renew ===")
    users_json = os.environ.get("THEROSE_USERS_JSON", "")
    if not users_json:
        print("Missing THEROSE_USERS_JSON")
        sys.exit(1)
    try:
        users = json.loads(users_json)
        if not isinstance(users, list) or len(users) == 0:
            raise ValueError("empty")
    except Exception as e:
        print("Invalid THEROSE_USERS_JSON:", e)
        sys.exit(1)
    print("Total users:", len(users))
    for i, user in enumerate(users):
        email = user.get("email") or user.get("username") or user.get("user", "")
        password = user.get("password") or user.get("pass") or user.get("pwd", "")
        if not email or not password:
            print("User", i+1, "missing credentials, skip")
            continue
        print("\n=== User", i+1, "/", len(users), ":", email, "===")
        safe = re.sub(r"[^a-z0-9]", "_", email.lower())
        ck = "therose_cookie_" + safe
        with SB(uc=True, headless=True) as sb:
            logged_in = False
            saved = kv_get(ck)
            if saved:
                try:
                    cookies = json.loads(saved)
                    for c in cookies:
                        try:
                            sb.driver.add_cookie(c)
                        except:
                            pass
                    print("  >> Injected", len(cookies), "cookies")
                except Exception as e:
                    print("  >> Cookie parse error:", e)
                sb.open(SERVERS_URL)
                sb.sleep(3)
                logged_in = "/login" not in sb.get_current_url()
                print("  >> Cookie", "valid" if logged_in else "invalid",
                      "(", sb.get_current_url(), ")")
            if not logged_in:
                ok, url = login(sb, email, password)
                if not ok:
                    send_tg("Login failed\nUser: " + email)
                    continue
                if KV_ENABLED:
                    try:
                        cookies = sb.driver.get_cookies()
                        if cookies:
                            kv_set(ck, json.dumps(cookies))
                    except:
                        pass
            if "/panel" not in sb.get_current_url():
                sb.open(SERVERS_URL)
                sb.sleep(3)
            if "/login" in sb.get_current_url():
                print("  >> Cookie expired")
                send_tg("Cookie expired\nUser: " + email)
                continue
            ok, info = do_renew(sb)
            if ok:
                msg = "Renew success\nUser: " + email + "\n" + info[:100]
                print("  >>", msg)
                sb.save_screenshot("renew_ok.png")
            else:
                msg = "Renew incomplete\nUser: " + email + "\n" + info
                print("  >>", msg)
                sb.save_screenshot("renew_fail.png")
            send_tg(msg)
    print("\n=== All done ===")

if __name__ == "__main__":
    main()
