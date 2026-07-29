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
	Group, Box3, Mesh, MeshStandardMaterial, CapsuleGeometry, SphereGeometry,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { AnimationManager } from '../animation-manager.js';
import { getMeshoptDecoder } from '../viewer/internal.js';
import { GUEST_SENTINEL, resolveGuestAvatar } from './play-handoff.js';
import { installVrmPlugin, prepareVrmModel } from './vrm-loader.js';
import { log } from '../shared/log.js';

export const AVATAR_DEFAULT = '/avatars/default.glb';
export const MANIFEST_URL = '/animations/manifest.json';
export const CLIP_IDLE = 'idle';
export const CLIP_WALK = 'av-walk-feminine';

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
	try {
		await meshoptReady; // ensure meshopt-compressed GLBs (incl. the default) parse
		// P3.4: pick up the reference VRM parser if boot installed one. Free no-op
		// otherwise, and idempotent, so it can sit on the hot path.
		installVrmPlugin(_gltf);
		const gltf = await _gltf.loadAsync(url);
		const model = gltf.scene;
		// A .vrm is a glTF binary, so it has already parsed by here; this fixes the
		// VRM-specific facing/culling/material issues a plain glTF load leaves
		// behind. No-op for every non-VRM avatar. See src/game/vrm-loader.js.
		prepareVrmModel(gltf);
		model.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = false; } });
		const box = new Box3().setFromObject(model);
		model.position.y -= box.min.y;
		rig.add(model);
		anim.attach(model);
		// Ensure the clip manifest is loaded before posing — callers often kick off
		// loadManifest() without awaiting it (see agent-commerce.js), so without this
		// the idle crossfade can run with no defs and leave the avatar in its raw
		// T-pose bind pose. loadManifest is idempotent + cached, so this is cheap.
		if (!_animDefs) await loadManifest();
		const defs = opts.clips === 'locomotion' ? getLocomotionDefs() : _animDefs;
		if (defs?.length) { anim.setAnimationDefs(defs); await anim.loadAll(); await anim.crossfadeTo(CLIP_IDLE, 0); }
		return { height: headAnchorHeight(box), fallback: false };
	} catch (err) {
		log.warn('[avatar-rig] avatar load failed, using stand-in:', url, err?.message);
		const body = new Mesh(new CapsuleGeometry(0.32, 0.7, 4, 10), new MeshStandardMaterial({ color: 0x8aa6d8 }));
		body.position.y = 0.85; body.castShadow = true;
		const head = new Mesh(new SphereGeometry(0.28, 14, 10), new MeshStandardMaterial({ color: 0xf1c9a5 }));
		head.position.y = 1.55; head.castShadow = true;
		rig.add(body, head);
		return { height: 1.7, fallback: true };
	}
}

// Play a one-shot emote clip on a rig's AnimationManager, then return to the
// locomotion clip. No-op if the emote isn't in the loaded manifest.
export async function playEmoteClip(anim, name, motion) {
	const def = (_allEmoteDefs || _emoteDefs || []).find((d) => d.name === name);
	if (!def) return;
	try {
		if (!anim.clips?.has?.(name)) await anim.loadAnimation(name, def.url, { loop: false });
		await anim.crossfadeTo(name, 0.15);
		setTimeout(() => anim.crossfadeTo(motion === 'walk' || motion === 'run' ? CLIP_WALK : CLIP_IDLE, 0.2), 2400);
	} catch { /* clip missing — ignore */ }
}

// Convenience: a fresh AnimationManager (re-exported so scenes don't need a
// separate import just to spin up a rig).
export function newAnim() {
	return new AnimationManager();
}
