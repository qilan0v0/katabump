# Katabump Server Auto-Renewal Tool

[English Version](README_EN.md) | [中文说明](README.md)

这是一个用于自动续期 Katabump 服务器的自动化脚本。它利用 Playwright 和 CDP (Chrome DevTools Protocol) 技术来模拟用户操作，自动处理验证码，确保持续的服务器服务。

> **验证码说明**：Katabump 在两个环节用了不同的验证码——
> - **登录页**：Cloudflare Turnstile（iframe），脚本通过 CDP 模拟真实鼠标点击绕过。
> - **续期弹窗**：ALTCHA（工作量证明 PoW），脚本点击复选框后由浏览器本地完成计算，**不依赖出口 IP 信誉**。

支持 **Windows 本地运行** 和 **GitHub Actions 云端运行**。

## ✨ 特性

- **双验证码处理**: 登录用 CDP 绕过 Cloudflare Turnstile；续期自动求解 ALTCHA（PoW）。
- **自动重试 + 快速失败**: 内置重试机制，连续多次验证失败会提前放弃，避免空转浪费 CI 时间。
- **多用户支持**: 支持配置多个账号批量续期。
- **Telegram 通知**: 续期成功 / 失败 / 跳过时推送消息（含截图），支持超级群话题(Topic)。
- **KV Cookie 缓存（Worker API）**：通过部署的 KV Admin Worker（`/api/get`、`/api/set`）统一存取登录 cookie，避免重复登录。仅需 `KV_ADMIN_URL` + `KV_ADMIN_PASS` 两个 Secret。支持所有项目（Katabump / ACLClouds / FreeMCHost / Zampto / Weirdhost / Lunes / Searcade / Vortexa / Gaming4Free）。
- **代理支持**: 支持普通 HTTP 代理，也支持云端自动安装 v2ray 用节点作为代理。
- **云端/本地**: 既可以在本地电脑跑，也可以利用 GitHub Actions 每天定时自动跑。

---

## 🚀 GitHub Actions 云端运行 (推荐)

这是最省心的方式，配置一次即可每天自动执行。

1. **Fork 本仓库** 到你的 GitHub 账号。
2. 进入你的仓库，点击 **Settings** -> **Secrets and variables** -> **Actions**。
3. 点击 **New repository secret**，添加一个名为 `USERS_JSON` 的 Secret。
4. **Value** 的格式必须是 JSON 数组（请尽量压缩为一行）：
   ```json
   [{"username": "your_email@example.com", "password": "your_password"}, {"username": "another@example.com", "password": "pwd"}]
   ```
   - **(可选) `serverUrl`**：若云端点击 "See" 无法跳转到服务器详情页（常见于无头环境），可为账号指定**续期页直达地址**，脚本会直接打开它，跳过点击 See：
     ```json
     [{"username": "a@b.com", "password": "pwd", "serverUrl": "https://dashboard.katabump.com/servers/edit?id=305327"}]
     ```
     > 获取方法：在浏览器登录后点进你的服务器页面，复制地址栏的 URL（形如 `https://dashboard.katabump.com/servers/edit?id=你的服务器ID`）。不填则默认点击 "See"。
5. **(可选) 配置代理**:
   如果 GitHub Actions 的 IP 被屏蔽，或者你想使用特定的 IP 访问，有两种方式（二选一）：

   **方式 A：普通 HTTP 代理** —— 添加名为 `HTTP_PROXY` 的 Secret。
   - **格式**:
     - 无认证: `http://ip:port`
     - 带认证: `http://username:password@ip:port`
   - 脚本会自动检测代理有效性并打印出口 IP。

   **方式 B：v2ray 节点** —— 添加名为 `V2RAY_VMESS` 的 Secret，值为节点的 `vmess://` 或 `vless://` 分享链接。
   - Workflow 会在云端自动下载 v2ray，把节点解析为本地 HTTP 代理（`127.0.0.1:10809`），并自动设置 `HTTP_PROXY` 指向它。
   - 启动时会用 `curl` 验证代理可用并打印出口 IP，失败则中止。
   - 同时设置了 `V2RAY_VMESS` 和 `HTTP_PROXY` 时，**优先使用 v2ray**。
   > 注意：续期的 ALTCHA 不看 IP 信誉，所以**仅为续期的话其实不需要代理**；代理主要用于登录的 Cloudflare 或站点本身被墙的场景。默认不启用。

6. **(可选) KV Cookie 缓存（所有项目通用）**:
   通过部署 **KV Admin Worker** 来缓存登录 cookie，所有脚本统一通过 Worker API 存取 cookie，免重复登录。
   
   **部署 Worker**（只需做一次）：
   1. 在 GitHub Secrets 中添加 `CF_API_TOKEN`（Cloudflare API Token，需 Workers + KV 权限）和 `CF_ACCOUNT_ID`
   2. 手动触发 Actions 中的 **Deploy KV Cookie Admin** workflow，它会自动部署
   3. 部署完成后，在 GitHub Secrets 中添加：
      - `KV_ADMIN_URL`: 部署成功的 Worker 地址，例如 `https://kv-cookie-admin.xxxx.workers.dev`
      - `KV_ADMIN_PASS`: 设置管理员密码（部署时自动从你的 `CF_API_TOKEN` 生成，或你自己记住的密码）
   
   > 所有 9 个项目（Katabump / ACLClouds / FreeMCHost / Zampto / Weirdhost / Lunes / Searcade / Vortexa / Gaming4Free）都共用同一套 `KV_ADMIN_URL` / `KV_ADMIN_PASS`。不配置则每次完整登录，功能不受影响。

7. **(可选) Telegram 消息推送**:
   如果你希望在续期成功、失败或跳过时收到 Telegram 通知（包含截图），请配置以下 Secret：
   - `TG_BOT_TOKEN`: 你的 Telegram Bot Token (从 @BotFather 获取)。
   - `TG_CHAT_ID`: 你的 Chat ID (用户 ID 或群组 ID)。
   - `TG_THREAD_ID`: **(可选)** 超级群「话题(Topic)」的 `message_thread_id`，设置后消息会发到指定话题下。普通私聊/群组无需填写。
   > **获取 Chat ID**: 先用自己的账号给 bot 发一条任意消息，再访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`，在返回 JSON 里找 `"chat":{"id":...}`。
   > **常见报错**: 若日志出现 `400 chat not found`，多半是 `TG_CHAT_ID` 填错，或你还没主动给 bot 发过消息。
   > 如果未配置，脚本将跳过发送通知。

### 4. 运行结果与截图

- **运行日志**: 在 Actions 中的 `Run Renew Script` 步骤查看。
- **截图留存**: 每次运行（无论成功与否），通过 `Upload Screenshots` 步骤自动上传截图。
  - 你可以在 Workflow 运行详情页的 **Artifacts** 区域下载 `screenshots` 压缩包。
  - 每个账号对应一张截图（`username.png`），方便确认状态。

5. 保存后，进入 **Actions** 页面，启用 Workflow。它会在**每天北京时间 08:00 (UTC 00:00)** 自动运行。
6. 你也可以手动点击 "Run workflow" 立即测试。

---

## 💻 Windows 本地运行指南

如果你想在本地观察运行过程或进行调试，请按以下步骤操作。

### 1. 环境准备

确保你已经安装了 [Node.js](https://nodejs.org/) (建议版本 v18+)。

### 2. 安装依赖

在项目根目录打开终端 (PowerShell 或 CMD)，运行：

```bash
npm install
```

### 3. 配置账号

在项目根目录**新建** `login.json`（已被 `.gitignore` 忽略，不会上传到 GitHub），填入你的账号密码：

1. 新建文件 `login.json`。
2. 用记事本或编辑器打开，填入账号数组：
   ```json
   [
       {
           "username": "myemail@gmail.com",
           "password": "mypassword123"
       }
   ]
   ```

   > **注意**: `login.json` 已被加入 `.gitignore`，不会被上传到 GitHub，请放心使用。
   >

### 4. 配置 Chrome 路径

打开 `renew.js` 文件，找到第 11-12 行：

```javascript
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const USER_DATA_DIR = path.join(__dirname, 'ChromeData_Katabump');
const HEADLESS = true;
```

* **CHROME_PATH**: 这是你本地 Chrome 浏览器的安装路径。如果你的安装位置不同，请务必修改！
* **USER_DATA_DIR**:
  * 这是一个用于存放 Script 运行时产生的浏览器数据（缓存、Cookie、登录状态等）的文件夹。
  * **作用**: 它能让你的登录状态保持更久，不需要每次运行都重新输入密码。
  * **能不能删？**: **可以删**。如果你想要重置所有状态（彻底清除缓存），只需删除这个文件夹即可。脚本下次运行时会自动重新创建它。
* **HEADLESS**:
  * `false`: 脚本运行时会弹出一个 Chrome 窗口，你可以看到它在做什么。
  * `true`: (默认)脚本在后台无头运行，界面不可见（适合只想静默完成任务时开启）。

### 3. 运行脚本

如果你需要使用代理运行脚本，请设置环境变量 `HTTP_PROXY`：

**Powershell:**
```powershell
$env:HTTP_PROXY="http://user:pass@127.0.0.1:7890"
node renew.js
```

**CMD:**
```cmd
set HTTP_PROXY=http://user:pass@127.0.0.1:7890
node renew.js
```

如果不设置代理，直接运行：
```bash
node renew.js
```

脚本会自动启动 Chrome (如果需要)，逐个处理账号，并在根目录下的 `photo/` 文件夹中保存每个账号运行结束时的截图（`账号名.png`）。窗口（默认无头模式为 false，你可以看到操作过程），并依次为列表中的用户续期。

---

## 🛠️ 项目结构

* `bothosting_renew.js`: Bot-Hosting.net (`bot-hosting.net`) 续期脚本（注入 cookie 直接访问账单页续期，过 CF Turnstile 验证，支持 KV cookie 缓存）。
* `renew.js`: Windows 本地运行的主程序（Katabump）。
* `action_renew.js`: 专门用于 GitHub Actions 环境的脚本（Katabump / ACLClouds）。
* `.github/workflows/renew.yml`: Katabump 续期定时任务（每天北京时间 08:00）。
* `.github/workflows/aclclouds.yml`: ACLClouds 续期定时任务（每天北京时间 10:00）。
* `.github/scripts/gen-v2ray-config.js`: 把 `vmess://` / `vless://` 分享链接解析为带本地 HTTP 入站的 v2ray 配置。
* `lunes_login.js`: Lunes Host (`betadash.lunes.host`) 登录保活脚本（支持 KV cookie 缓存）。
* `.github/workflows/lunes.yml`: Lunes 登录保活的定时任务（每天，支持 KV cookie 缓存）。
* `searcade_login.js`: Searcade (`searcade.com`) 登录保活脚本（经 userveria OAuth 两步登录，支持 KV cookie 缓存）。
* `.github/workflows/searcade.yml`: Searcade 登录保活定时任务（每周一北京时间 11:00，支持 KV cookie 缓存）。
* `freemchost_renew.js`: FreeMCHost (`new.freemchost.com`) 续期脚本（支持 KV cookie 缓存）。
* `.github/workflows/freemchost.yml`: FreeMCHost 续期定时任务（每天北京时间凌晨 2 点）。
* `zampto_renew.js`: Zampto (`zampto.net`) 续期脚本（两步登录 + serverUrl 点续期，支持 KV cookie 缓存）。
* `.github/workflows/zampto.yml`: Zampto 续期定时任务（每天北京时间凌晨 3 点）。
* `weirdhost_renew.js`: Weirdhost (`hub.weirdhost.xyz`) 续期脚本（过 CF 全屏验证 + 韩文面板登录 + serverUrl 点 연장하기，支持 KV cookie 缓存）。
* `.github/workflows/weirdhost.yml`: Weirdhost 续期定时任务（每天北京时间凌晨 1 点）。
* `vortexa_renew.js`: Vortexa (`vortexa.cloud`) VM 启动保活脚本（支持 KV cookie 缓存）。
* `.github/workflows/vortexa.yml`: Vortexa 保活定时任务（每天北京时间凌晨 4 点）。
* `gaming4free_checkin.js`: Gaming4Free (`control.gaming4free.net`) 每日签到脚本（仅支持 cookie 登录，需手动导出 cookie 上传到 KV）。
* `gaming4free_extend.js`: Gaming4Free 服务器续时脚本（每 5 分钟自动点 +90 min 延长运行时间）。
* `.github/workflows/gaming4free.yml`: Gaming4Free 每日签到定时任务（每天北京时间 09:00）。
* `.github/workflows/gaming4free-extend.yml`: Gaming4Free 服务器自动续时（每 5 分钟运行一次）。
* `kv-admin/worker.js`: KV Cookie 管理面板（Cloudflare Worker），提供 `/api/get`、`/api/set`、`/api/list`、`/api/delete` 接口，用于所有脚本统一存取 cookie。
* `kv-admin/wrangler.toml`: Worker 部署配置，绑定 KV 命名空间。
* `.github/workflows/deploy-kv-admin.yml`: KV Admin Worker 部署 workflow（手动触发）。
* `checkin_multi.py`: NewAPI 通用签到续期脚本（支持 hcnsec / pie-xian 等多站点，通过 `BASE_URL` 和 `CHECKIN_USERS_JSON` 环境变量切换）。
* `.github/workflows/renewal.yml`: hcnsec (`api.hcnsec.cn`) 每日签到续期（每天北京时间 06:00）。
* `.github/workflows/piexian.yml`: pie-xian (`api.pie-xian.com`) 每日签到续期（每天北京时间 05:30）。
* `checkin_agentrouter.py`: Agent Router (`agentrouter.org`) 登录即签到脚本（无独立 checkin API）。
* `.github/workflows/agentrouter.yml`: Agent Router 每日登录签到（仅手动触发）。
* `login.json`: (需手动创建) 存放本地运行的账号信息。

> **`action_renew.js` 已参数化**：默认面板是 katabump；设置环境变量 `DASH_BASE_URL`（如 `https://dash.aclclouds.com`）即可复用到同款面板。katabump 不设此变量，行为不变。

---

## 🌙 Lunes Host 登录保活 (附加)

防止 Lunes Host 账号因长期不活跃被重置密码，每周一自动登录一次进 dashboard 并发 Telegram 通知。

- **账号 Secret**：新建 `LUNES_USERS_JSON`，格式同 `USERS_JSON`：
  ```json
  [{"username": "a@b.com", "password": "pwd"}, {"username": "c@d.com", "password": "pwd2"}]
  ```
- **验证码**：登录页是 **Cloudflare Turnstile**，脚本通过 CDP 模拟点击绕过。
- **KV Cookie 缓存**：支持通过 `KV_ADMIN_URL` / `KV_ADMIN_PASS` 缓存 cookie（`lunes_cookie_<用户名>`），避免每次完整登录。
- **代理 / Telegram**：复用同一套 `V2RAY_VMESS` / `HTTP_PROXY` / `TG_BOT_TOKEN` / `TG_CHAT_ID` / `TG_THREAD_ID` Secret。
- **触发**：每天定时，或在 Actions 页手动 "Run workflow" (选 `Lunes Auto Login`)。截图在 `lunes-screenshots` artifact。

---

## ☁️ ACLClouds 续期 (附加)

`dash.aclclouds.com` 与 katabump 是**同款面板**，复用 `action_renew.js`（通过 `DASH_BASE_URL` 切换地址）。区别：aclclouds **登录后首页就有 Renew 按钮**，无需点 "See"——工作流里已设 `DASH_RENEW_ON_HOME=true` 跳过该步，登录→Renew→ALTCHA。

- **账号 Secret**：新建 `ACL_USERS_JSON`，格式同 `USERS_JSON`（首页续期模式**无需** `serverUrl`）：
  ```json
  [{"username": "a@b.com", "password": "pwd"}]
  ```
- **代理 / Telegram**：复用同一套 `V2RAY_VMESS` / `HTTP_PROXY` / `TG_*` Secret。
- **触发**：每天北京时间 10:00，或手动 "Run workflow" (选 `ACLClouds Auto Renew`)。截图在 `aclclouds-screenshots` artifact。

---

## 🎮 Searcade 登录保活 + 服务器保活 (附加)

`searcade.com` 登录走 **userveria.com 的 OAuth**（两步：先邮箱 "Continue with email"，再密码 "Log in"），登录成功后页面显示 `Successfully signed in as ...`。脚本自动完成整套流程并截图通知。无验证码。

登录后会自动检查服务器状态：若状态不是 `Online`，则点击 Start 按钮启动服务器，等待启动成功并发送通知。

- **账号 Secret**：新建 `SEARCADE_USERS_JSON`，格式同其它（可在每个用户对象中添加可选的 `serverUrl` 或 `serverUrls` 数组）：
  ```json
  [{"username": "a@b.com", "password": "pwd"}]
  ```
  **配置服务器保活的方式（任选其一）**：
  - **选项 A**：在用户 JSON 中添加 `serverUrl` 字段
    ```json
    [{"username": "a@b.com", "password": "pwd", "serverUrl": "https://searcade.com/en/admin/servers/7383"}]
    ```
  - **选项 B**：在用户 JSON 中添加 `serverUrls` 数组（多台服务器）
    ```json
    [{"username": "a@b.com", "password": "pwd", "serverUrls": [
      "https://searcade.com/en/admin/servers/7383",
      "https://searcade.com/en/admin/servers/7384"
    ]}]
    ```
  - **选项 C**：设置环境变量 `SEARCADE_SERVER_URLS`（所有用户共用，逗号分隔，需要显式配置 `KV_ADMIN_URL` 免登录时才有用）
  > 不配置服务器 URL 则不执行保活检查，仅登录保活。
- **代理 / Telegram**：复用同一套 `V2RAY_VMESS` / `HTTP_PROXY` / `TG_*` Secret。
- **KV Cookie 缓存**：支持通过 `KV_ADMIN_URL` / `KV_ADMIN_PASS` 缓存 cookie（`searcade_cookie_<用户名>`），避免每次完整登录。
- **触发**：每天定时，或手动 "Run workflow" (选 `Searcade Auto Login`)。截图在 `searcade-screenshots` artifact。

---

## ⛏️ FreeMCHost 续期 (附加)

`new.freemchost.com` 登录后打开服务器页面点 **Renew now** 续期。脚本自动完成登录→打开 serverUrl→续期→截图通知。无验证码。

- **账号 Secret**：新建 `FREEMCHOST_USERS_JSON`，**需要 `serverUrl`**：
  ```json
  [{"username":"a@b.com","password":"pwd","serverUrl":"https://new.freemchost.com/server/xxxx"}]
  ```
- **KV Cookie 缓存（可选）**：配置 `KV_ADMIN_URL` / `KV_ADMIN_PASS` 两个 Secret 后启用 cookie 缓存——先注入 Worker 里的 cookie 尝试免登录，失效才重新登录并把新 cookie 存回 Worker（所有项目共用同一套 KV 配置，cookie key 为 `freemchost_cookie_<用户名>`）。详见上方 KV Admin Worker 部署说明。
- **代理 / Telegram**：复用同一套 `V2RAY_VMESS` / `HTTP_PROXY` / `TG_*` Secret。
- **触发**：每天北京时间凌晨 2 点，或手动 "Run workflow" (选 `FreeMCHost Auto Renew`)。截图在 `freemchost-screenshots` artifact。

---

## 🚀 Zampto 续期 (附加)

`zampto.net` 登录走 **auth.zampto.net 两步登录**（先邮箱、再密码），登录成功后打开服务器页面点续期按钮。脚本自动完成登录→打开 serverUrl→续期→截图通知。

- **账号 Secret**：新建 `ZAMPTO_USERS_JSON`，**需要 `serverUrl`**：
  ```json
  [{"username":"a@b.com","password":"pwd","serverUrl":"https://..."}]
  ```
- **KV Cookie 缓存（可选）**：配置 `KV_ADMIN_URL` / `KV_ADMIN_PASS` 两个 Secret 后启用 cookie 缓存——先注入 Worker 里的 cookie 尝试免登录，失效才重新登录并把新 cookie 存回 Worker（所有项目共用同一套 KV 配置，cookie key 为 `zampto_cookie_<用户名>`）。详见上方 KV Admin Worker 部署说明。
- **代理 / Telegram**：复用同一套 `V2RAY_VMESS` / `HTTP_PROXY` / `TG_*` Secret。
- **触发**：每天北京时间凌晨 3 点，或手动 "Run workflow" (选 `Zampto Auto Renew`)。截图在 `zampto-screenshots` artifact。

---

## 🎮 Gaming4Free 每日签到 (附加)

`control.gaming4free.net` 仅支持 Google / Discord OAuth 登录，**无法在 GitHub Actions 中自动化登录**。采用 **KV Cookie 缓存**方案：首次手动登录后导出 cookie 上传到 KV Admin Worker，之后脚本每日自动签到。

### 首次配置

1. **在本地浏览器登录** `https://control.gaming4free.net`（用 Google 或 Discord）
2. **导出 Cookie**：用 Cookie-Editor 等扩展导出 `control.gaming4free.net` 的 cookie JSON
3. **上传到 KV Admin 面板**：打开 KV Cookie 管理后台 → **新增** → 选择 `Gaming4Free` → 填写标识 `g4f_user` → 粘贴 cookie JSON → **保存**

   > 或者用命令行上传：
   > ```bash
   > curl -X POST "$KV_ADMIN_URL/api/set" \
   >   -H "X-Admin-Pass: $KV_ADMIN_PASS" \
   >   -H "Content-Type: application/json" \
   >   -d '{"key":"gaming4free_cookie_g4f_user","value":'\'$(cat cookies.json)\''}'
   > ```

4. **手动触发一次** Actions 中的 `Gaming4Free Daily Check-in` 验证签到是否成功

### 后续

- 脚本每天自动打开 `https://control.gaming4free.net/create-free-server`，查找签到弹窗并点击签到按钮
- 签到成功/失败会发 Telegram 通知（含截图）
- **cookie 过期时**，脚本会发送 TG 通知提醒你重新导出 cookie 并上传

### 需要配置的 Secret

| Secret | 说明 |
|--------|------|
| `KV_ADMIN_URL` | KV Admin Worker 地址 |
| `KV_ADMIN_PASS` | 管理员密码 |
| `V2RAY_VMESS` | （可选）v2ray 节点 |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | Telegram 通知 |

---

## 🎮 Gaming4Free 服务器自动续时 (附加)

服务器免费额度 48 小时上限，脚本每 5 分钟自动点击 `+ 90 min` 按钮延长运行时间，避免到期停止。

- **配置**: 在 GitHub Secrets 中添加 `G4F_SERVER_URLS`，值为服务器管理 URL（逗号分隔多台）：
  ```
  https://control.gaming4free.net/server/982a3aff/console,https://control.gaming4free.net/server/xxxx/console
  ```
- **cookie**: 与签到共用 `gaming4free_cookie_g4f_user`（需先在签到流程中配置好）
- **冷却**: `+ 90 min` 按钮点击后有冷却时间（约 5 分钟），脚本在冷却期间不会重复点击，仅跳过
- **通知**:
  - ✅ 续时成功 → 显示剩余时间 + 截图
  - ⏳ 冷却中 → 跳过，不发通知（全部冷却中才汇总提醒）
- **触发**: 每 5 分钟自动运行，也可在 Actions 手动触发 `Gaming4Free Server Extend`

---

## 🇰🇷 Weirdhost 续期 (附加)

`hub.weirdhost.xyz` 是韩文 Pterodactyl 面板，打开有 **Cloudflare 全屏验证**（脚本 CDP 点击通过），登录需勾选同意框并点 `로그인`，续期在服务器页点 `연장하기`（未到时间按钮禁用）。

> ⚠️ **登录有 Google reCAPTCHA（会弹"选公交车"图片挑战），无法自动破解。** 因此采用 **KV Admin Worker 缓存登录 cookie**：首次手动登录后通过 Worker API 把 cookie 存进 KV，之后每次工作流注入 cookie **免登录**直接续期；仅当 cookie 失效才需重新登录（脚本会发 TG 提醒你手动更新）。weirdhost 登录态长期有效，所以基本一劳永逸。

- **账号 Secret `WEIRDHOST_USERS_JSON`**（一个账号多台服务器用 `serverUrls` 数组列出；单台也可用 `serverUrl`）：
  ```json
  [{"username": "a@b.com", "password": "pwd", "serverUrls": [
    "https://hub.weirdhost.xyz/server/e7681d43",
    "https://hub.weirdhost.xyz/server/81a4f4ab"
  ]}]
  ```
  > 每台服务器单独续期、单独发 TG 通知（含服务器 ID + 到期时间 + 截图）。`serverUrls`/`serverUrl` 都不填时会登录后自动发现账号下所有服务器。
- **KV Cookie 缓存**：配置 `KV_ADMIN_URL` / `KV_ADMIN_PASS` 两个 Secret 后启用（详见上方 KV Admin Worker 部署说明）。cookie key 为 `weirdhost_cookie_<用户名>`。
- **初始化 cookie（首次，只需手动一次）**：
  1. 在真实浏览器登录 `hub.weirdhost.xyz`；
  2. 用 Cookie-Editor 等扩展把 `hub.weirdhost.xyz` 的 cookie **Export as JSON** 存为 `cookies.json`；
  3. 通过 KV Admin Worker API 上传：
     ```bash
     curl -X POST "$KV_ADMIN_URL/api/set" \
       -H "X-Admin-Pass: $KV_ADMIN_PASS" \
       -H "Content-Type: application/json" \
       -d '{"key":"weirdhost_cookie_ql_282820_xyz","value":'\'$(cat cookies.json)\''}'
     ```
     或用浏览器打开 KV Cookie 管理面板 → 新增 → 选择 Weirdhost → 填写标识 → 粘贴 cookie JSON → 保存。
- **代理 / Telegram**：复用同一套 `V2RAY_VMESS` / `HTTP_PROXY` / `TG_*` Secret。
- **触发**：每天北京时间凌晨 1 点，或手动 "Run workflow" (选 `Weirdhost Auto Renew`)。截图在 `weirdhost-screenshots` artifact。

---

## 🎰 hcnsec (iamhc) 每日签到续期 (附加)

`api.hcnsec.cn` 是基于 [NewAPI](https://github.com/songquanpeng/new-api) 的 OpenAI API 代理面板，每日签到可获取免费额度。此脚本**批量处理多账户**自动签到，每日续额度。

### 📦 配置 Secret

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 说明 |
|--------|------|
| `hcnsec_USERS_JSON` | 多账户 JSON 数组（必填，格式见下方） |
| `TG_BOT_TOKEN` | Telegram Bot Token（可选，用于推送通知） |
| `TG_CHAT_ID` | Telegram Chat ID（可选，全局推送汇总结果） |

### 📝 hcnsec_USERS_JSON 格式

```json
[
  {"email": "user1@example.com", "password": "pass123"},
  {"email": "user2@example.com", "password": "pass456"},
  {"email": "user3@example.com", "password": "pass789", "tg_chat_id": "独立推送ID"}
]
```

- **`email`** / **`password`**：登录凭据（必填）
- **`tg_chat_id`**：（可选）为该账户单独推送签到结果，优先级高于全局 `TG_CHAT_ID`

### ⚙️ 工作流说明

- **Workflow 名称**：`hcnsec Multi-User Renewal`
- **触发时间**：每天 **北京时间 06:00 (UTC 22:00)**（与 Katabump 主续期错开时段）
- **手动触发**：Actions 页面 → `hcnsec Multi-User Renewal` → **Run workflow**
- **脚本**：`checkin_multi.py`（基于 `requests`，轻量无浏览器依赖）
- **清理**：自动删除 2 次前的旧运行记录，保持 Actions 列表整洁

### 工作流程

1. 读取 `hcnsec_USERS_JSON` 解析多组账户
2. 对每个账户：登录 → 查看余额 → 执行签到 → 查看签到后余额
3. 汇总所有结果，通过 Telegram 推送通知（全局 + 独立推送）
4. 账户间间隔 3 秒避免触发风控

---

## 🎰 pie-xian 每日签到续期 (附加)

`api.pie-xian.com` 同样是基于 NewAPI 的面板，复用 `checkin_multi.py` 脚本，通过 `BASE_URL` 环境变量切换目标站点。

### 📦 配置 Secret

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 说明 |
|--------|------|
| `PIEXIAN_USERS_JSON` | 多账户 JSON 数组（必填，格式同 hcnsec） |
| `TG_BOT_TOKEN` | Telegram Bot Token（可选，用于推送通知） |
| `TG_CHAT_ID` | Telegram Chat ID（可选，全局推送汇总结果） |

### 📝 PIEXIAN_USERS_JSON 格式

```json
[
  {"email": "user1@example.com", "password": "pass123"},
  {"email": "user2@example.com", "password": "pass456", "tg_chat_id": "独立推送ID"}
]
```

### ⚙️ 工作流说明

- **Workflow 名称**：`pie-xian Daily Checkin`
- **触发时间**：每天 **北京时间 05:30 (UTC 21:30)**（与 hcnsec 错开时段）
- **手动触发**：Actions 页面 → `pie-xian Daily Checkin` → **Run workflow**
- **脚本**：`checkin_multi.py`（同一脚本，`BASE_URL=https://api.pie-xian.com`）

---

## 🎰 Agent Router 每日登录签到 (附加)

`agentrouter.org` 同样是基于 NewAPI 的面板，但**无独立的签到 API**。每次成功登录即视为当日签到。使用独立脚本 `checkin_agentrouter.py`。

### 📦 配置 Secret

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 说明 |
|--------|------|
| `AGENTROUTER_USERS_JSON` | 多账户 JSON 数组（必填） |
| `TG_BOT_TOKEN` | Telegram Bot Token（可选） |
| `TG_CHAT_ID` | Telegram Chat ID（可选，全局推送汇总结果） |

### 📝 AGENTROUTER_USERS_JSON 格式

```json
[
  {"email": "user1@example.com", "password": "pass123"},
  {"email": "user2@example.com", "password": "pass456", "tg_chat_id": "独立推送ID"}
]
```

### ⚙️ 工作流说明

- **Workflow 名称**：`Agent Router Daily Login`
- **触发**：仅手动（Actions 页面 → `Agent Router Daily Login` → **Run workflow**）
- **脚本**：`checkin_agentrouter.py`（登录即签到，无 checkin API）
