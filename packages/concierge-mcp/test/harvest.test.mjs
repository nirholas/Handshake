// Pure-logic tests for the HTML → site snapshot harvester. Offline, no network.
//
// Run: node --test packages/concierge-mcp/test/harvest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { harvestHtml, MAX_CONTENT_CHARS } from '../src/lib/harvest.js';

const PAGE = `<!doctype html><html><head>
	<title>Acme &mdash; Rocket Skates</title>
	<meta name="description" content="Acme sells rocket skates to discerning coyotes.">
	<meta property="og:site_name" content="Acme">
</head><body>
	<header><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/pricing">Pricing</a></nav></header>
	<main>
		<h1>Rocket Skates</h1>
		<h2>Fast. Very fast.</h2>
		<p>Our skates reach 300&nbsp;mph in under two seconds &amp; never quit.</p>
		<script>window.secret = 'never-harvest-this';</script>
		<style>.x{color:red}</style>
	</main>
</body></html>`;

test('harvests title, description, deduped nav, og:site_name', () => {
	const s = harvestHtml(PAGE, { url: 'https://acme.example/pricing' });
	assert.match(s.title, /Acme.*Rocket Skates/);
	assert.match(s.description, /rocket skates/i);
	assert.deepEqual(s.nav, ['Home', 'Pricing']);
	assert.equal(s.name, 'Acme');
});

test('harvests h1-h3 headings, deduped', () => {
	const s = harvestHtml(PAGE);
	assert.deepEqual(s.headings, ['Rocket Skates', 'Fast. Very fast.']);
});

test('content excludes scripts + styles, decodes entities', () => {
	const s = harvestHtml(PAGE);
	assert.match(s.content, /300 mph/);
	assert.match(s.content, /&/); // &amp; decoded to literal &
	assert.ok(!s.content.includes('never-harvest-this'));
	assert.ok(!s.content.includes('color:red'));
});

test('falls back to hostname for the site name when no og:site_name', () => {
	const html = '<html><head><title>Docs</title></head><body><main>hi</main></body></html>';
	const s = harvestHtml(html, { url: 'https://www.example.com/docs' });
	assert.equal(s.name, 'example.com');
});

test('curated knowledge is carried through and capped', () => {
	const s = harvestHtml(PAGE, { knowledge: 'Pro skates cost $199.' });
	assert.match(s.knowledge, /\$199/);
});

test('content is capped at the budget', () => {
	const big = `<html><body><main><p>${'x'.repeat(MAX_CONTENT_CHARS * 3)}</p></main></body></html>`;
	const s = harvestHtml(big);
	assert.ok(s.content.length <= MAX_CONTENT_CHARS);
});

test('empty/garbage input degrades to an empty snapshot, never throws', () => {
	const s = harvestHtml('', {});
	assert.equal(s.title, '');
	assert.deepEqual(s.headings, []);
	assert.deepEqual(s.nav, []);
});
