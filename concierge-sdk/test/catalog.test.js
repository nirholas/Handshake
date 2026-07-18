import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	AVATARS,
	DEFAULT_AVATAR_ID,
	DEFAULT_ASSET_BASE,
	getAvatar,
	avatarUrl,
	customAvatarEntry,
} from '../src/catalog.js';

test('catalog entries are complete and rig-capable', () => {
	assert.ok(AVATARS.length >= 5);
	for (const a of AVATARS) {
		assert.ok(a.id && a.name && a.tagline, `${a.id}: identity fields`);
		assert.ok(a.file || a.url, `${a.id}: needs a GLB source`);
		assert.ok(['viseme', 'jaw', 'animation'].includes(a.lipsync), `${a.id}: lipsync mode`);
		assert.ok(['bust', 'upper', 'full'].includes(a.framing), `${a.id}: framing`);
		assert.ok(a.voice && typeof a.voice === 'object', `${a.id}: voice profile`);
		assert.match(a.accent, /^#[0-9a-f]{6}$/i, `${a.id}: accent color`);
	}
});

test('ids are unique and the default exists', () => {
	const ids = AVATARS.map((a) => a.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.includes(DEFAULT_AVATAR_ID));
});

test('getAvatar falls back to the default on unknown ids', () => {
	assert.equal(getAvatar('does-not-exist').id, DEFAULT_AVATAR_ID);
	assert.equal(getAvatar('nova').id, 'nova');
	assert.equal(getAvatar(undefined).id, DEFAULT_AVATAR_ID);
});

test('avatarUrl resolves against the asset base, absolute url wins', () => {
	const sol = getAvatar('sol');
	assert.equal(avatarUrl(sol), DEFAULT_ASSET_BASE + sol.file);
	assert.equal(avatarUrl(sol, 'https://cdn.example.com/glb'), 'https://cdn.example.com/glb/' + sol.file);
	assert.equal(avatarUrl({ ...sol, url: 'https://x.test/a.glb' }), 'https://x.test/a.glb');
	assert.equal(avatarUrl(null), null);
});

test('customAvatarEntry normalizes a bare URL and a partial entry', () => {
	const fromUrl = customAvatarEntry('https://x.test/hero.glb');
	assert.equal(fromUrl.id, 'custom');
	assert.equal(fromUrl.url, 'https://x.test/hero.glb');
	assert.ok(fromUrl.voice);

	const fromEntry = customAvatarEntry({ url: 'https://x.test/b.glb', name: 'Hero' });
	assert.equal(fromEntry.id, 'custom');
	assert.equal(fromEntry.name, 'Hero');
	assert.equal(fromEntry.url, 'https://x.test/b.glb');
});
