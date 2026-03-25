FROM node:20-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 全域安裝 Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# 安裝 bot 依賴
COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_OPTIONS=--dns-result-order=ipv4first

# 啟動時還原 Claude 認證（三層 fallback）：
# 1. 優先從環境變數還原
# 2. 若無環境變數，從備份目錄還原最新備份
# 3. 若無備份，建立最小設定檔
CMD ["sh", "-c", "\
  mkdir -p /root/.claude && \
  if [ -n \"$CLAUDE_CREDENTIALS\" ]; then \
    echo \"$CLAUDE_CREDENTIALS\" | base64 -d > /root/.claude/.credentials.json; \
  fi && \
  if [ -n \"$CLAUDE_CONFIG\" ]; then \
    echo \"$CLAUDE_CONFIG\" | base64 -d > /root/.claude.json; \
  elif [ ! -f /root/.claude.json ]; then \
    LATEST=$(ls -t /root/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1); \
    if [ -n \"$LATEST\" ]; then \
      cp \"$LATEST\" /root/.claude.json; \
    else \
      echo '{\"hasCompletedOnboarding\":true}' > /root/.claude.json; \
    fi; \
  fi && \
  node index.js"]
