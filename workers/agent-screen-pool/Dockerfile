# syntax=docker/dockerfile:1
# agent-screen-pool: on-demand Chromium caster pool.
#
# The base image ships Chromium plus every system dependency it needs. Its tag
# MUST match the playwright version pinned in package-lock.json: the image bakes
# exactly the browser build that playwright release expects, so a drifted pair
# starts fine and then dies on the first cast with
# "Executable doesn't exist at /ms-playwright/chromium-<rev>". Bump both together.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

# Lockfile-driven install so the image gets the exact playwright the base image
# was built for, not whatever the range resolves to on build day.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js control.js task-runner.js ./
COPY tasks ./tasks

# Chromium is baked into the base image at /ms-playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production \
    BASE_URL=https://three.ws \
    MAX_BROWSERS=6 \
    POLL_MS=3000 \
    FRAME_MS=700 \
    JPEG_QUALITY=58

# SCREEN_WORKER_SECRET must be supplied at runtime (-e SCREEN_WORKER_SECRET=...).
USER pwuser

CMD ["node", "index.js"]
