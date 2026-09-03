FROM node:22-alpine
WORKDIR /app
# Copy the lockfile too: `npm ci` installs the exact tree this service is tested
# against, instead of silently resolving newer minors at image-build time.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY allowlist.json ./allowlist.json
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
