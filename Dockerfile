FROM node:20-slim

RUN apt-get update && apt-get install -y ca-certificates curl jq bash && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 全域安裝 Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# 安裝 bot 依賴
COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_OPTIONS=--dns-result-order=ipv4first

CMD ["sh", "-c", "\
  mkdir -p /root/.claude && \
  { [ -n \"$CLAUDE_CREDENTIALS\" ] && printf '%s' \"$CLAUDE_CREDENTIALS\" | tr -d ' \\n\\r' | base64 -d > /root/.claude/.credentials.json 2>/dev/null || true; } && \
  if [ -n \"$CLAUDE_CONFIG\" ]; then \
    printf '%s' \"$CLAUDE_CONFIG\" | tr -d ' \\n\\r' | base64 -d > /root/.claude.json 2>/dev/null || true; \
  fi && \
  if [ ! -f /root/.claude.json ]; then \
    LATEST=$(ls -t /root/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1); \
    if [ -n \"$LATEST\" ]; then cp \"$LATEST\" /root/.claude.json; \
    else echo '{\"hasCompletedOnboarding\":true}' > /root/.claude.json; fi; \
  fi && \
  echo '{\"permissions\":{\"allow\":[\"Bash(*)\",\"Read(*)\",\"Write(*)\",\"Edit(*)\",\"MultiEdit(*)\",\"Glob(*)\",\"Grep(*)\",\"WebFetch(*)\",\"WebSearch(*)\",\"TodoWrite(*)\",\"TodoRead(*)\"]}}' > /root/.claude/settings.json && \
  node index.js"]
