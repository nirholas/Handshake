// Forge embed snippets — the single source of truth for the "embed this model"
// code the platform hands out. Pure, framework-free builders shared by the full
// Forge embed modal (src/forge-embed-panel.js), the homepage mini Forge embed
// sheet (src/home-forge.js), and Scene Studio's Share action
// (src/scene-studio/actions.js), so no surface ever drifts on snippet shape,
// size presets, or the /forge/embed URLs.
//
// Three flavours, all real:
//   • iframe        — points at /forge/embed?src=<glb>, the zero-dependency
//                     three.ws viewer page (orbit + AR + branding). Drops onto
//                     any site with no scripts on the host page.
//   • web component — a <model-viewer> snippet for builders who want the model
//                     inline in their own DOM with their own controls.
//   • agent-3d       — the platform's own <agent-3d viewer> web component
//                     (@three-ws/avatar), pinned to the current major CDN
//                     channel per specs/EMBED_SPEC.md. `viewer` is a pure-3D
//                     mode: no chat chrome, just the framed, orbitable model.

const ORIGIN = 'https://three.ws';
const MODEL_VIEWER_CDN =
	'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';
// Major-version CDN channel (specs/EMBED_SPEC.md): follows minor/patch
// releases automatically without pinning exact bytes like a demo snippet
// would ("latest" is explicitly demo-only per that spec).
const AGENT_3D_CDN = `${ORIGIN}/agent-3d/0/agent-3d.js`;

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

// <agent-3d viewer> — the platform's own component instead of a third-party
// one. `viewer` drops the chat chrome for a pure, orbitable 3D embed; `ar`
// (added by prompt 04) opts into the "View in AR" affordance once the
// consumer's page loads @three-ws/avatar's viewer runtime — the full
// <agent-3d> monolith already supports AR via WebXR/Quick Look natively.
export function buildAgentThreeDSnippet(glbUrl, title, sizeId) {
	const s = embedSize(sizeId);
	const alt = escEmbed(title || '3D model forged on three.ws');
	return (
		`<!-- once per page -->\n` +
		`<script type="module" src="${AGENT_3D_CDN}"></scr` +
		`ipt>\n\n` +
		`<agent-3d\n` +
		`  src="${escEmbed(glbUrl)}"\n` +
		`  aria-label="${alt}"\n` +
		`  viewer\n` +
		`  style="display:block;width:${s.w}px;height:${s.h}px;max-width:100%;border-radius:14px;overflow:hidden">` +
		`\n</agent-3d>`
	);
}

// "Add to your agent/site" — the other two real distribution channels for a
// rigged creation, beyond the pure orbit-viewer embeds above. Both packages
// are published, documented npm modules (@three-ws/page-agent,
// @three-ws/walk) with their OWN real "bring your own GLB" contracts — these
// snippets use those contracts exactly (AvatarStage + SpeechNarrator "Option
// B" for page-agent per page-agent-sdk/docs/guide-custom-avatars.md;
// createWalkCompanion({ avatars }) with an absolute-URL roster entry for
// walk, per walk-sdk/src/roster.js's resolveAvatarUrl — "Absolute URLs pass
// through untouched"). Neither package needs the GLB to already be a
// platform `avatars` row: any public https URL (a fresh Forge creation's
// download link included) works as-is.

// @three-ws/page-agent — a rigged, lipsync-capable guide docked on the page.
// Requires a *rigged* GLB (skeleton + idle/talk clips or ARKit visemes) —
// the same requirement forge_avatar/rig_mesh already satisfy.
export function buildPageAgentSnippet(glbUrl, title) {
	const alt = escEmbed(title || 'Your agent');
	const url = escEmbed(glbUrl);
	return (
		`<!-- npm i @three-ws/page-agent three -->\n` +
		`<div id="guide" style="width:320px;height:420px"></div>\n` +
		`<script type="module">\n` +
		`  import { AvatarStage, SpeechNarrator } from '@three-ws/page-agent';\n\n` +
		`  const stage = new AvatarStage(document.getElementById('guide'), { background: 'transparent' });\n` +
		`  await stage.load('${url}', { framing: 'upper' });\n\n` +
		`  const narrator = new SpeechNarrator(stage);\n` +
		`  narrator.setAgent({ voice: { lang: 'en-US', rate: 1.0, pitch: 1.0 } });\n` +
		`  await narrator.speak('Hi — I\\'m ${alt}, forged on three.ws.');\n` +
		`</script>`
	);
}

// @three-ws/walk — an idling corner companion the visitor can detach into a
// full-page playground. `avatars` overrides the built-in roster with one
// custom entry (rig:'shared' retargets idle/walk/wave from the platform's
// shared clip library, matching forge_avatar/rig_mesh output).
export function buildWalkCompanionSnippet(glbUrl, title) {
	const alt = escEmbed(title || 'Your avatar');
	const url = escEmbed(glbUrl);
	return (
		`<!-- npm i @three-ws/walk three -->\n` +
		`<script type="module">\n` +
		`  import { createWalkCompanion } from '@three-ws/walk';\n\n` +
		`  const walk = createWalkCompanion({\n` +
		`    defaultAvatarId: 'mine',\n` +
		`    avatars: [{\n` +
		`      id: 'mine', name: '${alt}', emoji: '✨', category: 'Yours',\n` +
		`      asset: '${url}', source: 'static', rig: 'shared',\n` +
		`      clips: { idle: 'idle', walk: 'av-walk-feminine', run: 'av-walk-feminine', wave: 'wave', jump: 'jump' },\n` +
		`      tags: ['custom'],\n` +
		`    }],\n` +
		`  });\n` +
		`  walk.bootstrap();\n` +
		`</script>`
	);
}
