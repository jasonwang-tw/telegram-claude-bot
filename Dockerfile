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

# 啟動時：若 .claude.json 不存在則從最新備份還原，再執行 bot
CMD ["sh", "-c", "[ -f /root/.claude.json ] || cp $(ls -t /root/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1) /root/.claude.json 2>/dev/null; node index.js"]
