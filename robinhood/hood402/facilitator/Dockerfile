# Build context is the repo root (robinhood/hood402/), because the facilitator
# depends on the sibling `hood402` package:
#   docker build -f facilitator/Dockerfile -t hood402-facilitator .
FROM node:22-slim AS build
WORKDIR /repo

# 1. Build the core protocol package and pack it into a tarball so the
#    facilitator installs a real copy (not a symlink out of the build context).
COPY package.json tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm install && npm run build && npm pack --pack-destination /tmp

# 2. Build the facilitator against that tarball.
WORKDIR /repo/facilitator
COPY facilitator/package.json facilitator/tsconfig.json ./
RUN CORE_TARBALL=$(ls /tmp/hood402-*.tgz) && npm pkg set dependencies.hood402="file:$CORE_TARBALL"
RUN npm install
COPY facilitator/src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/facilitator/node_modules ./node_modules
COPY --from=build /repo/facilitator/dist ./dist
COPY facilitator/package.json ./package.json

RUN mkdir -p /app/data && useradd --system --uid 10001 hood402 && chown -R hood402 /app
USER hood402

EXPOSE 4021
ENV PORT=4021
ENV LEDGER_PATH=/app/data/hood402-ledger.sqlite

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4021)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "dist/index.js"]
