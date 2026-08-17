// @vitest-environment jsdom
//
// /collection card rendering.
//
// Two of these pin defects that shipped and were invisible from the outside:
//
//   1. ESCAPING. subCard escaped every interpolation; skillCard escaped none of
//      them. An agent name or skill slug carrying a quote or a tag broke out of
//      the card markup. Nothing about the rendered page looked wrong until it
//      did, so the escaping is pinned per field rather than trusted.
//   2. THE WALLET FIELD NAMES. /api/users/me/purchased-skills aliases the
//      publisher's wallet columns as agent_solana_* (they come off
//      agent_identities.meta). The card read the un-prefixed names, so every
//      vanity address in a collection silently rendered as a plain one: real
//      data, wrong presentation, zero errors.

import { describe, it, expect } from 'vitest';

import {
	esc, fmtAmount, fmtUsd, explorerUrl, skillCard, subCard, skeletonGrid, emptyState,
} from '../src/collection-render.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
// A real three.ws agent wallet shape: base58, 44 chars, matched vanity prefix.
const AGENT_WALLET = 'THREEo1YQEbQvfPtSFH5aTLJgnQPnraJp8CJqrXHy9ke';

/** @param {Partial<Record<string, unknown>>} over */
function purchase(over = {}) {
	return {
		id: 'a2a2f1de-0000-4000-8000-000000000001',
		agent_id: '3aeed871-525c-4c7f-abe2-3345273a79b4',
		skill: 'code-review',
		kind: 'purchase',
		amount: '939000000',
		currency_mint: THREE_MINT,
		agent_name: 'Cipher #22',
		confirmed_at: '2026-08-17T10:00:00.000Z',
		...over,
	};
}

describe('esc', () => {
	it('neutralizes every character that can break out of markup', () => {
		expect(esc(`<script>"x"&'y'`)).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
	});

	it('renders null and undefined as empty, not as the words', () => {
		expect(esc(null)).toBe('');
		expect(esc(undefined)).toBe('');
	});
});

describe('skillCard', () => {
	it('escapes the skill name, the agent name and the thumbnail URL', () => {
		const html = skillCard(purchase({
			skill: '<img src=x onerror=alert(1)>',
			agent_name: 'Nova" onmouseover="alert(2)',
			agent_thumbnail: 'https://cdn.example/a.png" onload="alert(3)',
		}));
		expect(html).not.toContain('onmouseover="alert');
		expect(html).not.toContain('onload="alert');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');

		// Inert once parsed, which is the property that matters: the payload
		// survives as text, never as an element or an attribute.
		const host = document.createElement('div');
		host.innerHTML = html;
		expect(host.querySelectorAll('img').length).toBe(1); // the avatar only
		expect(host.querySelector('.col-card-skill').textContent)
			.toBe('<img src=x onerror=alert(1)>');
		const avatar = host.querySelector('img.col-card-avatar');
		expect(avatar.getAttribute('onload')).toBeNull();
		expect(avatar.getAttribute('src')).toBe('https://cdn.example/a.png" onload="alert(3)');
		expect(host.querySelector('.col-card-agent').textContent)
			.toBe('Nova" onmouseover="alert(2)');
	});

	it('falls back to a labelled agent rather than an empty line', () => {
		const host = document.createElement('div');
		host.innerHTML = skillCard(purchase({ agent_name: null }));
		expect(host.querySelector('.col-card-agent').textContent).toBe('Unknown agent');
	});

	it('links a purchase without an agent id to the marketplace, never to /undefined', () => {
		const host = document.createElement('div');
		host.innerHTML = skillCard(purchase({ agent_id: null }));
		expect(host.querySelector('a.col-cta').getAttribute('href')).toBe('/marketplace');
	});

	it('reads the wallet off the agent_solana_* aliases the endpoint actually returns', () => {
		const host = document.createElement('div');
		host.innerHTML = skillCard(purchase({
			agent_solana_address: AGENT_WALLET,
			agent_solana_vanity_prefix: 'THREE',
		}));
		const chip = host.querySelector('.col-card-wallet');
		expect(chip).not.toBeNull();
		expect(chip.textContent).toContain('THREE');
	});

	it('renders no wallet chip when the publisher has no custodial wallet', () => {
		const host = document.createElement('div');
		host.innerHTML = skillCard(purchase());
		expect(host.querySelector('.col-card-wallet')).toBeNull();
	});

	it('badges a trial apart from an owned skill', () => {
		expect(skillCard(purchase({ kind: 'trial' }))).toContain('badge-amber');
		expect(skillCard(purchase({ kind: 'purchase' }))).toContain('badge-green');
	});
});

describe('subCard', () => {
	const base = {
		id: 'b1b1f1de-0000-4000-8000-000000000002',
		plan_name: 'Studio access',
		creator_name: 'Harbor',
		creator_username: 'harbor',
		price_usd: 12,
		interval: 'month',
	};

	it('escapes the plan name, the creator and the creator handle', () => {
		const html = subCard({
			...base,
			plan_name: '"><b>pwn</b>',
			creator_name: '<i>x</i>',
			creator_username: 'a"b',
		});
		const host = document.createElement('div');
		host.innerHTML = html;
		expect(host.querySelector('b')).toBeNull();
		expect(host.querySelector('i')).toBeNull();
		expect(host.querySelector('a.col-cta').getAttribute('href')).toBe('/u/a%22b');
	});

	it('calls a future period end a renewal and a past one an ending', () => {
		const future = new Date(Date.now() + 86_400_000).toISOString();
		const past = new Date(Date.now() - 86_400_000).toISOString();
		expect(subCard({ ...base, status: 'active', current_period_end: future })).toContain('Renews');
		expect(subCard({ ...base, status: 'active', current_period_end: past })).toContain('Ended');
		expect(subCard({ ...base, status: 'cancelled', current_period_end: future })).toContain('Ends');
	});

	it('sends a subscription with no creator handle to the marketplace', () => {
		const host = document.createElement('div');
		host.innerHTML = subCard({ ...base, creator_username: null });
		expect(host.querySelector('a.col-cta').getAttribute('href')).toBe('/marketplace');
	});
});

describe('formatters', () => {
	it('names the mint it recognizes and stays silent about the one it does not', () => {
		expect(fmtAmount('939000000', THREE_MINT)).toBe('939.00 $THREE');
		expect(fmtAmount('1500000', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('1.50 USDC');
		expect(fmtAmount('1500000', 'SomeOtherMint1111111111111111111111111111111')).toBe('1.50');
		expect(fmtAmount(0, THREE_MINT)).toBe('');
	});

	it('formats a price and drops a missing one', () => {
		expect(fmtUsd(12)).toBe('$12.00');
		expect(fmtUsd(null)).toBe('');
	});

	it('points devnet mints at the cluster-qualified explorer', () => {
		expect(explorerUrl('Mint111', 'devnet')).toBe('https://explorer.solana.com/address/Mint111?cluster=devnet');
		expect(explorerUrl('Mint111', 'mainnet')).toBe('https://solscan.io/token/Mint111');
	});
});

describe('placeholder states', () => {
	it('renders the requested number of skeleton cards', () => {
		const host = document.createElement('div');
		host.innerHTML = skeletonGrid(4);
		expect(host.querySelectorAll('.skeleton-card').length).toBe(4);
	});

	it('gives each empty state a heading and a way out of it', () => {
		for (const panel of ['skills', 'subscriptions']) {
			const host = document.createElement('div');
			host.innerHTML = emptyState(panel);
			expect(host.querySelector('h3').textContent.length).toBeGreaterThan(0);
			expect(host.querySelector('a').getAttribute('href')).toBe('/marketplace');
		}
	});
});
