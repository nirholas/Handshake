// Forge embed snippets — the single source of truth for the "embed this model"
// code the platform hands out. Pure, framework-free builders shared by the full
// Forge embed modal (src/forge-embed-panel.js) and the homepage mini Forge embed
// sheet (src/home-forge.js), so the two surfaces never drift on snippet shape,
// size presets, or the /forge/embed URLs.
//
// Two flavours, both real:
//   • iframe        — points at /forge/embed?src=<glb>, the zero-dependency
//                     three.ws viewer page (orbit + AR + branding). Drops onto
//                     any site with no scripts on the host page.
//   • web component — a <model-viewer> snippet for builders who want the model
//                     inline in their own DOM with their own controls.

const ORIGIN = 'https://three.ws';
const MODEL_VIEWER_CDN =
	'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';

export const EMBED_SIZES = [
	{ id: 'wide', label: '16 : 9', w: 640, h: 360, ratio: '16 / 9' },
	{ id: 'square', label: 'Square', w: 480, h: 480, ratio: '1 / 1' },
	{ id: 'portrait', label: '4 : 5', w: 432, h: 540, ratio: '4 / 5' },
];

export function embedSize(sizeId) {
	return EMBED_SIZES.find((s) => s.id === sizeId) || EMBED_SIZES[0];
}

export function escEmbed(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

// Forge's download href is already a public hosted URL; resolve relatives
// against the prod origin so a copied snippet works off-site.
export function absoluteGlb(url) {
	if (!url) return '';
	try {
		return new URL(url, ORIGIN).href;
	} catch {
		return url;
	}
}

function embedQuery(glbUrl, title) {
	const q = new URLSearchParams({ src: glbUrl });
	if (title) q.set('title', String(title).slice(0, 120));
	return q.toString();
}

// Pretty, absolute URL for the copyable snippet + "open standalone" link —
// resolves via the /forge/embed rewrite in production.
export function embedPageUrl(glbUrl, title) {
	return `${ORIGIN}/forge/embed?${embedQuery(glbUrl, title)}`;
}

// Same viewer at the built file path on the *current* origin, so an in-panel
// live preview renders in local dev and previews too (the clean /forge/embed
// route is a production rewrite).
export function embedPreviewUrl(glbUrl, title, origin) {
	const o = origin || (typeof location !== 'undefined' ? location.origin : ORIGIN);
	return `${o}/forge-embed.html?${embedQuery(glbUrl, title)}`;
}

export function buildIframeSnippet(glbUrl, title, sizeId) {
	const s = embedSize(sizeId);
	const src = embedPageUrl(glbUrl, title);
	return (
		`<iframe src="${escEmbed(src)}"\n` +
		`        width="${s.w}" height="${s.h}"\n` +
		`        style="border:0;border-radius:14px;max-width:100%"\n` +
		`        allow="xr-spatial-tracking; fullscreen"\n` +
		`        loading="lazy" title="${escEmbed(title || '3D model forged on three.ws')}">` +
		`</iframe>`
	);
}

export function buildWebComponentSnippet(glbUrl, title, sizeId) {
	const s = embedSize(sizeId);
	const alt = escEmbed(title || '3D model forged on three.ws');
	return (
		`<!-- once per page -->\n` +
		`<script type="module"\n` +
		`  src="${MODEL_VIEWER_CDN}"></scr` +
		`ipt>\n\n` +
		`<model-viewer\n` +
		`  src="${escEmbed(glbUrl)}"\n` +
		`  alt="${alt}"\n` +
		`  camera-controls auto-rotate ar\n` +
		`  tone-mapping="aces"\n` +
		`  environment-image="${ORIGIN}/environments/gallery/env.hdr"\n` +
		`  exposure="1.5"\n` +
		`  shadow-intensity="1" shadow-softness="0.9"\n` +
		`  style="width:${s.w}px;height:${s.h}px;max-width:100%;background:#0b0b0b;border-radius:14px">` +
		`\n</model-viewer>`
	);
}
