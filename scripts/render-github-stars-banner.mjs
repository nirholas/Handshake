#!/usr/bin/env node
// Renders the "100 stars on GitHub" announcement graphics into docs/media/.
// Every number is passed in from the public sources named in
// docs/x-posts/github-100-stars.md; rerun with fresh values to regenerate.
//   node scripts/render-github-stars-banner.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'docs/media');
mkdirSync(outDir, { recursive: true });

const lockup = readFileSync(resolve(root, 'public/brand/three-ws-lockup-on-dark.png')).toString('base64');
const mark = readFileSync(resolve(root, 'public/brand/three-ws-mark.png')).toString('base64');

const STATS = [
  { value: '101', label: 'npm packages', sub: '@three-ws scope' },
  { value: '72', label: 'MCP servers', sub: 'official MCP registry' },
  { value: '11', label: 'contributors', sub: 'github.com/nirholas/three.ws' },
  { value: '9,508', label: 'commits', sub: 'since April 14, 2026' },
  { value: '26', label: 'forks', sub: 'and counting' },
  { value: '6,225', label: 'npm downloads', sub: 'last 30 days' },
];

function page({ width, height, square }) {
  const cols = square ? 2 : 3;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; background:#000; color:#fff; font-family:Inter, system-ui, sans-serif; overflow:hidden; }
  .wrap { position:relative; width:100%; height:100%; padding:${square ? 72 : 64}px ${square ? 72 : 80}px; display:flex; flex-direction:column; justify-content:space-between; }
  .glow { position:absolute; inset:0; background:
    radial-gradient(ellipse 55% 45% at 78% 18%, rgba(140,120,255,.22), transparent 60%),
    radial-gradient(ellipse 45% 40% at 12% 88%, rgba(255,150,120,.14), transparent 60%);
    pointer-events:none; }
  .grid { position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size:48px 48px; mask-image:radial-gradient(ellipse 70% 70% at 50% 50%, #000 30%, transparent 100%); pointer-events:none; }
  .top { position:relative; display:flex; align-items:center; justify-content:space-between; }
  .lockup { height:${square ? 96 : 104}px; }
  .pill { display:inline-flex; align-items:center; gap:10px; padding:10px 18px; border:1px solid rgba(255,255,255,.18); border-radius:999px; font-size:${square ? 20 : 22}px; font-weight:500; color:rgba(255,255,255,.85); background:rgba(255,255,255,.04); letter-spacing:.01em; }
  .pill svg { width:22px; height:22px; fill:#fff; }
  .hero { position:relative; display:flex; align-items:center; gap:${square ? 28 : 40}px; margin-top:${square ? 8 : 0}px; }
  .star { width:${square ? 132 : 150}px; height:${square ? 132 : 150}px; flex:none; filter:drop-shadow(0 0 40px rgba(255,220,120,.45)); }
  .hero h1 { font-size:${square ? 108 : 132}px; font-weight:800; line-height:.92; letter-spacing:-.045em; background:linear-gradient(120deg,#fff 0%,#dcd6ff 45%,#ffd9c7 100%); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hero p { margin-top:14px; font-size:${square ? 28 : 32}px; font-weight:500; color:rgba(255,255,255,.7); letter-spacing:-.01em; }
  .stats { position:relative; display:grid; grid-template-columns:repeat(${cols},1fr); gap:${square ? 14 : 18}px; }
  .stat { padding:${square ? 20 : 22}px ${square ? 22 : 26}px; border:1px solid rgba(255,255,255,.12); border-radius:18px; background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02)); }
  .stat b { display:block; font-size:${square ? 44 : 48}px; font-weight:700; letter-spacing:-.03em; line-height:1; font-variant-numeric:tabular-nums; }
  .stat span { display:block; margin-top:8px; font-size:${square ? 19 : 20}px; font-weight:600; color:rgba(255,255,255,.9); }
  .stat small { display:block; margin-top:3px; font-size:${square ? 15 : 16}px; color:rgba(255,255,255,.5); font-family:'JetBrains Mono', monospace; }
  .foot { position:relative; display:flex; justify-content:space-between; align-items:center; font-size:${square ? 18 : 20}px; color:rgba(255,255,255,.55); font-family:'JetBrains Mono', monospace; }
  .foot b { color:rgba(255,255,255,.85); font-weight:500; }
</style></head><body><div class="wrap">
  <div class="glow"></div><div class="grid"></div>
  <div class="top">
    <img class="lockup" src="data:image/png;base64,${lockup}" alt="three.ws">
    <div class="pill"><svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>github.com/nirholas/three.ws</div>
  </div>
  <div class="hero">
    <svg class="star" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff6d6"/><stop offset=".55" stop-color="#ffd166"/><stop offset="1" stop-color="#ff9f7a"/></linearGradient></defs><path fill="url(#g)" d="M12 1.8l3.1 6.5 7.1.9-5.2 4.9 1.3 7.1L12 17.8l-6.3 3.4L7 14.1 1.8 9.2l7.1-.9z"/></svg>
    <div><h1>100 stars</h1><p>on GitHub. Thank you. Open source is how three.ws is built.</p></div>
  </div>
  <div class="stats">${STATS.map(s => `<div class="stat"><b>${s.value}</b><span>${s.label}</span><small>${s.sub}</small></div>`).join('')}</div>
  <div class="foot"><span>Star the repo: <b>github.com/nirholas/three.ws</b></span><span><b>three.ws</b> · $THREE</span></div>
</div></body></html>`;
}

const browser = await chromium.launch();
try {
  for (const v of [
    { file: 'github-100-stars-x.png', width: 1600, height: 900, square: false },
    { file: 'github-100-stars-square.png', width: 1080, height: 1080, square: true },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1.5 });
    const p = await ctx.newPage();
    await p.setContent(page(v), { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: resolve(outDir, v.file), type: 'png' });
    await ctx.close();
    console.log('wrote docs/media/' + v.file);
  }
} finally {
  await browser.close();
}
