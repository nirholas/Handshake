# syntax=docker/dockerfile:1

# ---- full install + typecheck/build (needs devDependencies for tsc) ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json hoodchain-0.1.0.tgz ./
# `hoodchain` isn't on the npm registry yet — package.json pins it to this
# checked-in tarball. Once published, drop the tgz and switch to "^0.1.0".
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- production-only node_modules (no typescript/vitest/tsx) ----
FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json hoodchain-0.1.0.tgz ./
RUN npm install --omit=dev

# ---- runtime (distroless, no shell, no package manager) ----
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run / most PaaS inject PORT; the app reads it via env.ts (default 8787).
ENV PORT=8080
COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["dist/src/index.js"]
