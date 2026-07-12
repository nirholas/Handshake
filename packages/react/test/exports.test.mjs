// Export-surface tests: both shipped bundle formats (ESM + CJS) expose the
// same components, the WalkEmbed alias is identity-equal to Agent3D, and the
// type declarations are copied into dist/ by the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as esm from '../dist/index.esm.js';
import { render, iframeSrc } from './helpers.mjs';

const require = createRequire(import.meta.url);
const cjs = require('../dist/index.cjs.js');

const FORWARD_REF = Symbol.for('react.forward_ref');

test('ESM bundle exports exactly Agent3D and WalkEmbed', () => {
	assert.deepEqual(Object.keys(esm).sort(), ['Agent3D', 'WalkEmbed']);
});

test('CJS bundle exports the same surface as the ESM bundle', () => {
	const names = Object.keys(cjs).filter((k) => k !== '__esModule').sort();
	assert.deepEqual(names, ['Agent3D', 'WalkEmbed']);
});

test('WalkEmbed is an identity alias of Agent3D in both formats', () => {
	assert.equal(esm.WalkEmbed, esm.Agent3D);
	assert.equal(cjs.WalkEmbed, cjs.Agent3D);
});

test('Agent3D is a forwardRef component in both formats', () => {
	assert.equal(esm.Agent3D.$$typeof, FORWARD_REF);
	assert.equal(cjs.Agent3D.$$typeof, FORWARD_REF);
	assert.equal(typeof esm.Agent3D.render, 'function');
});

test('CJS bundle renders identically to the ESM bundle', () => {
	const props = { agentId: 'ag-1', controls: 'keyboard', autoplay: true };
	assert.equal(render(cjs.Agent3D, props), render(esm.Agent3D, props));
});

test('WalkEmbed renders the same markup as Agent3D', () => {
	const props = { agentId: 'ag-1', environment: 'studio' };
	assert.equal(render(esm.WalkEmbed, props), render(esm.Agent3D, props));
	assert.equal(iframeSrc(render(esm.WalkEmbed, props)).searchParams.get('env'), 'studio');
});

test('build copies the hand-written type declarations into dist/', () => {
	const dts = readFileSync(fileURLToPath(new URL('../dist/index.d.ts', import.meta.url)), 'utf8');
	for (const decl of [
		'export interface Agent3DProps',
		'export interface Agent3DHandle',
		'export type Agent3DControls',
		'export declare const Agent3D',
		'export declare const WalkEmbed',
	]) {
		assert.ok(dts.includes(decl), `dist/index.d.ts is missing "${decl}"`);
	}
});
