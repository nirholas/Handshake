// Render the three.ws Open Badge medallion PNG from the brand cube logo.
// Produces a square badge image suitable for Open Badges 2.0 (baked separately).
//
//   node scripts/openbadge/art.mjs "Quest Master" public/badges/quest-master.png
//
// The cube geometry mirrors public/pwa-icon.svg so the badge stays on-brand.
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const SIZE = 512;

// Escape text for safe inclusion in SVG.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The isometric cube, drawn centred and scaled into the medallion field.
// Source vertices (from pwa-icon.svg, 512 box) translated up + scaled to 0.62.
function cube() {
  const cx = 256, cy = 232, s = 0.62;
  const map = (x, y) => `${(cx + (x - 256) * s).toFixed(1)},${(cy + (y - 256) * s).toFixed(1)}`;
  const P = {
    top: [256, 110], fl: [116, 182], fr: [396, 182],
    midL: [116, 330], midR: [396, 330], front: [256, 254], bottom: [256, 402],
  };
  const p = (pts) => pts.map(([x, y]) => map(x, y)).join(' ');
  return `
    <polygon points="${p([P.top, P.fl, P.midL, P.bottom])}" fill="url(#faceLeft)"/>
    <polygon points="${p([P.top, P.fr, P.midR, P.bottom])}" fill="url(#faceRight)"/>
    <polygon points="${p([P.top, P.fl, P.front, P.fr])}" fill="url(#faceTop)"/>
    <g stroke-linecap="round" filter="url(#edgeGlow)">
      <line x1="${map(256,110).split(',')[0]}" y1="${map(256,110).split(',')[1]}" x2="${map(116,182).split(',')[0]}" y2="${map(116,182).split(',')[1]}" stroke="#7ec8e3" stroke-width="2.4" opacity="0.85"/>
      <line x1="${map(256,110).split(',')[0]}" y1="${map(256,110).split(',')[1]}" x2="${map(396,182).split(',')[0]}" y2="${map(396,182).split(',')[1]}" stroke="#7ec8e3" stroke-width="2.4" opacity="0.85"/>
      <line x1="${map(116,182).split(',')[0]}" y1="${map(116,182).split(',')[1]}" x2="${map(256,254).split(',')[0]}" y2="${map(256,254).split(',')[1]}" stroke="#5aadcf" stroke-width="1.8" opacity="0.6"/>
      <line x1="${map(396,182).split(',')[0]}" y1="${map(396,182).split(',')[1]}" x2="${map(256,254).split(',')[0]}" y2="${map(256,254).split(',')[1]}" stroke="#5aadcf" stroke-width="1.8" opacity="0.6"/>
      <line x1="${map(116,182).split(',')[0]}" y1="${map(116,182).split(',')[1]}" x2="${map(116,330).split(',')[0]}" y2="${map(116,330).split(',')[1]}" stroke="#5aadcf" stroke-width="2.2" opacity="0.6"/>
      <line x1="${map(396,182).split(',')[0]}" y1="${map(396,182).split(',')[1]}" x2="${map(396,330).split(',')[0]}" y2="${map(396,330).split(',')[1]}" stroke="#5aadcf" stroke-width="2.2" opacity="0.6"/>
      <line x1="${map(256,254).split(',')[0]}" y1="${map(256,254).split(',')[1]}" x2="${map(256,402).split(',')[0]}" y2="${map(256,402).split(',')[1]}" stroke="#4a9abf" stroke-width="1.8" opacity="0.5"/>
      <line x1="${map(116,330).split(',')[0]}" y1="${map(116,330).split(',')[1]}" x2="${map(256,402).split(',')[0]}" y2="${map(256,402).split(',')[1]}" stroke="#5aadcf" stroke-width="2.2" opacity="0.65"/>
      <line x1="${map(396,330).split(',')[0]}" y1="${map(396,330).split(',')[1]}" x2="${map(256,402).split(',')[0]}" y2="${map(256,402).split(',')[1]}" stroke="#5aadcf" stroke-width="2.2" opacity="0.65"/>
    </g>
    <g filter="url(#vtxGlow)">
      <circle cx="${map(256,110).split(',')[0]}" cy="${map(256,110).split(',')[1]}" r="9" fill="url(#vglow)"/>
      <circle cx="${map(116,182).split(',')[0]}" cy="${map(116,182).split(',')[1]}" r="6" fill="url(#vglow)" opacity="0.7"/>
      <circle cx="${map(396,182).split(',')[0]}" cy="${map(396,182).split(',')[1]}" r="6" fill="url(#vglow)" opacity="0.7"/>
      <circle cx="${map(256,402).split(',')[0]}" cy="${map(256,402).split(',')[1]}" r="5" fill="url(#vglow)" opacity="0.45"/>
    </g>`;
}

export function badgeSvg(title = 'three.ws') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>
    <radialGradient id="field" cx="50%" cy="42%" r="62%">
      <stop offset="0%" stop-color="#0e2236"/>
      <stop offset="70%" stop-color="#0a1726"/>
      <stop offset="100%" stop-color="#060e18"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#9fe6ff"/>
      <stop offset="45%" stop-color="#4aa6cf"/>
      <stop offset="100%" stop-color="#1d4f6e"/>
    </linearGradient>
    <radialGradient id="vglow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="35%" stop-color="#b8e8ff" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#b8e8ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="faceTop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#234055" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#0f2030" stop-opacity="0.95"/>
    </linearGradient>
    <linearGradient id="faceRight" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#13283c" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#091420" stop-opacity="0.95"/>
    </linearGradient>
    <linearGradient id="faceLeft" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#102234" stop-opacity="0.92"/>
      <stop offset="100%" stop-color="#0a131f" stop-opacity="0.95"/>
    </linearGradient>
    <filter id="edgeGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="vtxGlow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <path id="arc" d="M 96 256 A 160 160 0 0 1 416 256" fill="none"/>
  </defs>

  <circle cx="256" cy="256" r="248" fill="url(#ring)"/>
  <circle cx="256" cy="256" r="236" fill="#060e18"/>
  <circle cx="256" cy="256" r="232" fill="url(#field)"/>
  <circle cx="256" cy="256" r="232" fill="none" stroke="#7ec8e3" stroke-width="1" opacity="0.35"/>

  ${cube()}

  <!-- wordmark -->
  <text x="256" y="372" text-anchor="middle" font-family="'Segoe UI',system-ui,-apple-system,sans-serif"
        font-size="34" font-weight="700" letter-spacing="1" fill="#eaf6ff">three.ws</text>
  <!-- achievement title -->
  <text x="256" y="408" text-anchor="middle" font-family="'Segoe UI',system-ui,-apple-system,sans-serif"
        font-size="20" font-weight="600" letter-spacing="3" fill="#7ec8e3">${esc(title.toUpperCase())}</text>
  <line x1="196" y1="424" x2="316" y2="424" stroke="#4aa6cf" stroke-width="1.5" opacity="0.5"/>
</svg>`;
}

export async function renderBadge(title, outPath) {
  const png = await sharp(Buffer.from(badgeSvg(title))).png().toBuffer();
  writeFileSync(outPath, png);
  return outPath;
}

// CLI: node art.mjs "<title>" <out.png>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , title = 'three.ws', out = 'public/badges/badge.png'] = process.argv;
  renderBadge(title, out).then((p) => console.log('wrote', p));
}
