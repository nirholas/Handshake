// @three-ws/walk — roster invariants.
// ====================================
// The roster is the contract the unified loader relies on: every entry must
// declare a known-good animation strategy and a resolvable asset so nothing
// ever freezes in a bind/T-pose. These tests pin those invariants and the URL
// resolution that lets one roster work from the host origin, a CDN, or the GLB
// proxy. Pure logic — no Three.js, no DOM — so they run anywhere with
// `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	WALK_AVATARS,
	DEFAULT_AVATAR_ID,
	DEFAULT_SHARED_CLIPS,
	getAvatar,
	defaultAvatar,
	listCategories,
	makeApiAvatarEntry,
	makeGuestAvatarEntry,
	resolveAvatarUrl,
} from '../src/roster.js';

const STATES = ['idle', 'walk', 'run', 'wave', 'jump'];

test('every roster entry carries the fields the loader and picker need', () => {
	for (const a of WALK_AVATARS) {
		assert.equal(typeof a.id, 'string', `id on ${JSON.stringify(a)}`);
		assert.ok(a.id.length, `non-empty id on ${a.id}`);
		assert.equal(typeof a.name, 'string', `name on ${a.id}`);
		assert.equal(typeof a.category, 'string', `category on ${a.id}`);
		assert.ok(['embedded', 'shared'].includes(a.rig), `rig on ${a.id}`);
		assert.ok(['static', 'api'].includes(a.source), `source on ${a.id}`);
		assert.equal(typeof a.accent, 'string', `accent on ${a.id}`);
		assert.ok(/^#[0-9a-f]{3,8}$/i.test(a.accent), `accent is a hex colour on ${a.id}`);
	}
});

test('avatar ids are unique', () => {
	const ids = WALK_AVATARS.map((a) => a.id);
	assert.equal(new Set(ids).size, ids.length, 'duplicate avatar id in roster');
});

test('the default avatar exists in the roster', () => {
	assert.ok(getAvatar(DEFAULT_AVATAR_ID), 'DEFAULT_AVATAR_ID not present in WALK_AVATARS');
	assert.equal(defaultAvatar().id, DEFAULT_AVATAR_ID);
});

test('getAvatar resolves known ids and is null-safe', () => {
	assert.equal(getAvatar('fox')?.id, 'fox');
	assert.equal(getAvatar('does-not-exist'), null);
	assert.equal(getAvatar(''), null);
	assert.equal(getAvatar(null), null);
	assert.equal(getAvatar(undefined), null);
});

test('static entries point at a local asset; api/null are handled elsewhere', () => {
	for (const a of WALK_AVATARS) {
		if (a.source !== 'static') continue;
		assert.equal(typeof a.asset, 'string', `static ${a.id} must name an asset`);
		assert.ok(a.asset.startsWith('/') || /^https?:\/\//i.test(a.asset), `asset path on ${a.id}`);
	}
});

test('shared rigs only request known animation states', () => {
	for (const a of WALK_AVATARS) {
		if (a.rig !== 'shared' || !a.clips) continue;
		for (const k of Object.keys(a.clips)) {
			assert.ok(STATES.includes(k), `shared ${a.id} maps unknown state "${k}"`);
			assert.equal(typeof a.clips[k], 'string', `shared ${a.id}.${k} must name a manifest clip`);
		}
	}
});

test('embedded clip overrides are candidate-name arrays', () => {
	for (const a of WALK_AVATARS) {
		if (a.rig !== 'embedded' || !a.clips) continue;
		for (const k of Object.keys(a.clips)) {
			assert.ok(STATES.includes(k), `embedded ${a.id} maps unknown state "${k}"`);
			assert.ok(Array.isArray(a.clips[k]), `embedded ${a.id}.${k} must be a candidate array`);
		}
	}
});

test('DEFAULT_SHARED_CLIPS covers every animation state', () => {
	for (const s of STATES) {
		assert.equal(typeof DEFAULT_SHARED_CLIPS[s], 'string', `missing default clip for "${s}"`);
	}
});

test('listCategories is de-duplicated and in first-seen order', () => {
	const cats = listCategories();
	assert.equal(new Set(cats).size, cats.length, 'duplicate category');
	// first-seen order: the first roster entry seeds the first category.
	assert.equal(cats[0], WALK_AVATARS[0].category);
	// every roster category appears.
	for (const a of WALK_AVATARS) assert.ok(cats.includes(a.category), `missing ${a.category}`);
});

test('makeApiAvatarEntry builds a shared, retargeted, user-owned entry', () => {
	const e = makeApiAvatarEntry('abc123');
	assert.equal(e.id, 'abc123');
	assert.equal(e.source, 'api');
	assert.equal(e.rig, 'shared');
	assert.equal(e.asset, null);
	assert.equal(e.category, 'Yours');
	assert.deepEqual(e.clips, DEFAULT_SHARED_CLIPS);

	const named = makeApiAvatarEntry('xyz', { name: 'Nova', accent: '#abcdef' });
	assert.equal(named.name, 'Nova');
	assert.equal(named.accent, '#abcdef');
});

test('resolveAvatarUrl: static paths honour assetBase', () => {
	const fox = getAvatar('fox');
	assert.equal(resolveAvatarUrl(fox), fox.asset);
	assert.equal(resolveAvatarUrl(fox, { assetBase: 'https://cdn.example' }), `https://cdn.example${fox.asset}`);
});

test('resolveAvatarUrl: absolute asset urls pass through untouched', () => {
	const entry = { source: 'static', asset: 'https://cdn.example/x.glb' };
	assert.equal(resolveAvatarUrl(entry, { assetBase: 'https://other' }), 'https://cdn.example/x.glb');
});

test('resolveAvatarUrl: api entries hit the GLB proxy with apiBase + encoding', () => {
	const e = makeApiAvatarEntry('user/with space');
	assert.equal(resolveAvatarUrl(e), `/api/avatars/${encodeURIComponent('user/with space')}/glb`);
	assert.equal(
		resolveAvatarUrl(e, { apiBase: 'https://api.example' }),
		`https://api.example/api/avatars/${encodeURIComponent('user/with space')}/glb`,
	);
});

test('resolveAvatarUrl: null entry and asset-less static entry resolve to null', () => {
	assert.equal(resolveAvatarUrl(null), null);
	assert.equal(resolveAvatarUrl({ source: 'static', asset: null }), null);
});

test('makeGuestAvatarEntry: a message from a contact can be delivered by their own GLB', () => {
	const entry = makeGuestAvatarEntry('https://three.ws/api/avatars/abc/glb', { name: 'Sarah' });
	assert.equal(entry.name, 'Sarah');
	assert.equal(entry.rig, 'shared');
	assert.deepEqual(entry.clips, DEFAULT_SHARED_CLIPS);
	// The URL is used verbatim: a guest body is somebody else's avatar, not one
	// of ours to resolve against assetBase.
	assert.equal(resolveAvatarUrl(entry, { assetBase: 'https://cdn.example' }), 'https://three.ws/api/avatars/abc/glb');
});

test('makeGuestAvatarEntry: distinct URLs get distinct ids so a swap is detectable', () => {
	const a = makeGuestAvatarEntry('/avatars/one.glb');
	const b = makeGuestAvatarEntry('/avatars/two.glb');
	assert.notEqual(a.id, b.id);
	assert.equal(makeGuestAvatarEntry('/avatars/one.glb', { id: 'pinned' }).id, 'pinned');
	assert.equal(resolveAvatarUrl(a, { assetBase: 'https://cdn.example' }), 'https://cdn.example/avatars/one.glb');
});
