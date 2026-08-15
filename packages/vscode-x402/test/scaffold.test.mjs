// The scaffolded endpoint must be a file that actually deploys: it is the first
// thing a developer runs from this extension, so a template that does not parse
// or that quietly ships a Base-only challenge is a broken feature.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { renderEndpoint } from '../src/scaffold-template.js';

const source = renderEndpoint({ slug: 'summarize', priceUsd: '0.01', description: 'Summarize a document.' });

test('the generated source is valid JavaScript', async () => {
	// Compiling as a module catches a syntax error in the template (an unbalanced
	// brace, a bad interpolation) without executing the handler.
	const { SourceTextModule } = await import('node:vm').then((vm) => vm);
	assert.equal(typeof source, 'string');
	if (typeof SourceTextModule === 'function') {
		assert.doesNotThrow(() => new SourceTextModule(source, { identifier: 'scaffold.js' }));
		return;
	}
	// Without --experimental-vm-modules, parse it as a function body with the
	// import statements stripped, which still catches every syntax error below.
	const body = source.replace(/^import .*$/gm, '').replace(/^export default .*$/gm, '').replace(/^export const .*$/gm, '');
	assert.doesNotThrow(() => new Function(body));
});

test('the price is converted to USDC atomics', () => {
	assert.match(source, /priceAtomics: 10000,/);
	assert.match(renderEndpoint({ slug: 'a', priceUsd: 1, description: 'd' }), /priceAtomics: 1000000,/);
	assert.match(renderEndpoint({ slug: 'a', priceUsd: '0.000001', description: 'd' }), /priceAtomics: 1,/);
});

test('the challenge is Solana-first', () => {
	assert.match(source, /networks: \['solana', 'base'\]/);
});

test('the slug drives the route, the resource URL, and the service name', () => {
	assert.match(source, /route: '\/api\/x402\/summarize'/);
	assert.match(source, /const RESOURCE_URL = 'https:\/\/three\.ws\/api\/x402\/summarize'/);
	assert.match(source, /serviceName: "summarize"/);
});

test('the description is JSON-escaped, so quotes cannot break the file', () => {
	const tricky = renderEndpoint({ slug: 'x', priceUsd: '0.01', description: 'He said "no", then \\ left.' });
	assert.ok(tricky.includes(JSON.stringify('He said "no", then \\ left.')));
	assert.doesNotThrow(() => new Function(tricky.replace(/^import .*$/gm, '').replace(/^export .*$/gm, '')));
});

test('the imports it emits resolve against the real repo', async () => {
	const imports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
	assert.deepEqual(imports, [
		'../_lib/x402-paid-endpoint.js',
		'../_lib/x402-spec.js',
		'../_lib/x402/bazaar-helpers.js',
	]);
	// The scaffold writes into <workspace>/api/x402/, so '../_lib/x' is api/_lib/x.
	for (const spec of imports) {
		const path = fileURLToPath(new URL(`../../../api/${spec.replace('../', '')}`, import.meta.url));
		await readFile(path); // throws if the module the template imports is gone
	}
});

test('every option it passes is one paidEndpoint() actually destructures', async () => {
	const impl = await readFile(fileURLToPath(new URL('../../../api/_lib/x402-paid-endpoint.js', import.meta.url)), 'utf8');
	const spec = impl.slice(impl.indexOf('export function paidEndpoint(spec) {'));
	const options = [...source.matchAll(/^\t(\w+):/gm)].map((m) => m[1]);
	assert.ok(options.length >= 8, `expected the template to pass several options, saw ${options.length}`);
	for (const option of options) {
		assert.match(spec, new RegExp(`^\\t\\t${option}[,\\s=]`, 'm'), `paidEndpoint() does not accept "${option}"`);
	}
});
