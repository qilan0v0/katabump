#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EpicHost.pl 免费服务器自动续期 — 青龙面板调用版
通过 GitHub API 触发 epichost.yml workflow_dispatch
"""

import requests
import json
import time
import os

# ===== 配置（在青龙环境变量中设置）=====
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '')

# 仓库信息
REPO_OWNER = os.environ.get('REPO_OWNER', 'qilan0v0')
REPO_NAME = os.environ.get('REPO_NAME', 'katabump')
WORKFLOW_FILE = os.environ.get('WORKFLOW_FILE', 'epichost.yml')
WORKFLOW_REF = os.environ.get('WORKFLOW_REF', 'main')

# 代理（可选，如果青龙需要代理才能访问 github.com）
HTTP_PROXY = os.environ.get('HTTP_PROXY', '')
HTTPS_PROXY = os.environ.get('HTTPS_PROXY', '')


def trigger_workflow_dispatch(token):
    """直接触发指定 workflow 的 workflow_dispatch"""
    if not token:
        print('[错误] 未提供 GitHub Token')
        return False

    url = f'https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/actions/workflows/{WORKFLOW_FILE}/dispatches'
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'qinglong-epichost/1.0'
    }
    payload = {
        'ref': WORKFLOW_REF
    }

    proxies = {}
    if HTTP_PROXY:
        proxies['http'] = HTTP_PROXY
    if HTTPS_PROXY:
        proxies['https'] = HTTPS_PROXY

    print(f'[GitHub] 触发 workflow: {REPO_OWNER}/{REPO_NAME} -> {WORKFLOW_FILE} @ {WORKFLOW_REF}')
    print(f'[GitHub] 代理: {"启用" if proxies else "无"}')

    try:
        r = requests.post(url, headers=headers, json=payload, proxies=proxies if proxies else None, timeout=30)

        if r.status_code == 204:
            print('[✅] Workflow 已触发成功')
            return True
        elif r.status_code == 403:
            print(f'[❌] 权限不足 (403): token 可能缺少 repo 权限或 workflow 权限')
            print(f'  → 请确保 GitHub Token 勾选了 repo 完整权限')
            print(f'  → 响应: {r.text[:200]}')
            return False
        elif r.status_code == 404:
            print(f'[❌] workflow 文件不存在 (404): 检查 WORKFLOW_FILE 名称')
            print(f'  → 响应: {r.text[:200]}')
            return False
        else:
            print(f'[⚠️] 未知响应: {r.status_code}')
            print(f'  → 响应: {r.text[:300]}')
            return r.status_code == 204
    except requests.exceptions.ConnectTimeout:
        print('[❌] 连接超时（青龙网络可能无法访问 GitHub）')
        print('  → 请检查青龙是否配置了代理，或网络连通性')
        return False
    except requests.exceptions.ProxyError as e:
        print(f'[❌] 代理错误: {e}')
        print('  → 请检查 HTTP_PROXY / HTTPS_PROXY 环境变量配置')
        return False
    except Exception as e:
        print(f'[❌] 请求异常: {e}')
        return False


def check_last_run_status():
    """查询最近一次 workflow 运行状态"""
    token = GITHUB_TOKEN
    if not token:
        return

    url = f'https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/actions/workflows/{WORKFLOW_FILE}/runs?per_page=1'
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'qinglong-epichost/1.0'
    }

    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code == 200:
            runs = r.json().get('workflow_runs', [])
            if runs:
                last = runs[0]
                conclusion = last.get('conclusion', 'unknown')
                created = last.get('created_at', '')
                html_url = last.get('html_url', '')
                print(f'[状态] 上次运行: {conclusion} @ {created}')
                if conclusion == 'success':
                    print('  → ✅ 上次执行成功')
                elif conclusion == 'failure':
                    print('  → ❌ 上次执行失败，请检查日志')
                    if html_url:
                        print(f'  → 日志: {html_url}')
                elif conclusion == 'cancelled':
                    print('  → ⏹️ 上次被取消')
                else:
                    print(f'  → 状态: {conclusion}')
            else:
                print('[状态] 暂无运行记录')
        else:
            print(f'[状态] 查询失败: {r.status_code}')
    except Exception as e:
        print(f'[状态] 查询异常: {e}')


def main():
    print('=' * 55)
    print('  EpicHost.pl 服务器自动续期 — 青龙触发版')
    print(f'  workflow: {WORKFLOW_FILE}')
    print('=' * 55)

    token = GITHUB_TOKEN

    if not token:
        print('[错误] 未配置 GitHub Token')
        print('')
        print('使用方法:')
        print('  1. 在青龙环境变量或 .env 中添加:')
        print('     GITHUB_TOKEN = 你的 GitHub Personal Access Token')
        print('')
        print('GitHub Token 获取:')
        print('  1. 访问 https://github.com/settings/tokens')
        print('  2. 点 Generate new token (classic)')
        print('  3. 勾选 repo 权限（全选）')
        print('  4. 生成后复制 token')
        print('')
        print('可选环境变量:')
        print('  REPO_OWNER    - GitHub 用户名 (默认: qilan0v0)')
        print('  REPO_NAME     - 仓库名 (默认: katabump)')
        print('  WORKFLOW_FILE - workflow 文件名 (默认: epichost.yml)')
        print('  WORKFLOW_REF  - 分支名 (默认: main)')
        print('  HTTP_PROXY    - HTTP 代理地址')
        print('  HTTPS_PROXY   - HTTPS 代理地址')
        return

    # 查询上次状态
    check_last_run_status()
    print('')

    # 触发 workflow
    print('[触发] 正在调用 GitHub API...')
    success = trigger_workflow_dispatch(token)

    if success:
        print('[完成] API 调用结束，workflow 将在几秒内开始运行')
        print(f'  → 查看进度: https://github.com/{REPO_OWNER}/{REPO_NAME}/actions')
    else:
        print('[失败] 触发 workflow 失败')

    print('=' * 55)


if __name__ == '__main__':
    main()