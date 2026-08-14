// @vitest-environment jsdom
//
// Unit tests for the client access SDK (src/three/access.js) — the single module
// every gated surface imports. Against a mocked fetch + a real jsdom DOM (the gate
// modal mounts for real), these prove: the 30s matrix cache + per-feature derivation
// + `fresh` bypass, the Member-shaped fallback that means fetchAccess never throws,
// the tier-pass mint/cache/90s-renewal + the 401→sign_in / 403→link_wallet reason
// map, the high-level gate (eligible → pass; eligible-but-mint-fails → fail-open;
// not-eligible → opens the modal and resolves on cancel; Recheck into eligibility →
// proceeds), subscribe/refresh, and that a wallet:changed event busts the cache.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ACCESS_RE = /\/api\/three\/access/;
const PASS_RE = /\/api\/three\/tier-pass/;

// Mutable per-test responses the fetch mock serves; reset in beforeEach.
let accessState;
let passState;

const TIER = { level: 0, id: 'member', label: 'Member', held_usd: 0 };

function res(status, body) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A locked single-feature payload with a chosen reason — the real server shape.
function locked(reason = 'sign_in', extra = {}) {
	return {
		signed_in: reason !== 'sign_in',
		wallet_linked: reason === 'insufficient_tier',
		tier: TIER,
		access: {
			feature: 'forge.high',
			label: 'High-quality generation (200k poly + PBR)',
			why: 'The High tier spends real GPU budget — holders fund it by holding.',
			eligible: false,
			required: { level: 1, id: 'bronze', label: 'Bronze', min_usd: 25 },
			held: { level: 0, id: 'member', label: 'Member', min_usd: 0, usd: 0 },
			reason,
			pay_per_use: { action: 'forge.high', usd: 0.5 },
			...extra,
		},
	};
}

function eligible() {
	const d = locked('insufficient_tier');
	d.signed_in = true;
	d.wallet_linked = true;
	d.tier = { level: 1, id: 'bronze', label: 'Bronze', held_usd: 40 };
	d.access.eligible = true;
	d.access.reason = 'eligible';
	d.access.held = { level: 1, id: 'bronze', label: 'Bronze', min_usd: 25, usd: 40 };
	return d;
}

function matrix(features) {
	return { signed_in: true, wallet_linked: true, tier: { level: 1, id: 'bronze', label: 'Bronze', held_usd: 40 }, features };
}

// A real `<b64url(payload)>.<b64url(sig)>` pass whose exp is `secs` from now.
function makePass(secs) {
	const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return `${b64({ wallet: 'THREEsynthetic1111', exp: Math.floor(Date.now() / 1000) + secs })}.${b64({ sig: 'x' })}`;
}

function installFetch() {
	global.fetch = vi.fn(async (url) => {
		const u = String(url);
		if (ACCESS_RE.test(u)) return res(accessState.status, accessState.body);
		if (PASS_RE.test(u)) return res(passState.status, passState.body);
		return res(404, { error: 'not_found' });
	});
	return global.fetch;
}

// Each test gets a pristine module (module-level caches/singletons reset).
async function freshModule() {
	vi.resetModules();
	return import('../../src/three/access.js');
}

// The gate modal arrives through a dynamic import of ./gate-modal.js, so the
// first open in a fork pays that chunk's cold load. vi.waitFor's 1s default does
// not cover it under suite load, and the miss is not contained: the modal opens
// anyway a moment later, lands in the shared jsdom body after this test's
// cleanup, and the next test then drives THAT overlay instead of its own and
// hangs until the global timeout. That is exactly the pair of failures this
// budget removes; the assertions are unchanged.
const GATE_WAIT = { timeout: 30_000, interval: 20 };

beforeEach(() => {
	accessState = { status: 200, body: locked('sign_in') };
	passState = { status: 201, body: { pass: makePass(600), tier: { level: 1, id: 'bronze', label: 'Bronze' }, held_usd: 40 } };
	installFetch();
});

afterEach(() => {
	document.querySelectorAll('.tga-overlay').forEach((el) => el.remove());
	vi.restoreAllMocks();
});

describe('fetchAccess — cache, derivation, fallback', () => {
	it('returns the full matrix and memoizes it within the TTL', async () => {
		const { fetchAccess } = await freshModule();
		accessState.body = matrix([eligible().access]);
		const a = await fetchAccess();
		const b = await fetchAccess();
		expect(a).toEqual(b);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('derives a single feature from the warm matrix without a second request', async () => {
		const { fetchAccess } = await freshModule();
		accessState.body = matrix([eligible().access]);
		await fetchAccess(); // warms the matrix
		const f = await fetchAccess({ feature: 'forge.high' });
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(f.access.feature).toBe('forge.high');
		expect(f.tier.id).toBe('bronze');
		expect(f.signed_in).toBe(true);
	});

	it('fresh:true bypasses the cache', async () => {
		const { fetchAccess } = await freshModule();
		accessState.body = matrix([eligible().access]);
		await fetchAccess();
		await fetchAccess({ fresh: true });
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('never throws — returns a Member-shaped fallback on a network failure', async () => {
		const { fetchAccess } = await freshModule();
		global.fetch.mockRejectedValueOnce(new Error('offline'));
		const a = await fetchAccess({ feature: 'forge.high' });
		expect(a.signed_in).toBe(false);
		expect(a.wallet_linked).toBe(false);
		expect(a.tier.id).toBe('member');
		expect(a._error).toBe(true);
		expect(a.access.eligible).toBe(false);
	});

	it('signed-out shape matches the acceptance contract', async () => {
		const { fetchAccess } = await freshModule();
		accessState.body = { signed_in: false, wallet_linked: false, tier: TIER, access: locked('sign_in').access };
		const a = await fetchAccess({ feature: 'forge.high' });
		expect(a.signed_in).toBe(false);
		expect(a.wallet_linked).toBe(false);
		expect(a.tier.id).toBe('member');
	});
});

describe('getTierPass — mint, cache, renewal, reason map', () => {
	it('mints a pass (201) and caches it across calls', async () => {
		const { getTierPass } = await freshModule();
		const p1 = await getTierPass();
		const p2 = await getTierPass();
		expect(p1.pass).toBe(passState.body.pass);
		expect(p1.held_usd).toBe(40);
		expect(p1.tier.id).toBe('bronze');
		expect(p2).toBe(p1);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('re-mints when the cached pass is within 90s of expiry', async () => {
		const { getTierPass } = await freshModule();
		passState.body = { ...passState.body, pass: makePass(60) }; // inside the 90s renew window
		await getTierPass();
		await getTierPass();
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('force:true bypasses a fresh cache', async () => {
		const { getTierPass } = await freshModule();
		await getTierPass();
		await getTierPass({ force: true });
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('401 → null with reason sign_in', async () => {
		const { getTierPass, tierPassReason } = await freshModule();
		passState = { status: 401, body: { error: 'unauthorized' } };
		expect(await getTierPass()).toBeNull();
		expect(tierPassReason()).toBe('sign_in');
	});

	it('403 → null with reason link_wallet', async () => {
		const { getTierPass, tierPassReason } = await freshModule();
		passState = { status: 403, body: { error: 'wallet_required' } };
		expect(await getTierPass()).toBeNull();
		expect(tierPassReason()).toBe('link_wallet');
	});

	it('a network failure returns null without throwing', async () => {
		const { getTierPass } = await freshModule();
		global.fetch.mockRejectedValueOnce(new Error('offline'));
		expect(await getTierPass()).toBeNull();
	});
});

describe('ensureFeatureAccess — the gate', () => {
	it('eligible → { ok:true, pass } and mints a pass', async () => {
		const { ensureFeatureAccess } = await freshModule();
		accessState.body = eligible();
		const out = await ensureFeatureAccess('forge.high');
		expect(out.ok).toBe(true);
		expect(out.pass).toBe(passState.body.pass);
		expect(global.fetch).toHaveBeenCalledWith('/api/three/tier-pass', expect.objectContaining({ method: 'POST' }));
	});

	it('eligible with needsPass:false → { ok:true } and mints no pass', async () => {
		const { ensureFeatureAccess } = await freshModule();
		accessState.body = eligible();
		const out = await ensureFeatureAccess('forge.high', { needsPass: false });
		expect(out).toEqual({ ok: true, pass: null });
		expect(global.fetch).toHaveBeenCalledTimes(1); // access only, no tier-pass
	});

	it('eligible but the pass mint fails → fails OPEN with { ok:true, pass:null }', async () => {
		const { ensureFeatureAccess } = await freshModule();
		accessState.body = eligible();
		passState = { status: 401, body: { error: 'unauthorized' } };
		const out = await ensureFeatureAccess('forge.high');
		expect(out).toEqual({ ok: true, pass: null });
	});

	it('not eligible → opens the gate modal and does not throw', async () => {
		const { ensureFeatureAccess } = await freshModule();
		accessState.body = locked('sign_in');
		const p = ensureFeatureAccess('forge.high');
		await vi.waitFor(() => expect(document.querySelector('.tga-overlay')).toBeTruthy(), GATE_WAIT);
		expect(document.querySelector('.tga-title')).toBeTruthy();
		// Cancel via the close button → resolves { ok:false }.
		document.querySelector('[data-act="close"]').click();
		const out = await p;
		expect(out.ok).toBe(false);
		expect(out.reason).toBe('cancelled');
	});

	it('Recheck into eligibility proceeds the original action', async () => {
		const { ensureFeatureAccess } = await freshModule();
		accessState.body = locked('insufficient_tier');
		const p = ensureFeatureAccess('forge.high');
		await vi.waitFor(() => expect(document.querySelector('.tga-overlay')).toBeTruthy(), GATE_WAIT);
		// User acquires $THREE in another tab: the next read is eligible + a pass mints.
		accessState.body = eligible();
		document.querySelector('[data-act="recheck"]').click();
		const out = await p;
		expect(out.ok).toBe(true);
		expect(out.pass).toBe(passState.body.pass);
	});
});

describe('subscribeAccess / refreshAccess / wallet:changed', () => {
	it('notifies subscribers on refreshAccess and stops after unsubscribe', async () => {
		const { subscribeAccess, refreshAccess } = await freshModule();
		const cb = vi.fn();
		const off = subscribeAccess(cb);
		refreshAccess();
		expect(cb).toHaveBeenCalledTimes(1);
		off();
		refreshAccess();
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it('refreshAccess busts the matrix cache', async () => {
		const { fetchAccess, refreshAccess } = await freshModule();
		accessState.body = matrix([eligible().access]);
		await fetchAccess();
		refreshAccess();
		await fetchAccess();
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('a wallet:changed event busts the cache', async () => {
		const { fetchAccess } = await freshModule();
		accessState.body = matrix([eligible().access]);
		await fetchAccess();
		window.dispatchEvent(new CustomEvent('wallet:changed', { detail: { address: null } }));
		await fetchAccess();
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});
});
