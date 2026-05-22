// Curated catalog of default avatars + accessories served from the
// three.ws public CDN. All URLs are public and cacheable — no auth needed.
//
// The MCP keeps avatar sessions in-process: spawning an avatar returns a
// session id that other tools (dress_avatar, viewer_url, render_clip) can
// reference. Sessions don't persist across MCP restarts; for production
// flows the client should re-call spawn_avatar.

import { randomUUID } from 'node:crypto';

import { THREE_WS_BASE, VIEWER_BASE } from '../config.js';

export const DEFAULT_AVATARS = [
	{
		id: 'default',
		name: 'three.ws default',
		description: 'Stylized humanoid base mesh, rigged with the three.ws standard skeleton. Good starting point for any persona.',
		glb: `${THREE_WS_BASE}/avatars/default.glb`,
		thumbnail: null,
	},
	{
		id: 'cz',
		name: 'CZ',
		description: 'Suited exchange-founder type with a clean rig. Drops well-known crypto vibes into your demo.',
		glb: `${THREE_WS_BASE}/avatars/cz.glb`,
		thumbnail: null,
	},
];

export const ACCESSORIES = [
	{ id: 'hat-baseball', slot: 'head', glb: `${THREE_WS_BASE}/accessories/hat-baseball.glb`, name: 'Baseball cap' },
	{ id: 'hat-beanie', slot: 'head', glb: `${THREE_WS_BASE}/accessories/hat-beanie.glb`, name: 'Beanie' },
	{ id: 'hat-cowboy', slot: 'head', glb: `${THREE_WS_BASE}/accessories/hat-cowboy.glb`, name: 'Cowboy hat' },
	{ id: 'glasses-round', slot: 'face', glb: `${THREE_WS_BASE}/accessories/glasses-round.glb`, name: 'Round glasses' },
	{ id: 'glasses-shades', slot: 'face', glb: `${THREE_WS_BASE}/accessories/glasses-shades.glb`, name: 'Shades' },
	{ id: 'earrings-hoops', slot: 'ears', glb: `${THREE_WS_BASE}/accessories/earrings-hoops.glb`, name: 'Hoop earrings' },
	{ id: 'earrings-studs', slot: 'ears', glb: `${THREE_WS_BASE}/accessories/earrings-studs.glb`, name: 'Stud earrings' },
];

export const POSE_PRESETS = [
	'idle', 'wave', 'thumbs_up', 'dab', 't_pose', 'sit', 'point', 'salute', 'cheer',
];

export function findAvatar(id) {
	return DEFAULT_AVATARS.find((a) => a.id === id) || null;
}

export function findAccessory(id) {
	return ACCESSORIES.find((a) => a.id === id) || null;
}

// In-memory session store. Maps sessionId → { avatar, accessories[], pose,
// voice, createdAt, lastUpdated }.
const sessions = new Map();

export function createSession({ glb, name, voice, persona, accessories = [], pose = 'idle' }) {
	const id = randomUUID();
	const session = {
		id,
		name: name || null,
		persona: persona || null,
		voice: voice || 'nova',
		avatar: { glb, source: glb.startsWith(THREE_WS_BASE) ? 'three.ws' : 'external' },
		accessories: accessories.slice(),
		pose,
		wallet: null,
		createdAt: new Date().toISOString(),
		lastUpdated: new Date().toISOString(),
	};
	sessions.set(id, session);
	return session;
}

export function getSession(id) {
	return sessions.get(id) || null;
}

export function updateSession(id, patch) {
	const s = sessions.get(id);
	if (!s) return null;
	Object.assign(s, patch, { lastUpdated: new Date().toISOString() });
	return s;
}

export function listSessions() {
	return [...sessions.values()];
}

export function viewerUrlFor(session) {
	const params = new URLSearchParams({ src: session.avatar.glb });
	if (session.accessories.length) params.set('accessories', session.accessories.map((a) => a.id).join(','));
	if (session.pose && session.pose !== 'idle') params.set('pose', session.pose);
	return `${VIEWER_BASE}?${params.toString()}`;
}
