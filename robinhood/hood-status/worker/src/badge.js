/** Flat SVG status badge, shields.io-compatible geometry. */

const COLORS = {
  operational: '#2da44e',
  degraded: '#bf8700',
  down: '#cf222e',
  unknown: '#6e7781',
};

const STATUS_TEXT = {
  operational: 'operational',
  degraded: 'degraded',
  down: 'down',
  unknown: 'unknown',
};

// Verdana 11px approximate advance widths (the shields.io approach, reduced
// to the ASCII we actually emit). Fallback width covers anything else.
const CHAR_W = {
  ' ': 3.5, '(': 4, ')': 4, '.': 3.5, '-': 4.5,
  a: 6, b: 6.5, c: 5.5, d: 6.5, e: 6, f: 3.5, g: 6.5, h: 6.5, i: 3, j: 3.5,
  k: 6, l: 3, m: 10, n: 6.5, o: 6.5, p: 6.5, q: 6.5, r: 4.5, s: 5.5, t: 4,
  u: 6.5, v: 6, w: 9, x: 6, y: 6, z: 5.5,
  A: 7.5, B: 7.5, C: 7.5, D: 8, E: 7, F: 6.5, G: 8, H: 8, I: 4.5, J: 5,
  K: 7.5, L: 6, M: 9, N: 8, O: 8.5, P: 7, Q: 8.5, R: 8, S: 7.5, T: 7,
  U: 8, V: 7.5, W: 11, X: 7.5, Y: 7.5, Z: 7.5,
  0: 7, 1: 7, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 7, 8: 7, 9: 7,
};

function textWidth(s) {
  let w = 0;
  for (const ch of s) w += CHAR_W[ch] ?? 7;
  return Math.round(w);
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {string} label left-hand text, e.g. "robinhood chain"
 * @param {'operational'|'degraded'|'down'|'unknown'} status
 * @returns {string} SVG document
 */
export function renderBadge(label, status) {
  const value = STATUS_TEXT[status] ?? 'unknown';
  const color = COLORS[status] ?? COLORS.unknown;
  const pad = 10;
  const lw = textWidth(label) + pad;
  const vw = textWidth(value) + pad;
  const w = lw + vw;
  const h = 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(label)}: ${esc(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${w}" height="${h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="#555"/>
    <rect x="${lw}" width="${vw}" height="${h}" fill="${color}"/>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14" fill="#010101" fill-opacity=".3">${esc(label)}</text>
    <text x="${lw / 2}" y="13.3">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="14" fill="#010101" fill-opacity=".3">${esc(value)}</text>
    <text x="${lw + vw / 2}" y="13.3">${esc(value)}</text>
  </g>
</svg>`;
}
