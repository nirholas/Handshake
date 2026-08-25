#!/usr/bin/env node
// Renders the X Article header images for the weekly report into marketing/weekly-report-<n>/images/.
//   node scripts/render-weekly-report-header.mjs [issue=1] [subtitle]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const issue = process.argv[2] || '1';
const subtitle = process.argv[3] || 'Everything we have shipped so far. April 14 to August 25, 2026.';
const outDir = resolve(root, `marketing/weekly-report-${issue}/images`);
mkdirSync(outDir, { recursive: true });
const STATS = [
  ['9,508', 'commits'], ['21', 'contributors'], ['101', 'npm packages'],
  ['72', 'MCP servers'], ['4,519', 'x402 endpoints'], ['725', 'public pages'],
];
const lockup = readFileSync(resolve(root, 'public/brand/three-ws-lockup-on-dark.png')).toString('base64');

const html = ({ width, height }) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; background:#000; color:#fff; font-family:Inter, system-ui, sans-serif; overflow:hidden; }
  .wrap { position:relative; width:100%; height:100%; padding:${Math.round(height*0.11)}px ${Math.round(width*0.06)}px; display:flex; flex-direction:column; justify-content:space-between; }
  .glow { position:absolute; inset:0; background:
    radial-gradient(ellipse 50% 60% at 85% 20%, rgba(140,120,255,.20), transparent 60%),
    radial-gradient(ellipse 40% 50% at 10% 95%, rgba(255,150,120,.12), transparent 60%); }
  .grid { position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size:48px 48px; mask-image:radial-gradient(ellipse 70% 70% at 50% 50%, #000 30%, transparent 100%); }
  .lockup { position:relative; height:${Math.round(height*0.11)}px; width:auto; align-self:flex-start; }
  .kicker { position:relative; font-family:'JetBrains Mono', monospace; font-size:${Math.round(height*0.032)}px; letter-spacing:.18em; text-transform:uppercase; color:rgba(255,255,255,.55); margin-bottom:${Math.round(height*0.02)}px; }
  h1 { position:relative; font-size:${Math.round(height*0.19)}px; font-weight:800; line-height:.95; letter-spacing:-.045em; background:linear-gradient(120deg,#fff 0%,#dcd6ff 45%,#ffd9c7 100%); -webkit-background-clip:text; background-clip:text; color:transparent; }
  p { position:relative; margin-top:${Math.round(height*0.035)}px; font-size:${Math.round(height*0.042)}px; font-weight:500; color:rgba(255,255,255,.68); letter-spacing:-.01em; max-width:${Math.round(width*0.5)}px; }
  .body { position:relative; display:flex; align-items:flex-end; justify-content:space-between; gap:${Math.round(width*0.04)}px; }
  .stats { display:grid; grid-template-columns:repeat(2, ${Math.round(width*0.16)}px); gap:${Math.round(height*0.018)}px; flex:none; }
  .stat { padding:${Math.round(height*0.024)}px ${Math.round(height*0.03)}px; border:1px solid rgba(255,255,255,.12); border-radius:${Math.round(height*0.022)}px; background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02)); }
  .stat b { display:block; font-size:${Math.round(height*0.06)}px; font-weight:700; letter-spacing:-.03em; line-height:1; font-variant-numeric:tabular-nums; }
  .stat span { display:block; margin-top:${Math.round(height*0.01)}px; font-size:${Math.round(height*0.026)}px; color:rgba(255,255,255,.6); }
  .foot { position:relative; font-family:'JetBrains Mono', monospace; font-size:${Math.round(height*0.032)}px; color:rgba(255,255,255,.5); display:flex; justify-content:space-between; }
  .foot b { color:rgba(255,255,255,.85); font-weight:500; }
</style></head><body><div class="wrap"><div class="glow"></div><div class="grid"></div>
  <img class="lockup" src="data:image/png;base64,${lockup}" alt="three.ws">
  <div class="body"><div><div class="kicker">Weekly Report</div><h1>#${issue}</h1><p>${subtitle}</p></div>
  <div class="stats">${STATS.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div></div>
  <div class="foot"><span><b>three.ws</b> · open source · Apache-2.0</span><span><b>$THREE</b></span></div>
</div></body></html>`;

const browser = await chromium.launch();
try {
  for (const v of [
    { file: 'header-x-article.png', width: 1600, height: 800 },
    { file: 'header-16x9.png', width: 1600, height: 900 },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1.5 });
    const p = await ctx.newPage();
    await p.setContent(html(v), { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: resolve(outDir, v.file), type: 'png' });
    await ctx.close();
    console.log('wrote', resolve(outDir, v.file));
  }
} finally { await browser.close(); }
