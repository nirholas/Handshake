# syntax=docker/dockerfile:1
# Agent Screen Caster: Playwright Chromium runner.
# Base: official Playwright image ships Chromium + all system deps pre-installed.
# The tag MUST match the exact playwright version pinned in package.json. The
# image bakes one Chromium build under /ms-playwright and the npm package only
# looks for the revision it was published with, so a floating range here means
# "Executable doesn't exist at /ms-playwright/chromium-<rev>" at container boot.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install Node dependencies first (layer cached unless package.json changes).
COPY package.json ./
RUN npm install --omit=dev

# Copy service source.
COPY . .

# Playwright browsers are already baked into the base image at /ms-playwright.
# Tell playwright to use the system-installed Chromium rather than downloading.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Default env (override at runtime via --env or -e flags).
ENV NODE_ENV=production \
    HEADLESS=true \
    FRAME_INTERVAL_MS=400 \
    JPEG_QUALITY=72 \
    TASK=pump-monitor

# Run as non-root (the Playwright base image provides the pwuser account).
USER pwuser

CMD ["node", "index.js"]
