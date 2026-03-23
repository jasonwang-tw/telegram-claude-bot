# Telegram Claude Bot — 部署紀錄

在 Zeabur 雲端部署 Claude Code Telegram Bot，使用 Claude.ai 訂閱 OAuth 驗證。

---

## 架構

```
Telegram User
     ↓
telegraf v4（polling）
     ↓
execFile('claude', ['--print', prompt])
     ↓
~/.claude/.credentials.json（OAuth Token）
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
| 憑證 | Volume `claude-creds` 掛載至 `/root/.claude/` |
| Bot | `@CCZeabur_bot` |

---

## 部署步驟

### 1. 確認本地 OAuth 憑證

```bash
cat ~/.claude/.credentials.json
# 確認 subscriptionType: pro，expiresAt 有效
```

### 2. 上傳憑證到 Zeabur 主機

```bash
ssh Zeabur "mkdir -p ~/.claude"
scp ~/.claude/.credentials.json Zeabur:~/.claude/.credentials.json
```

### 3. 建立 GitHub Repo 並推送程式碼

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://<token>@github.com/jasonwang-tw/telegram-claude-bot.git
git push -u origin master
```

### 4. Zeabur Dashboard 操作

1. 進入專案 → **Add Service** → **Git** → 選 `telegram-claude-bot`
2. **環境變數** 分頁新增：
   ```
   TELEGRAM_BOT_TOKEN=<token>
   ALLOWED_USER_IDS=<your_user_id>
   ```
3. **硬碟** 分頁新增 Volume：
   - 硬碟 ID：`claude-creds`
   - 掛載目錄：`/root/.claude`

### 5. 將憑證寫入 Volume PVC

```bash
# 找 PVC 名稱
ssh Zeabur "sudo k3s kubectl get pvc -n environment-69bfc6c576bc68ba374ca9f3"

# 複製憑證到 PVC 路徑
ssh Zeabur "sudo cp ~/.claude/.credentials.json \
  /var/lib/rancher/k3s/storage/<pvc-dir>/.credentials.json"

# 重啟服務
ssh Zeabur "sudo k3s kubectl rollout restart deployment \
  -n environment-69bfc6c576bc68ba374ca9f3"
```

---

## 檔案結構

```
telegram-claude-bot/
├── index.js          # Bot 主程式（telegraf v4）
├── package.json      # 依賴：telegraf
├── Dockerfile        # Node.js + ca-certificates + claude CLI
├── .env              # 本地測試用（不進 Git）
├── .env.example
└── .gitignore
```

---

## Dockerfile

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm install -g @anthropic-ai/claude-code

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_OPTIONS=--dns-result-order=ipv4first

CMD ["node", "index.js"]
```

> `ca-certificates` 必須安裝；`--dns-result-order=ipv4first` 修復 K3s 容器 IPv6 路由不通導致的 ETIMEDOUT。

---

## 對話記憶機制

- 每個 user 維護獨立歷史（`Map<userId, history[]>`）
- 最多保留 20 則
- `/clear` 指令清除記憶
- 歷史以純文字前綴方式傳入 `claude --print`

---

## 問題排除紀錄

| 問題 | 原因 | 解法 |
|------|------|------|
| `ERR_MODULE_NOT_FOUND` | ESM import `@anthropic-ai/claude-code` 失敗 | 改用 CommonJS + subprocess `execFile('claude')` |
| `EFATAL: Telegram Bot Token not provided` | 環境變數未設定 | Zeabur 環境變數分頁新增 `TELEGRAM_BOT_TOKEN` |
| `EFATAL: AggregateError`（舊版） | `node-telegram-bot-api` 0.66 用 `@cypress/request`，在 Node 20 有 TLS 相容問題 | 改用 `telegraf` v4 |
| `FetchError: ETIMEDOUT` | K3s pod 預設嘗試 IPv6，但容器 IPv6 路由不通 | Dockerfile 加 `ENV NODE_OPTIONS=--dns-result-order=ipv4first` |
| `claude --print` 無 auth | Volume 憑證未複製 | `kubectl get pvc` 找路徑後手動 `cp` |
| Volume ID 驗證錯誤 | Zeabur 硬碟 ID 不可留空 | 填入任意名稱如 `claude-creds` |

---

## OAuth 憑證更新

Token 約 1 年後過期（`expiresAt` 欄位）。到期後：

```bash
# 本地重新登入
claude  # 完成 OAuth

# 重新上傳
scp ~/.claude/.credentials.json Zeabur:~/.claude/.credentials.json

# 複製到 PVC（路徑同上）
ssh Zeabur "sudo cp ~/.claude/.credentials.json /var/lib/rancher/k3s/storage/<pvc-dir>/.credentials.json"

# 重啟
ssh Zeabur "sudo k3s kubectl rollout restart deployment -n environment-69bfc6c576bc68ba374ca9f3"
```
