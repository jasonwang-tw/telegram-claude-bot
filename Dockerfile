FROM node:20-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 全域安裝 Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# 安裝 bot 依賴
COPY package*.json ./
RUN npm install

COPY . .

# 建立 claude 設定目錄（使用 node 使用者，非 root）
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude /app

ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENV HOME=/home/node

USER node

# 啟動時先建立 .claude.json 再執行 bot
CMD ["sh", "-c", "echo '{\"hasCompletedOnboarding\":true}' > /home/node/.claude.json && node index.js"]
