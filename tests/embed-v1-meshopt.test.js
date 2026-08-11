// public/embed/v1.js registers the Meshopt decoder with model-viewer.
//
// model-viewer auto-loads the Draco and KTX2 decoders but leaves Meshopt unset,
// and every server-baked avatar (the /api/avatars/<id>/glb lane and Forge
// output) ships EXT_meshopt_compression. Without the decoder the viewer throws
// "setMeshoptDecoder must be called before loading compressed files" and the
// agent never renders. Pages inside three.ws get this from
// /model-viewer-meshopt.js; an embed running on someone else's site has to
// carry it, which /embed/v1/preview proved it did not.
//
// Timing is the whole trick: model-viewer captures its decoder config when a
// load STARTS, so the property must be set before the element upgrades. These
// run the real script against a minimal custom-elements stub and assert the
// decoder survives every ordering.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(ROOT, 'public/embed/v1.js'), 'utf8');

const MESHOPT = 'https://cdn.jsdelivr.net/npm/meshoptimizer@0.22.0/meshopt_decoder.js';

// Minimal registry: enough for the embed's install path, no DOM engine needed.
function makeRegistry(predefined) {
	const defined = new Map(predefined ? [['model-viewer', predefined]] : []);
	const waiters = [];
	return {
		get: (name) => defined.get(name),
		define(name, ctor) {
			defined.set(name, ctor);
			for (const w of waiters) if (w.name === name) w.resolve(ctor);
		},
		whenDefined(name) {
			const hit = defined.get(name);
			if (hit) return Promise.resolve(hit);
			return new Promise((res) => waiters.push({ name, resolve: res }));
		},
	};
}

// Run just the decoder-install unit out of the real file, so the assertions
// track the shipped source rather than a copy of it.
function loadInstaller(registry) {
	const start = source.indexOf('\tfunction applyMeshopt(ctor) {');
	const end = source.indexOf('\t// model-viewer is loaded once, lazily');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	const unit = source.slice(start, end);
	const factory = new Function(
		'window',
		'customElements',
		'MESHOPT_CDN',
		`${unit}\nreturn installMeshopt;`,
	);
	return factory({ customElements: registry }, registry, MESHOPT);
}

describe('embed v1 meshopt wiring', () => {
	let registry;
	beforeEach(() => {
		registry = makeRegistry();
	});

	it('sets the decoder immediately when model-viewer is already defined', () => {
		const ctor = {};
		registry = makeRegistry(ctor);
		loadInstaller(registry)();
		expect(ctor.meshoptDecoderLocation).toBe(MESHOPT);
	});

	it('sets the decoder the moment model-viewer is defined afterwards', () => {
		loadInstaller(registry)();
		const ctor = {};
		registry.define('model-viewer', ctor);
		expect(ctor.meshoptDecoderLocation).toBe(MESHOPT);
	});

	it('leaves other custom elements untouched', () => {
		loadInstaller(registry)();
		const other = {};
		registry.define('some-widget', other);
		expect(other.meshoptDecoderLocation).toBeUndefined();
	});

	it('never overwrites a decoder the host page already chose', () => {
		const ctor = { meshoptDecoderLocation: 'https://host.example/meshopt.js' };
		registry = makeRegistry(ctor);
		loadInstaller(registry)();
		expect(ctor.meshoptDecoderLocation).toBe('https://host.example/meshopt.js');
	});

	it('survives a build where the static is read-only', () => {
		const ctor = {};
		Object.defineProperty(ctor, 'meshoptDecoderLocation', { get: () => undefined, set() { throw new Error('read only'); } });
		registry = makeRegistry(ctor);
		expect(() => loadInstaller(registry)()).not.toThrow();
	});
});

describe('embed v1 install ordering', () => {
	it('installs the decoder before the model-viewer CDN script is appended', () => {
		const install = source.indexOf('installMeshopt();');
		const append = source.indexOf("s.src = MV_CDN;");
		expect(install).toBeGreaterThan(-1);
		expect(append).toBeGreaterThan(-1);
		expect(install).toBeLessThan(append);
	});
});
