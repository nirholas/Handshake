// Captures screenshots of live three.ws surfaces for the Weekly Report article image folder.
// Usage: node scripts/render-weekly-report-shots.mjs [outDir]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const out = process.argv[2] || 'marketing/the-first-19-weeks/images';
const base = 'https://three.ws';
const pages = [
  ['home', '/'],
  ['create', '/create'],
  ['gallery', '/gallery'],
  ['avatar-studio', '/studio'],
  ['agents', '/agents'],
  ['three-token', '/three-token'],
  ['launches', '/launches'],
  ['play', '/play'],
  ['vaults', '/vaults'],
  ['labor-market', '/labor-market'],
  ['agora', '/agora'],
  ['marketplace', '/marketplace'],
  ['x402', '/x402'],
  ['agent-economy-volume', '/agent-economy-volume'],
  ['mcp-tools', '/mcp-tools'],
  ['partners', '/partners'],
  ['nvidia', '/nvidia'],
  ['changelog', '/changelog'],
  ['markets', '/markets'],
  ['markets-news', '/markets/news'],
  ['markets-archive', '/markets/archive'],
  ['forge', '/forge'],
  ['oracle', '/oracle'],
  ['objects', '/objects'],
  ['wardrobe', '/wardrobe'],
  ['ar-studio', '/ar/studio'],
  ['character-library', '/character-library'],
  ['reputation-market', '/reputation/market'],
  ['pulse', '/pulse'],
  ['arena', '/arena'],
  ['launchpad', '/launchpad'],
  ['sign-language', '/sign-language'],
  ['motion-swap', '/motion-swap'],
  ['deploy-onchain', '/deploy-onchain'],
  ['play-war', '/play/war'],
  ['walkthroughs', '/walkthroughs'],
  ['ar', '/ar'],
  ['docs', '/docs'],
  ['pricing', '/pricing'],
  ['explore', '/explore'],
];
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const results = [];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
for (const [name, path] of pages) {
  if (only && !only.has(name)) continue;
  try {
    const res = await page.goto(base + path, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => page.goto(base + path, { waitUntil: 'load', timeout: 45000 }));
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${out}/${name}.png` });
    results.push(`${name} ${path} ${res?.status()}`);
  } catch (e) {
    results.push(`${name} ${path} FAILED ${e.message.split('\n')[0]}`);
  }
}
await browser.close();
console.log(results.join('\n'));
