FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# 憑證由 Zeabur Volume 掛載至 /root/.claude/
CMD ["node", "index.js"]
