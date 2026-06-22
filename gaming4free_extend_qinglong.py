#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gaming4Free 服务器续时 — 青龙面板调用版
通过 GitHub API 触发 gaming4free-extend workflow
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
WORKFLOW_EVENT = os.environ.get('WORKFLOW_EVENT', 'gaming4free-extend')

# 代理（可选，如果青龙需要代理才能访问 github.com）
HTTP_PROXY = os.environ.get('HTTP_PROXY', '')
HTTPS_PROXY = os.environ.get('HTTPS_PROXY', '')


def trigger_workflow(token):
    """触发 GitHub Actions workflow"""
    if not token:
        print('[错误] 未提供 GitHub Token')
        return False
    
    url = f'https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/dispatches'
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'qinglong-g4f-extend/1.0'
    }
    payload = {
        'event_type': WORKFLOW_EVENT
    }
    
    proxies = {}
    if HTTP_PROXY:
        proxies['http'] = HTTP_PROXY
    if HTTPS_PROXY:
        proxies['https'] = HTTPS_PROXY
    
    print(f'[GitHub] 触发 workflow: {REPO_OWNER}/{REPO_NAME} -> {WORKFLOW_EVENT}')
    print(f'[GitHub] 代理: {"启用" if proxies else "无"}')
    
    try:
        r = requests.post(url, headers=headers, json=payload, proxies=proxies if proxies else None, timeout=30)
        
        if r.status_code == 204:
            print('[✅] Workflow 已触发成功')
            return True
        elif r.status_code == 403:
            print(f'[❌] 权限不足 (403): token 可能缺少 repo 权限')
            print(f'  → 请确保 GitHub Token 勾选了 repo 完整权限')
            print(f'  → 响应: {r.text[:200]}')
            return False
        elif r.status_code == 404:
            print(f'[❌] 仓库或事件不存在 (404): 检查 REPO_OWNER/REPO_NAME')
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
    """查询最近一次 worklow 运行状态（可选，了解上次执行结果）"""
    token = GITHUB_TOKEN
    if not token:
        return
    
    url = f'https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/actions/workflows/gaming4free-extend.yml/runs?per_page=1'
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'qinglong-g4f-extend/1.0'
    }
    
    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code == 200:
            runs = r.json().get('workflow_runs', [])
            if runs:
                last = runs[0]
                conclusion = last.get('conclusion', 'unknown')
                created = last.get('created_at', '')
                print(f'[状态] 上次运行: {conclusion} @ {created}')
                if conclusion == 'success':
                    print('  → 上次执行成功')
                elif conclusion == 'failure':
                    print('  → ⚠️ 上次执行失败，请检查 GitHub Actions 日志')
                elif conclusion == 'cancelled':
                    print('  → 上次被取消')
                else:
                    print(f'  → 状态: {conclusion}')
            else:
                print('[状态] 暂无运行记录')
        else:
            print(f'[状态] 查询失败: {r.status_code}')
    except Exception as e:
        print(f'[状态] 查询异常: {e}')


def main():
    print('=' * 50)
    print('  Gaming4Free 服务器续时 — 青龙触发版')
    print('=' * 50)
    
    # 获取 token
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
        return
    
    # 查询上次状态
    check_last_run_status()
    print('')
    
    # 触发 workflow
    print('[触发] 正在调用 GitHub API...')
    success = trigger_workflow(token)
    
    if success:
        print('[完成] API 调用结束，workflow 将在几秒内开始运行')
        print('  → 查看进度: https://github.com/qilan0v0/katabump/actions')
    else:
        print('[失败] 触发 workflow 失败')
    
    print('=' * 50)


if __name__ == '__main__':
    main()
