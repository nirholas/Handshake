/**
 * Deterministic ticker-monogram SVG generator.
 *
 * One consistent visual system for every token that has no self-owned
 * artwork (all Stock Tokens use this: we cannot ship trademarked company
 * logos). The design is a 64x64 rounded square with a dark two-stop
 * gradient whose hue is derived from the token address (stable across
 * refreshes), and the ticker set in the system font stack.
 */

/** FNV-1a 32-bit hash for stable hue derivation. */
function fnv1a(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function fontSize(length) {
  if (length <= 2) return 24
  if (length === 3) return 20
  if (length === 4) return 16
  if (length === 5) return 13
  return 11
}

/**
 * Build the monogram SVG for a token.
 * @param {string} symbol on-chain ticker, rendered as-is (upper-cased)
 * @param {string} address token address, drives the stable hue
 */
export function monogramSvg(symbol, address) {
  const hue = fnv1a(address.toLowerCase()) % 360
  const hue2 = (hue + 40) % 360
  const label = String(symbol).toUpperCase().slice(0, 6)
  const size = fontSize(label.length)
  // Escape the five XML-special characters; symbols are schema-validated
  // (no whitespace) but may contain & or $ etc.
  const escaped = label
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
  const gradientId = `g${fnv1a(label + address.toLowerCase()).toString(16)}`
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="' + escaped + '">',
    `  <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">`,
    `    <stop offset="0" stop-color="hsl(${hue} 45% 24%)"/>`,
    `    <stop offset="1" stop-color="hsl(${hue2} 55% 14%)"/>`,
    '  </linearGradient></defs>',
    `  <rect width="64" height="64" rx="14" fill="url(#${gradientId})"/>`,
    `  <rect width="64" height="64" rx="14" fill="none" stroke="hsl(${hue} 45% 42%)" stroke-opacity="0.55"/>`,
    `  <text x="32" y="32" dy="0.36em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="${size}" font-weight="700" letter-spacing="0.02em" fill="hsl(${hue} 70% 88%)">${escaped}</text>`,
    '</svg>',
    '',
  ].join('\n')
}
