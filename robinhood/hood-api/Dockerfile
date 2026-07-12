# syntax=docker/dockerfile:1

# ---- deps + build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Assumes `hoodchain` is published to npm (see README "Local development" for
# the pre-publish alternative — a monorepo-context build that installs the
# sibling SDK from source instead of the registry).
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime (distroless, no shell, no package manager) ----
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run / most PaaS inject PORT; the app reads it via env.ts (default 8787).
ENV PORT=8080
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["dist/src/index.js"]
