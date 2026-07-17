// @vitest-environment jsdom
//
// Header "Connect Wallet" button — the DOM-facing contract of src/wallet.js
// that the app shell (pages/app.html) and pump dashboard both bind. Covers the
// label/address swap, the connected-state class + a11y attributes, the
// icon-preserving [data-wallet-label] path, the plain-text fallback other
// surfaces rely on, the wallet:changed broadcast, and that initWalletButton
// wires a click without a wallet present.

import { describe, it, expect, afterEach, vi } from 'vitest';

// The Seeker/MWA boot (and its @solana/web3.js import) is a no-op off-device;
// stub it so this unit stays light and fast.
vi.mock('../../solana-mobile/src/index.js', () => ({}));

import {
	updateWalletState,
	initWalletButton,
	getConnectedWalletAddress,
} from '../../src/wallet.js';

const ADDR = 'So11111111111111111111111111111111111111112';
const SHORT = `${ADDR.slice(0, 4)}...${ADDR.slice(-4)}`;

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

function mountIconButton() {
	document.body.innerHTML = `
		<button id="connect-wallet-btn" title="Connect your Solana wallet" aria-label="Connect your Solana wallet">
			<svg></svg><span data-wallet-label>Connect Wallet</span>
		</button>`;
	return document.getElementById('connect-wallet-btn');
}

describe('connect-wallet button state', () => {
	it('shows the truncated address and connected affordances on connect', () => {
		const btn = mountIconButton();
		updateWalletState(ADDR);
		expect(btn.querySelector('[data-wallet-label]').textContent).toBe(SHORT);
		expect(btn.querySelector('svg')).toBeTruthy(); // icon survives the swap
		expect(btn.classList.contains('is-connected')).toBe(true);
		expect(btn.dataset.address).toBe(ADDR);
		expect(btn.getAttribute('aria-label')).toContain(ADDR);
		expect(btn.title).toContain(ADDR);
	});

	it('resets to the default prompt on disconnect', () => {
		const btn = mountIconButton();
		updateWalletState(ADDR);
		updateWalletState(null);
		expect(btn.querySelector('[data-wallet-label]').textContent).toBe('Connect Wallet');
		expect(btn.classList.contains('is-connected')).toBe(false);
		expect('address' in btn.dataset).toBe(false);
		expect(btn.getAttribute('aria-label')).toBe('Connect your Solana wallet');
	});

	it('falls back to textContent for plain-text buttons (no label span)', () => {
		document.body.innerHTML = '<button id="connect-wallet-btn">Connect Wallet</button>';
		const btn = document.getElementById('connect-wallet-btn');
		updateWalletState(ADDR);
		expect(btn.textContent).toBe(SHORT);
		expect(btn.classList.contains('is-connected')).toBe(true);
	});

	it('broadcasts wallet:changed with the address on connect and disconnect', () => {
		mountIconButton();
		const seen = [];
		const handler = (e) => seen.push(e.detail.address);
		window.addEventListener('wallet:changed', handler);
		updateWalletState(ADDR);
		updateWalletState(null);
		window.removeEventListener('wallet:changed', handler);
		expect(seen).toEqual([ADDR, null]);
	});

	it('is a no-op (no throw) when the button is absent', () => {
		expect(() => updateWalletState(ADDR)).not.toThrow();
	});

	it('offers an explicit Get-Phantom toast (no surprise tab) when no wallet is injected', () => {
		const btn = mountIconButton();
		const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
		initWalletButton(); // window.solana undefined → no provider, auto-connect skipped
		btn.click();

		// Clicking Connect does NOT hijack the tab...
		expect(openSpy).not.toHaveBeenCalled();
		// ...it surfaces a dismissible toast with a Get Phantom action.
		const toast = document.querySelector('.three-toast');
		expect(toast).toBeTruthy();
		const action = [...toast.querySelectorAll('button')].find((b) => /get phantom/i.test(b.textContent));
		expect(action).toBeTruthy();

		// The user chooses to open Phantom.
		action.click();
		expect(openSpy).toHaveBeenCalledWith('https://phantom.app/', '_blank', 'noopener');
		expect(getConnectedWalletAddress()).toBe(null);
	});

	it('shows a Connecting… busy state during an in-flight connect, then the address', async () => {
		const btn = mountIconButton();
		let resolveConnect;
		window.solana = {
			isPhantom: true,
			isConnected: false,
			on: () => {},
			connect: () => new Promise((r) => { resolveConnect = r; }),
		};
		initWalletButton();
		btn.click();

		// Mid-flight: disabled + busy + "Connecting…".
		expect(btn.disabled).toBe(true);
		expect(btn.getAttribute('aria-busy')).toBe('true');
		expect(btn.querySelector('[data-wallet-label]').textContent).toBe('Connecting…');

		resolveConnect({ publicKey: { toString: () => ADDR } });
		await Promise.resolve();
		await Promise.resolve();

		expect(btn.disabled).toBe(false);
		expect(btn.getAttribute('aria-busy')).toBe(null);
		expect(btn.querySelector('[data-wallet-label]').textContent).toBe(SHORT);
		delete window.solana;
	});
});
