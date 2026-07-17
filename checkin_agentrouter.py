#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Agent Router 每日登录签到脚本
该站点无独立的签到 API，每次成功登录即视为签到。
读取 AGENTROUTER_USERS_JSON 环境变量批量处理多组账户。
"""

import os, sys, time, json, requests
from urllib.parse import quote

# 全局 Telegram 配置
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN") or ""

BASE_URL = "https://agentrouter.org"
TURNSTILE_TOKEN = ""


def login(session: requests.Session, email: str, password: str):
    """登录并返回用户信息（id + username）。"""
    login_url = f"{BASE_URL}/api/user/login?turnstile={quote(TURNSTILE_TOKEN)}"

    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": BASE_URL,
        "Referer": f"{BASE_URL}/login",
    }

    resp = session.post(
        login_url,
        headers=headers,
        json={"username": email, "password": password},
        timeout=20,
    )

    if resp.status_code != 200:
        print(f"  ❌ 登录请求失败: {resp.status_code} (BASE_URL={BASE_URL})")
        return None

    data = resp.json()
    if not data.get("success"):
        print(f"  ❌ 登录失败: {data.get('message', '')} (BASE_URL={BASE_URL})")
        return None

    user_data = data.get("data", {})
    user_id = user_data.get("id")
    username = user_data.get("username", "")
    if not user_id:
        print("  ❌ 登录成功但未获取到用户 ID")
        return None

    print(f"  ✅ 登录成功 | 账户: {username} | ID: {user_id}")
    return {"id": user_id, "username": username}


def get_user_info(session: requests.Session, user_id):
    """获取用户信息，返回 data 字典。"""
    url = f"{BASE_URL}/api/user/self"
    headers = {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": BASE_URL,
        "New-Api-User": str(user_id),
    }
    resp = session.get(url, headers=headers, timeout=20)
    data = resp.json()
    if data.get("success"):
        return data.get("data", {})
    return None


def send_telegram(chat_id: str, message: str):
    """向指定 chat_id 发送 Telegram 消息。"""
    if not TG_BOT_TOKEN or not chat_id:
        return False
    try:
        tg_url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
        resp = requests.post(
            tg_url,
            json={"chat_id": chat_id, "text": message, "parse_mode": "HTML"},
            timeout=10,
        )
        if resp.status_code == 200:
            print(f"  📨 Telegram 通知已发送至 {chat_id}")
            return True
        else:
            print(f"  ⚠️ Telegram 发送失败: {resp.status_code}")
            return False
    except Exception as e:
        print(f"  ⚠️ Telegram 异常: {e}")
        return False


def process_user(email: str, password: str, tg_chat_id: str = "") -> dict:
    """处理单个用户的登录签到流程。"""
    result = {
        "email": email,
        "success": False,
        "username": "",
        "message": "",
    }

    session = requests.Session()

    user = login(session, email, password)
    if not user:
        result["message"] = "登录失败"
        return result

    result["username"] = user.get("username", str(user["id"]))
    user_id = user["id"]

    # 获取用户信息确认登录成功
    info = get_user_info(session, user_id)
    if info:
        quota = info.get("quota", 0)
        remaining = info.get("remaining_quota", 0) or quota
        result["message"] = f"登录成功，余额: ★{quota:,}"
        print(f"  ✅ 登录签到成功 | 余额: ★{quota:,}")
    else:
        result["message"] = "登录成功但获取用户信息失败"
        print(f"  ✅ 登录成功 | ID: {user_id}")

    result["success"] = True

    # 独立推送
    if tg_chat_id:
        local_time = time.gmtime(time.time() + 8 * 3600)
        now = time.strftime("%Y-%m-%d %H:%M:%S", local_time)
        sub_msg = (
            f"🎁 Agent Router 登录签到\n\n"
            f"✅ 登录成功\n"
            f"👤 账户: {result['username']} ({email})\n"
            f"ℹ️ {result['message']}\n"
            f"⏱️ 时间: {now}"
        )
        send_telegram(tg_chat_id, sub_msg)

    return result


def main():
    raw = os.environ.get("AGENTROUTER_USERS_JSON") or ""
    if not raw:
        print("❌ 请设置 AGENTROUTER_USERS_JSON 环境变量！")
        print("格式: [{\"email\":\"...\",\"password\":\"...\"}, ...]")
        sys.exit(1)

    try:
        users = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"❌ AGENTROUTER_USERS_JSON 格式错误: {e}")
        sys.exit(1)

    if not isinstance(users, list):
        print("❌ AGENTROUTER_USERS_JSON 必须是一个 JSON 数组！")
        sys.exit(1)

    print(f"📋 共 {len(users)} 个账户待登录签到\n" + "=" * 40)

    results = []
    for i, user_cfg in enumerate(users, 1):
        email = user_cfg.get("email", "")
        password = user_cfg.get("password", "")
        tg_chat_id = user_cfg.get("tg_chat_id", "")

        if not email or not password:
            print(f"[{i}/{len(users)}] ⏭️ 跳过: email 或 password 为空")
            continue

        print(f"\n[{i}/{len(users)}] 👤 {email}")
        result = process_user(email, password, tg_chat_id)
        results.append(result)

        if i < len(users):
            time.sleep(3)

    print("\n" + "=" * 40)
    print("📊 登录签到总结")

    success_count = sum(1 for r in results if r["success"])
    summary = (
        f"📊 Agent Router 登录签到汇总\n"
        f"👥 总账户: {len(results)}\n"
        f"✅ 成功: {success_count}\n"
    )
    print(summary)

    detail_lines = []
    for r in results:
        status = "✅" if r["success"] else "❌"
        detail_lines.append(f"{status} {r['email']} → {r['message']}")
    summary += "\n".join(detail_lines)

    global_tg_chat_id = os.environ.get("TG_CHAT_ID") or ""
    if global_tg_chat_id:
        send_telegram(global_tg_chat_id, summary)
    else:
        print("未配置 TG_CHAT_ID，跳过全局 Telegram 推送")


if __name__ == "__main__":
    main()