#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import re
import json
import time
import datetime
import urllib.request
import urllib.parse
import requests
import json as json_mod

# ---------- KV 工具 ----------
KV_ADMIN_URL = os.environ.get("KV_ADMIN_URL", "").strip()
KV_ADMIN_PASS = os.environ.get("KV_ADMIN_PASS", "").strip()

def kv_get(key):
    if not KV_ADMIN_URL or not KV_ADMIN_PASS:
        return None
    try:
        data = json.dumps({"key": key}).encode()
        req = urllib.request.Request(
            KV_ADMIN_URL + "/api/get",
            data=data,
            headers={
                "Content-Type": "application/json",
                "X-Admin-Pass": KV_ADMIN_PASS
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())
            if result.get("ok") and result.get("value") is not None:
                return result["value"]
    except Exception as e:
        print(f"[KV] 读取失败: {e}")
    return None

# 从 KV 获取 Discord Token
DISCORD_TOKEN_KV = kv_get("discord_token_darvinskaia_19972104@282820.xyz")
if DISCORD_TOKEN_KV:
    DISCORD_TOKEN = DISCORD_TOKEN_KV.strip()
    print("[KV] Discord Token 已从 KV 加载")
else:
    DISCORD_TOKEN = os.environ["DISCORD_TOKEN"].strip()
    print("[KV] 未从 KV 获取到 Token，使用环境变量")

# ============================================================
# 环境变量解析
# ============================================================



_tg        = os.environ.get("TG_BOT", "").split(",")
TG_CHAT_ID = _tg[0].strip() if len(_tg) > 0 else ""
TG_TOKEN   = _tg[1].strip() if len(_tg) > 1 else ""

DISCORD_API  = "https://discord.com/api/v9"
CLIENT_ID    = "972921155205877860"
REDIRECT_URI = "https://console.overnode.fr/auth/discord/callback"
GUILD_ID     = "1515897528011329657"
SITE_URL     = "https://console.overnode.fr"
UA           = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

SERVERS = [
    {"name": "FreeZero", "id": "6348f48a", "code": "Over-US 🇺🇸"},
    {"name": "FreeOne",  "id": "23e794e1", "code": "Over-FR 🇫🇷"},
]

# === AUTO-UPDATED ===
LAST_RENEWED_US = "2026-07-19 21:59:25"
LAST_RENEWED_FR = "2026-07-19 21:59:25"
# ===================


# ============================================================
# 工具函数
# ============================================================

def now_str():
    utc_now = datetime.datetime.utcnow()
    bj_now  = utc_now + datetime.timedelta(hours=8)
    return bj_now.strftime('%Y-%m-%d %H:%M:%S')

def log(msg):
    print(msg, flush=True)

def parse_dt(dt_str: str) -> datetime.datetime:
    dt_str = dt_str.replace("+00:00", "").replace("Z", "")
    if "." in dt_str:
        return datetime.datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S.%f")
    return datetime.datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S")

def fmt_remaining(total_sec: int) -> str:
    if total_sec <= 0:
        return "已过期"
    h = total_sec // 3600
    m = (total_sec % 3600) // 60
    return f"{h}h {m}m"

def send_tg(lines: list):
    if not TG_TOKEN or not TG_CHAT_ID:
        return
    msg  = "\n".join(lines)
    url  = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": TG_CHAT_ID, "text": msg}).encode()
    try:
        req = urllib.request.Request(url, data=data, method="POST")
        with urllib.request.urlopen(req, timeout=15):
            log("📨 TG 推送成功")
    except Exception as e:
        log(f"⚠️ TG 推送失败：{e}")


# ============================================================
# cron-job.org 写回调度
# ============================================================

def update_cronjob(target_utc: datetime.datetime):
    cron_env = os.environ.get("CRON_JOB", "").strip()
    if not cron_env or "," not in cron_env:
        log("⚠️ 未配置 CRON_JOB，跳过写回")
        return

    api_key, job_id = [x.strip() for x in cron_env.split(",", 1)]
    bj_time = target_utc + datetime.timedelta(hours=8)

    data = {
        "job": {
            "schedule": {
                "timezone":  "Asia/Shanghai",
                "expiresAt": 0,
                "hours":     [bj_time.hour],
                "minutes":   [bj_time.minute],
                "mdays":     [bj_time.day],
                "months":    [bj_time.month],
                "wdays":     [-1],
            }
        }
    }

    url     = f"https://api.cron-job.org/jobs/{job_id}"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = json.dumps(data).encode("utf-8")
    req     = urllib.request.Request(url, data=payload, headers=headers, method="PATCH")

    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=15):
                log(f"🔁 Cron 写回成功：下次触发 {bj_time.month:02d}月{bj_time.day:02d}日 {bj_time.hour:02d}:{bj_time.minute:02d}（北京时间）")
            return
        except Exception as e:
            log(f"⚠️ Cron 写回第{attempt+1}次失败：{e}")
            time.sleep(5)


def update_cronjob_delay(delay_minutes: int):
    target = datetime.datetime.utcnow() + datetime.timedelta(minutes=delay_minutes)
    update_cronjob(target)


# ============================================================
# 脚本自我重写
# ============================================================

def save_state(renewed_tags: list):
    if not renewed_tags:
        return
    try:
        with open(__file__, "r", encoding="utf-8") as f:
            content = f.read()

        new_content = content
        for tag in renewed_tags:
            pattern = rf'LAST_RENEWED_{tag} = ["\'].*?["\']'
            replacement = f'LAST_RENEWED_{tag} = "{now_str()}"'
            new_content = re.sub(pattern, replacement, new_content)

        with open(__file__, "w", encoding="utf-8") as f:
            f.write(new_content)

        log(f"💾 Auto-Updated：{', '.join('LAST_RENEWED_' + t for t in renewed_tags)}")
    except Exception as e:
        log(f"⚠️ Auto-Updated 失败：{e}")


# ============================================================
# 创建 requests Session
# ============================================================

def create_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "user-agent":      UA,
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    if os.environ.get("HTTP_PROXY") or os.environ.get("GOST_PROXY"):
        proxy = os.environ.get("HTTP_PROXY") or os.environ.get("GOST_PROXY")
        session.proxies.update({
            "http":  proxy,
            "https": proxy,
        })
    return session


# ============================================================
# Discord OAuth → connect.sid
# ============================================================

def login_via_discord(session: requests.Session):

    # ── 步骤1：访问 /auth/discord/login 拿服务端生成的 State ──
    log("🔗 开始获取 State...")
    resp = session.get(
        f"{SITE_URL}/auth/discord/login",
        headers={"accept": "text/html,*/*"},
        allow_redirects=False,
        timeout=20,
    )

    location = resp.headers.get("location", "")
    state = None

    if location and "discord.com" in location:
        parsed = urllib.parse.urlparse(location)
        qs     = urllib.parse.parse_qs(parsed.query)
        state  = qs.get("state", [None])[0]
        log("✅ 获取 State 成功")
    else:
        raise RuntimeError(f"❌ /auth/discord/login 未返回 Discord 重定向，location: '{location}'，status: {resp.status_code}")

    # ── 步骤2：用 Discord Token 授权，拿 Code ──
    redirect_uri_encoded = urllib.parse.quote(REDIRECT_URI, safe="")
    resp = session.post(
        f"{DISCORD_API}/oauth2/authorize"
        f"?client_id={CLIENT_ID}"
        f"&response_type=code"
        f"&redirect_uri={redirect_uri_encoded}"
        f"&scope=identify%20email%20guilds.join"
        f"&state={state}",
        json={
            "guild_id":         GUILD_ID,
            "permissions":      "0",
            "authorize":        True,
            "integration_type": 0,
            "location_context": {
                "guild_id":     "10000",
                "channel_id":   "10000",
                "channel_type": 10000,
            },
        },
        headers={
            "accept":        "*/*",
            "authorization": DISCORD_TOKEN,
            "content-type":  "application/json",
            "origin":        "https://discord.com",
            "referer": (
                f"https://discord.com/oauth2/authorize"
                f"?client_id={CLIENT_ID}"
                f"&redirect_uri={redirect_uri_encoded}"
                f"&response_type=code"
                f"&scope=identify+email+guilds.join"
                f"&state={state}"
            ),
        },
        timeout=20,
    )

    if resp.status_code == 401:
        raise RuntimeError("❌ Discord Token 无效或已过期")
    if resp.status_code == 429:
        raise RuntimeError("❌ Discord API 频率限制（Rate Limit）")
    if resp.status_code != 200:
        raise RuntimeError(f"❌ Discord OAuth 响应码: {resp.status_code}")

    location = resp.json().get("location", "")
    if not location:
        raise RuntimeError("❌ 无法从 OAuth 响应中提取 Redirect Location")

    code = urllib.parse.parse_qs(urllib.parse.urlparse(location).query).get("code", [None])[0]
    if not code:
        raise RuntimeError("❌ 无法从 Redirect URL 提取 Code")
    log("🎫 获取 OAuth Code 成功")

    # ── 步骤3：Callback → 获取 connect.sid ──
    log("🔄 Callback 换取 Session...")
    cb_resp = session.get(
        f"{REDIRECT_URI}?code={code}&state={state}",
        headers={
            "accept":  "text/html,application/xhtml+xml,*/*;q=0.8",
            "referer": "https://discord.com/",
        },
        allow_redirects=True,
        timeout=20,
    )

    sid = session.cookies.get("connect.sid")
    if not sid:
        all_cookies = {c.name: c.value for c in session.cookies}
        verify = session.get(f"{SITE_URL}/api/user", timeout=10)
        if verify.status_code == 200 and verify.json().get("username"):
            log("🍪 Connect.Sid 已获取")
            return
        raise RuntimeError(f"❌ 未获取到 connect.sid，最终 URL: {cb_resp.url}，Cookie: {list(all_cookies.keys())}")

    log("🍪 Connect.Sid 已获取")

    # 验证登录
    verify = session.get(f"{SITE_URL}/api/user", timeout=10)
    if verify.status_code != 200:
        raise RuntimeError(f"❌ 登录验证失败，/api/user 返回: {verify.status_code}")


# ============================================================
# 执行续期
# ============================================================

def do_renew(session: requests.Session, sid: str) -> dict:
    resp = session.post(
        f"{SITE_URL}/api/server/{sid}/renewal/renew",
        headers={
            "accept":  "application/json, text/plain, */*",
            "origin":  SITE_URL,
            "referer": f"{SITE_URL}/server/{sid}/overview",
        },
        timeout=20,
    )
    try:
        data = resp.json()
    except Exception:
        data = {"raw": resp.text[:300]}

    if resp.status_code not in (200, 400):
        raise RuntimeError(f"续期请求失败，状态码: {resp.status_code}，响应: {data}")

    return data


# ============================================================
# 主流程
# ============================================================

def run():
    server_names = " | ".join(s["code"] for s in SERVERS)
    log("=" * 50)
    log(f"🎮 Over-Renew 启动")
    log(f"🕐 运行时间: {now_str()}")
    log(f"🖥 服务器: {server_names}")
    log("=" * 50)

    session = create_session()

    # 验证出口 IP
    log("🌐 验证出口 IP...")
    try:
        ip_resp   = session.get("https://api.ipify.org/?format=json", timeout=10)
        ip        = ip_resp.json().get("ip", "")
        ip_masked = re.sub(r'(\d+\.\d+\.)\d+\.\d+', r'\g<1>**.**', ip)
        log(f"📍 出口 IP 确认：{ip_masked}")
    except Exception as e:
        log(f"⚠️ IP 验证失败：{e}")

    # Discord OAuth 登录
    log("🔑 Discord OAuth 登录...")
    try:
        login_via_discord(session)
    except Exception as e:
        log(f"❌ 登录失败：{e}")
        update_cronjob_delay(30)
        send_tg([
            "🎮 Over 续期通知",
            f"🕐 运行时间: {now_str()}",
            f"🖥 服务器: {server_names}",
            "❌ 登录失败，30分钟后重试",
            f"📝 {e}",
        ])
        return

    log("✅ Discord OAuth 登录完成")
    log("=" * 50)

    # ── 收集每台服务器的续期结果 ──
    srv_results = []   # {"code", "renewed", "remaining_str", "next_dt", "error"}

    for srv in SERVERS:
        code = srv["code"]
        sid  = srv["id"]
        tag  = "US" if "US" in code else "FR"
        log(f"── {code} ──")
        log("🔄 执行续期...")

        try:
            data    = do_renew(session, sid)
            renewal = data.get("renewalData", {})

            next_renewal_at = renewal.get("nextRenewalAt", "")
            renew_count     = renewal.get("renewalCount", 0)
            remaining_sec   = renewal.get("timeRemaining", {}).get("totalSeconds", 0)
            remaining_str   = fmt_remaining(remaining_sec)
            next_dt         = parse_dt(next_renewal_at) if next_renewal_at else None

            if data.get("message") == "Server renewed successfully":
                log(f"✅ 续期成功")
                log(f"📅 利用期限: {remaining_str}")
                if next_dt:
                    bj = next_dt + datetime.timedelta(hours=8)
                    log(f"🔁 下次续期: {bj.strftime('%m月%d日 %H:%M')}（北京时间）")
                srv_results.append({
                    "code": code, "tag": tag, "renewed": True,
                    "remaining_str": remaining_str, "next_dt": next_dt, "error": None,
                })
            else:
                log(f"⏳ 期限未至")
                log(f"📅 利用期限: {remaining_str}")
                if next_dt:
                    bj = next_dt + datetime.timedelta(hours=8)
                    log(f"🔁 下次续期: {bj.strftime('%m月%d日 %H:%M')}（北京时间）")
                srv_results.append({
                    "code": code, "tag": tag, "renewed": False,
                    "remaining_str": remaining_str, "next_dt": next_dt, "error": None,
                })

        except Exception as e:
            log(f"❌ 续期失败：{e}")
            srv_results.append({
                "code": code, "tag": tag, "renewed": False,
                "remaining_str": "N/A", "next_dt": None, "error": str(e),
            })

    # ── 写回 cron-job 逻辑 ──
    # 收集有效的 next_dt
    valid = [r for r in srv_results if r["next_dt"] is not None]

    if not valid:
        update_cronjob_delay(30)
    elif len(valid) == 1:
        earliest = valid[0]["next_dt"]
        if earliest <= datetime.datetime.utcnow():
            update_cronjob_delay(30)
        else:
            update_cronjob(earliest)
    else:
        # 按 next_dt 排序
        valid.sort(key=lambda r: r["next_dt"])
        first_dt  = valid[0]["next_dt"]
        second_dt = valid[1]["next_dt"]
        diff_sec  = (second_dt - first_dt).total_seconds()

        if diff_sec <= 300:
            # 两台相差 ≤5分钟，写回最早那台
            target = first_dt
        else:
            # 相差 >5分钟，写回第二台（先续完近的，然后等第二台）
            target = second_dt

        if target <= datetime.datetime.utcnow():
            update_cronjob_delay(30)
        else:
            update_cronjob(target)

    # ── 有续期成功则更新时间戳 ──
    renewed_tags = [r["tag"] for r in srv_results if r["renewed"]]
    if renewed_tags:
        save_state(renewed_tags)

    # ── TG 推送 ──
    remaining_parts = " | ".join(r["remaining_str"] for r in srv_results)
    result_parts    = []
    for r in srv_results:
        if r["error"]:
            result_parts.append("❌ 续期失败")
        elif r["renewed"]:
            result_parts.append("✅ 续期成功")
        else:
            result_parts.append("⌛️ 期限未至")

    send_tg([
        "🎮 Over 续期通知",
        f"🕐 运行时间: {now_str()}",
        f"🖥 服务器: {server_names}",
        f"📅 利用期限: {remaining_parts}",
        f"📊 续期结果: {' | '.join(result_parts)}",
    ])

    log("=" * 50)


if __name__ == "__main__":
    run()