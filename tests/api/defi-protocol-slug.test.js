// A /yields row links to /protocol/<project>, so the protocol route has to
// accept every slug DeFiLlama actually mints.
//
// It did not. The slug charset was [a-z0-9.-], but 14 of the ~6k protocols
// DeFiLlama tracks carry a parenthesis, a plus or a bang: `dinero-(pxeth)`,
// `synthetix-v1+v2`, `yay!`, `inceptionlrt-(isolated-restaking)`. Those pools
// appear in the /yields dataset, so every row for one of them rendered a link
// that answered 400 from the API and 404 from the route table. Dead links on a
// live page, indistinguishable from a typo.
//
// This pins the charset from both ends: the handler accepts a real upstream
// slug and still rejects anything outside the allowlist (the value lands in an
// api.llama.fi path), and the three route tables that resolve /protocol/:slug
// (vercel.json for prod, vite.config.js for dev, and the page's own parser)
// agree with it. A charset that only two of the four honour is the same outage
// in a different place.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// Slugs observed on https://api.llama.fi/protocols that the old charset refused.
const AWKWARD = [
	'dinero-(pxeth)',
	'synthetix-v1+v2',
	'yay!',
	'inceptionlrt-(isolated-restaking)',
	'ondo-v1-(legacy)',
];

const reply = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('/api/defi/protocol slug charset', () => {
	it('accepts the parenthesis, plus and bang slugs DeFiLlama mints', async () => {
		const { default: handler } = await import('../../api/defi/protocol.js');
		for (const slug of AWKWARD) {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const u = String(url);
				if (u.includes('/protocol/')) {
					// The slug must reach upstream percent-encoded, not raw.
					expect(u).toContain(encodeURIComponent(slug));
					return reply({ name: 'Test Protocol', tvl: [{ date: 1_700_000_000, totalLiquidityUSD: 10 }] });
				}
				return reply({}, 404);
			});
			const res = makeRes();
			await handler(makeReq({ url: `/api/defi/protocol?slug=${encodeURIComponent(slug)}` }), res);
			expect(res.statusCode, `${slug} should resolve`).toBe(200);
			expect(JSON.parse(res.body).slug).toBe(slug);
			vi.restoreAllMocks();
		}
	});

	it('still refuses a slug outside the allowlist', async () => {
		const { default: handler } = await import('../../api/defi/protocol.js');
		const spy = vi.spyOn(globalThis, 'fetch');
		for (const slug of ['../secrets', 'a b', 'a/b', 'a?b=1', 'a#b', "a'b", 'x'.repeat(81)]) {
			const res = makeRes();
			await handler(makeReq({ url: `/api/defi/protocol?slug=${encodeURIComponent(slug)}` }), res);
			expect(res.statusCode, `${slug} should be refused`).toBe(400);
		}
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('/protocol/:slug route tables agree', () => {
	it('vercel.json routes every awkward slug to protocol.html', () => {
		const routes = JSON.parse(read('../../vercel.json')).routes;
		const rule = routes.find((r) => r.src?.startsWith('/protocol/'));
		expect(rule, 'vercel.json must carry a /protocol/ rule').toBeTruthy();
		const re = new RegExp(`^${rule.src}$`);
		for (const slug of AWKWARD) {
			expect(re.test(`/protocol/${encodeURIComponent(slug)}`), `${slug} must route`).toBe(true);
		}
		expect(re.test('/protocol/aave-v3')).toBe(true);
	});

	it('the vite dev mirror matches the same slugs', () => {
		const src = read('../../vite.config.js');
		const m = src.match(/\/\^\\\/protocol\\\/\[([^\]]+)\]\{1,80\}\\\/\?\$\/i/);
		expect(m, 'vite.config.js must carry the /protocol/:slug mirror').toBeTruthy();
		const re = new RegExp(`^/protocol/[${m[1]}]{1,80}/?$`, 'i');
		for (const slug of AWKWARD) {
			expect(re.test(`/protocol/${encodeURIComponent(slug)}`), `${slug} must route in dev`).toBe(true);
		}
	});

	it('the page parser recovers the slug from the encoded path', () => {
		const src = read('../../src/protocol-page.js');
		const m = src.match(/const SLUG_RE = (\/\^\[[^/]+\]\{1,80\}\$\/i);/);
		expect(m, 'protocol-page.js must declare SLUG_RE').toBeTruthy();
		// eslint-disable-next-line no-eval -- reading the shipped literal, not user input
		const re = eval(m[1]);
		for (const slug of AWKWARD) {
			expect(re.test(decodeURIComponent(encodeURIComponent(slug))), `${slug} must parse`).toBe(true);
		}
	});
});
