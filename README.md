# Telegram Claude Bot — 部署紀錄

在 Zeabur 雲端部署 Claude Code Telegram Bot，使用 Claude.ai 訂閱 OAuth 驗證。

**版本：1.4.0**

---

## 架構

```
Telegram User
     ↓
telegraf v4（polling）
     ↓
spawn('claude', ['--print', '--add-dir', '/root'])  ← prompt 透過 stdin 傳入
     ↓
需要授權時 → Telegram inline keyboard [✅ Allow] [❌ Deny]
     ↓
~/.claude/.credentials.json（OAuth Token，從環境變數還原）
     ↓
Claude.ai Pro 訂閱（OAuth 自動 refresh，無需手動更新）
```

---

## 元件

| 元件 | 說明 |
|------|------|
| Zeabur 服務 | Docker 容器，project `69bfc6c5` |
| Node.js | v20-slim + ca-certificates |
| Claude Code CLI | 全域安裝 `@anthropic-ai/claude-code` |
| Telegram 框架 | `telegraf` v4（原生 fetch，穩定） |
| 憑證 | 環境變數 `CLAUDE_CREDENTIALS` / `CLAUDE_CONFIG`（base64）|
| Bot | `@CCZeabur_bot` |
| 授權機制 | Telegram inline keyboard（Allow / Deny 按鈕，60 秒逾時自動拒絕）|

---

## 環境變數

| 變數 | 說明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `ALLOWED_USER_IDS` | 允許使用的 Telegram User ID（逗號分隔） |
| `CLAUDE_CREDENTIALS` | `~/.claude/.credentials.json` 的 base64 編碼 |
| `CLAUDE_CONFIG` | `~/.claude.json`（含 oauthAccount）的 base64 編碼 |

---

## 部署步驟

### 1. 準備本機憑證

```bash
# 確認本機 Claude 已登入且 token 有效
cat ~/.claude/.credentials.json
# 確認 subscriptionType: pro，expiresAt 未過期
```

### 2. 產生環境變數值

```bash
# 產生 CLAUDE_CREDENTIALS
cat ~/.claude/.credentials.json | base64 -w 0

# 產生 CLAUDE_CONFIG（只取必要欄位）
node -e "
const fs = require('fs');
const local = JSON.parse(fs.readFileSync(process.env.HOME + '/.claude.json', 'utf8'));
const minimal = {
  hasCompletedOnboarding: true,
  opusProMigrationComplete: true,
  sonnet1m45MigrationComplete: true,
  userID: local.userID,
  oauthAccount: local.oauthAccount
};
process.stdout.write(Buffer.from(JSON.stringify(minimal)).toString('base64'));
"
```

### 3. Zeabur Dashboard 設定環境變數

進入專案 → telegram-claude-bot → **Variables** 分頁，新增：

```
TELEGRAM_BOT_TOKEN=<token>
ALLOWED_USER_IDS=<your_user_id>
CLAUDE_CREDENTIALS=<base64 from step 2>
CLAUDE_CONFIG=<base64 from step 2>
```

### 4. 推送程式碼觸發部署

```bash
git push origin master
# Zeabur 自動 build + deploy
```

---

## 啟動流程（Dockerfile CMD）

容器啟動時依序執行：

1. 建立 `/root/.claude/` 目錄
2. 若 `CLAUDE_CREDENTIALS` 存在 → base64 解碼寫入 `/root/.claude/.credentials.json`
3. 若 `CLAUDE_CONFIG` 存在 → base64 解碼寫入 `/root/.claude.json`
4. 若 `.claude.json` 不存在 → 從備份目錄還原最新備份
5. 若備份也不存在 → 建立最小設定 `{"hasCompletedOnboarding":true}`
6. 執行 `node index.js`

---

## 檔案結構

```
telegram-claude-bot/
├── index.js          # Bot 主程式
├── package.json      # 依賴：telegraf
├── Dockerfile        # Node.js + claude CLI + 三層憑證還原
├── CLAUDE.md         # Claude Code 容器環境說明（提供給 CLI 的 context）
├── .env              # 本地測試用（不進 Git）
├── .env.example
└── .gitignore
```

---

## index.js 重點說明

### 呼叫 Claude CLI

使用 `spawn` + stdin，加入 `--add-dir /root` 讓 Claude 可存取 `/root/` 下的憑證與設定：

```js
const child = spawn('claude', ['--print', '--add-dir', '/root'], {
  env: { ...process.env },
});
```

### 授權機制（Telegram Inline Keyboard）

偵測到授權提示時，向使用者發送帶有按鈕的訊息，等待確認：

```js
const PERMISSION_PATTERN = /\(y\)es\s*\/\s*\(n\)o|\(y\/n\)|\[y\/n\]|\(yes\/no\)|press enter|continue\?|Allow\s+.+\?|Do you want to allow|bash command:|wants to (read|write|run|execute|edit)/i;

// 偵測到授權請求時
await ctx.reply(
  `🔐 *需要授權*\n\`\`\`\n${permissionText.slice(0, 500)}\n\`\`\``,
  {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Allow', callback_data: `perm_allow_${permId}` },
        { text: '❌ Deny', callback_data: `perm_deny_${permId}` },
      ]],
    },
  }
);

// 60 秒無回應自動拒絕
setTimeout(() => {
  if (pendingPermissions.has(permId)) {
    pendingPermissions.delete(permId);
    child.stdin.write('n\n');
    resolve(false);
  }
}, 60000);
```

### 對話記憶

- 每個 user 獨立歷史（`Map<userId, history[]>`）
- 最多保留 20 則
- `/clear` 清除記憶

---

## CLAUDE.md — 容器環境說明

`CLAUDE.md` 放在 `/app/`（工作目錄），讓 Claude Code CLI 了解容器環境：

```markdown
# Bot 環境說明

你是一個運行在 Docker 容器內的 Telegram Bot，透過 Claude Code CLI 提供服務。

## 環境資訊

- 工作目錄：`/app`（Bot 程式碼）
- 使用者目錄：`/root`（你有完整存取權限）
- Claude 憑證：`/root/.claude/.credentials.json`
- Claude 設定：`/root/.claude.json`

## 行為準則

- **直接執行**：你可以直接讀取 `/root/` 下的所有檔案，不需要請使用者複製或手動操作
- **不要叫使用者執行指令**：你有工具可以直接完成，就直接做
- **路徑要完整**：存取 `/root/.claude/` 相關檔案時，使用完整絕對路徑
- **語言**：用使用者發訊息的語言回覆
```

---

## OAuth 憑證管理

### 自動 Refresh（正常運作時）

Bot 在每次呼叫 `claude --print` 時會**自動刷新** OAuth access token（透過 refreshToken），無需定時腳本或手動介入。refreshToken 有效期較長，正常使用下不需更新環境變數。

### 手動更新（refreshToken 過期時）

若出現 `401 OAuth token has expired` 且 bot 無法自動恢復：

```bash
# 1. 本機重新登入 Claude
claude auth login

# 2. 產生新的 base64 值
cat ~/.claude/.credentials.json | base64 -w 0

# 3. 到 Zeabur Dashboard 更新 CLAUDE_CREDENTIALS 環境變數
# → Variables → CLAUDE_CREDENTIALS → 貼上新值 → 儲存（觸發重新部署）
```

### Bot 獨立 OAuth Session

Bot 擁有獨立的 OAuth session，與本機互不影響：

```bash
# 複製憑證到 bot 後，本機登出再重新登入，建立獨立 session
claude auth logout
claude auth login
```

這樣 token rotation 不會互相失效。

> ⚠️ Zeabur 容器以 root 執行，無法在容器內進行 OAuth 登入（`claude.ai` 被 Cloudflare 封鎖容器 IP）。憑證必須從本機複製。

---

## 問題排除紀錄

| 問題 | 原因 | 解法 |
|------|------|------|
| `no stdin data received in 3s` | `execFile` 未提供 stdin | 改用 `spawn` + `child.stdin.write(prompt)` |
| `--dangerously-skip-permissions` 失敗 | Zeabur 強制以 root 執行容器 | 移除此 flag，`--print` 模式不需要工具權限 |
| `.claude.json` 遺失 | Claude CLI 執行時移動設定檔到備份 | CMD 啟動時三層 fallback 自動還原 |
| `base64: invalid input` | 環境變數含換行或空白 | `printf '%s' "$VAR" \| tr -d ' \n\r' \| base64 -d` |
| `OAuth token has expired` (401) | Access token 過期，容器內無法刷新 | 從本機複製最新憑證到環境變數 |
| 容器內無法 OAuth 登入 | `claude.ai` Cloudflare 封鎖 datacenter IP | 憑證只能從本機準備後貼入環境變數 |
| `ETIMEDOUT` | K3s pod 嘗試 IPv6，路由不通 | `ENV NODE_OPTIONS=--dns-result-order=ipv4first` |
| Claude 無法存取 `/root/.claude/` | 預設工作目錄 `/app`，Claude 受限於此 | 加入 `--add-dir /root` + 建立 `CLAUDE.md` |
| Bot 與本機 token 互相失效 | 共用同一 OAuth session，token rotation 互衝 | 複製憑證後本機重新登入，建立獨立 session |
| Claude 輸出「需要你批准」而非執行 | `--print` 模式 stdin 在寫入 prompt 後立即關閉，Claude 無法接收 y/n 回應 | Dockerfile CMD 建立 `settings.json` 預授權所有工具 |
| `exit code 1`（沉默失敗） | `settings.json` 格式錯誤導致 Claude CLI 崩潰 | 移除錯誤的 settings.json；error 訊息加入 stdout 輸出 |
| 更新 Zeabur 環境變數後其他變數消失 | `updateEnvironmentVariable` data:Map 會覆蓋全部變數 | 先 query 讀取現有變數，合併後再 update |
| `fetch failed`（Zeabur API） | 端點 `gateway.zeabur.com` 不存在 | 正確端點為 `api.zeabur.com/graphql` |

---

## Changelog

## [1.4.0] - 2026-03-26
### Added
- `statusline.sh` 複製進容器，Dockerfile 安裝 `curl jq bash`
- `/usage` 改為執行 `statusline.sh`，輸出 current/weekly 用量條（去除 ANSI 色碼）
- `CLAUDE_CREDENTIALS` 自動同步至 Zeabur：每次對話後偵測 credentials 變化即更新，每 4 小時定期同步
- token 即將過期（剩不到 1 小時）時自動觸發 refresh
### Fixed
- `/usage` 移除第一行 model/context 資訊，只顯示 current/weekly 用量
- Zeabur GraphQL 正確端點 `api.zeabur.com` 及 mutation `updateEnvironmentVariable(serviceID, environmentID, data: Map!)`
- 更新前先 query 現有變數並合併，避免覆蓋其他環境變數
- `settings.json` 格式錯誤導致 Claude CLI exit code 1，已移除
- error 訊息同時顯示 stdout，方便 debug

## [1.3.2] - 2026-03-26
### Added
- 新增預設指令：`/help`、`/usage`、`/model`、`/status`、`/version`
- 透過 `setMyCommands` 註冊指令選單，在 Telegram 輸入框旁顯示
- `runCLI` 輔助函式：直接執行 CLI 指令（不經 Claude），供指令處理器使用

## [1.3.1] - 2026-03-26
### Fixed
- Dockerfile CMD 啟動時建立 `/root/.claude/settings.json`，預先授權所有工具（Bash/Read/Write/Edit 等），避免 Claude 在 `--print` 模式下因 stdin 已關閉而無法回應授權提示，導致輸出「需要你批准」文字而非直接執行
- CLAUDE.md 加入工具授權說明，告知 Claude 所有工具均已預授權

## [1.3.0] - 2026-03-25
### Added
- `CLAUDE.md`：提供容器環境說明給 Claude Code CLI（工作目錄、憑證路徑、行為準則）
- Telegram inline keyboard 授權機制：偵測到需授權操作時發送 [✅ Allow] [❌ Deny] 按鈕，60 秒無回應自動拒絕
### Changed
- `spawn` 加入 `--add-dir /root` flag，允許 Claude 讀寫 `/root/` 下的憑證與設定
- OAuth 管理：確認 bot 本身可自動 refresh token，無需定時腳本
- Bot 獨立 OAuth session：與本機分離，token rotation 互不影響

## [1.2.0] - 2026-03-25
### Changed
- 憑證改用環境變數（`CLAUDE_CREDENTIALS` / `CLAUDE_CONFIG`）取代 Volume，解決重新部署後遺失問題
- CMD 加入三層 fallback 還原 `.claude.json`（env var > backup > 最小設定）
- `base64 -d` 加 `tr -d` 清除空白，加 `|| true` 防止容器崩潰

## [1.1.0] - 2026-03-25
### Changed
- `execFile` 改為 `spawn`，prompt 透過 stdin 傳入，修正 Claude CLI stdin 逾時錯誤
- 加入互動提示自動回應邏輯（偵測 `y/n` 提示自動送出 `y`）
- 移除 `--dangerously-skip-permissions`（root 環境不可用）
- Dockerfile 改用非 root `botuser` 執行（後因 Zeabur 強制 root 而調整）

## [1.0.0] - 2026-03-23
### Added
- 初始版本：telegraf v4 + claude CLI `--print` 模式
- 多輪對話記憶（最多 20 則）
- `/clear` 清除記憶指令
- ALLOWED_USER_IDS 白名單
