# agent-screen-worker, long-lived browser capture worker.
#
# Build from the worker directory:
#
#   docker build -t agent-screen-worker .
#   docker run --env-file .env agent-screen-worker
#
# Stagehand v3 drives Chrome over CDP through chrome-launcher, NOT through
# Playwright, so LOCAL browser mode needs a real Chromium on the image. The
# distro package is installed below and pointed at with CHROME_PATH.
#
# For Browserbase cloud mode the browser runs on Browserbase, so the local
# Chromium is dead weight: build with --build-arg SKIP_BROWSERS=1 for a much
# smaller image and set BROWSERBASE_API_KEY at run time.

FROM node:22-bookworm-slim

WORKDIR /app

ARG SKIP_BROWSERS=0
RUN if [ "$SKIP_BROWSERS" = "0" ]; then \
		apt-get update && \
		apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation && \
		rm -rf /var/lib/apt/lists/*; \
	fi

# chrome-launcher searches for a browser on PATH; naming the binary explicitly
# keeps it deterministic. Harmless when SKIP_BROWSERS=1, since Browserbase mode
# never launches a local browser.
ENV CHROME_PATH=/usr/bin/chromium

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "index.js"]
