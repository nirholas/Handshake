// @three-ws/walk — config resolution.
// ====================================
// One options object flows to the companion and the playground. Defaults must
// match the three.ws app — including the storage keys — so an existing
// visitor's saved avatar/state carries over, and a host can repoint assets,
// routes, and the picker without touching internals. Pure logic; `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, resolveAvatarEntry, DEFAULT_EXCLUDED_PREFIXES } from '../src/config.js';
import { WALK_AVATARS, DEFAULT_AVATAR_ID } from '../src/roster.js';

test('resolveConfig fills sensible defaults', () => {
	const c = resolveConfig();
	assert.equal(c.avatars, WALK_AVATARS);
	assert.equal(c.defaultAvatarId, DEFAULT_AVATAR_ID);
	assert.equal(c.assetBase, '');
	assert.equal(c.apiBase, '');
	assert.equal(c.manifestUrl, '/animations/manifest.json');
	assert.equal(c.excludedRoutes, DEFAULT_EXCLUDED_PREFIXES);
	assert.equal(c.enablePicker, true);
	assert.equal(c.lookAt, true);
	assert.equal(c.greeting, null);
	assert.equal(c.docsUrl, null);
});

test('lookAt is opt-out only when explicitly false', () => {
	// Cursor tracking is procedural IK on the live rig, so a host that wants the
	// fixed gaze has to say so; anything short of `false` keeps it on.
	assert.equal(resolveConfig({ lookAt: false }).lookAt, false);
	assert.equal(resolveConfig({ lookAt: undefined }).lookAt, true);
	assert.equal(resolveConfig({ lookAt: 0 }).lookAt, true);
});

test('storage keys are namespaced by storagePrefix', () => {
	const def = resolveConfig();
	assert.equal(def.keys.enabled, 'walk:companion:enabled');
	assert.equal(def.keys.state, 'walk:companion:state');
	assert.equal(def.keys.avatar, 'walk:companion:avatar');
	assert.equal(def.keys.greet, 'walk:companion:greet');
	assert.equal(def.keys.invited, 'walk:companion:invited');
	assert.equal(def.keys.resume, 'walk:playground:resume');
	assert.equal(def.keys.mode, 'walk:playground:mode');

	const pre = resolveConfig({ storagePrefix: 'three' });
	assert.equal(pre.keys.enabled, 'three:companion:enabled');
	assert.equal(pre.keys.resume, 'three:playground:resume');
});

test('enablePicker is opt-out only when explicitly false', () => {
	assert.equal(resolveConfig({ enablePicker: false }).enablePicker, false);
	assert.equal(resolveConfig({ enablePicker: undefined }).enablePicker, true);
	// any non-false value keeps the picker on
	assert.equal(resolveConfig({ enablePicker: 0 }).enablePicker, true);
});

test('greeting is kept only when it is a function', () => {
	const fn = (p) => p;
	assert.equal(resolveConfig({ greeting: fn }).greeting, fn);
	assert.equal(resolveConfig({ greeting: 'hi' }).greeting, null);
	assert.equal(resolveConfig({ greeting: null }).greeting, null);
});

test('hosts can repoint assets, api, manifest, routes, and docs', () => {
	const c = resolveConfig({
		assetBase: 'https://cdn.example',
		apiBase: 'https://api.example',
		manifestUrl: '/anim.json',
		excludedRoutes: ['/admin'],
		docsUrl: '/make',
	});
	assert.equal(c.assetBase, 'https://cdn.example');
	assert.equal(c.apiBase, 'https://api.example');
	assert.equal(c.manifestUrl, '/anim.json');
	assert.deepEqual(c.excludedRoutes, ['/admin']);
	assert.equal(c.docsUrl, '/make');
});

test('resolveAvatarEntry maps a roster id to its entry', () => {
	const c = resolveConfig();
	assert.equal(resolveAvatarEntry('fox', c).id, 'fox');
});

test('resolveAvatarEntry falls back to the default avatar for empty ids', () => {
	const c = resolveConfig();
	assert.equal(resolveAvatarEntry(null, c).id, DEFAULT_AVATAR_ID);
	assert.equal(resolveAvatarEntry('', c).id, DEFAULT_AVATAR_ID);
});

test('resolveAvatarEntry treats an unknown id as a user-generated api avatar', () => {
	const c = resolveConfig();
	const e = resolveAvatarEntry('unknown-user-id', c);
	assert.equal(e.id, 'unknown-user-id');
	assert.equal(e.source, 'api');
	assert.equal(e.rig, 'shared');
});

test('resolveAvatarEntry resolves against a custom roster', () => {
	const custom = [
		{ id: 'mascot', name: 'M', category: 'Brand', rig: 'shared', source: 'static', asset: '/m.glb', accent: '#fff' },
	];
	const c = resolveConfig({ avatars: custom, defaultAvatarId: 'mascot' });
	assert.equal(resolveAvatarEntry('mascot', c).id, 'mascot');
	assert.equal(resolveAvatarEntry(null, c).id, 'mascot');
});

test('DEFAULT_EXCLUDED_PREFIXES covers the full-screen 3D routes', () => {
	for (const p of ['/walk', '/embed', '/club', '/xr']) {
		assert.ok(DEFAULT_EXCLUDED_PREFIXES.includes(p), `missing excluded route ${p}`);
	}
});
