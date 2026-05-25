/**
 * Walk OG image endpoint
 * ----------------------
 * GET /api/walk-og?avatar=<id>&handle=<handle>
 *
 * Returns an SVG Open Graph card (1200×630) showing the avatar's thumbnail,
 * a "Walk with @handle" headline, and the three.ws branding.
 *
 * If the avatar has a real thumbnail_url, it is embedded as a base64 data-URI
 * so the SVG is self-contained and renders correctly in all OG crawlers.
 * On any fetch failure the card degrades to a text-only graphic.
 */

import { getAvatar } from './_lib/avatars.js';
import { cors, wrap } from './_lib/http.js';

const CACHE = 'public, max-age=3600, s-maxage=86400';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url  = new URL(req.url, 'http://x');
	const id   = url.searchParams.get('avatar') || '';
	const handle = url.searchParams.get('handle') || '';

	let thumbDataUri = '';
	if (id) {
		try {
			const avatar = await getAvatar({ id });
			if (avatar?.thumbnail_url) {
				const r = await fetch(avatar.thumbnail_url);
				if (r.ok) {
					const buf = await r.arrayBuffer();
					const ct  = r.headers.get('content-type') || 'image/jpeg';
					thumbDataUri = `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
				}
			}
		} catch {
			// degrade gracefully
		}
	}

	const displayHandle = handle ? `@${handle}` : 'three.ws';

	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(renderSvg({ thumbDataUri, displayHandle }));
});

function renderSvg({ thumbDataUri, displayHandle }) {
	const safeHandle = escapeXml(truncate(displayHandle, 40));

	const avatarBlock = thumbDataUri
		? `<image href="${thumbDataUri}" x="720" y="60" width="420" height="510" preserveAspectRatio="xMidYMid meet" clip-path="url(#thumb-clip)" />`
		: `<rect x="720" y="60" width="420" height="510" rx="24" fill="#1a1a2e" />
		   <text x="930" y="340" fill="#3d3d6b" font-family="Inter, system-ui, sans-serif" font-size="80" text-anchor="middle">👟</text>`;

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="1200" height="630" viewBox="0 0 1200 630" role="img"
     aria-label="Walk with ${safeHandle} on three.ws">
  <defs>
    <clipPath id="thumb-clip">
      <rect x="720" y="60" width="420" height="510" rx="24" />
    </clipPath>
    <linearGradient id="bg-grad" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#06040f" />
      <stop offset="100%" stop-color="#0d0921" />
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="60%" stop-color="transparent" />
      <stop offset="100%" stop-color="rgba(13,9,33,0.9)" />
    </linearGradient>
  </defs>

  <!-- background -->
  <rect width="1200" height="630" fill="url(#bg-grad)" />

  <!-- subtle grid lines -->
  <line x1="0" y1="210" x2="1200" y2="210" stroke="rgba(124,58,237,0.07)" stroke-width="1"/>
  <line x1="0" y1="420" x2="1200" y2="420" stroke="rgba(124,58,237,0.07)" stroke-width="1"/>
  <line x1="400" y1="0" x2="400" y2="630" stroke="rgba(124,58,237,0.07)" stroke-width="1"/>

  <!-- avatar thumbnail -->
  ${avatarBlock}

  <!-- right-side fade so text is legible -->
  <rect x="600" y="0" width="600" height="630" fill="url(#fade)" />

  <!-- accent line -->
  <rect x="72" y="160" width="4" height="80" rx="2" fill="#7c3aed" />

  <!-- headline -->
  <text x="92" y="220" fill="#f5f5f5"
        font-family="Inter, -apple-system, system-ui, sans-serif"
        font-size="28" font-weight="400" letter-spacing="-0.5">Walk with</text>
  <text x="92" y="280" fill="#a78bfa"
        font-family="Inter, -apple-system, system-ui, sans-serif"
        font-size="44" font-weight="700" letter-spacing="-1">${safeHandle}</text>

  <!-- subheadline -->
  <text x="92" y="340" fill="rgba(245,245,245,0.55)"
        font-family="Inter, -apple-system, system-ui, sans-serif"
        font-size="22" font-weight="300">Your 3D avatar walks anywhere on the web.</text>

  <!-- CTA pill -->
  <rect x="92" y="380" width="200" height="44" rx="22" fill="#7c3aed" />
  <text x="192" y="408" fill="#fff"
        font-family="Inter, -apple-system, system-ui, sans-serif"
        font-size="16" font-weight="600" text-anchor="middle">Try it free →</text>

  <!-- branding -->
  <text x="92" y="580" fill="rgba(245,245,245,0.25)"
        font-family="Inter, -apple-system, system-ui, sans-serif"
        font-size="18" font-weight="400" letter-spacing="3">three.ws</text>
</svg>`;
}

function truncate(s, n) {
	s = String(s || '');
	return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function escapeXml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}
