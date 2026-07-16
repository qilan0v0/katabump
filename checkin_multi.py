#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多账户批量签到续期脚本
从 CHECKIN_USERS_JSON 或 hcnsec_USERS_JSON 环境变量读取多组账户信息，
逐个登录并执行签到，汇总结果后推送 Telegram 通知。
支持通过 BASE_URL 环境变量切换目标站点（默认 api.hcnsec.cn）。
"""

import os, sys, time, json, requests
from datetime import datetime
from urllib.parse import quote

# 全局 Telegram 配置（可选，用于统一推送）
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN") or ""

# 站点配置（可通过环境变量覆盖）
BASE_URL = os.environ.get("BASE_URL") or "https://api.hcnsec.cn"
QUOTA_PER_UNIT = int(os.environ.get("QUOTA_PER_UNIT") or "500000")
TURNSTILE_TOKEN = ""


def login(session: requests.Session, email: str, password: str):
    """登录并返回用户信息（id + username）。"""
    login_url = f"{BASE_URL}/api/user/login?turnstile={quote(TURNSTILE_TOKEN)}"

    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
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
        print(f"  ❌ 登录请求失败: {resp.status_code}")
        return None

    data = resp.json()
    if not data.get("success"):
        print(f"  ❌ 登录失败: {data.get('message', '')}")
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
    """获取用户信息，返回 data 字典（包含 quota 等字段）。"""
    url = f"{BASE_URL}/api/user/self"
    headers = {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0",
        "Referer": BASE_URL,
        "New-Api-User": str(user_id),
    }
    resp = session.get(url, headers=headers, timeout=20)
    data = resp.json()
    if data.get("success"):
        return data.get("data", {})
    return None


def checkin(session: requests.Session, user_id):
    """执行签到，返回签到响应的完整 JSON。"""
    url = f"{BASE_URL}/api/user/checkin"
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Origin": BASE_URL,
        "Referer": BASE_URL,
        "New-Api-User": str(user_id),
    }
    resp = session.post(url, headers=headers, json={}, timeout=20)
    return resp.json()


def quota_to_dollar(quota):
    """将内部 quota 值转换为美元金额（整数）。"""
    return round(quota / QUOTA_PER_UNIT)


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
    """
    处理单个用户的签到流程。
    返回结果字典。
    """
    result = {
        "email": email,
        "success": False,
        "username": "",
        "awarded_dollar": 0,
        "balance_before": 0,
        "balance_after": 0,
        "message": "",
        "already_checked": False,
    }

    session = requests.Session()

    user = login(session, email, password)
    if not user:
        result["message"] = "登录失败"
        return result

    result["username"] = user.get("username", str(user["id"]))
    user_id = user["id"]

    # 签到前余额
    info_before = get_user_info(session, user_id)
    balance_before = quota_to_dollar(info_before.get("quota", 0)) if info_before else 0
    result["balance_before"] = balance_before

    # 签到
    checkin_data = checkin(session, user_id)

    # 签到后余额
    info_after = get_user_info(session, user_id)
    balance_after = quota_to_dollar(info_after.get("quota", 0)) if info_after else 0
    result["balance_after"] = balance_after

    success = checkin_data.get("success", False)
    msg = str(checkin_data.get("message", ""))

    if success:
        awarded_data = checkin_data.get("data", {})
        awarded_quota = awarded_data.get("quota_awarded", 0)
        awarded_dollar = quota_to_dollar(awarded_quota) if awarded_quota else (balance_after - balance_before)
        result["success"] = True
        result["awarded_dollar"] = awarded_dollar
        result["message"] = f"签到成功，获得 {awarded_dollar}$"
        print(f"  ✅ 签到成功 | 获得: {awarded_dollar}$ | 余额: {balance_before}$ → {balance_after}$")
    elif "已签到" in msg or "重复签到" in msg or "今天已签到" in msg:
        result["success"] = True
        result["already_checked"] = True
        result["message"] = f"今日已签到，当前余额 {balance_after}$"
        print(f"  ✅ 今日已签到 | 余额: {balance_after}$")
    else:
        result["message"] = f"签到失败: {msg}"
        print(f"  ❌ 签到失败 | {msg}")

    # 如果该账户有独立 tg_chat_id，单独推送
    if tg_chat_id:
        local_time = time.gmtime(time.time() + 8 * 3600)
        now = time.strftime("%Y-%m-%d %H:%M:%S", local_time)
        if result["success"]:
            status = "✅ 今日已签到" if result["already_checked"] else "✅ 签到成功"
            sub_msg = (
                f"🎁 续期签到通知\n\n"
                f"{status}\n"
                f"👤 账户: {result['username']} ({email})\n"
                f"💰 获得: {result['awarded_dollar']}$\n"
                f"💰 余额: {result['balance_before']}$ → {result['balance_after']}$\n"
                f"⏱️ 时间: {now}"
            )
        else:
            sub_msg = (
                f"🎁 续期签到通知\n\n"
                f"❌ 签到失败: {result['message']}\n"
                f"👤 账户: {email}\n"
                f"⏱️ 时间: {now}"
            )
        send_telegram(tg_chat_id, sub_msg)

    return result


def main():
    raw = os.environ.get("CHECKIN_USERS_JSON") or os.environ.get("hcnsec_USERS_JSON") or ""
    if not raw:
        print("❌ 请设置 CHECKIN_USERS_JSON 或 hcnsec_USERS_JSON 环境变量！")
        print("格式: [{\"email\":\"...\",\"password\":\"...\"}, ...]")
        print("可选字段: \"tg_chat_id\":\"...\" (每个账户独立推送)")
        sys.exit(1)

    try:
        users = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"❌ {os.environ.get('CHECKIN_USERS_JSON') and 'CHECKIN_USERS_JSON' or 'hcnsec_USERS_JSON'} 格式错误: {e}")
        sys.exit(1)

    if not isinstance(users, list):
        print("❌ CHECKIN_USERS_JSON / hcnsec_USERS_JSON 必须是一个 JSON 数组！")
        sys.exit(1)

    print(f"📋 共 {len(users)} 个账户待签到\n" + "=" * 40)

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

        # 账户间短暂停顿，避免触发风控
        if i < len(users):
            time.sleep(3)

    print("\n" + "=" * 40)
    print("📊 签到总结")

    success_count = sum(1 for r in results if r["success"])
    total_awarded = sum(r["awarded_dollar"] for r in results if r["success"] and not r["already_checked"])
    already_count = sum(1 for r in results if r["already_checked"])

    summary = (
        f"📊 续期签到汇总\n"
        f"👥 总账户: {len(results)}\n"
        f"✅ 成功: {success_count} (含已签到 {already_count})\n"
        f"🎁 本次获得: {total_awarded}$\n"
    )
    print(summary)

    # 详情
    detail_lines = []
    for r in results:
        status = "✅" if r["success"] else "❌"
        if r.get("already_checked"):
            status = "⏭️"
        detail_lines.append(f"{status} {r['email']} → {r['message']}")

    summary += "\n".join(detail_lines)

    # 全局 Telegram 推送
    global_tg_chat_id = os.environ.get("TG_CHAT_ID") or ""
    if global_tg_chat_id:
        send_telegram(global_tg_chat_id, summary)
    else:
        print("未配置 TG_CHAT_ID，跳过全局 Telegram 推送")
        print("（每个账户可在 CHECKIN_USERS_JSON 中设置独立 tg_chat_id）")


if __name__ == "__main__":
    main()