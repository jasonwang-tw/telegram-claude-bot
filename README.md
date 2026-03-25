# Telegram Claude Bot — 部署紀錄

在 Zeabur 雲端部署 Claude Code Telegram Bot，使用 Claude.ai 訂閱 OAuth 驗證。

**版本：1.2.0**

---

## 架構

```
Telegram User
     ↓
telegraf v4（polling）
     ↓
spawn('claude', ['--print'])  ← prompt 透過 stdin 傳入
     ↓
~/.claude/.credentials.json（OAuth Token，從環境變數還原）
     ↓
Claude.ai Pro 訂閱
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
├── .env              # 本地測試用（不進 Git）
├── .env.example
└── .gitignore
```

---

## index.js 重點說明

### 呼叫 Claude CLI

使用 `spawn` + stdin，避免 `execFile` 的 stdin 逾時問題：

```js
const child = spawn('claude', ['--print'], {
  env: { ...process.env },
});

// 偵測互動提示，自動回應 y
const AUTO_CONFIRM = /\(y\/n\)|\[y\/n\]|\(yes\/no\)|press enter|continue\?/i;
child.stdout.on('data', (data) => {
  stdout += data;
  if (AUTO_CONFIRM.test(data.toString())) child.stdin.write('y\n');
});

child.stdin.write(prompt);
child.stdin.end();
```

### 對話記憶

- 每個 user 獨立歷史（`Map<userId, history[]>`）
- 最多保留 20 則
- `/clear` 清除記憶

---

## OAuth 憑證更新（Token 過期時）

Token 有效期約數小時至數天。過期後容器會出現 `401 OAuth token has expired`。

### 更新方式：從本機複製最新憑證

```bash
# 1. 確認本機 token 有效
node -e "const c=require(process.env.HOME+'/.claude/.credentials.json'); console.log(new Date(c.claudeAiOauth.expiresAt))"

# 2. 產生新的 base64 值
cat ~/.claude/.credentials.json | base64 -w 0

# 3. 到 Zeabur Dashboard 更新 CLAUDE_CREDENTIALS 環境變數
# → Variables → CLAUDE_CREDENTIALS → 貼上新值 → 儲存（觸發重新部署）
```

> ⚠️ Zeabur 容器以 root 執行，無法在容器內進行 OAuth 登入（`claude.ai` 被 Cloudflare 封鎖容器 IP）。憑證必須從本機複製。

---

## 問題排除紀錄

| 問題 | 原因 | 解法 |
|------|------|------|
| `no stdin data received in 3s` | `execFile` 未提供 stdin | 改用 `spawn` + `child.stdin.write(prompt)` |
| `--dangerously-skip-permissions` 失敗 | Zeabur 強制以 root 執行容器 | 移除此 flag，`--print` 模式不需要工具權限 |
| `.claude.json` 遺失 | Claude CLI 執行時移動設定檔到備份 | CMD 啟動時三層 fallback 自動還原 |
| `base64: invalid input` | 環境變數含換行或空白 | `printf '%s' "$VAR" | tr -d ' \n\r' | base64 -d` |
| `OAuth token has expired` (401) | Access token 過期，容器內無法刷新 | 從本機複製最新憑證到環境變數 |
| 容器內無法 OAuth 登入 | `claude.ai` Cloudflare 封鎖 datacenter IP | 憑證只能從本機準備後貼入環境變數 |
| `ETIMEDOUT` | K3s pod 嘗試 IPv6，路由不通 | `ENV NODE_OPTIONS=--dns-result-order=ipv4first` |

---

## Changelog

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
