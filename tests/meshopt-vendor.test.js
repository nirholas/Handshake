// The EXT_meshopt_compression decoder is a hard dependency of the delivery
// format three.ws now writes by default (api/_lib/glb-compress.js), so it is
// served from our own origin instead of a public CDN. That only holds while the
// vendored copy actually matches the `meshoptimizer` package it came from: a
// dependency bump that leaves public/vendor/ behind would ship an old decoder to
// every visitor, and nothing about the page would look wrong until a model
// failed to load. Pin it here rather than trusting a manual copy step.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareVendoredDecoder, TARGET } from '../scripts/vendor-meshopt-decoder.mjs';

describe('vendored meshopt decoder', () => {
	it('matches the installed meshoptimizer build byte for byte', () => {
		const { inSync, source, target } = compareVendoredDecoder();
		expect(source, 'meshoptimizer is not installed').toBeTruthy();
		expect(target, `${TARGET} is missing; run npm run vendor:meshopt`).toBeTruthy();
		expect(inSync, 'public/vendor/meshopt_decoder.js is stale; run npm run vendor:meshopt').toBe(true);
	});

	it('defines the global that model-viewer reads', () => {
		// model-viewer injects this file as a CLASSIC script and then reads
		// `MeshoptDecoder` off the global. An ESM-only build would load without
		// error and leave the viewer waiting forever, so the global fallback in
		// the UMD tail is the part that actually has to be there.
		const src = readFileSync(TARGET, 'utf8');
		expect(src).toMatch(/self\s*!==\s*'undefined'\s*\?\s*self\s*:\s*this\)\.MeshoptDecoder/);
	});

	it('is the URL every first-party viewer points at', () => {
		const root = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
		for (const file of ['public/model-viewer-meshopt.js', 'public/embed/v1.js', 'public/agenc/embed.js']) {
			const src = root(file);
			expect(src, `${file} still hotlinks a CDN decoder`).not.toMatch(/cdn\.jsdelivr\.net[^\n'"]*meshopt_decoder/);
			expect(src, `${file} does not reference the vendored decoder`).toContain('/vendor/meshopt_decoder.js');
		}
	});
});
