import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harvestSiteContext, buildSitePayload, MAX_CONTENT_CHARS } from '../src/context.js';

const PAGE = `<!doctype html><html><head>
	<title>Acme — Rocket Skates</title>
	<meta name="description" content="Acme sells rocket skates to discerning coyotes.">
	<meta property="og:site_name" content="Acme">
</head><body>
	<header><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/pricing">Pricing</a></nav></header>
	<main>
		<h1>Rocket Skates</h1>
		<h2>Fast. Very fast.</h2>
		<p>Our skates reach 300 mph in under two seconds.</p>
		<script>window.secret = 'never-harvest-this';</script>
		<div aria-hidden="true">decorative noise</div>
		<div data-three-concierge><p>widget text must not feed back</p></div>
	</main>
</body></html>`;

function doc() {
	return new JSDOM(PAGE).window.document;
}

test('harvests title, description, headings, deduped nav, site name', () => {
	const ctx = harvestSiteContext(doc());
	assert.equal(ctx.title, 'Acme — Rocket Skates');
	assert.match(ctx.description, /rocket skates/i);
	assert.deepEqual(ctx.headings, ['Rocket Skates', 'Fast. Very fast.']);
	assert.deepEqual(ctx.nav, ['Home', 'Pricing']);
	assert.equal(ctx.name, 'Acme');
});

test('content excludes scripts, hidden nodes, and the widget itself', () => {
	const ctx = harvestSiteContext(doc());
	assert.match(ctx.content, /300 mph/);
	assert.ok(!ctx.content.includes('never-harvest-this'));
	assert.ok(!ctx.content.includes('decorative noise'));
	assert.ok(!ctx.content.includes('widget text'));
});

test('content is capped at the budget', () => {
	const d = doc();
	d.querySelector('main p').textContent = 'x'.repeat(MAX_CONTENT_CHARS * 2);
	const ctx = harvestSiteContext(d);
	assert.ok(ctx.content.length <= MAX_CONTENT_CHARS);
});

test('buildSitePayload lets curated knowledge lead and shrinks page content', () => {
	const knowledge = 'k'.repeat(MAX_CONTENT_CHARS);
	const payload = buildSitePayload(doc(), { knowledge });
	assert.equal(payload.knowledge.length, MAX_CONTENT_CHARS);
	assert.equal(payload.content, '');

	const light = buildSitePayload(doc(), { knowledge: 'Returns accepted within 30 days.' });
	assert.match(light.knowledge, /30 days/);
	assert.match(light.content, /300 mph/);
});

test('null document degrades to an empty snapshot', () => {
	const ctx = harvestSiteContext(null);
	assert.equal(ctx.title, '');
	assert.deepEqual(ctx.headings, []);
});
