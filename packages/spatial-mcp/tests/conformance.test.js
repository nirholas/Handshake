// The package's own conformance: the fixture corpus is the spec's test suite,
// and this file proves the shipped validator agrees with every entry. It runs in
// the root vitest suite (packages/*/tests/** is globbed), so a validator change
// that breaks a documented verdict fails CI here, not in a downstream adopter.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpatialArtifact, lintSpatialMeta, buildSpatialArtifact, SPATIAL_MCP_VERSION } from '../src/index.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(path.join(PKG, rel), 'utf8'));
const manifest = read('fixtures/manifest.json');

describe('single source of truth', () => {
	it('src/index.js is byte-identical to the published browser module', () => {
		// public/spatial-mcp/spatial-validator.js (served at
		// https://three.ws/spatial-mcp/spatial-validator.js) is the canonical
		// implementation; the package ships a copy so `npm i` works offline. This
		// guard makes drift impossible to ship: change one, re-copy the other.
		const packaged = readFileSync(path.join(PKG, 'src/index.js'), 'utf8');
		const canonical = readFileSync(path.join(PKG, '../../public/spatial-mcp/spatial-validator.js'), 'utf8');
		expect(packaged).toBe(canonical);
	});
});

describe('fixture corpus', () => {
	it('covers both verdicts and the lint', () => {
		const verdicts = new Set(manifest.fixtures.map((f) => f.valid));
		expect(verdicts).toEqual(new Set([true, false]));
		expect(manifest.fixtures.some((f) => f.mustLint?.length)).toBe(true);
		expect(manifest.spatialMcpVersion).toBe(SPATIAL_MCP_VERSION);
	});

	describe.each(manifest.fixtures)('$file', (fixture) => {
		const artifact = read(path.join('fixtures', fixture.file));
		const result = validateSpatialArtifact(artifact);

		it(`validates as ${fixture.valid ? 'conformant' : 'non-conformant'}`, () => {
			expect(result.valid).toBe(fixture.valid);
		});

		if (fixture.mustFlag?.length) {
			it(`flags ${fixture.mustFlag.join(', ')}`, () => {
				const flagged = result.errors.map((e) => e.path);
				for (const required of fixture.mustFlag) expect(flagged).toContain(required);
			});
		}

		if (fixture.mustLint?.length) {
			it(`lint reports ${fixture.mustLint.join(', ')}`, () => {
				const linted = lintSpatialMeta(artifact).map((f) => f.path);
				for (const required of fixture.mustLint) expect(linted).toContain(required);
			});
		}
	});
});

describe('lintSpatialMeta', () => {
	it('is silent on a clean artifact', () => {
		const clean = read('fixtures/valid/model-full.json');
		expect(lintSpatialMeta(clean)).toEqual([]);
	});

	it('never affects validity', () => {
		const leaky = read('fixtures/lint/privacy-leak.json');
		expect(validateSpatialArtifact(leaky).valid).toBe(true);
		expect(lintSpatialMeta(leaky).length).toBeGreaterThan(0);
	});

	it('ignores https URLs in meta (viewerUrl is the block\'s job)', () => {
		const artifact = buildSpatialArtifact({
			glbUrl: 'https://assets.example/m.glb',
			viewerUrl: 'https://three.ws/viewer?src=https%3A%2F%2Fassets.example%2Fm.glb',
			title: 'ok',
		});
		expect(lintSpatialMeta(artifact)).toEqual([]);
	});

	it('flags credential-shaped values, not just key names', () => {
		const artifact = {
			spatialMcpVersion: '0.1',
			kind: 'model',
			scene: { glbUrl: 'https://assets.example/m.glb', format: 'glb' },
			camera: { autoRotate: true },
			meta: { note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' },
		};
		const paths = lintSpatialMeta(artifact).map((f) => f.path);
		expect(paths).toContain('meta.note');
	});
});

describe('buildSpatialArtifact', () => {
	it('always emits a corpus-grade artifact', () => {
		const artifact = buildSpatialArtifact({ glbUrl: 'https://assets.example/anything.glb' });
		const result = validateSpatialArtifact(artifact);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(lintSpatialMeta(artifact)).toEqual([]);
	});
});
