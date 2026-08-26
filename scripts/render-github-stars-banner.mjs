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
  { value: '9,508', label: 'commits', sub: 'since April 14, 2026' },
  { value: '21', label: 'contributors', sub: 'github.com/nirholas/three.ws' },
  { value: '60', label: 'pull requests', sub: '26 forks' },
  { value: '101', label: 'npm packages', sub: '@three-ws scope' },
  { value: '72', label: 'MCP servers', sub: 'official MCP registry' },
  { value: '60', label: 'agent skills', sub: 'SKILL.md, any agent' },
  { value: '4,519', label: 'x402 endpoints', sub: '/.well-known/x402.json' },
  { value: '110,416', label: 'x402 settlements', sub: 'on-chain, Solana, USDC' },
  { value: '803,483', label: 'x402 verifications', sub: 'self-hosted facilitator' },
  { value: '3,000', label: 'validator attestations', sub: 'Solana, threews.validation.v1' },
  { value: '126,522', label: 'custody proofs', sub: '244 attestation epochs' },
  { value: '725', label: 'public pages', sub: 'Apache-2.0, all of it' },
];

const ECOSYSTEM = [
  { value: '111', label: 'open-source repos', sub: 'spun out of three.ws' },
  { value: '1,222', label: 'stars across them', sub: 'github.com/nirholas' },
  { value: '12', label: 'EVM chains', sub: 'ERC-8004 registries, CREATE2' },
  { value: '2', label: 'Solana programs', sub: 'agent invocation, skill license' },
  { value: '33', label: 'GPU and CPU workers', sub: '27 Docker images' },
  { value: '1,752', label: 'test files', sub: '323 docs, 31 specs' },
  { value: '50', label: 'x402 suite repos', sub: 'standalone paid services' },
  { value: '3', label: 'Hugging Face', sub: 'org, Space, blog' },
  { value: '3', label: 'MCP directories', sub: 'official registry, Glama, PulseMCP' },
  { value: '2', label: 'editor integrations', sub: 'Blender addon, ComfyUI nodes' },
  { value: '2', label: 'store extensions', sub: 'VS Code, Open VSX, Chrome' },
  { value: '3', label: 'GitHub Pages apps', sub: 'AR Studio, deployer, wallets' },
];

const SURFACES = ['IBM Community user group', 'AWS Builder Center', 'Alibaba Cloud Marketplace', 'NVIDIA Inception', 'NVIDIA Developer Forums', 'Google Cloud for Web3', 'OpenAI GPT Store', 'Quicknode', 'Hugging Face', 'VS Code Marketplace', 'Open VSX', 'Official MCP Registry', 'Claude Code plugins', 'Glama', 'PulseMCP', 'LobeHub', 'SperaxOS', 'x402scan', 'Coinbase Bazaar', '402index', 'BNB Dappbay', 'pump.fun', 'Jupiter', 'CoinGecko', 'Bybit Alpha', 'KuCoin Alpha', 'MEXC', 'LBank', 'KCEX'];

function page({ width, height, square, surfaces = null, stats = STATS, title = '100 stars', tagline = 'on GitHub. Thank you. Everything three.ws ships is open source.' }) {
  const cols = square ? 3 : 4;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; background:#000; color:#fff; font-family:Inter, system-ui, sans-serif; overflow:hidden; }
  .wrap { position:relative; width:100%; height:100%; padding:${square ? 48 : 40}px ${square ? 52 : 60}px; display:flex; flex-direction:column; justify-content:space-between; }
  .glow { position:absolute; inset:0; background:
    radial-gradient(ellipse 55% 45% at 78% 18%, rgba(140,120,255,.22), transparent 60%),
    radial-gradient(ellipse 45% 40% at 12% 88%, rgba(255,150,120,.14), transparent 60%);
    pointer-events:none; }
  .grid { position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size:48px 48px; mask-image:radial-gradient(ellipse 70% 70% at 50% 50%, #000 30%, transparent 100%); pointer-events:none; }
  .top { position:relative; display:flex; align-items:center; justify-content:space-between; }
  .lockup { height:${square ? 80 : 88}px; }
  .pill { display:inline-flex; align-items:center; gap:10px; padding:10px 18px; border:1px solid rgba(255,255,255,.18); border-radius:999px; font-size:${square ? 20 : 22}px; font-weight:500; color:rgba(255,255,255,.85); background:rgba(255,255,255,.04); letter-spacing:.01em; }
  .pill svg { width:22px; height:22px; fill:#fff; }
  .hero { position:relative; display:flex; align-items:center; gap:${square ? 24 : 32}px; }
  .star { width:${square ? 96 : 108}px; height:${square ? 96 : 108}px; flex:none; filter:drop-shadow(0 0 40px rgba(255,220,120,.45)); }
  .hero h1 { font-size:${square ? 84 : surfaces ? 84 : 100}px; font-weight:800; line-height:.92; letter-spacing:-.045em; background:linear-gradient(120deg,#fff 0%,#dcd6ff 45%,#ffd9c7 100%); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hero p { margin-top:10px; font-size:${square ? 24 : 28}px; font-weight:500; color:rgba(255,255,255,.7); letter-spacing:-.01em; }
  .stats { position:relative; display:grid; grid-template-columns:repeat(${cols},1fr); gap:${square ? 10 : 12}px; }
  .stat { padding:${square ? 11 : surfaces ? 9 : 12}px ${square ? 14 : 18}px; border:1px solid rgba(255,255,255,.12); border-radius:18px; background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02)); }
  .stat b { display:block; font-size:${square ? 30 : surfaces ? 30 : 34}px; font-weight:700; letter-spacing:-.03em; line-height:1; font-variant-numeric:tabular-nums; }
  .stat span { display:block; margin-top:6px; font-size:${square ? 15 : 17}px; font-weight:600; color:rgba(255,255,255,.9); }
  .stat small { display:block; margin-top:2px; font-size:${square ? 12 : 13}px; color:rgba(255,255,255,.5); font-family:'JetBrains Mono', monospace; }
  .where { position:relative; }
  .where h2 { font-size:${square ? 13 : 14}px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:rgba(255,255,255,.45); margin-bottom:${square ? 8 : 10}px; }
  .chips { display:flex; flex-wrap:wrap; gap:${square ? 6 : 8}px; }
  .chip { padding:${square ? 5 : 6}px ${square ? 11 : 13}px; border:1px solid rgba(255,255,255,.14); border-radius:999px; font-size:${square ? 14 : 16}px; font-weight:500; color:rgba(255,255,255,.82); background:rgba(255,255,255,.04); white-space:nowrap; }
  .where { position:relative; }
  .where h2 { font-size:14px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:rgba(255,255,255,.45); margin-bottom:10px; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; }
  .chip { padding:6px 13px; border:1px solid rgba(255,255,255,.14); border-radius:999px; font-size:15px; font-weight:500; color:rgba(255,255,255,.82); background:rgba(255,255,255,.04); white-space:nowrap; }
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
    <div><h1>${title}</h1><p>${tagline}</p></div>
  </div>
  <div class="stats">${stats.map(s => `<div class="stat"><b>${s.value}</b><span>${s.label}</span><small>${s.sub}</small></div>`).join('')}</div>
  ${surfaces ? `<div class="where"><h2>Listed, published, or partnered</h2><div class="chips">${surfaces.map(n => `<span class="chip">${n}</span>`).join('')}</div></div>` : ''}
  <div class="foot"><span>Star the repo: <b>github.com/nirholas/three.ws</b></span><span><b>three.ws</b> · $THREE</span></div>
</div></body></html>`;
}

// The people variant pulls the real contributor avatars from GitHub at render
// time. The "claude" login is a misattributed noreply email, not a person.
async function fetchContributors() {
  const res = await fetch('https://api.github.com/repos/nirholas/three.ws/contributors?per_page=100', { headers: { 'User-Agent': 'three.ws-banner' } });
  if (!res.ok) throw new Error(`GitHub contributors API ${res.status}`);
  const list = (await res.json()).filter((c) => c.type === 'User' && c.login !== 'claude');
  return Promise.all(list.map(async (c) => {
    const img = await fetch(`${c.avatar_url}&s=200`);
    if (!img.ok) throw new Error(`avatar ${c.login} ${img.status}`);
    return { login: c.login, b64: Buffer.from(await img.arrayBuffer()).toString('base64') };
  }));
}

const COMMANDS = [
  ['npm i @three-ws/sdk', 'an avatar with a wallet, in any app'],
  ['/plugin marketplace add nirholas/three.ws', 'four Claude Code plugins'],
  ['npx -y @three-ws/x402-mcp', 'pay any x402 endpoint from an agent'],
];

function peoplePage({ width, height, people }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; background:#000; color:#fff; font-family:Inter, system-ui, sans-serif; overflow:hidden; }
  .wrap { position:relative; width:100%; height:100%; padding:48px 64px; display:flex; flex-direction:column; justify-content:space-between; }
  .glow { position:absolute; inset:0; background: radial-gradient(ellipse 55% 45% at 78% 18%, rgba(140,120,255,.22), transparent 60%), radial-gradient(ellipse 45% 40% at 12% 88%, rgba(255,150,120,.14), transparent 60%); }
  .grid { position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size:48px 48px; mask-image:radial-gradient(ellipse 70% 70% at 50% 50%, #000 30%, transparent 100%); }
  .top { position:relative; display:flex; align-items:center; justify-content:space-between; }
  .lockup { height:84px; }
  .pill { display:inline-flex; align-items:center; gap:10px; padding:10px 18px; border:1px solid rgba(255,255,255,.18); border-radius:999px; font-size:20px; font-weight:500; color:rgba(255,255,255,.85); background:rgba(255,255,255,.04); }
  .hero { position:relative; display:flex; align-items:center; gap:32px; }
  .star { width:108px; height:108px; flex:none; filter:drop-shadow(0 0 40px rgba(255,220,120,.45)); }
  h1 { font-size:100px; font-weight:800; line-height:.92; letter-spacing:-.045em; background:linear-gradient(120deg,#fff 0%,#dcd6ff 45%,#ffd9c7 100%); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hero p { margin-top:10px; font-size:26px; font-weight:500; color:rgba(255,255,255,.7); }
  .people { position:relative; }
  .people h2, .try h2 { font-size:14px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:rgba(255,255,255,.45); margin-bottom:12px; }
  .faces { display:flex; gap:14px; flex-wrap:wrap; }
  .face { display:flex; flex-direction:column; align-items:center; gap:8px; width:120px; }
  .face img { width:88px; height:88px; border-radius:50%; border:2px solid rgba(255,255,255,.22); box-shadow:0 0 0 4px rgba(0,0,0,.6); object-fit:cover; }
  .face span { font-family:'JetBrains Mono', monospace; font-size:14px; color:rgba(255,255,255,.7); max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .try { position:relative; display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .cmd { padding:14px 18px; border:1px solid rgba(255,255,255,.12); border-radius:16px; background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02)); }
  .cmd code { display:block; font-family:'JetBrains Mono', monospace; font-size:19px; color:#fff; white-space:nowrap; }
  .cmd small { display:block; margin-top:6px; font-size:15px; color:rgba(255,255,255,.55); }
  .foot { position:relative; display:flex; justify-content:space-between; font-size:18px; color:rgba(255,255,255,.55); font-family:'JetBrains Mono', monospace; }
  .foot b { color:rgba(255,255,255,.85); font-weight:500; }
</style></head><body><div class="wrap"><div class="glow"></div><div class="grid"></div>
  <div class="top"><img class="lockup" src="data:image/png;base64,${lockup}" alt="three.ws"><div class="pill">github.com/nirholas/three.ws</div></div>
  <div class="hero"><svg class="star" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff6d6"/><stop offset=".55" stop-color="#ffd166"/><stop offset="1" stop-color="#ff9f7a"/></linearGradient></defs><path fill="url(#g)" d="M12 1.8l3.1 6.5 7.1.9-5.2 4.9 1.3 7.1L12 17.8l-6.3 3.4L7 14.1 1.8 9.2l7.1-.9z"/></svg>
    <div><h1>100 stars. Thank you.</h1><p>Every star, fork, issue, and pull request came from someone who chose to build in the open with us.</p></div></div>
  <div class="people"><h2>Built by</h2><div class="faces">${people.map((p) => `<div class="face"><img src="data:image/jpeg;base64,${p.b64}" alt="${p.login}"><span>${p.login}</span></div>`).join('')}<div class="face"><div style="width:88px;height:88px;border-radius:50%;border:2px dashed rgba(255,255,255,.35);display:flex;align-items:center;justify-content:center;font-size:40px;color:rgba(255,255,255,.6)">+</div><span>you</span></div></div></div>
  <div class="try"><h2 style="grid-column:1/-1;margin-bottom:0">Try it in 60 seconds</h2>${COMMANDS.map(([c, d]) => `<div class="cmd"><code>${c}</code><small>${d}</small></div>`).join('')}</div>
  <div class="foot"><span>Star the repo: <b>github.com/nirholas/three.ws</b></span><span><b>three.ws</b> · Apache-2.0 · $THREE</span></div>
</div></body></html>`;
}

const browser = await chromium.launch();
try {
  for (const v of [
    { file: 'github-100-stars-x.png', width: 1600, height: 900, square: false },
    { file: 'github-100-stars-square.png', width: 1080, height: 1080, square: true },
    { file: 'github-100-stars-ecosystem.png', width: 1600, height: 900, square: false, stats: ECOSYSTEM, surfaces: SURFACES, title: 'One repo, everywhere', tagline: 'Where the three.ws open-source ecosystem stems beyond github.com/nirholas/three.ws.' },
    { file: 'github-100-stars-people.png', width: 1600, height: 900, people: true },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1.5 });
    const p = await ctx.newPage();
    await p.setContent(v.people ? peoplePage({ ...v, people: await fetchContributors() }) : page(v), { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: resolve(outDir, v.file), type: 'png' });
    await ctx.close();
    console.log('wrote docs/media/' + v.file);
  }
} finally {
  await browser.close();
}
