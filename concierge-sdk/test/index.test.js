/**
 * Package entry contract.
 *
 * The other suites cover individual modules. This one covers the thing every
 * consumer actually touches first: `import '@three-ws/concierge'`. It runs
 * under plain node with no DOM, which is exactly the environment an SSR
 * framework (Next, Nuxt, SvelteKit, Astro) evaluates the module in, so it also
 * pins the "importing the package must not need a browser" guarantee.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'));

const entry = await import('../src/index.js');

test('the entry imports with no DOM present (SSR safe)', () => {
	assert.equal(typeof globalThis.window, 'undefined');
	assert.equal(typeof globalThis.HTMLElement, 'undefined');
	assert.equal(typeof entry.Concierge, 'function');
	assert.equal(entry.default, entry.Concierge);
});

test('VERSION tracks package.json', () => {
	assert.equal(entry.VERSION, pkg.version);
});

test('every export the README documents is present', () => {
	const classes = ['Concierge', 'ThreeConciergeElement', 'AvatarStage', 'SpeechNarrator'];
	const functions = [
		'mount', 'registerElement', 'drainSentences',
		'createLipsync', 'buildMorphMap', 'estimateDurationMs',
		'getAvatar', 'avatarUrl', 'customAvatarEntry',
		'harvestSiteContext', 'buildSitePayload',
		'askConcierge', 'parseSseEvent', 'createSseBuffer',
		'renderMarkdown', 'stripMarkdown', 'escapeHtml',
		'createMic', 'micSupported', 'ensureStyles',
		'detectShop', 'normalizeShopDomain', 'shopOrigin', 'fetchCatalog',
		'fetchPolicies', 'searchProducts', 'parseIntent', 'catalogSummary',
		'buildShoppingPayload', 'normalizeProduct', 'money',
	];
	for (const name of [...classes, ...functions]) {
		assert.equal(typeof entry[name], 'function', `missing export: ${name}`);
	}
	assert.ok(Array.isArray(entry.AVATARS) && entry.AVATARS.length > 0);
	assert.equal(typeof entry.DEFAULT_AVATAR_ID, 'string');
	assert.equal(typeof entry.DEFAULT_ENDPOINT, 'string');
	assert.equal(typeof entry.DEFAULT_ASSET_BASE, 'string');
	assert.equal(typeof entry.CSS, 'string');
	for (const n of ['MAX_CONTENT_CHARS', 'MAX_KNOWLEDGE_CHARS', 'MAX_HISTORY_TURNS', 'MAX_RECOMMENDATIONS']) {
		assert.equal(typeof entry[n], 'number', `missing export: ${n}`);
	}
});

test('the documented imperative API exists on the prototype', () => {
	for (const m of ['ask', 'setOpen', 'toggle', 'setAvatar', 'setMuted', 'reset', 'dispose', 'on']) {
		assert.equal(typeof entry.Concierge.prototype[m], 'function', `Concierge#${m} missing`);
	}
});

test('the element proxies the documented methods', () => {
	for (const m of ['ask', 'open', 'close', 'reset', 'setAvatar', 'setMuted']) {
		assert.equal(
			typeof entry.ThreeConciergeElement.prototype[m],
			'function',
			`<three-concierge>#${m} missing`,
		);
	}
	for (const cb of ['connectedCallback', 'disconnectedCallback']) {
		assert.equal(typeof entry.ThreeConciergeElement.prototype[cb], 'function');
	}
});

test('registerElement is a no-op without customElements, and names the tag', () => {
	assert.equal(typeof globalThis.customElements, 'undefined');
	assert.equal(entry.registerElement(), 'three-concierge');
	assert.equal(entry.registerElement('my-concierge'), 'my-concierge');
});

test('the package manifest points at artifacts the build produces', () => {
	assert.equal(pkg.exports['.'].import, './dist/concierge.mjs');
	assert.equal(pkg.exports['./catalog'].import, './src/catalog.js');
	assert.equal(pkg.exports['./style.css'], './dist/concierge.css');
	assert.equal(pkg.exports['./global'], './dist/concierge.global.js');
	assert.equal(pkg.types, './types/index.d.ts');
	for (const f of ['dist/concierge.mjs', 'dist/concierge.global.js', 'dist/concierge.css', 'types']) {
		assert.ok(pkg.files.includes(f), `package.json "files" is missing ${f}`);
	}
});
