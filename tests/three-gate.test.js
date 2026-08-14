// @vitest-environment jsdom
//
// Unit tests for the reusable $THREE paywall: the tier-pass helper
// (src/three-tier-pass.js) and the <three-gate> custom element (src/three-gate.js).
//
// The helper is exercised against a mocked fetch (real cache + sessionStorage +
// auto-wire); the element is mounted for real and driven through the same mocked
// endpoint, proving the loading → locked / unlocked / error states, the held-vs-
// required copy + progress, the reason-specific secondaries, the pay-per-use line,
// the `three-gate:unlocked` event, that gated children are made inert while locked
// and freed when unlocked, fail-closed on a missing feature, and HTML escaping. No
// network — the live endpoint is covered by the api/_lib three-access registry +
// HTTP tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getAccess,
	getTierPass,
	threeHeaders,
	clearTierPass,
} from '../src/three-tier-pass.js';
import '../src/three-gate.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const LOCKED = {
	signed_in: true,
	wallet_linked: true,
	tier: { level: 0, id: 'member', label: 'Member', held_usd: 10 },
	access: {
		feature: 'forge.high',
		label: 'High-quality generation (200k poly + PBR)',
		why: 'The High tier spends real GPU/vendor budget — holders fund it by holding.',
		eligible: false,
		required: { level: 1, id: 'bronze', label: 'Bronze', min_usd: 25 },
		held: { level: 0, id: 'member', label: 'Member', min_usd: 0, usd: 10 },
		reason: 'insufficient_tier',
		pay_per_use: { action: 'forge.high', usd: 0.5 },
	},
};

const UNLOCKED = {
	signed_in: true,
	wallet_linked: true,
	tier: { level: 2, id: 'silver', label: 'Silver', held_usd: 120 },
	access: {
		feature: 'forge.high',
		label: 'High-quality generation (200k poly + PBR)',
		why: '',
		eligible: true,
		required: { level: 1, id: 'bronze', label: 'Bronze', min_usd: 25 },
		held: { level: 2, id: 'silver', label: 'Silver', min_usd: 100, usd: 120 },
		reason: 'eligible',
		pay_per_use: { action: 'forge.high', usd: 0.5 },
	},
};

function withReason(reason, over = {}) {
	return {
		...LOCKED,
		signed_in: reason !== 'sign_in',
		wallet_linked: reason === 'insufficient_tier',
		access: { ...LOCKED.access, reason, ...over },
	};
}

// ── helpers ─────────────────────────────────────────────────────────────────

function jsonRes(status, body) {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	});
}

// A pass string in the real `<base64url(payload)>.<sig>` shape, carrying `exp`
// (unix seconds) so the helper's expiry decode + freshness window are exercised.
function makePass(expSec) {
	const payload = Buffer.from(JSON.stringify({ exp: expSec, w: 'wallet' }))
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return `${payload}.signature`;
}
const freshPass = () => makePass(Math.floor(Date.now() / 1000) + 600);

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => {
	await tick();
	await tick();
};

function mountGate(attrs = {}, childId = 'premium') {
	const el = document.createElement('three-gate');
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	const child = document.createElement('button');
	child.id = childId;
	child.textContent = 'Generate (High)';
	el.appendChild(child);
	document.body.appendChild(el);
	return el;
}

beforeEach(() => {
	document.body.innerHTML = '';
	window.sessionStorage.clear();
	clearTierPass();
});
afterEach(() => {
	vi.restoreAllMocks();
});

// ── three-tier-pass.js ──────────────────────────────────────────────────────

describe('getAccess', () => {
	it('returns the parsed payload and sends credentials', async () => {
		global.fetch = vi.fn(() => jsonRes(200, LOCKED));
		const data = await getAccess('forge.high');
		expect(data).toEqual(LOCKED);
		expect(global.fetch).toHaveBeenCalledWith('/api/three/access?feature=forge.high', {
			credentials: 'include',
		});
	});

	it('returns a Member-shaped fallback (flagged _error) on a network failure', async () => {
		global.fetch = vi.fn(() => Promise.reject(new Error('offline')));
		const data = await getAccess('forge.high');
		expect(data._error).toBe(true);
		expect(data.tier.id).toBe('member');
		expect(data.access.eligible).toBe(false);
		expect(data.access.reason).toBe('error');
	});

	it('falls back on a non-OK response too', async () => {
		global.fetch = vi.fn(() => jsonRes(500, { error: 'boom' }));
		const data = await getAccess('forge.high');
		expect(data._error).toBe(true);
	});
});

describe('getTierPass', () => {
	it('mints a pass, returns the string, and caches it in sessionStorage', async () => {
		const pass = freshPass();
		const fetchMock = vi.fn(() => jsonRes(201, { pass, tier: { id: 'bronze' } }));
		global.fetch = fetchMock;

		const p1 = await getTierPass();
		expect(p1).toBe(pass);
		expect(fetchMock).toHaveBeenCalledWith('/api/three/tier-pass', {
			method: 'POST',
			credentials: 'include',
		});
		expect(JSON.parse(window.sessionStorage.getItem('three_tier_pass')).pass).toBe(pass);

		// A fresh pass is reused — no second network call.
		const p2 = await getTierPass();
		expect(p2).toBe(pass);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns null and stores nothing when unauthenticated (401)', async () => {
		global.fetch = vi.fn(() => jsonRes(401, { error: 'unauthorized' }));
		expect(await getTierPass()).toBeNull();
		expect(window.sessionStorage.getItem('three_tier_pass')).toBeNull();
	});

	it('re-mints once the pass is within the staleness window', async () => {
		const nearExpiry = makePass(Math.floor(Date.now() / 1000) + 60); // < 2-min buffer
		const fetchMock = vi.fn(() => jsonRes(201, { pass: nearExpiry }));
		global.fetch = fetchMock;
		await getTierPass();
		await getTierPass();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('re-fetches after clearTierPass drops the cache', async () => {
		const fetchMock = vi.fn(() => jsonRes(201, { pass: freshPass() }));
		global.fetch = fetchMock;
		await getTierPass();
		clearTierPass();
		await getTierPass();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe('threeHeaders', () => {
	it('carries the pass header when a pass is available', async () => {
		const pass = freshPass();
		global.fetch = vi.fn(() => jsonRes(201, { pass }));
		expect(await threeHeaders()).toEqual({ 'x-three-tier-pass': pass });
	});

	it('is an empty object when no pass is available', async () => {
		global.fetch = vi.fn(() => jsonRes(401, {}));
		expect(await threeHeaders()).toEqual({});
	});
});

describe('wallet:changed auto-wire', () => {
	it('clears the cached pass and broadcasts three:tier-changed', async () => {
		global.fetch = vi.fn(() => jsonRes(201, { pass: freshPass() }));
		await getTierPass();
		expect(window.sessionStorage.getItem('three_tier_pass')).toBeTruthy();

		const relay = vi.fn();
		window.addEventListener('three:tier-changed', relay);
		window.dispatchEvent(new CustomEvent('wallet:changed', { detail: { address: null } }));
		window.removeEventListener('three:tier-changed', relay);

		expect(relay).toHaveBeenCalledOnce();
		expect(window.sessionStorage.getItem('three_tier_pass')).toBeNull();
	});
});

// ── <three-gate> ────────────────────────────────────────────────────────────

describe('<three-gate> — lifecycle & states', () => {
	it('shows a skeleton (not a flash of locked) while access is resolving', async () => {
		global.fetch = vi.fn(() => new Promise(() => {})); // never resolves
		const el = mountGate({ feature: 'forge.high' });
		const root = el.shadowRoot;
		expect(root.querySelector('.tg-root').dataset.state).toBe('loading');
		expect(root.querySelector('.tg-card--skel')).toBeTruthy();
		expect(root.querySelector('[role="status"]').textContent).toMatch(/checking/i);
		// Gated child is inert (not tab-reachable) while we don't yet know access.
		expect(el.querySelector('#premium').inert).toBe(true);
	});

	it('renders the locked card with held-vs-required, progress, CTA and pay line', async () => {
		global.fetch = vi.fn(() => jsonRes(200, LOCKED));
		const el = mountGate({ feature: 'forge.high' });
		await flush();
		const root = el.shadowRoot;
		expect(root.querySelector('.tg-root').dataset.state).toBe('locked');

		const card = root.querySelector('.tg-card');
		expect(card.getAttribute('role')).toBe('group');
		expect(card.textContent).toMatch(/You hold\s*\$10\s*·\s*Member/);
		expect(card.textContent).toMatch(/Requires\s*Bronze\s*·\s*\$25/);

		// Progress = held_usd (10) / required min_usd (25) = 40%.
		const fill = root.querySelector('.tg-prog-fill');
		expect(fill.getAttribute('style')).toContain('width:40%');
		// The cap counts up from 0 with requestAnimationFrame (ui-juice `countUp`), so
		// the two microtask ticks in `flush` land mid-animation whenever the machine is
		// busy enough for a frame to fire first. Wait for the settled copy instead of
		// racing the frame: the assertion is that it ARRIVES at "40% there", not that it
		// skips the animation.
		await vi.waitFor(
			() => expect(root.querySelector('.tg-prog-cap').textContent).toMatch(/40% there/),
			{ timeout: 4000, interval: 20 },
		);

		// Get $THREE → a real Jupiter swap URL for the canonical mint.
		const get = root.querySelector('[data-tg-get]');
		expect(get.tagName).toBe('A');
		expect(get.getAttribute('href')).toBe(
			'https://jup.ag/swap/SOL-FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		);
		expect(get.getAttribute('target')).toBe('_blank');

		// pay-per-use line + perks link.
		expect(card.textContent).toMatch(/or pay\s*\$0\.50\s*per use/);
		expect(root.querySelector('a.tg-perks').getAttribute('href')).toBe('/three-token');

		// Child stays inert behind the lock.
		expect(el.querySelector('#premium').inert).toBe(true);
	});

	it('reveals children, clears inert, and emits three-gate:unlocked for a holder', async () => {
		global.fetch = vi.fn(() => jsonRes(200, UNLOCKED));
		const el = mountGate({ feature: 'forge.high' });
		const detail = vi.fn();
		el.addEventListener('three-gate:unlocked', (e) => detail(e.detail));
		await flush();
		const root = el.shadowRoot;

		expect(root.querySelector('.tg-root').dataset.state).toBe('unlocked');
		expect(root.querySelector('.tg-veil-inner').innerHTML).toBe('');
		expect(el.querySelector('#premium').inert).toBe(false);
		expect(detail).toHaveBeenCalledOnce();
		expect(detail.mock.calls[0][0]).toMatchObject({ feature: 'forge.high', tier: { id: 'silver' } });
	});

	it('renders an actionable, retryable error on a degraded read', async () => {
		const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
		global.fetch = fetchMock;
		const el = mountGate({ feature: 'forge.high' });
		await flush();
		const root = el.shadowRoot;
		expect(root.querySelector('.tg-root').dataset.state).toBe('error');
		expect(root.querySelector('[role="alert"]').textContent).toMatch(/couldn.t check/i);

		// Retry re-reads access; this time it resolves to unlocked.
		fetchMock.mockImplementation(() => jsonRes(200, UNLOCKED));
		root.querySelector('[data-tg-retry]').click();
		await flush();
		expect(root.querySelector('.tg-root').dataset.state).toBe('unlocked');
	});

	it('fails closed (locked + inert) when the required feature attribute is missing', async () => {
		global.fetch = vi.fn(() => jsonRes(200, UNLOCKED));
		const el = mountGate({}); // no feature
		await flush();
		expect(el.shadowRoot.querySelector('.tg-root').dataset.state).toBe('error');
		expect(global.fetch).not.toHaveBeenCalled();
		expect(el.querySelector('#premium').inert).toBe(true);
	});
});

describe('<three-gate> — reason-specific secondaries', () => {
	it('reason=sign_in offers a Sign in link', async () => {
		global.fetch = vi.fn(() => jsonRes(200, withReason('sign_in')));
		const el = mountGate({ feature: 'forge.high' });
		await flush();
		expect(el.shadowRoot.querySelector('a[href="/login"]')).toBeTruthy();
	});

	it('reason=link_wallet offers a Connect wallet button', async () => {
		global.fetch = vi.fn(() => jsonRes(200, withReason('link_wallet')));
		const el = mountGate({ feature: 'forge.high' });
		await flush();
		const connect = el.shadowRoot.querySelector('[data-tg-connect]');
		expect(connect).toBeTruthy();
		expect(connect.tagName).toBe('BUTTON');
	});

	it('reason=insufficient_tier shows a "hold to unlock" explainer instead of a button', async () => {
		global.fetch = vi.fn(() => jsonRes(200, LOCKED));
		const el = mountGate({ feature: 'forge.high' });
		await flush();
		const root = el.shadowRoot;
		expect(root.querySelector('.tg-hold-hint')).toBeTruthy();
		expect(root.querySelector('[data-tg-connect]')).toBeNull();
	});
});

describe('<three-gate> — hardening', () => {
	it('escapes untrusted strings from the access payload', async () => {
		global.fetch = vi.fn(() =>
			jsonRes(200, {
				...LOCKED,
				access: {
					...LOCKED.access,
					label: '<img src=x onerror=alert(1)>',
					required: { ...LOCKED.access.required, label: '<script>bad</script>' },
				},
			}),
		);
		const el = mountGate({ feature: 'forge.high' });
		await flush();
		const root = el.shadowRoot;
		expect(root.querySelector('img')).toBeNull();
		expect(root.querySelector('script')).toBeNull();
	});

	it('reflects the mode attribute onto the root for replace styling', async () => {
		global.fetch = vi.fn(() => jsonRes(200, LOCKED));
		const el = mountGate({ feature: 'forge.high', mode: 'replace' });
		await flush();
		expect(el.shadowRoot.querySelector('.tg-root').dataset.mode).toBe('replace');
	});
});
