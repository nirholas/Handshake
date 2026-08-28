#!/usr/bin/env node
// Generates the buildable dApp Store listing assets into publish/media/:
//   icon.png     512x512   flattened app icon (from /public/pwa-512x512.png)
//   banner.png   1200x600  brand lockup, drawn in a browser with the site fonts
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

/** Fail here rather than shipping a file the Publisher Portal will bounce. */
async function writeAsset(name, buffer, width, height, note) {
  const meta = await sharp(buffer).metadata();
  if (meta.width !== width || meta.height !== height) {
    throw new Error(`[make-media] ${name} is ${meta.width}x${meta.height}, the listing slot requires ${width}x${height}`);
  }
  if (meta.hasAlpha) throw new Error(`[make-media] ${name} carries an alpha channel; the listing slot requires an opaque PNG`);
  const file = path.join(OUT, name);
  await sharp(buffer).toFile(file);
  console.log(`[make-media] ${name}  ${width}x${height}  ${Math.round(buffer.length / 1024)} KB  (${note})`);
}

await writeAsset(
  'icon.png',
  await sharp(path.join(ROOT, 'public/pwa-512x512.png'))
    .flatten({ background: BG }).resize(512, 512).removeAlpha().png({ compressionLevel: 9 }).toBuffer(),
  512, 512, 'shipped app mark on the brand ground',
);

/* Banner: the brand lockup on the brand ground, drawn in a real browser against
   the same Space Grotesk and Inter files the site serves. An SVG rendered by
   sharp cannot see those faces and silently substitutes a system one, which
   ships a store banner whose type does not match the product. The faces are
   inlined as data URIs so the render never depends on a running server. */
const FONT_FACES = [
  ['Space Grotesk', '300 700', 'space-grotesk-latin.woff2'],
  ['Inter', '300 800', 'inter-latin.woff2'],
].map(([family, weight, file]) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(path.join(ROOT, 'public/fonts', file)).toString('base64')}) format('woff2');}`).join('\n');

const MARK_URI = `data:image/png;base64,${readFileSync(path.join(ROOT, 'public/pwa-512x512.png')).toString('base64')}`;
/* The banner says exactly what the listing's short description says, read from
   the same file, so the two can never drift. */
const [TAGLINE_A, TAGLINE_B] = readFileSync(path.join(ROOT, 'solana-mobile/publish/listing/short-description.txt'), 'utf8')
  .trim().split(/(?<=\.)\s+/);

async function renderBanner(browser) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
${FONT_FACES}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:600px;overflow:hidden;background:${BG};
  background-image:radial-gradient(80% 120% at 28% 50%, #141438 0%, #0b0b1e 45%, ${BG} 100%);
  display:flex;align-items:center;gap:64px;padding:0 104px;color:#fff;
  font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
img{width:320px;height:320px;flex:none;border-radius:64px;
  box-shadow:0 24px 80px rgba(80,140,255,.28)}
h1{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:104px;
  letter-spacing:-.045em;line-height:1}
p{font-size:30px;line-height:1.45;margin-top:28px}
p b{font-weight:500;color:#b8e8ff;display:block}
p span{color:#8899bb}
</style><body><img src="${MARK_URI}" alt=""><div><h1>three.ws</h1>
<p><b>${TAGLINE_A}</b><span>${TAGLINE_B}</span></p></div>`, { waitUntil: 'load' });

  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('600 104px "Space Grotesk"') && document.fonts.check('400 30px "Inter"');
  });
  if (!loaded) throw new Error('[make-media] brand fonts did not load; the banner would render in a fallback face');

  const shot = await page.screenshot({ type: 'png' });
  await page.close();
  return sharp(shot).flatten({ background: BG }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
}

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

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-webgl'] });
let feature;
try {
  await writeAsset('banner.png', await renderBanner(browser), 1200, 600, 'brand lockup in Space Grotesk');

  console.log(`[make-media] capturing ${agentUrl}`);
  const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
  await page.goto(agentUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);
  feature = await page.screenshot({ type: 'png' });
} finally {
  await browser.close();
}

const means = (await sharp(feature).stats()).channels.map((c) => Number(c.mean.toFixed(1)));
if (means.every((m) => m < 12)) {
  throw new Error(`[make-media] feature.png looks blank (channel means ${means.join(',')}): WebGL likely failed to render; retry or pass a different agent URL`);
}
await writeAsset(
  'feature.png',
  await sharp(feature).flatten({ background: BG }).removeAlpha().png({ compressionLevel: 9 }).toBuffer(),
  1024, 500, `live agent capture, channel means ${means.join(',')}`,
);
