// @vitest-environment jsdom
//
// Unit tests for the connected-wallet wiring in the v1 client helper
// (src/three-access.js). They prove the four contract points added when a Phantom /
// Seeker wallet is connected without a three.ws account:
//   • getAccess() reads the wallet's on-chain tier via ?wallet=, and falls back to
//     the session (no ?wallet=) when none is connected;
//   • getTierPass({ interactive }) mints through the signature path — signing the
//     canonical, server-validated message — only on an interactive call, never in a
//     background prime, and de-dupes concurrent mints onto one signature;
//   • the session path still mints silently (no wallet, no body);
//   • mountTierBadge renders for a connected-wallet holder even when signed_in:false.
//
// src/wallet.js is mocked for the provider (signature path); the connected address is
// read from the nav connect button's data-address mirror, exactly as wallet.js
// publishes it, so loadModule() seeds that from the same state. The live endpoint +
// signature verifier are covered by tests/three-tier-public.test.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mutable, hoisted so the vi.mock factory can read the current identity each call.
const state = vi.hoisted(() => ({ addr: null, provider: null }));

vi.mock('../src/wallet.js', () => ({
	getConnectedWalletAddress: () => state.addr,
	getConnectedWallet: () => state.provider,
}));

const WALLET = 'So11111111111111111111111111111111111111112';

// A pass string shaped like the server's: `<base64url(payload)>.<sig>`, payload.exp
// in unix seconds, far enough out to read as fresh (cached until ~1 min before exp).
function makePass(secondsOut = 600) {
	const exp = Math.floor(Date.now() / 1000) + secondsOut;
	const payload = btoa(JSON.stringify({ exp }))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return `${payload}.signature`;
}

const PASS = makePass();

function jsonRes(body, { ok = true, status = 200 } = {}) {
	return { ok, status, json: async () => body };
}

// Fresh module instance per test so the in-memory caches don't leak across cases.
async function loadModule() {
	vi.resetModules();
	if (state.addr) {
		const btn = document.createElement('button');
		btn.id = 'connect-wallet-btn';
		btn.dataset.address = state.addr;
		document.body.appendChild(btn);
	}
	return import('../src/three-access.js');
}

beforeEach(() => {
	state.addr = null;
	state.provider = null;
	global.fetch = vi.fn();
	document.body.innerHTML = '';
});

describe('getAccess — identity-aware', () => {
	it('appends ?wallet= for a connected wallet (alongside &feature=)', async () => {
		state.addr = WALLET;
		const matrix = { signed_in: false, wallet_linked: true, tier: { level: 1, id: 'bronze', label: 'Bronze', held_usd: 30 } };
		global.fetch = vi.fn(async () => jsonRes(matrix));
		const { getAccess } = await loadModule();

		const data = await getAccess('forge.high');
		const url = String(global.fetch.mock.calls[0][0]);
		expect(url).toContain('feature=forge.high');
		expect(url).toContain(`wallet=${WALLET}`);
		expect(data).toBe(matrix);
	});

	it('omits ?wallet= when no wallet is connected (session fallback)', async () => {
		const matrix = { signed_in: true, wallet_linked: true, tier: { level: 0, id: 'member', label: 'Member', held_usd: 0 } };
		global.fetch = vi.fn(async () => jsonRes(matrix));
		const { getAccess } = await loadModule();

		await getAccess();
		const url = String(global.fetch.mock.calls[0][0]);
		expect(url).not.toContain('wallet=');
	});

	it('re-keys the matrix cache on wallet:changed', async () => {
		const matrix = { signed_in: false, wallet_linked: true, tier: { level: 1, id: 'bronze', label: 'Bronze', held_usd: 30 } };
		global.fetch = vi.fn(async () => jsonRes(matrix));
		const { getAccess } = await loadModule();

		await getAccess(); // session read, cached
		expect(global.fetch).toHaveBeenCalledTimes(1);
		await getAccess(); // served from the 30s cache
		expect(global.fetch).toHaveBeenCalledTimes(1);

		state.addr = WALLET;
		window.dispatchEvent(new CustomEvent('wallet:changed', { detail: { address: WALLET } }));
		await getAccess(); // identity changed → cache invalidated → fresh fetch with ?wallet=
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(String(global.fetch.mock.calls[1][0])).toContain(`wallet=${WALLET}`);
	});
});

describe('getTierPass — signature path for a connected wallet', () => {
	it('mints by signing the canonical message on an interactive call', async () => {
		state.addr = WALLET;
		state.provider = { signMessage: vi.fn(async () => ({ signature: new Uint8Array(64) })) };
		global.fetch = vi.fn(async (url, opts) => {
			expect(String(url)).toContain('/api/three/tier-pass');
			expect(opts.method).toBe('POST');
			const body = JSON.parse(opts.body);
			expect(body.wallet).toBe(WALLET);
			expect(body.message).toContain('three.ws');
			expect(body.message).toContain(`Wallet: ${WALLET}`);
			expect(body.message).toContain('Issued At:');
			expect(typeof body.signature).toBe('string');
			return jsonRes({ pass: PASS, tier: { level: 3, id: 'gold', label: 'Gold' } }, { status: 201 });
		});
		const { getTierPass, tierPassHeader } = await loadModule();

		const pass = await getTierPass({ interactive: true });
		expect(pass.pass).toBe(PASS);
		expect(pass.wallet).toBe(WALLET);
		expect(state.provider.signMessage).toHaveBeenCalledOnce();
		expect(tierPassHeader()).toBe(PASS);
	});

	it('never prompts the wallet on a background (non-interactive) call', async () => {
		state.addr = WALLET;
		state.provider = { signMessage: vi.fn() };
		const { getTierPass } = await loadModule();

		const pass = await getTierPass(); // primeTierPass() path
		expect(pass).toBeNull();
		expect(state.provider.signMessage).not.toHaveBeenCalled();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('de-dupes concurrent interactive mints onto one signature', async () => {
		state.addr = WALLET;
		let resolveSig;
		state.provider = {
			signMessage: vi.fn(() => new Promise((r) => { resolveSig = r; })),
		};
		global.fetch = vi.fn(async () => jsonRes({ pass: PASS, tier: { level: 3, id: 'gold', label: 'Gold' } }, { status: 201 }));
		const { getTierPass } = await loadModule();

		const a = getTierPass({ interactive: true });
		const b = getTierPass({ interactive: true });
		// The provider is reached through the lazily-loaded wallet module, so the
		// signature prompt lands a few microtasks after the calls, not synchronously.
		await vi.waitFor(() => expect(state.provider.signMessage).toHaveBeenCalled());
		resolveSig({ signature: new Uint8Array(64) });
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra).toBe(rb);
		expect(state.provider.signMessage).toHaveBeenCalledOnce();
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps the silent session path for a signed-in user (no wallet, no body)', async () => {
		global.fetch = vi.fn(async (url, opts) => {
			expect(String(url)).toContain('/api/three/tier-pass');
			expect(opts.method).toBe('POST');
			expect(opts.body).toBeUndefined();
			return jsonRes({ pass: PASS, tier: { level: 2, id: 'silver', label: 'Silver' } }, { status: 201 });
		});
		const { getTierPass } = await loadModule();

		const pass = await getTierPass(); // background prime works silently for a session
		expect(pass.pass).toBe(PASS);
		expect(pass.wallet).toBeNull();
	});
});

describe('mountTierBadge — connected-wallet holder', () => {
	it('renders the chip for a connected wallet even when signed_in:false', async () => {
		state.addr = WALLET;
		global.fetch = vi.fn(async () =>
			jsonRes({ signed_in: false, wallet_linked: true, tier: { level: 2, id: 'silver', label: 'Silver', held_usd: 300 } }),
		);
		document.body.innerHTML = '<div id="badge"></div>';
		const { mountTierBadge } = await loadModule();

		await mountTierBadge('#badge');
		const el = document.getElementById('badge');
		expect(el.hidden).toBe(false);
		expect(el.innerHTML).toContain('Silver');
		expect(el.innerHTML).toContain('tg-tier-silver');
	});

	it('hides the chip for a non-holder (Member, level 0)', async () => {
		global.fetch = vi.fn(async () =>
			jsonRes({ signed_in: true, wallet_linked: false, tier: { level: 0, id: 'member', label: 'Member', held_usd: 0 } }),
		);
		document.body.innerHTML = '<div id="badge"></div>';
		const { mountTierBadge } = await loadModule();

		await mountTierBadge('#badge');
		const el = document.getElementById('badge');
		expect(el.hidden).toBe(true);
		expect(el.innerHTML).toBe('');
	});
});
