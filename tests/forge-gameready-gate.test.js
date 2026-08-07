// @vitest-environment jsdom
//
// The Game-Ready export panel (src/forge-gameready.js) is $THREE hold-or-pay
// gated, and the proof it carries decides whether a real holder is charged. The
// panel used to mint that proof through the session-only helper, so a visitor
// who had connected a holding wallet without linking it to an account was billed
// the per-export fee their holding already covered. These tests pin the wiring
// that fixes it:
//
//   1. An eligible holder's export carries the x-three-tier-pass header, and the
//      pass is minted interactively (a connected wallet signs) before the request.
//   2. An eligible holder is never shown the pay modal.
//   3. A non-holder is not asked to sign, hits the 402, pays once, and the retry
//      carries the settled payment proof.
//   4. Opening the panel states the viewer's real price: free for a holder, the
//      server-quoted per-export price for everyone else.
//
// three-access / forge-pay are mocked: this suite is about the panel's own gate
// wiring, not the access network or the payment modal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Shared, hoisted so the vi.mock factories below can read it: `eligible` drives
// what the access read reports, and `pass` is the minted proof attachTierPass
// puts on a request (exactly the real module's contract).
const stub = vi.hoisted(() => ({ eligible: false, pass: null }));

vi.mock('../src/three-access.js', () => ({
	getAccess: vi.fn(async () => ({
		signed_in: false,
		wallet_linked: false,
		access: {
			feature: 'forge.gameready',
			label: 'Game-Ready export (Unity/Unreal retopo + PBR)',
			eligible: stub.eligible,
			pay_per_use: { action: 'forge.gameready', usd: 0.1 },
		},
	})),
	getTierPass: vi.fn(async () => {
		stub.pass = stub.eligible ? 'signed.tier.pass' : null;
		return stub.pass;
	}),
	attachTierPass: vi.fn((headers = {}) => {
		if (stub.pass) headers['x-three-tier-pass'] = stub.pass;
		return headers;
	}),
}));

vi.mock('../src/forge-pay.js', () => ({
	payForConsumption: vi.fn(async () => ({ ok: true, paymentId: 'pay_1', refId: 'ref_1' })),
}));

const GLB_URL = 'https://cdn.three.ws/models/knight.glb';

// The three elements src/forge-gameready.js mounts against on /forge.
function mountPage() {
	document.body.innerHTML = `
		<section id="state-result">
			<div id="viewer-shell"><model-viewer id="viewer"></model-viewer></div>
			<button id="forge-gameready-btn" aria-expanded="false"></button>
		</section>`;
}

// The forge POST bodies seen so far, newest last.
function exportPosts() {
	return global.fetch.mock.calls
		.filter(([url, init]) => String(url) === '/api/forge-gameready' && init?.method === 'POST')
		.map(([, init]) => ({ headers: init.headers, body: JSON.parse(init.body) }));
}

// Mount the panel with a live model selected. `serverStatus` decides how the
// first export attempt is answered, so a test can drive the 402 gate.
async function mountWithModel({ gate402 = false } = {}) {
	let attempts = 0;
	global.fetch = vi.fn(async (url, init) => {
		const u = String(url);
		// The panel reads the source GLB to size its poly budget; a non-ok read
		// leaves the default budget, which is all these tests need.
		if (u === GLB_URL) return { ok: false, status: 404, json: async () => ({}) };
		if (u === '/api/forge-gameready' && init?.method === 'POST') {
			attempts += 1;
			const paid = Boolean(JSON.parse(init.body).payment_id);
			if (gate402 && attempts === 1 && !paid) {
				return {
					ok: false,
					status: 402,
					json: async () => ({
						error: 'three_hold_required',
						message: 'Game-Ready export requires holding $THREE.',
						pay_per_use: { action: 'forge.gameready', usd: 0.1 },
					}),
				};
			}
			return { ok: true, status: 200, json: async () => ({ job_id: 'job_1' }) };
		}
		return { ok: true, status: 200, json: async () => ({ status: 'running' }) };
	});

	mountPage();
	await import('../src/forge-gameready.js');
	document.dispatchEvent(new CustomEvent('forge:model-ready', { detail: { glbUrl: GLB_URL, label: 'knight' } }));
	await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
	vi.clearAllMocks();
	stub.eligible = false;
	stub.pass = null;
	// jsdom has no scrollIntoView, and the panel calls it on open.
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
});

describe('Game-Ready export gate', () => {
	it('carries the tier pass for an eligible holder and never opens the pay modal', async () => {
		stub.eligible = true;
		await mountWithModel();
		const { getTierPass } = await import('../src/three-access.js');
		const { payForConsumption } = await import('../src/forge-pay.js');

		document.querySelector('.gr-run').click();
		await vi.advanceTimersByTimeAsync(1);

		const posts = exportPosts();
		expect(posts).toHaveLength(1);
		expect(posts[0].headers['x-three-tier-pass']).toBe('signed.tier.pass');
		// Interactive: a connected wallet with no account signs to prove the holding.
		expect(getTierPass).toHaveBeenCalledWith({ interactive: true });
		expect(payForConsumption).not.toHaveBeenCalled();
	});

	it('never raises a signature prompt for a viewer who could not unlock anything', async () => {
		await mountWithModel();
		const { getTierPass } = await import('../src/three-access.js');

		document.querySelector('.gr-run').click();
		await vi.advanceTimersByTimeAsync(1);

		expect(getTierPass).toHaveBeenCalledWith({ interactive: false });
		expect(exportPosts()[0].headers['x-three-tier-pass']).toBeUndefined();
	});

	it('pays once on the 402 and retries with the settled proof', async () => {
		await mountWithModel({ gate402: true });
		const { payForConsumption } = await import('../src/forge-pay.js');

		document.querySelector('.gr-run').click();
		await vi.advanceTimersByTimeAsync(1);

		expect(payForConsumption).toHaveBeenCalledTimes(1);
		// The price is the server's quote, never a hardcoded client constant.
		expect(payForConsumption.mock.calls[0][0].usd).toBe(0.1);
		const posts = exportPosts();
		expect(posts).toHaveLength(2);
		expect(posts[1].body.payment_id).toBe('pay_1');
		expect(posts[1].body.ref_id).toBe('ref_1');
	});

	it('states the real price in the footnote when the panel opens', async () => {
		await mountWithModel();
		document.getElementById('forge-gameready-btn').click();
		await vi.advanceTimersByTimeAsync(1);
		expect(document.querySelector('.gr-pay-note').textContent).toContain('$0.10 per export');

		// Connecting a holding wallet re-reads the entitlement while the panel is open.
		stub.eligible = true;
		window.dispatchEvent(new CustomEvent('wallet:changed', { detail: { address: 'Wa11et' } }));
		await vi.advanceTimersByTimeAsync(1);
		expect(document.querySelector('.gr-pay-note').textContent).toContain('free for you');
	});
});
