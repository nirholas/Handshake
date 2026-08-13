FROM node:20-alpine
WORKDIR /app
# Copy the lockfile too: `npm ci` installs the exact tree this service is tested
# against, instead of silently resolving newer minors at image-build time.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js carbon-source.js graduation-event.js token-info.js ./
CMD ["node", "index.js"]
