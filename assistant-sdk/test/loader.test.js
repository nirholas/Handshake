// Unit tests for the pure, DOM-free surface of @three-ws/assistant.
//
// The module imports cleanly in Node because it touches the DOM only at call
// time. These tests cover the parts that decide what the frame receives:
// frameUrl, isHex, configFromScript, and the createAssistant API shape.
//
// Run: node --test assistant-sdk/test/loader.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	frameUrl,
	isHex,
	PARAM_KEYS,
	CHANNEL,
	configFromScript,
	createAssistant,
} from '../src/loader.js';
import ThreeAssistant, { VERSION, init, say, mount } from '../src/index.js';

test('isHex accepts 3/6/8-digit hex only', () => {
	assert.equal(isHex('#abc'), true);
	assert.equal(isHex('#aabbcc'), true);
	assert.equal(isHex('#aabbccdd'), true);
	assert.equal(isHex('#abcd'), false);
	assert.equal(isHex('red'), false);
	assert.equal(isHex(42), false);
});

test('frameUrl only emits known keys and pins a host targetOrigin', () => {
	const url = frameUrl(
		{ name: 'Atelier AI', bg: 'ember', mode: 'chat', evil: 'dropme' },
		'https://three.ws',
		'https://customer.example',
	);
	const parsed = new URL(url);
	assert.equal(parsed.origin, 'https://three.ws');
	assert.equal(parsed.pathname, '/assistant-frame');
	assert.equal(parsed.searchParams.get('name'), 'Atelier AI');
	assert.equal(parsed.searchParams.get('bg'), 'ember');
	assert.equal(parsed.searchParams.get('mode'), 'chat');
	assert.equal(parsed.searchParams.get('evil'), null);
	assert.equal(parsed.searchParams.get('targetOrigin'), 'https://customer.example');
});

test('frameUrl skips empty values and respects an explicit targetOrigin', () => {
	const url = frameUrl(
		{ name: '', greeting: undefined, targetOrigin: 'https://pinned.example' },
		'https://three.ws',
		'https://customer.example',
	);
	const parsed = new URL(url);
	assert.equal(parsed.searchParams.get('name'), null);
	assert.equal(parsed.searchParams.get('targetOrigin'), 'https://pinned.example');
});

test('frameUrl produces a bare path when config is empty (no host origin)', () => {
	const url = frameUrl({}, 'https://three.ws', '');
	assert.equal(url, 'https://three.ws/assistant-frame');
});

test('PARAM_KEYS and CHANNEL are the stable wire contract', () => {
	for (const key of ['avatar', 'agent', 'bg', 'mode', 'accent', 'name', 'greeting', 'context', 'voice', 'badge', 'targetOrigin']) {
		assert.ok(PARAM_KEYS.includes(key), `${key} missing from PARAM_KEYS`);
	}
	assert.equal(CHANNEL, 'three-assistant');
});

test('configFromScript reads data-* attributes including position and open', () => {
	const attrs = {
		'data-name': 'Atelier AI',
		'data-bg': 'ocean',
		'data-position': 'left',
		'data-open': '',
	};
	const fakeScript = {
		getAttribute: (k) => (k in attrs ? attrs[k] : null),
		hasAttribute: (k) => k in attrs,
	};
	const config = configFromScript(fakeScript);
	assert.equal(config.name, 'Atelier AI');
	assert.equal(config.bg, 'ocean');
	assert.equal(config.position, 'left');
	assert.equal(config.open, true);
});

test('createAssistant exposes the full API bound to an origin', () => {
	const api = createAssistant({ origin: 'https://preview.three.ws' });
	assert.equal(api.origin, 'https://preview.three.ws');
	assert.equal(api.instance, null);
	for (const method of ['init', 'open', 'close', 'toggle', 'say', 'setMode', 'destroy']) {
		assert.equal(typeof api[method], 'function', `${method} must be a function`);
	}
});

test('idle API methods are safe no-ops with no instance mounted', () => {
	const api = createAssistant();
	assert.doesNotThrow(() => {
		api.open();
		api.close();
		api.toggle();
		api.say('hi');
		api.setMode('chat');
		api.destroy();
	});
	assert.equal(api.instance, null);
});

test('default export and named helpers are wired', () => {
	assert.equal(typeof VERSION, 'string');
	assert.equal(ThreeAssistant.origin, 'https://three.ws');
	assert.equal(typeof init, 'function');
	assert.equal(typeof say, 'function');
	assert.equal(typeof mount, 'function');
});
