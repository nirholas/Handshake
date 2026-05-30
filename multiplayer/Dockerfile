# Production image for the three.ws multiplayer Colyseus server.
#
# Build & run locally:
#   docker build -t three-ws-multiplayer .
#   docker run --rm -p 2567:2567 three-ws-multiplayer
#
# Deploy to Fly.io:
#   fly launch --no-deploy   # accepts the included fly.toml
#   fly deploy

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs the exact, pre-resolved versions from package-lock.json.
# The lock pins Colyseus to a set that uses @colyseus/ws-transport and never
# pulls uWebSockets.js (an optional transport that resolves to a git ssh ref
# the slim image can't fetch). --omit=optional keeps that guarantee.
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=2567
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||2567)+'/health', (r) => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/index.js"]
