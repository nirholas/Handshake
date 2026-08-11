// @three-ws/walk - the public entry point.
// ========================================
// The package's one import surface. Everything a host touches comes through
// src/index.js (bundled to dist/index.mjs by build.mjs), so this file locks in
// two promises the README makes: every documented export is really there with
// the shape the docs claim, and importing the package is side-effect free, so
// a server-rendered or SSR-prerendered host can import it with no DOM at all.
// Real module, real import, no DOM shim: `node --test` runs it bare.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as walk from '../src/index.js';

const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

// Everything the README's API section tells a host to import, and the type it
// promises. Adding a public export means adding it here.
const FUNCTIONS = [
	'createWalkCompanion',
	'createAvatarPicker',
	'getAvatar',
	'defaultAvatar',
	'listCategories',
	'makeApiAvatarEntry',
	'resolveAvatarUrl',
	'resolveEmotes',
	'loadWalkAvatar',
	'resolveConfig',
	'resolveAvatarEntry',
	'launchPlayground',
	'exitPlayground',
	'switchPlaygroundMode',
	'getPlaygroundMode',
	'shouldDropIn',
	'consumeDropIn',
	'playgroundState',
];

test('every documented function is exported and callable', () => {
	for (const name of FUNCTIONS) {
		assert.equal(typeof walk[name], 'function', `missing function export: ${name}`);
	}
});

test('roster and clip constants are exported with the documented shapes', () => {
	assert.ok(Array.isArray(walk.WALK_AVATARS) && walk.WALK_AVATARS.length > 0);
	assert.equal(typeof walk.DEFAULT_AVATAR_ID, 'string');
	assert.ok(walk.WALK_AVATARS.some((a) => a.id === walk.DEFAULT_AVATAR_ID));
	assert.ok(Array.isArray(walk.DEFAULT_EXCLUDED_PREFIXES));
	for (const key of ['DEFAULT_SHARED_CLIPS', 'DEFAULT_EMOTES']) {
		assert.equal(typeof walk[key], 'object', `missing constant export: ${key}`);
		assert.ok(Object.keys(walk[key]).length > 0, `${key} is empty`);
	}
});

test('VERSION tracks the published package version', () => {
	assert.equal(walk.VERSION, pkg.version);
});

test('importing the package touches no DOM global', () => {
	// The README promises "side-effect free on import". If any module ran DOM
	// work at import time, node would have thrown before reaching this test, so
	// the assertion is that the environment is still DOM-less.
	assert.equal(typeof globalThis.document, 'undefined');
	assert.equal(typeof globalThis.window, 'undefined');
});

test('createWalkCompanion returns the documented control surface', () => {
	const control = walk.createWalkCompanion();
	for (const method of [
		'isEnabled',
		'enable',
		'disable',
		'toggle',
		'setAvatar',
		'openPicker',
		'bootstrap',
	]) {
		assert.equal(typeof control[method], 'function', `control.${method} is missing`);
	}
	assert.equal(control.instance, null, 'no companion is constructed until enable()');
	assert.equal(control.isEnabled(), false, 'storage-less env reads as disabled');
});

test('createWalkCompanion mounts nothing and options reach the resolved config', () => {
	const control = walk.createWalkCompanion({
		defaultAvatarId: 'fox',
		assetBase: 'https://cdn.example',
		storagePrefix: 'demo',
	});
	assert.equal(control.config.defaultAvatarId, 'fox');
	assert.equal(control.config.assetBase, 'https://cdn.example');
	assert.equal(control.config.keys.enabled, 'demo:companion:enabled');
	// bootstrap() is the app-style auto-mount; with no window it is a no-op
	// rather than a crash, which is what makes SSR-safe imports possible.
	control.bootstrap();
	assert.equal(control.instance, null);
});

test('the low-level loader path resolves a roster entry to a real asset url', () => {
	const entry = walk.getAvatar(walk.DEFAULT_AVATAR_ID);
	assert.ok(entry, 'the default avatar resolves');
	const url = walk.resolveAvatarUrl(entry, { assetBase: 'https://three.ws' });
	assert.ok(url.startsWith('https://three.ws/'), `unexpected asset url: ${url}`);
	assert.ok(url.endsWith('.glb'), `default avatar should be a GLB: ${url}`);
});
