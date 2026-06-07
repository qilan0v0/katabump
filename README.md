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

6. **(可选) Telegram 消息推送**:
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

项目中有一个 `login.json.template` 模板文件。

1. 将其**重命名**为 `login.json`。
2. 用记事本或编辑器打开，填入你的账号密码：
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

* `renew.js`: Windows 本地运行的主程序。
* `action_renew.js`: 专门用于 GitHub Actions 环境的脚本（适配 Linux/Headless）。
* `.github/workflows/renew.yml`: GitHub Actions 的定时任务配置文件。
* `.github/scripts/gen-v2ray-config.js`: 把 `vmess://` / `vless://` 分享链接解析为带本地 HTTP 入站的 v2ray 配置。
* `lunes_login.js`: Lunes Host (`betadash.lunes.host`) 登录保活脚本（云端，登录过 Cloudflare Turnstile 后进 dashboard 截图通知）。
* `.github/workflows/lunes.yml`: Lunes 登录保活的定时任务（每天北京时间 09:00）。
* `login.json`: (需手动创建) 存放本地运行的账号信息。

---

## 🌙 Lunes Host 登录保活 (附加)

防止 Lunes Host 账号因长期不活跃被重置密码，每天自动登录一次进 dashboard 并发 Telegram 通知。

- **账号 Secret**：新建 `LUNES_USERS_JSON`，格式同 `USERS_JSON`：
  ```json
  [{"username": "a@b.com", "password": "pwd"}, {"username": "c@d.com", "password": "pwd2"}]
  ```
- **验证码**：登录页是 **Cloudflare Turnstile**，脚本通过 CDP 模拟点击绕过。
- **代理 / Telegram**：复用同一套 `V2RAY_VMESS` / `HTTP_PROXY` / `TG_BOT_TOKEN` / `TG_CHAT_ID` / `TG_THREAD_ID` Secret。
- **触发**：每天定时，或在 Actions 页手动 "Run workflow" (选 `Lunes Auto Login`)。截图在 `lunes-screenshots` artifact。
