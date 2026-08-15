// Core-path tests for the mounted widget: the launcher, the panel, the iframe,
// and the postMessage bridge that carries `say` into the frame.
//
// The pure helpers are covered in loader.test.js; this suite drives the part a
// host page actually uses, so it needs a DOM. jsdom stands in for the browser
// (the widget never runs outside a page), and the frame is never loaded: the
// bridge is exercised by dispatching the same messages the real frame sends.
//
// Run: node --test assistant-sdk/test/mount.test.js

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
	url: 'https://customer.example/pricing',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.CustomEvent = dom.window.CustomEvent;

const { createAssistant, CHANNEL } = await import('../src/loader.js');

const ORIGIN = 'https://three.ws';

/** Deliver a frame->host message exactly as the real frame would. */
function fromFrame(assistant, type, payload, overrides = {}) {
	const event = new dom.window.MessageEvent('message', {
		data: { channel: CHANNEL, v: 1, type, payload },
		origin: overrides.origin ?? ORIGIN,
	});
	// jsdom's MessageEvent constructor ignores `source` unless it is a real
	// window proxy, so pin it directly to the frame the widget mounted.
	Object.defineProperty(event, 'source', {
		value: 'source' in overrides ? overrides.source : assistant.iframe.contentWindow,
	});
	dom.window.dispatchEvent(event);
}

/** Capture every `three-assistant` CustomEvent the widget emits on window. */
function recordEvents() {
	const seen = [];
	const onEvent = (e) => seen.push({ type: e.detail.type, payload: e.detail.payload });
	dom.window.addEventListener(CHANNEL, onEvent);
	seen.stop = () => dom.window.removeEventListener(CHANNEL, onEvent);
	return seen;
}

/** Record what the widget posts into the frame, without loading it. */
function recordPosts(assistant) {
	const posted = [];
	Object.defineProperty(assistant.iframe, 'contentWindow', {
		configurable: true,
		value: { postMessage: (msg, target) => posted.push({ msg, target }) },
	});
	return posted;
}

let api;

beforeEach(() => {
	document.body.innerHTML = '';
	document.getElementById('three-assistant-style')?.remove();
	api = createAssistant();
});

after(() => dom.window.close());

test('init mounts a launcher, a panel, and the frame iframe', () => {
	const assistant = api.init({ name: 'Atelier AI', accent: '#0ea5e9', position: 'left' });

	const launcher = document.querySelector('.three-assistant-launcher');
	const panel = document.querySelector('.three-assistant-panel');
	assert.ok(launcher, 'launcher is on the page');
	assert.ok(panel, 'panel is on the page');
	assert.equal(launcher.getAttribute('aria-label'), 'Open Atelier AI');
	assert.equal(launcher.getAttribute('aria-expanded'), 'false');
	assert.equal(launcher.getAttribute('aria-haspopup'), 'dialog');
	assert.equal(panel.getAttribute('role'), 'dialog');
	assert.equal(panel.getAttribute('aria-label'), 'Atelier AI');
	assert.equal(panel.dataset.pos, 'left');
	assert.equal(panel.dataset.chrome, 'clear', 'a transparent widget gets no panel chrome');
	assert.equal(panel.inert, true, 'a closed panel is inert, so nothing inside it is focusable');

	const iframe = panel.querySelector('iframe');
	const url = new URL(iframe.src);
	assert.equal(url.origin, ORIGIN);
	assert.equal(url.pathname, '/assistant-frame');
	assert.equal(url.searchParams.get('name'), 'Atelier AI');
	assert.equal(url.searchParams.get('accent'), '#0ea5e9');
	assert.equal(
		url.searchParams.get('targetOrigin'),
		'https://customer.example',
		'the frame is told which origin may receive its messages',
	);
	assert.equal(iframe.loading, 'lazy');

	assert.equal(api.instance, assistant);
	assistant.destroy();
});

test('a solid background gets panel chrome, transparent does not', () => {
	const solid = api.init({ bg: '#101820' });
	assert.equal(solid.panel.dataset.chrome, 'solid');
	solid.destroy();

	const clear = api.init({ bg: 'TRANSPARENT' });
	assert.equal(clear.panel.dataset.chrome, 'clear');
	clear.destroy();
});

test('clicking the launcher opens and closes, and emits the lifecycle events', () => {
	const assistant = api.init({ name: 'Atelier AI' });
	const events = recordEvents();

	assistant.launcher.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	assert.equal(assistant.isOpen, true);
	assert.equal(assistant.panel.dataset.open, 'true');
	assert.equal(assistant.panel.inert, false);
	assert.equal(assistant.launcher.dataset.open, 'true');
	assert.equal(assistant.launcher.getAttribute('aria-expanded'), 'true');
	assert.equal(assistant.launcher.getAttribute('aria-label'), 'Close Atelier AI');

	assistant.launcher.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	assert.equal(assistant.isOpen, false);
	assert.equal(assistant.panel.dataset.open, 'false');
	assert.equal(assistant.panel.inert, true);
	assert.equal(assistant.launcher.getAttribute('aria-expanded'), 'false');
	assert.equal(assistant.launcher.getAttribute('aria-label'), 'Open Atelier AI');

	assert.deepEqual(
		events.map((e) => e.type),
		['open', 'close'],
	);
	events.stop();
	assistant.destroy();
});

test('Escape closes an open widget and leaves a closed one alone', () => {
	const assistant = api.init({ open: true });
	assert.equal(assistant.isOpen, true);

	const events = recordEvents();
	dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
	assert.equal(assistant.isOpen, false);

	dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
	assert.deepEqual(
		events.map((e) => e.type),
		['close'],
		'a second Escape on a closed widget emits nothing',
	);
	events.stop();
	assistant.destroy();
});

test('say() before the frame is ready is queued, then flushed on ready', () => {
	const assistant = api.init({});
	const posted = recordPosts(assistant);

	api.say('Welcome to the sale!');
	assert.equal(assistant.isOpen, true, 'say opens the widget');
	assert.equal(posted.length, 0, 'nothing is posted into a frame that has not booted');

	fromFrame(assistant, 'ready', {});
	assert.equal(posted.length, 1);
	assert.equal(posted[0].msg.type, 'say');
	assert.equal(posted[0].msg.channel, CHANNEL);
	assert.equal(posted[0].msg.payload.text, 'Welcome to the sale!');
	assert.equal(posted[0].target, ORIGIN, 'posts are pinned to the frame origin');

	api.say('And again.');
	assert.equal(posted.length, 2, 'later lines go straight through');

	api.setMode('speak');
	assert.equal(posted[2].msg.type, 'setMode');
	assert.equal(posted[2].msg.payload.mode, 'speak');

	assistant.destroy();
});

test('say() ignores empty text and truncates a very long line', () => {
	const assistant = api.init({});
	const posted = recordPosts(assistant);
	fromFrame(assistant, 'ready', {});

	assistant.say('');
	assistant.say(null);
	assert.equal(posted.length, 0);

	assistant.say('x'.repeat(900));
	assert.equal(posted[0].msg.payload.text.length, 600);
	assistant.destroy();
});

test('frame messages re-emit on window, and a foreign origin is ignored', () => {
	const assistant = api.init({});
	const events = recordEvents();

	fromFrame(assistant, 'message', { role: 'assistant', content: 'Hi there' });
	assert.deepEqual(events[0], {
		type: 'message',
		payload: { role: 'assistant', content: 'Hi there' },
	});

	fromFrame(assistant, 'message', { role: 'assistant', content: 'spoofed' }, {
		origin: 'https://evil.example',
	});
	fromFrame(assistant, 'message', { role: 'assistant', content: 'wrong frame' }, {
		source: { postMessage() {} },
	});
	assert.equal(events.length, 1, 'only the mounted frame on the pinned origin is trusted');

	events.stop();
	assistant.destroy();
});

test('a close message from the frame closes the widget', () => {
	const assistant = api.init({ open: true });
	fromFrame(assistant, 'close', {});
	assert.equal(assistant.isOpen, false);
	assistant.destroy();
});

test('init replaces the previous instance instead of stacking widgets', () => {
	const first = api.init({ name: 'First' });
	const second = api.init({ name: 'Second' });

	assert.notEqual(first, second);
	assert.equal(api.instance, second);
	assert.equal(document.querySelectorAll('.three-assistant-launcher').length, 1);
	assert.equal(document.querySelectorAll('.three-assistant-panel').length, 1);
	assert.equal(second.panel.getAttribute('aria-label'), 'Second');
	second.destroy();
});

test('destroy removes the DOM and detaches every listener', () => {
	const assistant = api.init({});
	const events = recordEvents();
	assistant.destroy();

	assert.equal(document.querySelector('.three-assistant-launcher'), null);
	assert.equal(document.querySelector('.three-assistant-panel'), null);
	assert.equal(api.instance, null);

	dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
	fromFrame(assistant, 'message', { role: 'assistant', content: 'after destroy' });
	assert.equal(events.length, 0, 'a destroyed widget is inert on the page');
	events.stop();
});

test('styles are injected once, no matter how many widgets mount', () => {
	const first = api.init({});
	first.destroy();
	const second = api.init({});
	assert.equal(document.querySelectorAll('#three-assistant-style').length, 1);
	second.destroy();
});
