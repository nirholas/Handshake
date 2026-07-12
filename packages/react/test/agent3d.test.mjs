// <Agent3D> behavior tests, asserted on server-rendered markup: prop → embed
// URL wiring, defaults, wrapper/iframe attributes, style handling, and edge
// cases (missing agent id, special characters, invalid baseUrl).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agent3D } from '../dist/index.esm.js';
import { render, iframeSrc, attrOf, styleOf } from './helpers.mjs';

// --- Embed URL construction -------------------------------------------------

test('defaults: points at https://three.ws/walk-embed with avatar + joystick only', () => {
	const src = iframeSrc(render(Agent3D, { agentId: 'ag-1' }));
	assert.equal(src.origin, 'https://three.ws');
	assert.equal(src.pathname, '/walk-embed');
	assert.equal(src.searchParams.get('avatar'), 'ag-1');
	assert.equal(src.searchParams.get('controls'), 'joystick');
	assert.equal([...src.searchParams.keys()].length, 2, 'no extra params emitted by default');
});

test('avatarId overrides agentId as the avatar param', () => {
	const src = iframeSrc(render(Agent3D, { agentId: 'ag-1', avatarId: 'av-9' }));
	assert.equal(src.searchParams.get('avatar'), 'av-9');
});

test('controls prop is forwarded, including "none"', () => {
	for (const controls of ['keyboard', 'none']) {
		const src = iframeSrc(render(Agent3D, { agentId: 'ag-1', controls }));
		assert.equal(src.searchParams.get('controls'), controls);
	}
});

test('background maps to the bg param with URL encoding for hex colors', () => {
	const src = iframeSrc(render(Agent3D, { agentId: 'ag-1', background: '#1b1b1b' }));
	assert.equal(src.searchParams.get('bg'), '#1b1b1b');
	assert.ok(src.search.includes('bg=%231b1b1b'), 'hash must be percent-encoded in the query');
});

test('environment maps to the env param', () => {
	const src = iframeSrc(render(Agent3D, { agentId: 'ag-1', environment: 'studio' }));
	assert.equal(src.searchParams.get('env'), 'studio');
});

test('autoplay emits autoplay=true only when truthy', () => {
	const on = iframeSrc(render(Agent3D, { agentId: 'ag-1', autoplay: true }));
	assert.equal(on.searchParams.get('autoplay'), 'true');
	const off = iframeSrc(render(Agent3D, { agentId: 'ag-1', autoplay: false }));
	assert.equal(off.searchParams.get('autoplay'), null);
});

test('ground/orbit are only emitted to turn the player defaults OFF', () => {
	const src = iframeSrc(render(Agent3D, { agentId: 'ag-1', ground: false, orbit: false }));
	assert.equal(src.searchParams.get('ground'), 'false');
	assert.equal(src.searchParams.get('orbit'), 'false');

	// true matches the player default → param stays absent, same as undefined.
	const on = iframeSrc(render(Agent3D, { agentId: 'ag-1', ground: true, orbit: true }));
	assert.equal(on.searchParams.get('ground'), null);
	assert.equal(on.searchParams.get('orbit'), null);
});

test('speed never leaks into the URL (it is applied live via postMessage)', () => {
	const src = iframeSrc(render(Agent3D, { agentId: 'ag-1', speed: 1.5 }));
	assert.equal(src.searchParams.get('speed'), null);
});

test('baseUrl override changes the embed origin', () => {
	const src = iframeSrc(render(Agent3D, { agentId: 'ag-1', baseUrl: 'https://staging.example.com' }));
	assert.equal(src.origin, 'https://staging.example.com');
	assert.equal(src.pathname, '/walk-embed');
});

test('baseUrl with a trailing slash or path still resolves /walk-embed at the root', () => {
	for (const baseUrl of ['https://example.com/', 'https://example.com/nested/app']) {
		const src = iframeSrc(render(Agent3D, { agentId: 'ag-1', baseUrl }));
		assert.equal(src.href.replace(/\?.*$/, ''), 'https://example.com/walk-embed');
	}
});

test('agent ids with reserved characters are URL-encoded, not string-concatenated', () => {
	const src = iframeSrc(render(Agent3D, { agentId: 'ag 1/&?=#' }));
	assert.equal(src.searchParams.get('avatar'), 'ag 1/&?=#');
});

// --- Edge cases ---------------------------------------------------------------

test('missing agentId still renders a player with no avatar param', () => {
	const html = render(Agent3D, {});
	const src = iframeSrc(html);
	assert.equal(src.searchParams.get('avatar'), null);
	assert.equal(src.searchParams.get('controls'), 'joystick');
	assert.ok(html.includes('<iframe'), 'iframe must still render');
});

test('an unparseable baseUrl throws during render instead of producing a broken src', () => {
	assert.throws(() => render(Agent3D, { agentId: 'ag-1', baseUrl: 'not a url' }), TypeError);
});

// --- Wrapper <div> ------------------------------------------------------------

test('wrapper defaults to position:relative, 100% x 600px', () => {
	const style = styleOf(render(Agent3D, { agentId: 'ag-1' }), 'div');
	assert.equal(style.position, 'relative');
	assert.equal(style.width, '100%');
	assert.equal(style.height, '600px');
});

test('numeric width/height are coerced to px; strings pass through', () => {
	const px = styleOf(render(Agent3D, { agentId: 'ag-1', width: 480, height: 720 }), 'div');
	assert.equal(px.width, '480px');
	assert.equal(px.height, '720px');

	const rel = styleOf(render(Agent3D, { agentId: 'ag-1', width: '32rem', height: '50vh' }), 'div');
	assert.equal(rel.width, '32rem');
	assert.equal(rel.height, '50vh');
});

test('user style merges over the computed wrapper style', () => {
	const style = styleOf(
		render(Agent3D, { agentId: 'ag-1', width: 480, style: { width: '10px', borderRadius: '8px' } }),
		'div',
	);
	assert.equal(style.width, '10px', 'explicit style wins over the width prop');
	assert.equal(style['border-radius'], '8px');
	assert.equal(style.position, 'relative', 'computed defaults survive the merge');
});

test('className and extra DOM props land on the wrapper div', () => {
	const html = render(Agent3D, {
		agentId: 'ag-1',
		className: 'hero-agent',
		id: 'stage',
		'data-testid': 'agent-embed',
	});
	assert.equal(attrOf(html, 'div', 'class'), 'hero-agent');
	assert.equal(attrOf(html, 'div', 'id'), 'stage');
	assert.equal(attrOf(html, 'div', 'data-testid'), 'agent-embed');
});

test('onLoad/onError/ref-only props never serialize into the markup', () => {
	const html = render(Agent3D, {
		agentId: 'ag-1',
		onLoad: () => {},
		onError: () => {},
		speed: 2,
	});
	assert.ok(!/onLoad|onError|speed/.test(html), `handler props leaked into markup: ${html}`);
});

// --- <iframe> -----------------------------------------------------------------

test('iframe carries the accessibility title, default and overridden', () => {
	assert.equal(attrOf(render(Agent3D, { agentId: 'ag-1' }), 'iframe', 'title'), 'three.ws 3D agent');
	assert.equal(
		attrOf(render(Agent3D, { agentId: 'ag-1', title: 'Concierge avatar' }), 'iframe', 'title'),
		'Concierge avatar',
	);
});

test('iframe is lazy-loaded and grants the XR/media permissions the player needs', () => {
	const html = render(Agent3D, { agentId: 'ag-1' });
	assert.equal(attrOf(html, 'iframe', 'loading'), 'lazy');
	const allow = attrOf(html, 'iframe', 'allow');
	for (const feature of ['xr-spatial-tracking', 'microphone', 'camera', 'autoplay']) {
		assert.ok(allow.includes(feature), `allow is missing "${feature}"`);
	}
});

test('iframe fills the wrapper with no border', () => {
	const style = styleOf(render(Agent3D, { agentId: 'ag-1' }), 'iframe');
	assert.equal(style.display, 'block');
	assert.equal(style.width, '100%');
	assert.equal(style.height, '100%');
	assert.equal(style.border, '0');
});
