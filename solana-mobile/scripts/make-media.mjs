#!/usr/bin/env node
// Generates the buildable dApp Store listing assets into publish/media/:
//   icon.png     512x512   flattened app icon (from /public/pwa-512x512.png)
//   banner.png   1200x600  logo + wordmark + tagline on the brand background
//   feature.png  1024x500  live capture of a real agent in the three.ws viewer
// The five 1080x1920 screenshots are NOT generated here: reviewers require
// real Seeker device captures (see ../docs/ASSETS.md).
//
// Usage: node solana-mobile/scripts/make-media.mjs [agent-page-url]

import sharp from 'sharp';
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'solana-mobile/publish/media');
const BG = '#080814';
mkdirSync(OUT, { recursive: true });

await sharp(path.join(ROOT, 'public/pwa-512x512.png'))
  .flatten({ background: BG })
  .resize(512, 512)
  .removeAlpha()
  .png()
  .toFile(path.join(OUT, 'icon.png'));
console.log('[make-media] icon.png');

const logoSvg = readFileSync(path.join(ROOT, 'public/pwa-icon.svg'));
const logoPng = await sharp(logoSvg).resize(320, 320).png().toBuffer();
const bannerSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600">
  <defs>
    <radialGradient id="glow" cx="30%" cy="50%" r="80%">
      <stop offset="0%" stop-color="#101030"/>
      <stop offset="100%" stop-color="${BG}"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="600" fill="url(#glow)"/>
  <text x="480" y="290" font-family="DejaVu Sans" font-size="96" font-weight="bold" fill="#ffffff">three.ws</text>
  <text x="484" y="360" font-family="DejaVu Sans" font-size="30" fill="#b8e8ff">Mint a 3D agent to your Seed Vault.</text>
  <text x="484" y="404" font-family="DejaVu Sans" font-size="30" fill="#8899bb">On-chain, Solana-native, signed by Seeker.</text>
</svg>`);
await sharp(bannerSvg)
  .composite([{ input: logoPng, left: 110, top: 140 }])
  .removeAlpha()
  .png()
  .toFile(path.join(OUT, 'banner.png'));
console.log('[make-media] banner.png');

// Default hero: first agent returned by the live marketplace API, so the
// capture always reflects real, current product UI.
let agentUrl = process.argv[2];
if (!agentUrl) {
  const res = await fetch('https://three.ws/api/marketplace/agents?limit=1');
  const body = await res.json();
  const first = body?.data?.items?.[0];
  if (!first) throw new Error('[make-media] marketplace API returned no agents to capture');
  agentUrl = `https://three.ws/agents/${first.id}`;
}
console.log(`[make-media] capturing ${agentUrl}`);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-webgl'] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
  await page.goto(agentUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);
  await page.screenshot({ path: path.join(OUT, 'feature.png') });
} finally {
  await browser.close();
}
const stats = await sharp(path.join(OUT, 'feature.png')).stats();
const means = stats.channels.map((c) => Number(c.mean.toFixed(1)));
if (means.every((m) => m < 12)) {
  throw new Error(`[make-media] feature.png looks blank (channel means ${means.join(',')}): WebGL likely failed to render; retry or pass a different agent URL`);
}
console.log(`[make-media] feature.png (channel means ${means.join(',')})`);
