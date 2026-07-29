// Guards the server-side render that gives JS-only directory pages real content
// before hydration (server/ssr-pages.mjs).
//
// The failure this protects against is silent: if the shell's markers drift, or
// the upstream payload changes shape, /discover quietly goes back to shipping an
// empty grid to crawlers and no-JS visitors, and nothing in CI notices.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { __test, isSsrRoute, renderSsrPage } from '../server/ssr-pages.mjs';

const root = resolve(__dirname, '..');
const { renderDiscover, renderDiscoverCard, escapeHtml, PAGES } = __test;

const sampleData = {
	items: [
		{
			kind: 'onchain',
			chainId: 8453,
			chainShortName: 'Base',
			agentId: '60087',
			name: 'Weather Oracle',
			description: 'Answers forecast questions and settles per call.',
			has3d: true,
			x402Support: true,
		},
		{
			kind: 'onchain',
			chainId: 1,
			chainShortName: 'Ethereum',
			agentId: '42',
			name: 'Agent #42',
			description: '',
			has3d: false,
			x402Support: false,
		},
	],
	totals: { all: 150065, threeD: 17936, onchain: 130559, solana: 1571 },
};

describe('ssr-pages: the /discover shell markers still match', () => {
	it('every registered page markup marker appears exactly once in its shell', () => {
		for (const page of PAGES) {
			const shell = readFileSync(resolve(root, 'public', page.file), 'utf8');
			const rendered = page.build(sampleData);
			expect(rendered, `${page.route} produced no render`).toBeTruthy();
			const out = page.apply(shell, rendered);
			// apply() is a no-op when a marker has drifted; that is the exact
			// regression this test exists to catch.
			expect(out, `${page.route}: shell markers no longer match`).not.toBe(shell);
		}
	});

	it('the client clears the container it renders into, so SSR content cannot duplicate', () => {
		// public/discover/discover.js must reset the grid before rendering; without
		// that, the injected cards would sit above the hydrated ones.
		const client = readFileSync(resolve(root, 'public/discover/discover.js'), 'utf8');
		expect(client).toMatch(/els\.grid\.innerHTML\s*=\s*''/);
	});
});

describe('ssr-pages: rendering', () => {
	it('renders a link to the on-chain detail page for on-chain agents', () => {
		const html = renderDiscoverCard(sampleData.items[0]);
		expect(html).toContain('href="/discover/a/8453/60087"');
		expect(html).toContain('Weather Oracle');
	});

	it('renders badges only for the capabilities an agent actually has', () => {
		const rich = renderDiscoverCard(sampleData.items[0]);
		expect(rich).toContain('>3D<');
		expect(rich).toContain('>x402<');
		const plain = renderDiscoverCard(sampleData.items[1]);
		expect(plain).not.toContain('>3D<');
		expect(plain).not.toContain('>x402<');
	});

	it('formats the directory totals the same way the client does', () => {
		const rendered = renderDiscover(sampleData);
		expect(rendered.stats).toBe(
			'150,065 agents · 17,936 with 3D avatars · 130,559 on EVM chains · 1,571 on Solana',
		);
	});

	it('escapes agent-supplied text', () => {
		// Agent names and descriptions are user/on-chain data: untrusted by default.
		const html = renderDiscoverCard({
			kind: 'onchain',
			chainId: 1,
			agentId: '1',
			name: '<img src=x onerror=alert(1)>',
			description: '"><script>alert(2)</script>',
		});
		expect(html).not.toContain('<img src=x');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;img');
	});

	it('escapes every HTML-significant character', () => {
		expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
	});

	it('renders nothing when the payload carries no items, leaving the shell alone', () => {
		expect(renderDiscover({ items: [], totals: {} })).toBeNull();
		expect(renderDiscover({})).toBeNull();
		expect(renderDiscover(null)).toBeNull();
	});
});

describe('ssr-pages: failure modes never take the page down', () => {
	it('only claims routes it is registered for', () => {
		expect(isSsrRoute('/discover')).toBe(true);
		expect(isSsrRoute('/discover/')).toBe(false);
		expect(isSsrRoute('/gallery')).toBe(false);
	});

	it('falls back to the static shell when the upstream is unreachable', async () => {
		// Port 1 refuses instantly: stands in for a dead/hanging internal API.
		const shell = '<div class="explore-grid" data-role="grid"></div>';
		const out = await renderSsrPage('/discover', shell, 'http://127.0.0.1:1');
		expect(out).toBeNull();
	});
});
