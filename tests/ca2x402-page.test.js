// @vitest-environment jsdom
//
// /ca2x402 renders a resolved token. This suite exists because of a defect the
// page could not show you it had: `momentumStrip()` and `riskPanel()` were
// written, complete and correct, but nothing ever called them and no stylesheet
// ever styled them. The resolver had always returned four timeframes of price
// change and a scored risk breakdown, so the page was throwing away most of the
// intel its own $0.01 endpoint sells and rendering a single 24h number instead.
// Nothing failed, nothing logged, and the page looked finished.
//
// So the assertions here are deliberately about the WIRING, not the markup: for
// every block of the resolver payload, prove it reaches the DOM. A render
// helper that exists but is never called fails this suite.
//
// The page is driven through its real boot path (?ca=<mint> resolves on load)
// and its real form, with only the network boundary replaced.

import { describe, it, expect, beforeAll, vi } from 'vitest';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Shaped exactly like a live GET /api/ca2x402/resolve body (see
// api/ca2x402/resolve.js and buildTokenRisk in api/_lib/token-market.js).
const RESOLVED = {
	ok: true,
	token: {
		mint: MINT,
		symbol: 'three',
		name: 'three.ws',
		chain: 'solana',
		dex: 'pumpswap',
		pair_url: 'https://dexscreener.com/solana/pair',
		price_usd: 0.001599,
		change_24h: -6.96,
		market_cap_usd: 1_599_461,
		liquidity_usd: 220_440.2,
		volume_24h_usd: 50_189.8,
		momentum: { m5: -0.18, h1: 1.11, h6: -0.05, h24: -6.96 },
		signal: 'bearish',
		headline: 'THREE drops 6.96%, sellers in control',
		rationale: 'Volume is light against liquidity.',
		risk: {
			score: 34,
			level: 'medium',
			summary: 'THREE clears the basic depth, age, and flow checks.',
			factors: [
				{ label: 'Liquidity', status: 'low', detail: '$220,440 pooled, healthy depth.' },
				{ label: 'Age', status: 'low', detail: 'Pair is 110d old, established.' },
				{ label: 'Float', status: 'medium', detail: 'Cap is 7.3x liquidity.' },
				{ label: 'Flow', status: 'high', detail: '71% of 24h trades are buys.' },
			],
		},
	},
	service: {
		name: 'three.ws Token Oracle',
		endpoint: `https://three.ws/api/x402/token-intel?mint=${MINT}`,
		method: 'GET',
		price_usd: 0.01,
		asset: 'USDC',
		networks: ['solana', 'base'],
		bazaar_discoverable: true,
		snippets: {
			curl: 'curl -i "https://three.ws/api/x402/token-intel"',
			node: 'import { wrapFetchWithPayment } from "x402-fetch";',
			agent: '// inside a three.ws agent',
		},
	},
};

// The one boundary that is faked: the network. Everything downstream of it is
// the page's own code.
let respond = async () => ({ ok: true, json: async () => RESOLVED });

vi.mock('../src/api.js', () => ({
	apiFetch: (...args) => respond(...args),
}));

const $ = (sel) => document.querySelector(sel);
const all = (sel) => [...document.querySelectorAll(sel)];

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function submit(value) {
	$('#cx-input').value = value;
	$('#cx-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
	await settle();
}

beforeAll(async () => {
	document.body.innerHTML = '<main class="cx-shell" id="cx-root"></main>';
	window.history.replaceState(null, '', `/ca2x402?ca=${MINT}`);
	await import('../src/ca2x402.js');
	await settle();
});

describe('/ca2x402 resolved token card', () => {
	it('renders the token identity and headline stats', () => {
		expect($('.cx-token')).toBeTruthy();
		expect($('.cx-token-sym').textContent).toContain('three');
		expect(all('.cx-stat-k').map((n) => n.textContent))
			.toEqual(['Price', '24h', 'Market cap', 'Liquidity', '24h volume']);
	});

	it('renders every momentum timeframe the resolver returned', () => {
		const strip = $('.cx-momentum');
		expect(strip, 'momentumStrip() must be called from tokenCard()').toBeTruthy();
		expect([...strip.querySelectorAll('.cx-mom-k')].map((n) => n.textContent)).toEqual(['5m', '1h', '6h', '24h']);
		expect([...strip.querySelectorAll('.cx-mom-v')].map((n) => n.textContent.trim()))
			.toEqual(['-0.18%', '+1.11%', '-0.05%', '-6.96%']);
		expect(strip.getAttribute('aria-label')).toBe('Momentum by timeframe');
	});

	it('colours each timeframe by direction so a mixed move reads at a glance', () => {
		const cls = all('.cx-mom-v').map((n) => n.className);
		expect(cls[0]).toContain('cx-neg');
		expect(cls[1]).toContain('cx-pos');
		expect(cls[3]).toContain('cx-neg');
	});

	it('renders the risk score, its level, and every factor behind it', () => {
		const panel = $('.cx-risk');
		expect(panel, 'riskPanel() must be called from tokenCard()').toBeTruthy();
		expect(panel.className).toContain('cx-risk-medium');
		expect($('.cx-risk-score').textContent).toBe('34');
		expect($('.cx-risk-lvl').textContent).toBe('medium');
		expect($('.cx-risk-summary').textContent).toContain('depth, age, and flow');

		const factors = all('.cx-rf');
		expect(factors).toHaveLength(RESOLVED.token.risk.factors.length);
		expect(factors.map((f) => f.querySelector('.cx-rf-label').textContent))
			.toEqual(['Liquidity', 'Age', 'Float', 'Flow']);
		// The severity class is what tints each dot; without it every factor
		// reads as equally serious.
		expect(factors.map((f) => f.className)).toEqual([
			'cx-rf cx-rf-low', 'cx-rf cx-rf-low', 'cx-rf cx-rf-medium', 'cx-rf cx-rf-high',
		]);
	});

	it('drives the gauge arc from the score', () => {
		expect($('.cx-risk-gauge').getAttribute('style')).toContain('--cx-risk:34');
	});

	it('still renders the service card next to the intel', () => {
		expect($('.cx-url').textContent).toContain('/api/x402/token-intel');
	});
});

describe('/ca2x402 payloads that omit the optional blocks', () => {
	it('drops the momentum strip rather than printing four dashes', async () => {
		respond = async () => ({
			ok: true,
			json: async () => ({
				...RESOLVED,
				token: { ...RESOLVED.token, momentum: { m5: null, h1: null, h6: null, h24: null }, risk: null },
			}),
		});
		await submit(MINT);
		expect($('.cx-token')).toBeTruthy();
		expect($('.cx-momentum')).toBeNull();
		expect($('.cx-risk')).toBeNull();
	});

	it('drops the risk panel when the resolver scored nothing', async () => {
		respond = async () => ({
			ok: true,
			json: async () => ({ ...RESOLVED, token: { ...RESOLVED.token, risk: { level: 'low', factors: [] } } }),
		});
		await submit(MINT);
		expect($('.cx-momentum')).toBeTruthy();
		expect($('.cx-risk')).toBeNull();
	});
});

describe('/ca2x402 failure states name which failure happened', () => {
	it('tells a user their typo is a typo, without a network round trip', async () => {
		let called = false;
		respond = async () => { called = true; return { ok: true, json: async () => RESOLVED }; };
		await submit('not-an-address');
		expect(called).toBe(false);
		expect($('.cx-error h2').textContent).toBe('That is not a contract address');
		expect($('#cx-retry')).toBeTruthy();
	});

	it('separates "no market for this token" from "the resolver is down"', async () => {
		respond = async () => ({
			ok: false,
			json: async () => ({ ok: false, error: 'token_not_found', error_description: 'No live market found for this address on DexScreener.' }),
		});
		await submit(MINT);
		expect($('.cx-error h2').textContent).toBe('No market found for that address');
		expect($('.cx-error p').textContent).toContain('No live market found');

		respond = async () => { throw new TypeError('Failed to fetch'); };
		await submit(MINT);
		expect($('.cx-error h2').textContent).toBe('Could not resolve');
		expect($('.cx-error p').textContent).toContain('Network error');
	});

	it('offers a way out of every error state', async () => {
		$('#cx-retry').dispatchEvent(new window.Event('click', { bubbles: true }));
		await settle();
		expect($('.cx-error')).toBeNull();
		expect($('.cx-empty')).toBeTruthy();
		expect(document.getElementById('cx-root').textContent).toContain('Paste');
	});
});
