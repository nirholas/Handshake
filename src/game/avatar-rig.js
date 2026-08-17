// Shared avatar rig helpers — the single path for loading a GLB/VRM avatar into
// a Three.js rig, wiring its AnimationManager (idle/walk + emotes), and playing
// one-shot emotes. Used by every multiplayer 3D scene (the social walkaround in
// coincommunities.js, plus /walk and /city) so avatar loading, fallbacks, and
// the animation clip set never drift between experiences.
//
// Scene-specific concerns (chat bubbles, nameplates, position interpolation,
// HP bars) live in each scene's own player class — this module only owns the
// model + animation rig.

import {
	Box3, Mesh, MeshStandardMaterial, CapsuleGeometry, SphereGeometry,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationManager } from '../animation-manager.js';
import { getMeshoptDecoder } from '../viewer/internal.js';
import { GUEST_SENTINEL, resolveGuestAvatar } from './play-handoff.js';
import { installVrmPlugin, prepareVrmModel } from './vrm-loader.js';
import { log } from '../shared/log.js';

export const AVATAR_DEFAULT = '/avatars/default.glb';
export const MANIFEST_URL = '/animations/manifest.json';
export const CLIP_IDLE = 'idle';
export const CLIP_WALK = 'av-walk-feminine';
// The seated idle a driver holds behind the wheel. It lives in the emote half of
// the manifest, so locomotion-only rigs (every /play avatar) fetch it on demand
// through crossfadeToMotion rather than paying for it at join.
export const CLIP_DRIVE = 'sitloop';

// A shared GLTF loader with Draco decompression wired in — many avatar GLBs
// (and most Sketchfab/pump.fun exports) are Draco-compressed, and without this
// they fail with "No DRACOLoader instance provided". Decoders are vendored at
// /three/draco/gltf/ (see scripts/copy-three-decoders.mjs).
const _draco = new DRACOLoader();
_draco.setDecoderPath('/three/draco/gltf/');
const _gltf = new GLTFLoader();
_gltf.setDRACOLoader(_draco);
// Many avatar GLBs — including the platform's own /avatars/default.glb — ship
// with EXT_meshopt_compression. Without the meshopt decoder, GLTFLoader throws
// "setMeshoptDecoder must be called before loading compressed files" on the very
// first bufferView and every avatar silently falls back to a capsule stand-in.
// Wire the shared, memoized decoder once and gate loads on it (see meshoptReady)
// so the first avatar parses too. getMeshoptDecoder lazy-imports the small
// meshopt module and is shared with the rest of the app (footer-bot, viewer).
const meshoptReady = getMeshoptDecoder()
	.then((decoder) => { _gltf.setMeshoptDecoder(decoder); return decoder; })
	.catch((e) => { log.warn('[avatar-rig] meshopt decoder unavailable:', e?.message); return null; });
// Exported so other loaders (avatar-thumb, boot-avatar) share one decoder module
// + cache and can wire it onto their own GLTFLoader instances.
export const dracoLoader = _draco;
export { meshoptReady };
let _animDefs = null; // cached manifest defs (locomotion + emotes)
let _emoteDefs = null;
let _allEmoteDefs = null; // all non-locomotion emotes for the wheel

// Fetch the animation manifest once and cache the locomotion + emote clip defs.
// Idempotent: safe to await from multiple scenes.
export async function loadManifest() {
	if (_animDefs) return;
	let manifest = [];
	try {
		const r = await fetch(MANIFEST_URL, { cache: 'force-cache' });
		if (r.ok) manifest = await r.json();
	} catch { /* fall through to locomotion-only */ }
	const byName = (n) => manifest.find((d) => d.name === n);
	const loco = [byName(CLIP_IDLE), byName(CLIP_WALK)].filter(Boolean);
	const allEmotes = manifest.filter((d) => d.name !== CLIP_IDLE && d.name !== CLIP_WALK);
	_emoteDefs = allEmotes.slice(0, 6); // quick tray
	_allEmoteDefs = allEmotes;          // full wheel
	_animDefs = [...loco, ...allEmotes]; // register all for lazy loading
}

// The emote clip defs loaded by loadManifest() (empty until it resolves).
export function getEmoteDefs() {
	return _emoteDefs || [];
}

// All non-locomotion emote defs — powers the full emote wheel.
export function getAllEmoteDefs() {
	return _allEmoteDefs || [];
}

// The locomotion clip defs (idle + walk) loaded by loadManifest(). Lets other
// modules (e.g. the thumbnail renderer) pose an avatar into idle instead of its
// raw T-pose bind pose without re-parsing the manifest.
export function getLocomotionDefs() {
	return (_animDefs || []).filter((d) => d.name === CLIP_IDLE || d.name === CLIP_WALK);
}

// Resolve an avatar input (GLB/VRM URL, site path, or three.ws avatar id) to a
// loadable model URL. Falls back to the default avatar on anything unresolved.
export async function resolveAvatarUrl(input) {
	const v = (input || '').trim();
	if (!v) return AVATAR_DEFAULT;
	// A just-created avatar staged locally (create → play handoff). Resolves to a
	// blob: URL for instant self-preview; the scene uploads it in the background
	// and swaps in a public URL so peers can load it too.
	if (v === GUEST_SENTINEL) return (await resolveGuestAvatar()) || AVATAR_DEFAULT;
	if (/^https?:\/\//i.test(v) || v.startsWith('/')) return v;
	try {
		const r = await fetch(`/api/avatars/${encodeURIComponent(v)}`, { headers: { accept: 'application/json' } });
		if (r.ok) { const { avatar } = await r.json(); if (avatar?.url) return avatar.url; }
	} catch { /* ignore */ }
	return AVATAR_DEFAULT;
}

// ── shared model templates ────────────────────────────────────────────────────
// One download + parse per distinct avatar URL, shared by every rig that wears
// it. Before this cache, N peers in the same model cost N downloads, N parses
// and N full GPU uploads: with community avatars running to 24 MB, a crowded
// world OOM-killed phones. A clone (SkeletonUtils) deep-copies the bone
// hierarchy while sharing geometry and textures with its template; materials
// are cloned per rig (they are tiny) so per-peer effects like the downed-peer
// fade never bleed across players wearing the same model.

const MB = 1024 * 1024;
// A coarse primary pointer is the one signal phones and tablets reliably share.
const _touchPrimary = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
// Per-model download ceiling on touch devices. Uploads are capped at 16 MB, but
// a 10 MB+ meshopt GLB decompresses to far more than a phone can spare per
// peer; an oversized model renders as the default avatar there instead.
const PHONE_MODEL_DOWNLOAD_CAP = 10 * MB;
// Estimated resident bytes (geometry + decoded textures) the template cache may
// hold. Templates a rig still wears are never evicted; idle ones go LRU-first
// once the budget is crossed.
const RESIDENT_BUDGET_BYTES = _touchPrimary ? 160 * MB : 512 * MB;

const _templates = new Map();  // url → { url, promise, refs, bytes, lastUse }
const _cloneInfo = new WeakMap(); // cloned model root → { entry, materials }
const _sizeChecks = new Map(); // url → Promise<number|null> published byte size

// Published size of a remote model, from a HEAD request. Resolves null when the
// host hides content-length or blocks HEAD; unknown sizes are allowed through
// (the resident budget still bounds the session).
function publishedModelBytes(url) {
	if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) return Promise.resolve(null);
	let pending = _sizeChecks.get(url);
	if (!pending) {
		pending = fetch(url, { method: 'HEAD' })
			.then((r) => (r.ok ? Number(r.headers.get('content-length')) || null : null))
			.catch(() => null);
		_sizeChecks.set(url, pending);
	}
	return pending;
}

// Rough resident cost of a parsed scene: geometry buffers plus decoded RGBA
// texture bytes, each counted once however many meshes share them.
function estimateSceneBytes(scene) {
	let bytes = 0;
	const seen = new Set();
	scene.traverse((n) => {
		if (n.geometry && !seen.has(n.geometry.uuid)) {
			seen.add(n.geometry.uuid);
			for (const attr of Object.values(n.geometry.attributes || {})) bytes += attr?.array?.byteLength || 0;
			bytes += n.geometry.index?.array?.byteLength || 0;
		}
		const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
		for (const mat of mats) {
			for (const value of Object.values(mat)) {
				if (value?.isTexture && !seen.has(value.uuid)) {
					seen.add(value.uuid);
					const img = value.image;
					if (img?.width && img?.height) bytes += img.width * img.height * 4;
				}
			}
		}
	});
	return bytes;
}

function loadTemplate(url) {
	let entry = _templates.get(url);
	if (entry) return entry;
	entry = { url, refs: 0, bytes: 0, lastUse: Date.now(), promise: null };
	entry.promise = (async () => {
		await meshoptReady;
		installVrmPlugin(_gltf);
		const gltf = await _gltf.loadAsync(url);
		// VRM facing/skeleton fixes run once here; every clone inherits them.
		prepareVrmModel(gltf);
		const scene = gltf.scene;
		const box = new Box3().setFromObject(scene);
		entry.bytes = estimateSceneBytes(scene);
		return { scene, box };
	})();
	// A failed load must not poison the URL for the rest of the session.
	entry.promise.catch(() => { if (_templates.get(url) === entry) _templates.delete(url); });
	_templates.set(url, entry);
	return entry;
}

/**
 * True when a model is already downloaded (or downloading) into the shared
 * template cache, so wearing it again costs no network. The ambient crowd reads
 * this to decide whether picking a gallery model spends its download budget.
 */
export function hasModelTemplate(url) {
	return _templates.has(url);
}

function disposeTemplateScene(scene) {
	scene.traverse((n) => {
		if (!n.isMesh) return;
		n.geometry?.dispose?.();
		for (const mat of Array.isArray(n.material) ? n.material : [n.material]) {
			if (!mat) continue;
			for (const value of Object.values(mat)) value?.isTexture && value.dispose();
			mat.dispose?.();
		}
	});
}

// Drop idle templates (LRU first) until the cache fits the budget. Templates
// with live clones are always kept: their buffers are shared and in use.
function evictIdleTemplates() {
	let resident = 0;
	for (const e of _templates.values()) resident += e.bytes;
	if (resident <= RESIDENT_BUDGET_BYTES) return;
	const idle = [..._templates.values()].filter((e) => e.refs === 0).sort((a, b) => a.lastUse - b.lastUse);
	for (const e of idle) {
		if (resident <= RESIDENT_BUDGET_BYTES) break;
		_templates.delete(e.url);
		resident -= e.bytes;
		e.promise.then(({ scene }) => disposeTemplateScene(scene)).catch(() => { /* never parsed */ });
	}
}

// Release the avatar model (and any capsule stand-in) buildAvatar put on this
// rig: per-rig materials are disposed, the shared template is derefed, and idle
// templates past the memory budget are freed. Every scene that churns rigs
// (peers leaving, avatar swaps, world exits) must call this instead of relying
// on scene.remove()/rig.clear(), which drop the JS reference but leak the GPU
// buffers. Children this module didn't create (cosmetics, glow rings) are left
// for their owners to dispose.
export function releaseAvatar(rig) {
	if (!rig) return;
	for (const child of [...rig.children]) {
		const info = _cloneInfo.get(child);
		if (info) {
			rig.remove(child);
			_cloneInfo.delete(child);
			for (const mat of info.materials) mat.dispose();
			info.entry.refs = Math.max(0, info.entry.refs - 1);
			info.entry.lastUse = Date.now();
		} else if (child.userData?.avatarStandIn) {
			rig.remove(child);
			child.geometry?.dispose?.();
			child.material?.dispose?.();
		}
	}
	evictIdleTemplates();
}

// Plausible human heights in metres. Name labels and chat bubbles anchor to
// this value, so it must stay near the *visible* top of the avatar.
const MIN_AVATAR_HEIGHT_M = 0.5;
const MAX_AVATAR_HEIGHT_M = 2.4;
const FALLBACK_AVATAR_HEIGHT_M = 1.7;

// Derive the head-anchor height from a model's bounding box. Box3.setFromObject
// reads each skinned mesh's *rest-pose* geometry AABB — which for many rigged
// GLBs/VRMs bears no relation to the posed, visible silhouette (stray helper
// geometry, a scaled skeleton root, or bind-pose vertices flung far from origin
// can report tens of metres while the avatar renders at normal size). An
// unbounded height pushes the chat bubble past the camera's far plane, so the
// frustum cull in _updateLabels hides it and the bubble never appears above the
// head. Clamp to a human range so a mis-measured model still anchors sanely.
function headAnchorHeight(box) {
	const raw = box.max.y - box.min.y;
	if (!Number.isFinite(raw)) return FALLBACK_AVATAR_HEIGHT_M;
	return Math.min(MAX_AVATAR_HEIGHT_M, Math.max(MIN_AVATAR_HEIGHT_M, raw));
}

// Load a GLB avatar into a rig + wire an AnimationManager (idle/walk/emotes).
// Returns { height, fallback }. On failure, drops in a capsule stand-in so the
// player is never invisible, and flags `fallback: true` so callers can tell the
// user their model didn't load instead of silently swapping it.
//
// opts.clips: 'all' (default — locomotion + every emote, the /city and /play
// behaviour) or 'locomotion' — idle + walk only. Crowd-scale scenes (the Agora
// Commons loads a player AND every remote human this way) must not serialize
// entry behind dozens of emote-clip downloads; emotes still lazy-load on first
// use via playEmoteClip, which fetches a missing clip on demand.
export async function buildAvatar(rig, url, anim, opts = {}) {
	let loadUrl = url || AVATAR_DEFAULT;
	let downgraded = false;
	// On phones, refuse to download a model over the per-model ceiling: one 16 MB
	// GLB can end the whole session there. The peer still reads as a person (the
	// default avatar), and a template already resident costs nothing to reuse.
	if (_touchPrimary && loadUrl !== AVATAR_DEFAULT && !_templates.has(loadUrl)) {
		const bytes = await publishedModelBytes(loadUrl);
		if (bytes && bytes > PHONE_MODEL_DOWNLOAD_CAP) {
			log.warn('[avatar-rig] model over the mobile size cap, wearing the default:', loadUrl, `${(bytes / MB).toFixed(1)}MB`);
			loadUrl = AVATAR_DEFAULT;
			downgraded = true;
		}
	}
	try {
		const entry = loadTemplate(loadUrl);
		const { scene, box } = await entry.promise;
		const model = cloneSkinnedScene(scene);
		// Per-rig materials over shared geometry/textures: effects that write to a
		// material (downed-peer fade, highlights) must never leak onto another
		// player wearing the same model.
		const materials = [];
		model.traverse((n) => {
			if (!n.isMesh) return;
			n.castShadow = true; n.receiveShadow = false;
			if (n.material) {
				const mats = (Array.isArray(n.material) ? n.material : [n.material]).map((m) => m.clone());
				n.material = Array.isArray(n.material) ? mats : mats[0];
				materials.push(...mats);
			}
		});
		model.position.y -= box.min.y;
		entry.refs += 1;
		entry.lastUse = Date.now();
		_cloneInfo.set(model, { entry, materials });
		rig.add(model);
		anim.attach(model);
		// Ensure the clip manifest is loaded before posing — callers often kick off
		// loadManifest() without awaiting it (see agent-commerce.js), so without this
		// the idle crossfade can run with no defs and leave the avatar in its raw
		// T-pose bind pose. loadManifest is idempotent + cached, so this is cheap.
		if (!_animDefs) await loadManifest();
		const defs = opts.clips === 'locomotion' ? getLocomotionDefs() : _animDefs;
		if (defs?.length) { anim.setAnimationDefs(defs); await anim.loadAll(); await anim.crossfadeTo(CLIP_IDLE, 0); }
		return { height: headAnchorHeight(box), fallback: downgraded, downgraded };
	} catch (err) {
		log.warn('[avatar-rig] avatar load failed, using stand-in:', loadUrl, err?.message);
		// The requested model failed; the bundled default keeps the player human-
		// shaped before the capsule of last resort.
		if (loadUrl !== AVATAR_DEFAULT) {
			const res = await buildAvatar(rig, AVATAR_DEFAULT, anim, opts);
			return { ...res, fallback: true, downgraded: true };
		}
		const body = new Mesh(new CapsuleGeometry(0.32, 0.7, 4, 10), new MeshStandardMaterial({ color: 0x8aa6d8 }));
		body.position.y = 0.85; body.castShadow = true; body.userData.avatarStandIn = true;
		const head = new Mesh(new SphereGeometry(0.28, 14, 10), new MeshStandardMaterial({ color: 0xf1c9a5 }));
		head.position.y = 1.55; head.castShadow = true; head.userData.avatarStandIn = true;
		rig.add(body, head);
		return { height: 1.7, fallback: true };
	}
}

// The library clip a networked `motion` value poses an avatar in. Every scene
// that renders somebody else's motion goes through this, so a driver reads as
// seated for their peers exactly as they do for themselves.
export function clipForMotion(motion) {
	if (motion === 'walk' || motion === 'run') return CLIP_WALK;
	if (motion === 'drive') return CLIP_DRIVE;
	return CLIP_IDLE;
}

/**
 * Crossfade a rig into the clip for a `motion` value, fetching the clip first
 * when the rig was built locomotion-only. Falls back to the standing idle if
 * the seated clip can't be loaded or retargeted onto this particular model, so
 * an avatar is never left frozen in whatever pose it was last in.
 */
export async function crossfadeToMotion(anim, motion, duration = 0.18) {
	if (!anim) return;
	const name = clipForMotion(motion);
	try {
		if (!anim.clips?.has?.(name)) {
			if (!_animDefs) await loadManifest();
			const def = (_animDefs || []).find((d) => d.name === name);
			if (def) await anim.loadAnimation(name, def.url, { loop: true });
		}
		await anim.crossfadeTo(name, duration);
		if (anim.currentName === name || name === CLIP_IDLE) return;
	} catch (e) {
		log.warn(`[avatar-rig] "${name}" unavailable for this rig:`, e?.message);
	}
	await anim.crossfadeTo(CLIP_IDLE, duration);
}

// Play a one-shot emote clip on a rig's AnimationManager, then return to the
// locomotion clip. No-op if the emote isn't in the loaded manifest.
export async function playEmoteClip(anim, name, motion) {
	const def = (_allEmoteDefs || _emoteDefs || []).find((d) => d.name === name);
	if (!def) return;
	try {
		if (!anim.clips?.has?.(name)) await anim.loadAnimation(name, def.url, { loop: false });
		await anim.crossfadeTo(name, 0.15);
		setTimeout(() => crossfadeToMotion(anim, motion, 0.2), 2400);
	} catch { /* clip missing — ignore */ }
}

// Convenience: a fresh AnimationManager (re-exported so scenes don't need a
// separate import just to spin up a rig).
export function newAnim() {
	return new AnimationManager();
}
