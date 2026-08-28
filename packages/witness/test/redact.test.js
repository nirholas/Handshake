// Privacy is enforced at capture time, so these are the tests that decide
// whether a live credential can end up in a bug report. Each one is a shape
// that has leaked out of a real logging pipeline at some company before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { redactText, redactUrl, isSensitiveField, summarizeInput } from '../src/redact.js';

function el(html) {
	return new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body.firstElementChild;
}

test('secrets are replaced wherever they appear in free text', () => {
	const cases = [
		['reach me at ada@example.com', '[email]'],
		['my key sk-abcdef0123456789abcdef', '[api-key]'],
		['token ghp_abcdefghijklmnopqrstuvwxyz0123', '[token]'],
		['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', '[jwt]'],
		['card 4111 1111 1111 1111', '[card]'],
		['wallet 0x71C7656EC7ab88b098defB751B7401B5f6d8976F', '[address]'],
	];
	for (const [input, expected] of cases) {
		assert.match(redactText(input), new RegExp(expected.replace(/[[\]]/g, '\\$&')), input);
	}
});

test('a base58 run long enough to be a key never survives', () => {
	const mint = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
	assert.equal(redactText(`the coin ${mint} broke`).includes(mint), false);
});

test('ordinary prose is left alone', () => {
	const plain = 'The download button does nothing on my phone.';
	assert.equal(redactText(plain), plain);
});

test('a url keeps its path and parameter names but never a credential value', () => {
	const out = redactUrl('https://three.ws/dashboard?token=supersecretvalue&tab=models', { origin: 'https://three.ws' });
	assert.equal(out, '/dashboard?token=[redacted]&tab=models');
	assert.ok(!out.includes('supersecretvalue'));
});

test('userinfo and the hash are dropped entirely', () => {
	const out = redactUrl('https://user:pw@three.ws/x#access_token=abc123', { origin: 'https://three.ws' });
	assert.ok(!out.includes('pw'));
	assert.ok(!out.includes('abc123'));
});

test('a cross-origin request keeps its origin so a third party is identifiable', () => {
	const out = redactUrl('https://api.stripe.com/v1/charges', { origin: 'https://three.ws' });
	assert.equal(out, 'https://api.stripe.com/v1/charges');
});

test('password and hidden inputs are always sensitive', () => {
	assert.equal(isSensitiveField(el('<input type="password">')), true);
	assert.equal(isSensitiveField(el('<input type="hidden" name="csrf">')), true);
});

test('a field is sensitive when any of its hints say so', () => {
	assert.equal(isSensitiveField(el('<input name="cardNumber">')), true);
	assert.equal(isSensitiveField(el('<input autocomplete="one-time-code">')), true);
	assert.equal(isSensitiveField(el('<input aria-label="Seed phrase">')), true);
	assert.equal(isSensitiveField(el('<input placeholder="you@example.com">')), true);
	assert.equal(isSensitiveField(el('<input name="modelName">')), false);
});

test('an opted-out subtree is never observed', () => {
	const form = el('<form data-witness="off"><input name="notes"></form>');
	assert.equal(isSensitiveField(form.querySelector('input')), true);
});

test('typed content is counted and shaped, never kept', () => {
	const input = el('<input name="modelName">');
	const summary = summarizeInput(input, 'Knight rider');
	assert.deepEqual(summary, { length: 12, shape: 'text' });
	assert.equal(JSON.stringify(summary).includes('Knight'), false);
});

test('a sensitive field yields no length at all, not even a hint', () => {
	assert.deepEqual(summarizeInput(el('<input type="password">'), 'hunter2'), { length: null, shape: 'private' });
});

test('shapes distinguish the cases a maintainer actually needs', () => {
	const field = el('<input name="q">');
	assert.equal(summarizeInput(field, '12345').shape, 'digits');
	assert.equal(summarizeInput(field, 'a@b.co').shape, 'email');
	assert.equal(summarizeInput(field, 'https://x.dev').shape, 'url');
	assert.equal(summarizeInput(field, 'x'.repeat(200)).shape, 'paragraph');
	assert.equal(summarizeInput(field, '').shape, 'empty');
});
