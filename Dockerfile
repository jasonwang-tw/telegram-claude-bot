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

CMD ["node", "index.js"]
