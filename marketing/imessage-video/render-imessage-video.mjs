// Renders the "locked in" iMessage marketing video via postmock.com and saves
// the MP4 next to this script. Edit SCRIPT below to change the dialogue, then
// run from the repo root: node marketing/imessage-video/render-imessage-video.mjs
//
// PostMock renders anonymously in the browser; this pulls the finished blob
// straight from the render session. The photo bubble uses forge-plant-bubble.png
// (regenerate it with capture-forge-bubble.mjs).
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT = [
  ['You', 'miss you bro, you been so locked in, what have you been working on?'],
  ['Them', 'one sec, sending you something'],
  ['Them', 'PHOTO'],
  ['You', 'bro what'],
  ['You', 'you typed a sentence and it put a 3D model in your room??'],
  ['Them', 'yeah. text to 3D, straight into AR. about 30 seconds end to end'],
  ['You', 'how long have you been sitting on this'],
  ['Them', 'eight months heads down. we partnered with OpenAI last week, it\'s live in ChatGPT now'],
  ['You', 'wait, actual OpenAI'],
  ['Them', 'actual OpenAI. search three.ws in the GPT Store'],
  ['You', 'ok so what\'s the ceiling here'],
  ['Them', 'unicorn is the plan. AR is how we get there'],
  ['You', 'proud of you man'],
  ['Them', 'miss you too bro. come by and I\'ll put something in your living room'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(20000);

await page.goto('https://postmock.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const clear = await page.$('button:has-text("Clear all")');
if (clear) { await clear.click().catch(() => {}); await page.waitForTimeout(600); }

// The composer keeps this placeholder; per-row inline editors do not. Matching
// anything looser resolves to a row editor once messages exist and corrupts the thread.
const input = page.locator('input[placeholder*="choose a side" i], textarea[placeholder*="choose a side" i]').first();
let photoRowIndex = -1;
let idx = 0;
for (const [side, text] of SCRIPT) {
  if (text === 'PHOTO') {
    await input.fill('.');
    photoRowIndex = idx;
  } else {
    await input.fill(text);
  }
  await page.locator(`button:has-text("Add as ${side}")`).click();
  await page.waitForTimeout(250);
  idx++;
}
console.log('messages added:', idx, 'photo row:', photoRowIndex);

const moreButtons = page.locator('button:has-text("⋯")');
await moreButtons.nth(photoRowIndex).scrollIntoViewIfNeeded();
await moreButtons.nth(photoRowIndex).click();
await page.waitForTimeout(800);

const fileInput = page.locator('input[type="file"]').last();
await fileInput.setInputFiles(join(HERE, 'forge-plant-bubble.png'));
await page.waitForTimeout(1200);
console.log('photo bubble attached');

const bang = page.locator('button:has-text("‼️")').last();
if (await bang.isVisible().catch(() => false)) {
  await bang.click();
  console.log('reaction set');
}

const candidates = page.locator('button:has-text("Export as video")');
const n = await candidates.count();
for (let i = 0; i < n; i++) {
  const btn = candidates.nth(i);
  if (await btn.isVisible()) { await btn.scrollIntoViewIfNeeded(); await btn.click(); break; }
}
await page.waitForTimeout(1200);
await page.locator('button:has-text("Create video")').click();
console.log('rendering...');

let done = false;
for (let i = 0; i < 110 && !done; i++) {
  await page.waitForTimeout(5000);
  done = await page.locator('button:has-text("Sign in to download")').isVisible().catch(() => false);
}
if (!done) throw new Error('render did not finish within the polling window');

const media = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map(v => ({ src: v.src || v.currentSrc, duration: v.duration, w: v.videoWidth, h: v.videoHeight })));
const blobVid = media.find(m => m.src && m.src.startsWith('blob:'));
if (!blobVid) throw new Error('no rendered video blob found on the page');

const b64 = await page.evaluate(async (src) => {
  const blob = await (await fetch(src)).blob();
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), type: blob.type, size: blob.size };
}, blobVid.src);
const ext = b64.type.includes('mp4') ? 'mp4' : 'webm';
writeFileSync(join(HERE, `imessage-locked-in.${ext}`), Buffer.from(b64.b64, 'base64'));
console.log(`saved imessage-locked-in.${ext} size=${b64.size} duration=${blobVid.duration}s ${blobVid.w}x${blobVid.h}`);
await browser.close();
