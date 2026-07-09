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
