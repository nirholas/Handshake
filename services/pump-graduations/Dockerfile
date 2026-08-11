FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js carbon-source.js graduation-event.js token-info.js ./
CMD ["node", "index.js"]
