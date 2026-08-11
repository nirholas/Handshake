import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configure, getConfig, version, pay, discover, init } from '../src/x402-modal.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('public API surface is intact', () => {
	assert.equal(typeof pay, 'function');
	assert.equal(typeof discover, 'function');
	assert.equal(typeof init, 'function');
	assert.equal(typeof configure, 'function');
	assert.match(version, /^\d+\.\d+\.\d+$/);
});

// The exported string is what merchants read in bug reports and what the
// builder-code echo carries. It was hardcoded and drifted two patch releases
// behind package.json; pin the two so a release bump cannot leave it behind.
test('the exported version matches package.json', () => {
	assert.equal(version, pkg.version);
});

test('init() is a no-op without a document (does not throw in Node)', () => {
	assert.doesNotThrow(() => init());
});

test('pay() rejects without an endpoint', async () => {
	await assert.rejects(() => pay({}), /endpoint is required/);
});

test('configure merges brand and builderCode without dropping siblings', () => {
	const base = getConfig();
	assert.equal(base.brand.label, 'Powered by three.ws');
	assert.equal(base.builderCode.wallet, '3d_agent');

	configure({ brand: { label: 'Powered by Acme' } });
	const afterBrand = getConfig();
	assert.equal(afterBrand.brand.label, 'Powered by Acme');
	// href left intact since only label was overridden
	assert.equal(afterBrand.brand.href, 'https://three.ws');

	configure({ apiOrigin: 'https://pay.example.com' });
	assert.equal(getConfig().apiOrigin, 'https://pay.example.com');

	configure({ builderCode: { service: 'acme_checkout' } });
	const afterBuilder = getConfig();
	assert.equal(afterBuilder.builderCode.service, 'acme_checkout');
	assert.equal(afterBuilder.builderCode.wallet, '3d_agent');

	// null disables the echo entirely
	configure({ builderCode: null });
	assert.equal(getConfig().builderCode, null);

	// restore defaults for any later test run in the same process
	configure({
		apiOrigin: null,
		brand: { label: 'Powered by three.ws', href: 'https://three.ws' },
		builderCode: { wallet: '3d_agent', service: '3d_agent_modal' },
	});
});

test("configure honours an explicit empty-string apiOrigin (same-origin)", () => {
	configure({ apiOrigin: '' });
	assert.equal(getConfig().apiOrigin, '');
	configure({ apiOrigin: null });
});
