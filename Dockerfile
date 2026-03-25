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

# 啟動時從環境變數還原 Claude 認證檔案，再執行 bot
CMD ["sh", "-c", "\
  mkdir -p /root/.claude && \
  [ -n \"$CLAUDE_CREDENTIALS\" ] && echo \"$CLAUDE_CREDENTIALS\" | base64 -d > /root/.claude/.credentials.json; \
  [ -n \"$CLAUDE_CONFIG\" ] && echo \"$CLAUDE_CONFIG\" | base64 -d > /root/.claude.json; \
  node index.js"]
