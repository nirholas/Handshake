// @vitest-environment jsdom
//
// DOM-level smoke tests for the drop-in payment modal (public/x402.js). Drives
// the real flow through window.X402.pay() with a stubbed 402 endpoint and a
// faked Phantom provider, asserting the trust + accessibility behavior added for
// the user influx: payee disclosure, trust copy, background inert, focus trap,
// ESC-to-cancel + focus restore, and the dedicated insufficient-funds state.
//
// Fixtures use $THREE (the only coin) as the Solana asset/payTo, per CLAUDE.md.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pay } from '../../public/x402.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const PAYER = 'Payer1111111111111111111111111111111111111';

const solanaAccept = {
	scheme: 'exact',
	network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	amount: '10000', // 0.01 USDC
	asset: THREE_MINT,
	payTo: THREE_MINT,
	maxTimeoutSeconds: 60,
	resource: 'https://three.ws/api/x402/demo',
	extra: { name: 'USDC', decimals: 6, feePayer: THREE_MINT },
};

function stub402(accepts = [solanaAccept]) {
	return {
		status: 402,
		headers: { get: () => null },
		json: async () => ({ accepts }),
		text: async () => '{"error":"payment required"}',
	};
}

// Let queued microtasks + the rAF the modal uses to focus settle.
function flush() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('x402 payment modal — trust + a11y', () => {
	let background;

	beforeEach(() => {
		document.body.innerHTML = '';
		// A pre-existing page element the modal must make inert while open.
		background = document.createElement('button');
		background.id = 'bg-btn';
		background.textContent = 'background';
		document.body.appendChild(background);
		background.focus();

		// Fake Phantom so a Solana accept renders a usable wallet button.
		window.phantom = { solana: { isPhantom: true } };
		global.fetch = vi.fn(async () => stub402());
		global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
		// The real-funds risk acknowledgment gates the pay flow before any
		// signing/balance work. Its module import falls back to confirm() under
		// jsdom; accept it so the flow under test (modal states) is reachable.
		// The gate itself is covered by its own suite.
		vi.stubGlobal('confirm', vi.fn(() => true));
	});

	afterEach(() => {
		delete window.phantom;
		vi.restoreAllMocks();
	});

	it('opens a dialog showing the payee and a trust statement', async () => {
		const p = pay({ endpoint: 'https://three.ws/api/x402/demo', merchant: 'Acme', action: 'Run' });
		p.catch(() => {}); // pending until cancel; swallow the eventual cancel rejection
		await flush();

		const dialog = document.querySelector('.x402-modal[role="dialog"]');
		expect(dialog).toBeTruthy();
		expect(dialog.getAttribute('aria-modal')).toBe('true');

		// Payee disclosure: truncated payTo with an explorer link.
		const payee = document.querySelector('.x402-payee');
		expect(payee?.textContent).toContain('Pays to');
		expect(payee.textContent).toContain(THREE_MINT.slice(0, 6));
		expect(document.querySelector('.x402-payee-addr')?.getAttribute('href')).toContain(THREE_MINT);

		// Trust statement present.
		expect(document.querySelector('.x402-trust')?.textContent || '').toMatch(/your own wallet/i);

		// Live region for screen-reader progress.
		expect(document.querySelector('[data-body]')?.getAttribute('aria-live')).toBe('polite');
	});

	it('makes the rest of the page inert while open and restores it on close', async () => {
		const p = pay({ endpoint: 'https://three.ws/api/x402/demo', merchant: 'Acme', action: 'Run' });
		p.catch(() => {});
		await flush();

		expect(background.hasAttribute('inert')).toBe(true);
		expect(background.getAttribute('aria-hidden')).toBe('true');

		// ESC cancels → promise rejects with code 'cancelled', page is restored.
		document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
		await expect(p).rejects.toMatchObject({ code: 'cancelled' });
		await flush();
		expect(background.hasAttribute('inert')).toBe(false);
		expect(background.getAttribute('aria-hidden')).toBe(null);
		// Focus returns to the element that opened the modal.
		expect(document.activeElement).toBe(background);
	});

	it('lands initial focus on the primary action, not the close button', async () => {
		const p = pay({ endpoint: 'https://three.ws/api/x402/demo', merchant: 'Acme', action: 'Run' });
		p.catch(() => {});
		await flush();

		const active = document.activeElement;
		expect(active?.getAttribute('data-wallet')).toBe('phantom');
		document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
		await p.catch(() => {});
	});

	it('shows a dedicated insufficient-funds state on a positive shortfall', async () => {
		// Phantom connects, but the wallet holds 0 USDC (empty token-accounts read).
		window.phantom.solana.connect = async () => ({ publicKey: { toString: () => PAYER } });
		window.phantom.solana.signTransaction = async () => {
			throw new Error('should not reach signing when underfunded');
		};
		global.fetch = vi.fn(async (url) => {
			// The modal reads the buyer's SPL balance through the same-origin
			// /api/solana-rpc proxy (getTokenAccountsByOwner); an empty value[]
			// means a 0 balance, which must surface the insufficient-funds state.
			if (String(url).includes('solana-rpc')) {
				return { ok: true, json: async () => ({ result: { value: [] } }) }; // 0 balance
			}
			return stub402();
		});

		const p = pay({ endpoint: 'https://three.ws/api/x402/demo', merchant: 'Acme', action: 'Run' });
		p.catch(() => {});
		await flush();
		// Click the Phantom wallet button to start the Solana flow.
		document.querySelector('[data-wallet="phantom"]').click();
		// The connect → balance-read → render chain spans several macrotask ticks
		// (rAF is stubbed to setTimeout); a fixed flush count races it under
		// full-suite CPU load, so poll for the state instead.
		await vi.waitFor(() => {
			expect(document.querySelector('.x402-insuff-title')).toBeTruthy();
		});

		expect(document.querySelector('.x402-insuff-title')?.textContent).toMatch(/not enough/i);
		expect(document.body.textContent).toContain('short by');
		// A retry control exists; nothing was signed.
		expect(document.querySelector('[data-retry]')).toBeTruthy();

		document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
		await p.catch(() => {});
	});
});

// ── Agent-wallet payment method ──────────────────────────────────────────────
// A signed-in user's agents (each with a custodial Solana wallet) appear in the
// picker and settle server-side via POST /api/x402-pay with no wallet popup. These
// tests fake the three session-bound endpoints (?agents=1, /api/csrf-token, the
// SSE settle) and assert the picker, the funded/short gating, and that the
// resolved envelope keeps the browser-path shape ({ ok, result, payment }).

function sseResponse(events) {
	const enc = new TextEncoder();
	const frames = events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join('');
	const chunks = [enc.encode(frames)];
	let i = 0;
	return {
		ok: true,
		status: 200,
		headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
		body: {
			getReader: () => ({
				read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
			}),
		},
	};
}

describe('x402 payment modal: agent wallet method', () => {
	const TX = 'AgentTxSig1111111111111111111111111111111111';
	let agents;
	let payPosts;

	beforeEach(() => {
		document.body.innerHTML = '';
		window.phantom = { solana: { isPhantom: true } };
		global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
		vi.stubGlobal('confirm', vi.fn(() => true));
		agents = [
			{ id: 'agent-1', name: 'Scout', solana_address: PAYER, usdc: 5, sol: 0.01 },
			{ id: 'agent-2', name: 'Broke', solana_address: PAYER, usdc: 0.001, sol: 0 },
		];
		payPosts = [];
		global.fetch = vi.fn(async (url, init = {}) => {
			const u = String(url);
			if (u.includes('/api/x402-pay?agents=1')) {
				return { ok: true, json: async () => ({ agents }) };
			}
			if (u.includes('/api/csrf-token')) {
				return { ok: true, json: async () => ({ data: { token: 'tok-1' } }) };
			}
			if (u.includes('/api/x402-pay') && init.method === 'POST') {
				payPosts.push({ headers: init.headers, body: JSON.parse(init.body) });
				return sseResponse([
					['challenge', { network: solanaAccept.network, amount: solanaAccept.amount, payTo: solanaAccept.payTo, price_usdc: 0.01 }],
					['built', { build_ms: 5 }],
					['settled', { settle_ms: 9, tx: TX, network: solanaAccept.network, payer: PAYER }],
					['result', {
						ok: true,
						result: { granted: true },
						payment: { network: solanaAccept.network, payer: PAYER, payTo: solanaAccept.payTo, asset: solanaAccept.asset, amount: solanaAccept.amount, tx: TX },
					}],
				]);
			}
			return stub402();
		});
	});

	afterEach(() => {
		delete window.phantom;
		vi.restoreAllMocks();
	});

	it('lists funded agents as payment methods and disables short ones', async () => {
		const p = pay({ endpoint: 'https://three.ws/api/x402/demo', merchant: 'Acme', action: 'Run' });
		p.catch(() => {});
		await vi.waitFor(() => {
			expect(document.querySelector('[data-agent-wallet="agent-1"]')).toBeTruthy();
		});

		const funded = document.querySelector('[data-agent-wallet="agent-1"]');
		expect(funded.disabled).toBe(false);
		expect(funded.textContent).toContain('Scout');
		expect(funded.textContent).toContain('5.00 USDC');

		// 0.001 USDC cannot cover the 0.01 USDC price: offered but disabled.
		const broke = document.querySelector('[data-agent-wallet="agent-2"]');
		expect(broke.disabled).toBe(true);
		expect(broke.textContent).toContain('short');

		// Browser wallets stay available alongside, under their group label.
		expect(document.querySelector('[data-wallet="phantom"]')).toBeTruthy();
		expect(document.body.textContent).toContain('Your agents');
		expect(document.body.textContent).toContain('Browser wallets');

		document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
		await p.catch(() => {});
	});

	it('settles server-side from the agent wallet and resolves the browser-path shape', async () => {
		const p = pay({ endpoint: '/api/x402/demo', merchant: 'Acme', action: 'Run' });
		await vi.waitFor(() => {
			expect(document.querySelector('[data-agent-wallet="agent-1"]')).toBeTruthy();
		});
		document.querySelector('[data-agent-wallet="agent-1"]').click();
		await vi.waitFor(() => {
			expect(document.querySelector('.x402-receipt-title')).toBeTruthy();
		});

		// The settle POST carried the owner CSRF token, the agent id, and the
		// ABSOLUTE endpoint URL (the server probes it independently).
		expect(payPosts.length).toBe(1);
		expect(payPosts[0].headers['x-csrf-token']).toBe('tok-1');
		expect(payPosts[0].body.agentId).toBe('agent-1');
		expect(payPosts[0].body.url).toBe(new URL('/api/x402/demo', location.href).href);
		expect(payPosts[0].body.stream).toBe(true);

		// Resolved envelope keeps the exact shape browser-wallet payments return,
		// so the 20+ surfaces calling X402.pay need no changes.
		const out = await p;
		expect(out.ok).toBe(true);
		expect(out.result).toEqual({ granted: true });
		expect(out.payment.transaction).toBe(TX);
		expect(out.payment.payer).toBe(PAYER);
		expect(out.agent).toEqual({ id: 'agent-1', name: 'Scout' });

		// Receipt shows the settled tx.
		expect(document.body.textContent).toContain('Payment confirmed');
	});

	it('offers no agent method when signed out (agents read fails)', async () => {
		global.fetch = vi.fn(async (url) => {
			if (String(url).includes('/api/x402-pay?agents=1')) return { ok: false, status: 401, json: async () => ({ error: 'authentication_required' }) };
			return stub402();
		});
		const p = pay({ endpoint: 'https://three.ws/api/x402/demo', merchant: 'Acme', action: 'Run' });
		p.catch(() => {});
		await vi.waitFor(() => {
			expect(document.querySelector('[data-wallet="phantom"]')).toBeTruthy();
		});
		await flush();
		expect(document.querySelector('[data-agent-wallet]')).toBe(null);
		expect(document.body.textContent).not.toContain('Your agents');

		document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
		await p.catch(() => {});
	});
});
