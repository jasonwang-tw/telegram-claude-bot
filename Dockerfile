FROM node:20-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 全域安裝 Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# 安裝 bot 依賴
COPY package*.json ./
RUN npm install

COPY . .

# 建立非 root 使用者與 claude 設定目錄
RUN useradd -m -s /bin/sh botuser && \
    mkdir -p /home/botuser/.claude && \
    echo '{"hasCompletedOnboarding":true}' > /home/botuser/.claude.json && \
    chown -R botuser:botuser /home/botuser /app

ENV NODE_OPTIONS=--dns-result-order=ipv4first

# 以 root 啟動，再用 su 切換到 botuser 執行 node（繞過 Zeabur 強制 root 問題）
CMD ["sh", "-c", "su -p -s /bin/sh botuser -c 'HOME=/home/botuser node /app/index.js'"]
