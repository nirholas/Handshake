/**
 * Entry-point contract for @three-ws/page-agent.
 *
 * These run under plain `node --test`, with no DOM at all, which is exactly the
 * environment an SSR framework (Next, Nuxt, SvelteKit, Astro) evaluates the
 * package in before it ever reaches a browser. Importing the entry there must
 * not throw: the docs tell framework users to construct `PageAgent` inside a
 * client-only effect, which only holds if the import itself is inert on the
 * server. The rest of the file pins the public surface the README and
 * docs/api-reference.md promise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as entry from '../src/index.js';
import PageAgentDefault from '../src/index.js';

test('the entry imports with no DOM present (SSR-safe)', () => {
	assert.equal(typeof globalThis.window, 'undefined', 'this suite must run without a DOM');
	assert.equal(typeof entry.PageAgent, 'function');
	assert.equal(typeof entry.PageAgentElement, 'function');
});

test('every export the docs promise is present and callable', () => {
	const classes = ['PageAgent', 'PageAgentElement', 'AvatarStage', 'SpeechNarrator', 'AvatarPicker'];
	const fns = [
		'registerElement', 'mount', 'collectSegments',
		'createLipsync', 'buildMorphMap', 'estimateDurationMs',
		'getAgent', 'agentUrl', 'filterAgents',
		'resolvePreset', 'sanitizeContext', 'buildSystemPrompt',
	];
	for (const name of [...classes, ...fns]) {
		assert.equal(typeof entry[name], 'function', `missing export: ${name}`);
	}
	assert.ok(Array.isArray(entry.AGENTS) && entry.AGENTS.length > 0);
	assert.equal(typeof entry.DEFAULT_AGENT_ID, 'string');
	assert.equal(typeof entry.DEFAULT_ASSET_BASE, 'string');
	assert.equal(typeof entry.PRESETS, 'object');
	assert.ok(Array.isArray(entry.PRESET_IDS) && entry.PRESET_IDS.length > 0);
});

test('the default export is the PageAgent class', () => {
	assert.equal(PageAgentDefault, entry.PageAgent);
});

test('constructing outside a browser fails loudly, as the framework guide documents', () => {
	assert.throws(() => new entry.PageAgent(), /requires a browser environment/);
	assert.throws(() => entry.mount({ agent: 'sol' }), /requires a browser environment/);
});

test('registerElement is a no-op without customElements and returns the tag', () => {
	assert.equal(typeof globalThis.customElements, 'undefined');
	assert.equal(entry.registerElement(), 'page-agent');
	assert.equal(entry.registerElement('my-guide'), 'my-guide');
});

test('<page-agent> proxies the documented imperative API', () => {
	const proto = entry.PageAgentElement.prototype;
	for (const method of ['connectedCallback', 'disconnectedCallback', 'narrate', 'narratePage',
		'stop', 'setAgent', 'mute', 'collapse', 'openPicker', 'setContext']) {
		assert.equal(typeof proto[method], 'function', `missing element method: ${method}`);
	}
	for (const getter of ['controller', 'currentAgent', 'currentPreset', 'systemPrompt', 'tools']) {
		assert.ok(Object.getOwnPropertyDescriptor(proto, getter)?.get, `missing element getter: ${getter}`);
	}
});

test('the README catalog columns match the catalog the code ships', () => {
	for (const agent of entry.AGENTS) {
		assert.equal(entry.getAgent(agent.id), agent);
		assert.ok(['viseme', 'jaw', 'animation'].includes(agent.lipsync), `${agent.id}: ${agent.lipsync}`);
		assert.deepEqual(entry.filterAgents({ lipsync: agent.lipsync }).includes(agent), true);
		assert.ok(entry.agentUrl(agent).startsWith('http'));
	}
	assert.ok(entry.getAgent(entry.DEFAULT_AGENT_ID));
});
