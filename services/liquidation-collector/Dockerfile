# Always-on collector for public futures liquidation streams (Binance/Bybit/OKX).
# Runs on Cloud Run with min-instances=1 — the process holds three long-lived
# WebSockets, which serverless request-scoped functions cannot (see README.md).
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
