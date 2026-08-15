// @vitest-environment jsdom
//
// @three-ws/avatar entry points: every subpath the package publishes must
// actually load, and the elements it registers must expose the API the type
// declarations promise.
//
// The gap this closes: `avatar-sdk-api.test.js` covers the creator and the
// agent guard, and `avatar-sdk-viewer-state.test.js` covers the viewer's pure
// state math, but nothing loaded `./viewer` or `./react` at all. Both are
// documented headline entries, and both used to break in ways a consumer only
// discovered in their own build (a `.jsx` extension Node cannot import; a
// `<three-ws-viewer>` that ignored `el.src = url` because the property did not
// exist).
//
// The WebGL half stays out of scope on purpose: jsdom has no GL context, so
// these tests construct elements without connecting them. Rendering is covered
// against a real browser instead.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import '../avatar-sdk/src/viewer.js';
import { Avatar, AgentAvatar, AvatarCreator, useAvatar } from '../avatar-sdk/src/react.js';
// The published `./runtime/*` subpaths serve build-time copies of these two
// repo modules (avatar-sdk/build.mjs copies them into dist/, which is
// gitignored), so the source files are what a test can always reach.
import * as choreography from '../src/runtime/choreography.js';
import * as slots from '../src/runtime/animation-slots.js';

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'avatar-sdk');
const pkg = JSON.parse(readFileSync(resolve(SDK, 'package.json'), 'utf8'));

describe('exports map', () => {
	it('resolves every subpath to a file Node can load', () => {
		// A subpath that resolves to an extension Node has no loader for (.jsx is
		// the one that bit us) is unusable outside a bundler that transpiles
		// node_modules, which Next.js does not do by default.
		const loadable = new Set(['.js', '.mjs', '.cjs', '.css', '.json']);
		for (const [subpath, value] of Object.entries(pkg.exports)) {
			const target = typeof value === 'string' ? value : value.import || value.default;
			const ext = target.slice(target.lastIndexOf('.'));
			expect(loadable.has(ext), `${subpath} -> ${target} has no Node loader`).toBe(true);
		}
	});

	it('exposes ./package.json so tooling can read the manifest', () => {
		expect(pkg.exports['./package.json']).toBe('./package.json');
	});
});

describe('<three-ws-viewer>', () => {
	it('registers itself on import', () => {
		expect(customElements.get('three-ws-viewer')).toBeTruthy();
	});

	it('observes every attribute the README documents', () => {
		const observed = customElements.get('three-ws-viewer').observedAttributes;
		for (const attr of ['src', 'alt', 'background', 'ar', 'auto-rotate']) {
			expect(observed, `missing observedAttribute ${attr}`).toContain(attr);
		}
	});

	it('reflects the documented properties to their attributes', () => {
		const el = document.createElement('three-ws-viewer');

		el.src = 'https://three.ws/avatars/default.glb';
		el.alt = 'The three.ws default avatar';
		el.background = 'transparent';
		el.ar = true;
		el.autoRotate = true;

		expect(el.getAttribute('src')).toBe('https://three.ws/avatars/default.glb');
		expect(el.getAttribute('alt')).toBe('The three.ws default avatar');
		expect(el.getAttribute('background')).toBe('transparent');
		expect(el.hasAttribute('ar')).toBe(true);
		expect(el.hasAttribute('auto-rotate')).toBe(true);

		// And back out through the getters.
		expect(el.src).toBe('https://three.ws/avatars/default.glb');
		expect(el.ar).toBe(true);
		expect(el.autoRotate).toBe(true);
	});

	it('clears an attribute when its property is unset', () => {
		const el = document.createElement('three-ws-viewer');
		el.src = 'https://three.ws/avatars/default.glb';
		el.ar = true;

		el.src = null;
		el.ar = false;

		expect(el.hasAttribute('src')).toBe(false);
		expect(el.hasAttribute('ar')).toBe(false);
		expect(el.src).toBeNull();
	});

	it('recovers a property assigned before the element upgraded', () => {
		// A framework that sets el.src on a not-yet-defined element leaves an own
		// property shadowing the accessor. The upgrade dance hands it back.
		const el = document.createElement('three-ws-viewer');
		Object.defineProperty(el, 'src', {
			value: 'https://three.ws/avatars/michelle.glb',
			writable: true,
			configurable: true,
			enumerable: true,
		});

		el._upgradeProperty('src');

		expect(Object.prototype.hasOwnProperty.call(el, 'src')).toBe(false);
		expect(el.getAttribute('src')).toBe('https://three.ws/avatars/michelle.glb');
	});
});

describe('./react', () => {
	it('exports the four documented bindings', () => {
		expect(typeof AvatarCreator).toBe('function');
		expect(typeof useAvatar).toBe('function');
		// forwardRef components are objects, not functions.
		expect(Avatar).toBeTruthy();
		expect(AgentAvatar).toBeTruthy();
	});

	it('<Avatar> renders the viewer element with its props applied', () => {
		const html = renderToStaticMarkup(
			createElement(Avatar, {
				src: 'https://three.ws/avatars/default.glb',
				alt: 'The three.ws default avatar',
				className: 'hero-avatar',
			}),
		);
		expect(html).toContain('<three-ws-viewer');
		expect(html).toContain('class="hero-avatar"');
	});

	it('<AgentAvatar> renders a labelled placeholder until the monolith loads', () => {
		// Server-side (and pre-load on the client) the heavy element is not
		// registered yet, so the component must render something meaningful
		// rather than an empty custom element that never upgrades.
		const html = renderToStaticMarkup(createElement(AgentAvatar, { avatarId: 'demo' }));
		expect(html).toContain('data-three-ws-agent-loading');
		expect(html).toMatch(/Loading three\.ws avatar/);
	});

	it('<AvatarCreator> renders nothing; the modal mounts to document.body', () => {
		expect(renderToStaticMarkup(createElement(AvatarCreator, { open: false }))).toBe('');
	});
});

describe('./runtime subpaths', () => {
	it('publishes the two runtime modules the build copies into dist', () => {
		expect(pkg.exports['./runtime/choreography.js']).toBe('./dist/runtime/choreography.js');
		expect(pkg.exports['./runtime/animation-slots.js']).toBe('./dist/runtime/animation-slots.js');
	});

	it('ships a dependency-free choreography sequencer', () => {
		expect(typeof choreography.RoutinePlayer).toBe('function');
		expect(Array.isArray(choreography.PRESET_ROUTINES)).toBe(true);
		expect(choreography.PRESET_ROUTINES.length).toBeGreaterThan(0);

		const routine = choreography.normalizeRoutine(choreography.PRESET_ROUTINES[0]);
		const roundTripped = choreography.decodeRoutine(choreography.encodeRoutine(routine));
		expect(roundTripped.steps.map((s) => s.clip)).toEqual(routine.steps.map((s) => s.clip));
		expect(choreography.routineDuration(routine)).toBeGreaterThan(0);
	});

	it('ships the canonical animation slot vocabulary', () => {
		expect(Array.isArray(slots.SLOTS)).toBe(true);
		expect(slots.SLOTS).toContain('idle');
		expect(typeof slots.resolveSlot).toBe('function');
		expect(typeof slots.resolveHint).toBe('function');
	});
});
