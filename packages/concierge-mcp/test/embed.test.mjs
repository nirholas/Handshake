// Pure-logic tests for the embed snippet generator. Offline, no network.
//
// Run: node --test packages/concierge-mcp/test/embed.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEmbed, FLAVORS } from '../src/lib/embed.js';

test('flavor "all" returns every snippet flavor', () => {
	const { snippets } = buildEmbed({ siteName: 'Acme' }, 'all');
	for (const f of FLAVORS) assert.ok(snippets[f], `missing ${f} snippet`);
});

test('script snippet is the one-tag CDN install with data-concierge', () => {
	const { snippets } = buildEmbed({ siteName: 'Acme', accent: '#f97316' }, 'script');
	assert.match(snippets.script, /<script type="module"/);
	assert.match(snippets.script, /concierge\/concierge\.global\.js/);
	assert.match(snippets.script, /data-concierge/);
	assert.match(snippets.script, /data-site-name="Acme"/);
	assert.match(snippets.script, /data-accent="#f97316"/);
});

test('web-component snippet emits <three-concierge> with kebab attributes', () => {
	const { snippets } = buildEmbed({ siteName: 'Acme', noPicker: true }, 'web-component');
	assert.match(snippets['web-component'], /<three-concierge/);
	assert.match(snippets['web-component'], /site-name="Acme"/);
	assert.match(snippets['web-component'], /no-picker/);
});

test('suggestions are pipe-joined and capped at 4', () => {
	const { snippets, config } = buildEmbed(
		{ siteName: 'Acme', suggestions: ['a', 'b', 'c', 'd', 'e'] },
		'script',
	);
	assert.equal(config.suggestions.length, 4);
	assert.match(snippets.script, /data-suggestions="a\|b\|c\|d"/);
});

test('attribute values are HTML-escaped (no injection)', () => {
	const { snippets } = buildEmbed({ siteName: 'A" onload="alert(1)' }, 'script');
	assert.ok(!snippets.script.includes('onload="alert(1)"'));
	assert.match(snippets.script, /&quot;/);
});

test('npm snippet is runnable JS with the config object', () => {
	const { snippets } = buildEmbed({ siteName: 'Acme', knowledge: 'Pro is $20/mo.' }, 'npm');
	assert.match(snippets.npm, /import \{ Concierge \} from '@three-ws\/concierge'/);
	assert.match(snippets.npm, /new Concierge\(/);
	assert.match(snippets.npm, /"siteName": "Acme"/);
});

test('web-component snippet is paste-ready: loads the global build, no bare import', () => {
	const { snippets } = buildEmbed({ siteName: 'Acme' }, 'web-component');
	assert.match(snippets['web-component'], /concierge\/concierge\.global\.js/);
	assert.ok(!snippets['web-component'].includes("import '@three-ws/concierge'"));
});

test('imperative snippet loads the global build and calls mount()', () => {
	const { snippets: imp } = buildEmbed({ siteName: 'Acme' }, 'imperative');
	const { snippets: npm } = buildEmbed({ siteName: 'Acme' }, 'npm');
	assert.match(imp.imperative, /concierge\/concierge\.global\.js/);
	assert.match(imp.imperative, /window\.ThreeWsConcierge\.mount\(/);
	assert.match(imp.imperative, /"siteName": "Acme"/);
	assert.notEqual(imp.imperative, npm.npm);
});

test('empty/unset fields are omitted from the snippet', () => {
	const { config } = buildEmbed({ siteName: 'Acme', accent: '', greeting: undefined }, 'script');
	assert.equal(config.siteName, 'Acme');
	assert.ok(!('accent' in config));
	assert.ok(!('greeting' in config));
});
