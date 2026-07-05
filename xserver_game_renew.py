#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
XServer Game 免费服务器自动续期 — 多账号版
支持 XSERVER_USERS_JSON 多账号配置，每账号可独立指定 V2 代理

XSERVER_USERS_JSON 格式:
[{"username":"...","password":"...","serverUrl":"https://secure.xserver.ne.jp/...","V2":"vless://..."}]
  - V2 字段可选：有此字段则用此代理续期该账号；无此字段则用全局代理；全局代理也无则直连
  - serverUrl 字段当前仅作记录/标识，续期逻辑自动从登录账号解析跳转
"""

import os
import re
import json
import sys
import time
import subprocess
import tempfile
import atexit
import signal
import socket
import base64
from datetime import datetime
from urllib.parse import urlparse, parse_qs

import requests

# ===== 读取多账号配置 =====
USERS_JSON_RAW = os.environ.get("XSERVER_USERS_JSON", "")
if not USERS_JSON_RAW:
    print("❌ 请设置环境变量 / GitHub Secret: XSERVER_USERS_JSON")
    print("   格式: [{\"username\":\"...\",\"password\":\"...\",\"serverUrl\":\"...\",\"V2\":\"vless://...\"}]")
    sys.exit(1)

try:
    ALL_USERS = json.loads(USERS_JSON_RAW)
    if not isinstance(ALL_USERS, list) or len(ALL_USERS) == 0:
        raise ValueError("必须是非空 JSON 数组")
except Exception as e:
    print(f"❌ XSERVER_USERS_JSON 解析失败: {e}")
    sys.exit(1)

# ===== 全局常量 =====
BASE_URL = "https://secure.xserver.ne.jp"
LOGIN_PAGE = f"{BASE_URL}/xapanel/login/xserver/?request_page=xserver%2Findex"
LOGIN_URL = f"{BASE_URL}/xapanel/myaccount/login"
XMGAME_INDEX_URL = f"{BASE_URL}/xapanel/xmgame/index"
ONETIMELOGIN_URL = f"{BASE_URL}/xmgame/onetimelogin"
INFO_URL = f"{BASE_URL}/xmgame/game/index"
EXTEND_URL = f"{BASE_URL}/xmgame/game/freeplan/extend/index"
RENEW_URL = f"{BASE_URL}/xmgame/game/freeplan/extend/input"
CONF_URL = f"{BASE_URL}/xmgame/game/freeplan/extend/conf"
DO_URL = f"{BASE_URL}/xmgame/game/freeplan/extend/do"

RENEW_THRESHOLD_HOURS = 16

# 全局代理（由 workflow 启动的 v2ray HTTP 代理，或用户设置的 HTTP_PROXY）
GLOBAL_HTTP_PROXY = os.environ.get("HTTP_PROXY", "")

# TG 通知
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "")

# v2ray 二进制路径（从 workflow 传递，用于为每个账号启动独立 v2ray 代理）
V2RAY_BIN = os.environ.get("V2RAY_BIN", "")

BASE_HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
}

SCRIPT_NAME = os.path.basename(__file__)
_start_time = time.time()

# 管理所有启动的 v2ray 子进程
_v2ray_processes = []
_v2ray_config_paths = []


def log(msg):
    print(msg, flush=True)


def divider(label):
    width = 60
    inner = f" {{{label}}} "
    pad_total = width - len(inner)
    pad_l = pad_total // 2
    pad_r = pad_total - pad_l
    log("=" * pad_l + inner + "=" * pad_r)


def elapsed():
    return f"{time.time() - _start_time:.2f}s"


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ===== v2ray config 生成（Python 版，无需 Node.js）=====

def build_v2ray_config(v2_link: str, http_port: int) -> dict:
    """从 vless:// 或 vmess:// 链接生成 v2ray HTTP 入站配置"""
    link = v2_link.strip()
    if link.startswith("vmess://"):
        return _build_vmess_config(link, http_port)
    elif link.startswith("vless://"):
        return _build_vless_config(link, http_port)
    else:
        raise ValueError(f"不支持的 V2 链接类型 ({link[:20]}...)，仅支持 vmess:// 或 vless://")


def _b64decode(s):
    s = s.replace("-", "+").replace("_", "/")
    while len(s) % 4:
        s += "="
    return base64.b64decode(s).decode("utf-8")


def _build_vmess_config(link: str, http_port: int) -> dict:
    raw = link[len("vmess://"):]
    conf = json.loads(_b64decode(raw))
    tls = conf.get("tls") == "tls" or conf.get("tls") is True
    net = conf.get("net", "tcp")
    stream = {"network": net, "security": "tls" if tls else "none"}
    if tls:
        stream["tlsSettings"] = {
            "serverName": conf.get("sni") or conf.get("host") or conf.get("add"),
            "allowInsecure": False,
        }
    if net == "ws":
        stream["wsSettings"] = {
            "path": conf.get("path", "/"),
            "headers": {"Host": conf["host"]} if conf.get("host") else {},
        }
    elif net == "grpc":
        stream["grpcSettings"] = {"serviceName": conf.get("path", "")}
    outbound = {
        "protocol": "vmess",
        "settings": {
            "vnext": [
                {
                    "address": conf["add"],
                    "port": int(conf["port"]),
                    "users": [
                        {
                            "id": conf["id"],
                            "alterId": int(conf.get("aid", "0")),
                            "security": conf.get("scy", "auto"),
                        }
                    ],
                }
            ]
        },
        "streamSettings": stream,
    }
    return _make_config(outbound, http_port)


def _build_vless_config(link: str, http_port: int) -> dict:
    u = urlparse(link)
    q = parse_qs(u.query)
    net = q.get("type", ["tcp"])[0]
    security = q.get("security", ["none"])[0]
    stream = {"network": net, "security": security}
    if security in ("tls", "reality"):
        sni = q.get("sni", [u.hostname])[0]
        if security == "reality":
            stream["realitySettings"] = {
                "serverName": sni,
                "publicKey": q.get("pbk", [""])[0],
                "shortId": q.get("sid", [""])[0],
                "fingerprint": q.get("fp", ["chrome"])[0],
            }
        else:
            stream["tlsSettings"] = {"serverName": sni, "allowInsecure": False}
    if net == "ws":
        stream["wsSettings"] = {
            "path": q.get("path", ["/"])[0],
            "headers": {"Host": q.get("host", [""])[0]} if q.get("host") else {},
        }
    elif net == "grpc":
        stream["grpcSettings"] = {"serviceName": q.get("serviceName", [""])[0]}
    outbound = {
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": u.hostname,
                    "port": int(u.port or 443),
                    "users": [
                        {
                            "id": u.username or "",
                            "encryption": q.get("encryption", ["none"])[0],
                            "flow": q.get("flow", [""])[0],
                        }
                    ],
                }
            ]
        },
        "streamSettings": stream,
    }
    return _make_config(outbound, http_port)


def _make_config(outbound: dict, http_port: int) -> dict:
    return {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {
                "tag": "http-in",
                "port": http_port,
                "listen": "127.0.0.1",
                "protocol": "http",
                "settings": {"allowTransparent": False},
            }
        ],
        "routing": {"domainStrategy": "UseIPv4", "rules": []},
        "outbounds": [{**outbound, "tag": "proxy"}, {"protocol": "freedom", "tag": "direct"}],
    }


def start_v2ray_proxy(v2_link: str, port: int) -> bool:
    """启动一个 v2ray 子进程作为 HTTP 代理，返回是否成功"""
    if not V2RAY_BIN or not os.path.isfile(V2RAY_BIN):
        log(f"  ⚠️ v2ray 二进制不存在 ({V2RAY_BIN})，无法启动独立代理")
        return False
    try:
        config = build_v2ray_config(v2_link, port)
        fd, cfg_path = tempfile.mkstemp(suffix=".json", prefix="v2ray_")
        os.close(fd)
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False)
        _v2ray_config_paths.append(cfg_path)

        proc = subprocess.Popen(
            [V2RAY_BIN, "run", "-config", cfg_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _v2ray_processes.append(proc)

        # 等待端口就绪
        for _ in range(30):
            time.sleep(0.5)
            try:
                s = socket.create_connection(("127.0.0.1", port), timeout=1)
                s.close()
                log(f"  ✅ 独立 v2ray 代理已启动 (127.0.0.1:{port})")
                return True
            except (ConnectionRefusedError, OSError):
                continue
        log(f"  ⚠️ 独立 v2ray 代理启动超时 (127.0.0.1:{port})")
        return False
    except Exception as e:
        log(f"  ❌ 启动独立 v2ray 代理失败: {e}")
        return False


def cleanup_v2ray():
    """清理所有 v2ray 子进程和临时配置文件"""
    for proc in _v2ray_processes:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    for cfg in _v2ray_config_paths:
        try:
            os.unlink(cfg)
        except Exception:
            pass


atexit.register(cleanup_v2ray)
signal.signal(signal.SIGTERM, lambda *_: cleanup_v2ray() or sys.exit(0))
signal.signal(signal.SIGINT, lambda *_: cleanup_v2ray() or sys.exit(0))


def get_proxies_for_account(account: dict, index: int) -> dict:
    """确定该账号使用的代理设置"""
    account_v2 = account.get("V2", "").strip()
    if account_v2:
        port = 11080 + index  # 每个账号用不同端口
        if start_v2ray_proxy(account_v2, port):
            return {"http": f"http://127.0.0.1:{port}", "https": f"http://127.0.0.1:{port}"}
        else:
            log("  ⚠️ 账号独立 V2 代理启动失败，改用全局代理")

    # 使用全局代理
    if GLOBAL_HTTP_PROXY:
        return {"http": GLOBAL_HTTP_PROXY, "https": GLOBAL_HTTP_PROXY}
    return {}


def get_masked_username(username: str) -> str:
    if "@" in username:
        return f"***@{username.split('@')[1]}"
    return username[:3] + "***"


# ===== XServer 续期核心函数 =====

def parse_remaining(page_html: str) -> tuple:
    numbers = re.findall(r'<span class="numberTxt">(\d+)</span>', page_html)
    deadline = re.search(r'<span class="dateLimit">\(([^)]+)\)</span>', page_html)
    hours = int(numbers[0]) if len(numbers) > 0 else -1
    minutes = int(numbers[1]) if len(numbers) > 1 else -1
    dl_str = deadline.group(1) if deadline else "未知"
    return hours, minutes, dl_str


def can_renew(page_html: str) -> bool:
    return "残り契約時間が16時間を切るまで" not in page_html


def notify_tg(account_info: str, result: str, deadline: str):
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    message = (
        f"🎮 XServer Game 续期通知\n"
        f"🕐 运行时间: {now_str()}\n"
        f"👤 账号: {account_info}\n"
        f"📅 利用期限: {deadline}\n"
        f"📊 续期结果: {result}"
    )
    try:
        requests.post(
            f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
            json={"chat_id": TG_CHAT_ID, "text": message},
            timeout=10,
        )
        log("📨 TG 推送成功")
    except Exception as e:
        log(f"⚠️ TG 推送失败: {e}")


def login(username: str, password: str, proxies: dict):
    log(f"🔑 正在登录... 账号: {get_masked_username(username)}")
    session = requests.Session()
    try:
        resp = session.get(LOGIN_PAGE, headers=BASE_HEADERS, timeout=15, proxies=proxies or None)
    except Exception as e:
        log(f"❌ 获取登录页失败: {e}")
        return None

    uniqid_match = re.search(r'name="uniqid"\s+value="([^"]+)"', resp.text)
    if not uniqid_match:
        log("❌ 未找到 uniqid")
        return None
    uniqid = uniqid_match.group(1)

    try:
        session.post(
            LOGIN_URL,
            headers={
                **BASE_HEADERS,
                "content-type": "application/x-www-form-urlencoded",
                "origin": BASE_URL,
                "referer": LOGIN_PAGE,
            },
            data={
                "request_page": "xserver/index",
                "site": "",
                "uniqid": uniqid,
                "memberid": username,
                "user_password": password,
                "service_login": "xserver",
                "action_user_login": "%A5%ED%A5%B0%A5%A4%A5%F3%A4%B9%A4%EB",
            },
            allow_redirects=True,
            timeout=15,
            proxies=proxies or None,
        )
    except Exception as e:
        log(f"❌ 登录请求失败: {e}")
        return None

    if not session.cookies.get("X2SESSID"):
        log("❌ 登录失败，未获取到 X2SESSID")
        return None

    log("✅ 登录成功")
    return session


def jump_to_xmgame(session, proxies: dict) -> bool:
    log("🔗 跳转到游戏面板...")
    try:
        resp = session.get(
            XMGAME_INDEX_URL,
            headers={**BASE_HEADERS, "referer": BASE_URL},
            timeout=15,
            proxies=proxies or None,
            allow_redirects=True,
        )
        resp.encoding = "EUC-JP"
    except Exception as e:
        log(f"❌ 获取 xmgame index 失败: {e}")
        return False

    jumpvps_match = re.search(r'/xapanel/xmgame/jumpvps/\?id=(\d+)', resp.text)
    if not jumpvps_match:
        log("❌ 未找到 jumpvps 链接")
        return False
    server_id = jumpvps_match.group(1)
    log(f"✅ 找到服务器 ID: {server_id}")

    try:
        resp2 = session.get(
            f"{BASE_URL}/xapanel/xmgame/jumpvps/?id={server_id}",
            headers={**BASE_HEADERS, "referer": XMGAME_INDEX_URL},
            timeout=15,
            proxies=proxies or None,
            allow_redirects=True,
        )
        resp2.encoding = "EUC-JP"
    except Exception as e:
        log(f"❌ 获取 jumpvps 失败: {e}")
        return False

    username = re.search(r'name="username"\s+value="([^"]+)"', resp2.text)
    server_identify = re.search(r'name="server_identify"\s+value="([^"]+)"', resp2.text)
    password = re.search(r'name="password"\s+value="([^"]+)"', resp2.text)
    service = re.search(r'name="service"\s+value="([^"]+)"', resp2.text)
    master_panel = re.search(r'name="master_panel_username"\s+value="([^"]*)"', resp2.text)
    back = re.search(r'name="back"\s+value="([^"]+)"', resp2.text)

    if not all([username, server_identify, password, service]):
        log("❌ 解析 onetimelogin 表单失败")
        return False

    try:
        session.post(
            ONETIMELOGIN_URL,
            headers={
                **BASE_HEADERS,
                "content-type": "application/x-www-form-urlencoded",
                "origin": BASE_URL,
                "referer": f"{BASE_URL}/xapanel/xmgame/jumpvps/?id={server_id}",
            },
            data={
                "username": username.group(1),
                "server_identify": server_identify.group(1),
                "password": password.group(1),
                "service": service.group(1),
                "master_panel_username": master_panel.group(1) if master_panel else "",
                "back": back.group(1) if back else "",
            },
            allow_redirects=True,
            timeout=15,
            proxies=proxies or None,
        )
    except Exception as e:
        log(f"❌ onetimelogin 请求失败: {e}")
        return False
    return True


def fetch_info_page(session, proxies: dict) -> str:
    try:
        resp = session.get(
            INFO_URL,
            headers={**BASE_HEADERS, "referer": BASE_URL},
            timeout=15,
            proxies=proxies or None,
            allow_redirects=True,
        )
        resp.encoding = "EUC-JP"
        return resp.text
    except Exception as e:
        log(f"❌ 获取游戏首页失败: {e}")
        return ""


def fetch_extend_page(session, proxies: dict) -> str:
    try:
        resp = session.get(
            EXTEND_URL,
            headers={**BASE_HEADERS, "referer": INFO_URL},
            timeout=15,
            proxies=proxies or None,
            allow_redirects=True,
        )
        resp.encoding = "EUC-JP"
        return resp.text
    except Exception as e:
        log(f"❌ 获取续期页面失败: {e}")
        return ""


def do_renew(session, proxies: dict) -> bool:
    log("📝 获取续期表单...")
    try:
        resp = session.get(
            RENEW_URL,
            headers={**BASE_HEADERS, "referer": EXTEND_URL},
            timeout=15,
            proxies=proxies or None,
            allow_redirects=True,
        )
        resp.encoding = "EUC-JP"
    except Exception as e:
        log(f"❌ 获取续期表单失败: {e}")
        return False

    uniqid = re.search(r'name="uniqid"\s+value="([^"]+)"', resp.text)
    login_token = re.search(r'name="login_token"\s+value="([^"]+)"', resp.text)
    period = re.search(r'name="period"[^>]*value="(\d+)"', resp.text)

    if not uniqid or not login_token:
        log("❌ 解析续期表单失败")
        return False

    period_val = period.group(1) if period else "48"

    log("📤 提交确认页...")
    try:
        resp2 = session.post(
            CONF_URL,
            headers={
                **BASE_HEADERS,
                "content-type": "application/x-www-form-urlencoded",
                "origin": BASE_URL,
                "referer": RENEW_URL,
            },
            data={
                "uniqid": uniqid.group(1),
                "ethna_csrf": "",
                "login_token": login_token.group(1),
                "period": period_val,
            },
            timeout=15,
            proxies=proxies or None,
            allow_redirects=True,
        )
        resp2.encoding = "EUC-JP"
    except Exception as e:
        log(f"❌ 提交确认页失败: {e}")
        return False

    uniqid2 = re.search(r'name="uniqid"\s+value="([^"]+)"', resp2.text)
    if not uniqid2:
        log("❌ 解析确认页表单失败")
        return False

    log("✅ 执行续期确认...")
    try:
        session.post(
            DO_URL,
            headers={
                **BASE_HEADERS,
                "content-type": "application/x-www-form-urlencoded",
                "origin": BASE_URL,
                "referer": CONF_URL,
            },
            data={
                "uniqid": uniqid2.group(1),
                "ethna_csrf": "",
                "period": period_val,
            },
            timeout=15,
            proxies=proxies or None,
            allow_redirects=True,
        )
    except Exception as e:
        log(f"❌ 执行续期失败: {e}")
        return False

    return True


def process_account(account: dict, index: int) -> bool:
    """处理单个账号的续期，返回是否成功"""
    username = account.get("username", "")
    password = account.get("password", "")
    if not username or not password:
        log(f"⚠️ 账号 #{index} 缺少 username 或 password，跳过")
        return False

    account_label = get_masked_username(username)
    divider(f"#{index + 1}: {account_label}")

    # 确定代理
    proxies = get_proxies_for_account(account, index)
    if account.get("V2", "").strip():
        mode = "独立 V2 代理" if proxies else "独立 V2 代理(启动失败)"
    elif GLOBAL_HTTP_PROXY:
        mode = "全局代理"
    else:
        mode = "直连"
    log(f"🌐 代理: {mode}")

    # 检查出口 IP
    try:
        resp = requests.get(
            "https://api.ipify.org?format=json",
            timeout=10,
            proxies=proxies or None,
        )
        raw_ip = resp.json().get("ip", "未知")
        masked = re.sub(r'\.\d+$', '.**', raw_ip)
        log(f"🌐 出口 IP: {masked}")
    except Exception as e:
        log(f"⚠️  出口 IP 检测失败: {e}")

    # 登录
    session = login(username, password, proxies)
    if not session:
        log(f"❌ {account_label} 登录失败")
        notify_tg(account_label, "❌ 登录失败！", "未知")
        return False

    # 跳转游戏面板
    if not jump_to_xmgame(session, proxies):
        log(f"❌ {account_label} 跳转游戏面板失败")
        notify_tg(account_label, "❌ 面板跳转失败！", "未知")
        return False

    # 读取服务器信息
    log("📋 读取服务器信息...")
    page_info = fetch_info_page(session, proxies)
    if not page_info:
        return False

    h_before, m_before, dl_before = parse_remaining(page_info)
    if h_before < 0:
        log("❌ 解析剩余时间失败")
        notify_tg(account_label, "❌ 时间解析失败！", "未知")
        return False

    log(f"📅 当前利用期限：{dl_before}")
    log(f"⏳ 剩余时间：{h_before} 小时 {m_before} 分")

    if h_before >= RENEW_THRESHOLD_HOURS:
        log(f"ℹ️  剩余 {h_before} 小时，未低于阈值，无需续期")
        notify_tg(account_label, "⌛️ 期限未至！", dl_before)
        return True

    page_extend = fetch_extend_page(session, proxies)
    if not can_renew(page_extend):
        log("⚠️  页面提示暂不可续期")
        notify_tg(account_label, "⌛️ 期限未至！", dl_before)
        return True

    # 执行续期
    log("🔄 开始续期...")
    if not do_renew(session, proxies):
        notify_tg(account_label, "❌ 续期失败！", dl_before)
        return False

    # 验证结果
    page_info_after = fetch_info_page(session, proxies)
    h_after, m_after, dl_after = parse_remaining(page_info_after)
    log(f"📅 续期后利用期限：{dl_after}")
    log(f"⏳ 续期后剩余时间：{h_after} 小时 {m_after} 分")

    if dl_after != dl_before or h_after > h_before:
        log("✅ 续期成功！")
        notify_tg(account_label, "✅ 续期成功！", dl_after)
        return True
    else:
        log("❌ 续期失败，时间未变化")
        notify_tg(account_label, "❌ 续期失败！", dl_after or dl_before)
        return False


def main():
    divider(f"{SCRIPT_NAME} starts — {len(ALL_USERS)} 账号")
    log(f"🕐 运行时间: {now_str()}")

    # 检测 v2ray 二进制
    global V2RAY_BIN
    if not V2RAY_BIN or not os.path.isfile(V2RAY_BIN):
        for candidate in ["./v2ray", "./v2ray/v2ray", "/usr/local/bin/v2ray", os.path.expanduser("~/v2ray/v2ray")]:
            if os.path.isfile(candidate):
                V2RAY_BIN = candidate
                break
    if V2RAY_BIN and os.path.isfile(V2RAY_BIN):
        log(f"🔧 v2ray 二进制: {V2RAY_BIN}")
    else:
        log("⚠️  v2ray 未找到 — 账号独立 V2 代理不可用，将回退全局代理或直连")

    if GLOBAL_HTTP_PROXY:
        log(f"🛡️ 全局代理: {GLOBAL_HTTP_PROXY}")
    else:
        log("🌐 无全局代理")

    results = []
    for i, account in enumerate(ALL_USERS):
        print()
        success = process_account(account, i)
        results.append(success)

    # 汇总
    success_count = sum(1 for r in results if r)
    divider(f"汇总: {success_count}/{len(results)} 成功")
    sys.exit(0 if success_count > 0 else 1)


if __name__ == "__main__":
    main()
