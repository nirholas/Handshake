// The master wallet page (/wallet) and its API client.
//
// These lock in the properties that make a spend surface safe to ship:
//
//   1. Reads carry no CSRF token; every write carries a fresh one. The four
//      /api/user/wallet routes reject a token-less POST with 403, so a missing
//      header is not a style issue, it is a broken button.
//   2. Reviewing a send NEVER signs. The review step must call the endpoint
//      with `simulate: true`, which is what makes the confirmation numbers real
//      instead of a browser guess, and what guarantees pressing "Review" cannot
//      move money.
//   3. A wallet that has never been provisioned is a SUCCESS, not an error.
//      `{"wallet": null}` has to render the create-wallet invitation. Treating
//      it as a failure is how this feature stayed invisible in the first place.
//   4. The page markup is wired to the module that drives it, with the routing
//      and page-index entries that make it reachable.
//
// The client is tested against a stubbed fetch rather than the network: these
// assert the request contract (method, path, headers, body), which is exactly
// the part that regressed historically. The endpoints themselves are exercised
// against real Solana state by docs/user-wallet.md's curl examples.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const CSRF = 'tok_master_wallet';

/** Stub fetch, recording every call so the request contract can be asserted. */
function stubFetch(handler) {
	const calls = [];
	globalThis.fetch = vi.fn(async (path, init = {}) => {
		calls.push({ path: String(path), init });
		if (String(path).includes('/api/csrf-token')) {
			return new Response(JSON.stringify({ data: { token: CSRF } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		return handler(String(path), init);
	});
	return calls;
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

async function loadClient() {
	// Fresh module per test: src/api.js caches CSRF tokens in module scope.
	vi.resetModules();
	return import('../src/wallet-api.js');
}

describe('master wallet API client', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('reads the wallet without a CSRF token', async () => {
		const calls = stubFetch(() => jsonResponse({ wallet: null }));
		const { fetchWallet } = await loadClient();
		const res = await fetchWallet();

		expect(res.ok).toBe(true);
		expect(res.data).toEqual({ wallet: null });
		const call = calls.find((c) => c.path.endsWith('/api/user/wallet'));
		expect(call).toBeTruthy();
		expect(call.init.method || 'GET').toBe('GET');
		expect(call.init.headers?.['x-csrf-token']).toBeUndefined();
		expect(calls.some((c) => c.path.includes('/api/csrf-token'))).toBe(false);
	});

	it('sends a CSRF token when creating the wallet', async () => {
		const calls = stubFetch(() => jsonResponse({ wallet: { created: true } }, 201));
		const { createWallet } = await loadClient();
		const res = await createWallet();

		expect(res.ok).toBe(true);
		expect(res.status).toBe(201);
		const call = calls.find((c) => c.path.endsWith('/api/user/wallet') && c.init.method === 'POST');
		expect(call.init.headers['x-csrf-token']).toBe(CSRF);
	});

	// The property that makes the confirm step trustworthy: reviewing a transfer
	// must be incapable of moving funds.
	it('previewSend asks the server to simulate, and never omits the flag', async () => {
		const calls = stubFetch(() =>
			jsonResponse({ simulation: { asset: 'SOL', destination: 'Dest111', human_amount: 0.5 } }),
		);
		const { previewSend } = await loadClient();
		const res = await previewSend({ destination: 'Dest111', asset: 'SOL', amount: '0.5' });

		expect(res.ok).toBe(true);
		const call = calls.find((c) => c.path.includes('/api/user/wallet/send'));
		const body = JSON.parse(call.init.body);
		expect(body.simulate).toBe(true);
		expect(body.destination).toBe('Dest111');
		expect(call.init.headers['x-csrf-token']).toBe(CSRF);
	});

	it('send omits the simulate flag so the server broadcasts', async () => {
		const calls = stubFetch(() => jsonResponse({ signature: 'sig123', human_amount: 0.5 }));
		const { send } = await loadClient();
		await send({ destination: 'Dest111', asset: 'SOL', amount: '0.5' });

		const call = calls.find((c) => c.path.includes('/api/user/wallet/send'));
		expect(JSON.parse(call.init.body).simulate).toBeUndefined();
	});

	it('fundAgent posts the agent id the endpoint expects', async () => {
		const calls = stubFetch(() => jsonResponse({ signature: 'sig456' }));
		const { fundAgent } = await loadClient();
		await fundAgent({ agentId: 'agt_1', asset: 'USDC', amount: '5' });

		const call = calls.find((c) => c.path.includes('/api/user/wallet/fund-agent'));
		const body = JSON.parse(call.init.body);
		expect(body.agent_id).toBe('agt_1');
		expect(body.asset).toBe('USDC');
		expect(call.init.headers['x-csrf-token']).toBe(CSRF);
	});

	it('clamps the history limit to what the endpoint accepts', async () => {
		const calls = stubFetch(() => jsonResponse({ history: [] }));
		const { fetchHistory } = await loadClient();
		await fetchHistory(500);
		await fetchHistory(0);

		const limits = calls
			.filter((c) => c.path.includes('/api/user/wallet/history'))
			.map((c) => Number(new URL(c.path, 'https://x').searchParams.get('limit')));
		expect(limits).toEqual([50, 20]);
	});

	// Every failure has to arrive as a value the page can render. A throw here
	// would surface as an unhandled rejection and a blank panel.
	it('turns an API error into a designed result instead of throwing', async () => {
		stubFetch(() =>
			jsonResponse({ error: 'insufficient_balance', error_description: 'too low' }, 400),
		);
		const { previewSend } = await loadClient();
		const res = await previewSend({ destination: 'D', asset: 'SOL', amount: '999' });

		expect(res.ok).toBe(false);
		expect(res.status).toBe(400);
		expect(res.code).toBe('insufficient_balance');
	});

	it('turns a network failure into a designed result instead of throwing', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		vi.resetModules();
		const { fetchWallet } = await import('../src/wallet-api.js');
		const res = await fetchWallet();

		expect(res.ok).toBe(false);
		expect(res.code).toBe('network_error');
	});
});

describe('master wallet page wiring', () => {
	const html = read('pages/wallet.html');
	const controller = read('src/master-wallet.js');

	it('mounts the controller on the root element it renders into', () => {
		expect(html).toContain('id="wlt-root"');
		expect(html).toContain('/src/master-wallet.js');
		expect(controller).toContain("getElementById('wlt-root')");
	});

	it('loads its own stylesheet and the shared shell', () => {
		expect(html).toContain('/master-wallet.css');
		expect(html).toContain('/style.css');
		expect(html).toContain('id="nav-container"');
		expect(html).toContain('id="footer-container"');
	});

	// A custodial wallet page must never be indexed or framed by a third party.
	it('is noindex', () => {
		expect(html).toMatch(/<meta name="robots" content="noindex"/);
	});

	it('renders a create invitation rather than an error when no wallet exists', () => {
		expect(controller).toContain("state.phase = 'empty'");
		expect(controller).toMatch(/do not have a master wallet yet/i);
		expect(controller).toContain("data-act=\"create\"");
	});

	it('designs every state, including signed out and failure', () => {
		for (const phase of ['loading', 'anon', 'empty', 'ready', 'error']) {
			expect(controller).toContain(`${phase}:`);
		}
		expect(controller).toContain('/login?next=');
	});

	// The confirm step is the spend gate. It must show what is being sent, to
	// whom, and on which network, before any broadcast call exists.
	it('requires an explicit confirmation that states amount, recipient and network', () => {
		expect(controller).toContain('Confirm this transfer');
		expect(controller).toContain('Nothing has been signed or sent yet');
		expect(controller).toContain('Solana mainnet');
		expect(controller).toContain("data-act=\"confirm\"");
		expect(controller).toContain("data-act=\"cancel\"");
	});

	it('escapes interpolated values so a chain-supplied string cannot inject markup', () => {
		expect(controller).toMatch(/function esc\(/);
		// Transaction summaries and addresses come from the chain, not from us.
		expect(controller).toContain('esc(t.summary');
		expect(controller).toContain('esc(t.explorer)');
	});

	it('keeps the external-wallet connector separate from the custodial page', () => {
		// src/wallet.js is the Phantom / Seed Vault connector. Importing it here
		// would put a browser wallet in front of a server-custodied one.
		expect(controller).not.toMatch(/from '\.\/wallet\.js'/);
		expect(read('src/wallet.js')).toContain('window.solana');
	});
});

describe('master wallet page is reachable', () => {
	it('is routed and built', () => {
		const vercel = JSON.parse(read('vercel.json'));
		const routed = vercel.routes.filter((r) => r.src === '/wallet' || r.src === '/wallet/');
		expect(routed).toHaveLength(2);
		for (const r of routed) expect(r.dest).toBe('/wallet.html');
		expect(read('vite.config.js')).toContain("wallet: resolve(__dirname, 'pages/wallet.html')");
	});

	it('is declared in the page index so the sitemap and changelog pick it up', () => {
		const pages = JSON.parse(read('data/pages.json'));
		const all = pages.sections.flatMap((s) => s.pages || []);
		const entry = all.find((p) => p.path === '/wallet');
		expect(entry).toBeTruthy();
		expect(entry.title).toBeTruthy();
		expect(entry.description.length).toBeGreaterThan(40);
		expect(entry.added).toBe('2026-07-30');
	});

	it('is linked from the dashboard sidebar so a signed-in user can find it', () => {
		const nav = read('src/dashboard-next/nav.js');
		expect(nav).toContain("path: '/wallet'");
		expect(nav).toMatch(/wallet:\s+'<svg/); // its icon exists
	});

	it('is documented', () => {
		const doc = read('docs/user-wallet.md');
		expect(doc).toContain('three.ws/wallet');
		expect(doc).toContain('src/master-wallet.js');
		expect(read('STRUCTURE.md')).toContain('pages/wallet.html');
	});
});
