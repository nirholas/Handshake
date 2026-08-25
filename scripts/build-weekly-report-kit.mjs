#!/usr/bin/env node
// Builds the posting kit for a weekly report: a formatted HTML copy of the
// article (paste from a browser into the X Article editor), a numbered image
// manifest, and one zip holding every image in insertion order.
//   node scripts/build-weekly-report-kit.mjs <slug>   (docs/<slug>.md, marketing/<slug>/)
import { marked } from 'marked';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const issue = process.argv[2] || 'the-first-19-weeks';
const md = readFileSync(resolve(root, `docs/${issue}.md`), 'utf8');
const kitDir = resolve(root, `marketing/${issue}/kit`);
const imgDir = resolve(kitDir, 'images');
mkdirSync(imgDir, { recursive: true });

const sources = [resolve(root, `marketing/${issue}/images`), resolve(root, 'docs/media')];
const order = [];
let n = 0;
const body = md.replace(/^\[IMAGE: ([^\]]+)\]$/gm, (_, file) => {
  n += 1;
  const src = sources.map((d) => resolve(d, file)).find((p) => existsSync(p));
  const out = `${String(n).padStart(2, '0')}-${file}`;
  if (src) copyFileSync(src, resolve(imgDir, out));
  order.push({ n, file: out, found: Boolean(src) });
  return `<p class="img"><em>[ insert image ${String(n).padStart(2, '0')}: ${file} ]</em></p>`;
});

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${issue}</title>
<style>body{max-width:760px;margin:40px auto;padding:0 20px;font-family:Inter,system-ui,sans-serif;line-height:1.55;color:#111}h1{font-size:2rem}h2{margin-top:2.2em}hr{border:0;border-top:1px solid #ddd;margin:2em 0}.img{background:#f4f4f4;padding:8px 12px;border-radius:6px}li{margin:.25em 0}</style>
</head><body>${marked.parse(body)}</body></html>`;
writeFileSync(resolve(kitDir, `${issue}.html`), html);

const manifest = ['# Image insertion order', '', 'Numbers match the placeholders in ' + issue + '.html. Cover image is separate (cover-x-article.png).', '']
  .concat(order.map((o) => `${String(o.n).padStart(2, '0')}. ${o.file}${o.found ? '' : '  (MISSING)'}`)).join('\n') + '\n';
writeFileSync(resolve(kitDir, 'IMAGE-ORDER.md'), manifest);

for (const [from, to] of [
  [`marketing/${issue}/images/header-x-article.png`, 'cover-x-article.png'],
  [`marketing/${issue}/images/header-16x9.png`, 'announce-post-16x9.png'],
]) if (existsSync(resolve(root, from))) copyFileSync(resolve(root, from), resolve(kitDir, to));

execFileSync('zip', ['-qr', `${issue}-kit.zip`, '.'], { cwd: kitDir });
console.log(`kit: ${kitDir}`);
console.log(`images: ${order.length} (${order.filter((o) => !o.found).length} missing)`);
