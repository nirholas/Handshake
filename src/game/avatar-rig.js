// Shared avatar rig helpers — the single path for loading a GLB/VRM avatar into
// a Three.js rig, wiring its AnimationManager (idle/walk + emotes), and playing
// one-shot emotes. Used by every multiplayer 3D scene (the social walkaround in
// coincommunities.js, the isometric RPG in iso-game.js) so avatar loading,
// fallbacks, and the animation clip set never drift between experiences.
//
// Scene-specific concerns (chat bubbles, nameplates, position interpolation,
// HP bars) live in each scene's own player class — this module only owns the
// model + animation rig.

import {
	Group, Box3, Mesh, MeshStandardMaterial, CapsuleGeometry, SphereGeometry,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationManager } from '../animation-manager.js';

export const AVATAR_DEFAULT = '/avatars/default.glb';
export const MANIFEST_URL = '/animations/manifest.json';
export const CLIP_IDLE = 'idle';
export const CLIP_WALK = 'av-walk-feminine';

const _gltf = new GLTFLoader();
let _animDefs = null; // cached manifest defs (locomotion + emotes)
let _emoteDefs = null;

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
	const emotes = manifest.filter((d) => d.name !== CLIP_IDLE && d.name !== CLIP_WALK).slice(0, 6);
	_emoteDefs = emotes;
	_animDefs = [...loco, ...emotes];
}

// The emote clip defs loaded by loadManifest() (empty until it resolves).
export function getEmoteDefs() {
	return _emoteDefs || [];
}

// Resolve an avatar input (GLB/VRM URL, site path, or three.ws avatar id) to a
// loadable model URL. Falls back to the default avatar on anything unresolved.
export async function resolveAvatarUrl(input) {
	const v = (input || '').trim();
	if (!v) return AVATAR_DEFAULT;
	if (/^https?:\/\//i.test(v) || v.startsWith('/')) return v;
	try {
		const r = await fetch(`/api/avatars/${encodeURIComponent(v)}`, { headers: { accept: 'application/json' } });
		if (r.ok) { const { avatar } = await r.json(); if (avatar?.url) return avatar.url; }
	} catch { /* ignore */ }
	return AVATAR_DEFAULT;
}

// Load a GLB avatar into a rig + wire an AnimationManager (idle/walk/emotes).
// Returns { height }. On failure, drops in a capsule stand-in so the player is
// never invisible.
export async function buildAvatar(rig, url, anim) {
	try {
		const gltf = await _gltf.loadAsync(url);
		const model = gltf.scene;
		model.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = false; } });
		const box = new Box3().setFromObject(model);
		model.position.y -= box.min.y;
		rig.add(model);
		anim.attach(model);
		if (_animDefs?.length) { anim.setAnimationDefs(_animDefs); await anim.loadAll(); await anim.crossfadeTo(CLIP_IDLE, 0); }
		return { height: Math.max(0.5, box.max.y - box.min.y) };
	} catch (err) {
		console.warn('[avatar-rig] avatar load failed, using stand-in:', url, err?.message);
		const body = new Mesh(new CapsuleGeometry(0.32, 0.7, 4, 10), new MeshStandardMaterial({ color: 0x8aa6d8 }));
		body.position.y = 0.85; body.castShadow = true;
		const head = new Mesh(new SphereGeometry(0.28, 14, 10), new MeshStandardMaterial({ color: 0xf1c9a5 }));
		head.position.y = 1.55; head.castShadow = true;
		rig.add(body, head);
		return { height: 1.7 };
	}
}

// Play a one-shot emote clip on a rig's AnimationManager, then return to the
// locomotion clip. No-op if the emote isn't in the loaded manifest.
export async function playEmoteClip(anim, name, motion) {
	const def = getEmoteDefs().find((d) => d.name === name);
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
