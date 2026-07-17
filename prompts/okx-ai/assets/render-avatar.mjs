// Renders avatar.html to okx-avatar-440.png: the OKX.AI listing avatar for
// agent #2632 "three.ws 3D Studio".
// OKX spec (rejection email 2026-07-17): exactly 440x440 px, square corners,
// sharp and polished. Renders at 3x device scale, downsamples with lanczos3,
// flattens to opaque RGB so no alpha edge survives.
// Run from the repo root: node prompts/okx-ai/assets/render-avatar.mjs
import { chromium } from 'playwright';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, 'okx-avatar-440.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 440, height: 440 }, deviceScaleFactor: 3 });
await page.goto('file://' + path.join(dir, 'avatar.html'));
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
const big = await page.screenshot({ type: 'png' });
await browser.close();

await sharp(big)
  .resize(440, 440, { kernel: 'lanczos3' })
  .flatten({ background: '#0a0d14' })
  .png({ compressionLevel: 9 })
  .toFile(out);

const meta = await sharp(out).metadata();
if (meta.width !== 440 || meta.height !== 440) throw new Error(`bad dimensions ${meta.width}x${meta.height}`);
if (meta.hasAlpha) throw new Error('output must be opaque');
console.log(`wrote ${out} (${meta.width}x${meta.height}, ${meta.channels} channels)`);
