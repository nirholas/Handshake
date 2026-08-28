// Machine vision for 3D: turn a GLB into something an AI agent can actually see.
//
// Every text-to-3D API in existence answers with a URL to a binary file. The
// agent that asked for the model cannot open it, cannot judge it, and cannot
// tell a clean mesh from a melted one. It has to hand the link to a human and
// hope. That blindness is the reason agentic 3D stalls at one shot: there is no
// feedback signal to iterate on.
//
// This module closes the loop. It renders a model from several angles and
// returns the frames as image bytes, so a vision-capable agent (MCP image
// content blocks, or any multimodal API) LOOKS at the thing it just made,
// forms an opinion, and fixes it. Paired with the geometry facts below, an
// agent can answer the questions it could never answer before: is the subject
// complete, is it facing the right way, is the topology sane, is it the size it
// claims to be.
//
// The renderer is the platform's own headless pipeline (avatar-render.js), the
// same one the quality gate and the avatar studio use, so a frame here is the
// frame every other surface would produce. Nothing new holds a GPU.

import { renderAvatarScene, SCENE_PRESETS } from './avatar-render.js';
import { assertSafePublicUrl } from './ssrf-guard.js';

// Camera angles, in the renderer's orbit terms: `theta` swings around the
// model, `phi` is the polar angle (90 is eye level, smaller looks down).
//
// The default set is chosen to be the smallest number of frames that answers
// "is this model good": the three-quarter reads form and depth the way a
// product shot does, front and side catch asymmetry and collapsed faces, and
// back catches the half of the model a single-view generator most often leaves
// unfinished. More frames cost render seconds and agent context for very
// little extra signal.
export const VIEW_ANGLES = Object.freeze({
	front: { theta: 0, phi: 80 },
	'three-quarter': { theta: 35, phi: 78 },
	side: { theta: 90, phi: 80 },
	back: { theta: 180, phi: 80 },
	top: { theta: 0, phi: 25 },
	bottom: { theta: 0, phi: 155 },
});

export const DEFAULT_VIEWS = Object.freeze(['three-quarter', 'front', 'side', 'back']);
export const MAX_VIEWS = 6;
export const MIN_SIZE = 128;
export const MAX_SIZE = 1024;
export const DEFAULT_SIZE = 512;

export function isKnownView(name) {
	return Object.hasOwn(VIEW_ANGLES, String(name));
}

// Normalize a caller's view list: unknown names are dropped rather than
// failing the call (an agent guessing "left" should still get its render), the
// order the caller asked for is preserved, duplicates collapse, and an empty
// result falls back to the default set instead of rendering nothing.
export function normalizeViews(requested) {
	if (!Array.isArray(requested) || requested.length === 0) return [...DEFAULT_VIEWS];
	const seen = new Set();
	const out = [];
	for (const name of requested) {
		const key = String(name || '').trim().toLowerCase();
		if (!isKnownView(key) || seen.has(key)) continue;
		seen.add(key);
		out.push(key);
		if (out.length >= MAX_VIEWS) break;
	}
	return out.length ? out : [...DEFAULT_VIEWS];
}

export function normalizeSize(requested) {
	const n = Math.round(Number(requested));
	if (!Number.isFinite(n)) return DEFAULT_SIZE;
	return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
}

// Render one model from several angles.
//
// Frames are produced SEQUENTIALLY on purpose. The renderer drives one shared
// headless browser; firing four pages at it in parallel is how you turn a
// 4-second turntable into an out-of-memory kill under any real concurrency.
// A failed frame is recorded and skipped rather than failing the whole set:
// three good views beat an error, and the caller is told which angle is missing.
export async function renderTurntable({ glbUrl, views, size, background = 'transparent' } = {}) {
	await assertSafePublicUrl(glbUrl);
	const names = normalizeViews(views);
	const dim = normalizeSize(size);
	const frames = [];
	const failed = [];
	for (const name of names) {
		const orbit = VIEW_ANGLES[name];
		try {
			const { png } = await renderAvatarScene({
				glbUrl,
				width: dim,
				height: dim,
				background,
				cameraOrbit: { theta: orbit.theta, phi: orbit.phi, radius: null },
				// 'full-body' frames the entire bounding box. The other presets crop
				// to a humanoid's torso or head, which would silently cut a prop,
				// a vehicle or a creature in half.
				scenePreset: SCENE_PRESETS['full-body'],
			});
			frames.push({ view: name, ...orbit, png, bytes: png.length });
		} catch (err) {
			failed.push({ view: name, error: String(err?.message || err).slice(0, 160) });
		}
	}
	if (!frames.length) {
		const detail = failed[0]?.error || 'the renderer produced no frames';
		throw Object.assign(new Error(`could not render this model: ${detail}`), { code: 'render_failed', failed });
	}
	return { frames, failed, size: dim };
}

// Plain-language reading of the geometry, for an agent that has the numbers but
// no intuition for what they mean. Every line is derived from the stats the
// inspector already returns; nothing here guesses at quality it cannot measure.
export function describeGeometry(stats) {
	if (!stats || typeof stats !== 'object') return [];
	const notes = [];
	const tris = Number(stats.triangles);
	if (Number.isFinite(tris) && tris > 0) {
		const band =
			tris < 2_000
				? 'very light, suitable for a distant prop or a low-end device'
				: tris < 60_000
					? 'a normal real-time budget for a hero prop or character'
					: tris < 300_000
						? 'heavy for real time; consider decimating before shipping to a game or the web'
						: 'far above a real-time budget; this is a render or print asset, not a game asset';
		notes.push(`${tris.toLocaleString('en-US')} triangles, ${band}.`);
	}
	const mats = Number(stats.materials);
	if (Number.isFinite(mats) && mats > 8) {
		notes.push(`${mats} materials means at least that many draw calls; merging identical ones is usually free performance.`);
	}
	if (stats.animations > 0) notes.push(`Carries ${stats.animations} animation clip(s).`);
	if (stats.textures === 0) notes.push('No textures: the surface is untextured or vertex-coloured only.');
	return notes;
}
