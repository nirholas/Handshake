// Play gate — the wallet sign-in screen that stands in front of /play.
//
// When the platform has pinned a game token, no one reaches the lobby without
// connecting a Solana wallet, signing a server nonce to prove ownership, and
// holding ≥ the required balance of the token. This module owns that screen and
// every state it can be in: checking, wallet-not-installed, ready-to-connect,
// signing, verifying, balance-too-low (with a path to acquire the token), and
// error — each honest and actionable, none a dead end. It resolves only once the
// wallet clears the gate (or immediately, with required:false, when no token is
// pinned and /play is open).

import { fetchPlayConfig, signInToPlay, loadStoredPass, hasWallet, PlayAuthError } from './play-auth.js';

const PHANTOM_INSTALL = 'https://phantom.app/download';

// Monochrome line icons (stroke = currentColor) — the gate's design language is
// strictly greyscale, so no emoji.
const SVG = {
	wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 9h18"/><circle cx="16.5" cy="13" r="1.2"/></svg>',
	key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/><path d="M11.2 11.2 20 20"/><path d="M16.5 16.5 19 14"/></svg>',
	ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z"/><path d="M14 7v10" stroke-dasharray="1.5 2"/></svg>',
	warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>',
};

/**
 * Ensure the player has cleared the token gate before the lobby opens.
 * @returns {Promise<{ required: boolean, wallet?: string, playPass?: string, balance?: number, symbol?: string }>}
 */
export function ensurePlayAccess() {
	return new Gate().run();
}

class Gate {
	constructor() {
		this.root = null;
		this.cfg = null; // { nonce, mint, minBalance, required }
		this._resolve = null;
	}

	run() {
		return new Promise((resolve) => {
			this._resolve = resolve;
			this._start();
		});
	}

	async _start() {
		// Probe the gate. If we can't reach it we don't know whether sign-in is
		// required, so show a retryable error rather than guessing either way.
		this._mount();
		this._render({ state: 'checking' });
		let cfg;
		try {
			cfg = await fetchPlayConfig();
		} catch (err) {
			this._render({ state: 'error', error: err?.message || 'Could not reach sign-in.', retry: () => this._start() });
			return;
		}
		this.cfg = cfg;

		// No token pinned → /play is open. Tear the gate down and let everyone in.
		if (!cfg.required) {
			this._finish({ required: false });
			return;
		}

		// A still-fresh pass from earlier this session skips the wallet prompt.
		const cached = loadStoredPass();
		if (cached && cached.mint === cfg.mint) {
			this._finish({ required: true, wallet: cached.wallet, playPass: cached.playPass, balance: cached.balance, symbol: cached.symbol });
			return;
		}

		this._renderConnect();
	}

	_renderConnect(error = '') {
		if (!hasWallet()) {
			this._render({ state: 'no_wallet' });
			return;
		}
		this._render({ state: 'connect', error });
	}

	async _attempt() {
		// Each attempt gets a fresh nonce — they're short-lived and single-use in
		// spirit, so never reuse one across a retry.
		this._render({ state: 'working', stage: 'connecting' });
		let nonce = this.cfg?.nonce;
		try {
			const cfg = await fetchPlayConfig();
			this.cfg = cfg;
			nonce = cfg.nonce;
		} catch {
			/* fall back to the nonce we already have; verify will reject if stale */
		}

		try {
			const res = await signInToPlay({ nonce, onStage: (stage) => this._render({ state: 'working', stage }) });
			if (res.ok && res.playPass) {
				this._render({ state: 'granted', symbol: res.symbol, balance: res.balance });
				setTimeout(() => {
					this._finish({ required: true, wallet: res.wallet, playPass: res.playPass, balance: res.balance, symbol: res.symbol });
				}, 700);
				return;
			}
			// Verified ownership, but short of the floor.
			this._render({ state: 'low', data: res });
		} catch (err) {
			const code = err instanceof PlayAuthError ? err.code : 'error';
			if (code === 'no_wallet') { this._render({ state: 'no_wallet' }); return; }
			if (code === 'rejected') { this._renderConnect(err.message); return; }
			if (code === 'balance_unavailable') {
				this._render({ state: 'error', error: 'Couldn’t read your on-chain balance right now. Please try again.', retry: () => this._attempt() });
				return;
			}
			// nonce_invalid / bad_signature / verify_failed / anything else.
			this._render({ state: 'error', error: err?.message || 'Sign-in failed. Please try again.', retry: () => this._attempt() });
		}
	}

	// ── DOM ────────────────────────────────────────────────────────────────────

	_mount() {
		if (this.root) return;
		const root = document.createElement('div');
		root.className = 'pg-root';
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'true');
		root.setAttribute('aria-label', 'Sign in to play');
		document.body.appendChild(root);
		this.root = root;
	}

	_finish(result) {
		if (this.root) {
			this.root.classList.add('pg-leaving');
			const el = this.root;
			setTimeout(() => el.remove(), 320);
			this.root = null;
		}
		this._resolve?.(result);
		this._resolve = null;
	}

	_render(view) {
		if (!this.root) return;
		this.root.innerHTML = this._html(view);
		// Wire the freshly-rendered buttons.
		const q = (sel) => this.root.querySelector(sel);
		q('[data-act="connect"]')?.addEventListener('click', () => this._attempt());
		q('[data-act="recheck"]')?.addEventListener('click', () => this._attempt());
		q('[data-act="retry"]')?.addEventListener('click', () => view.retry?.());
		const acquire = q('[data-act="acquire"]');
		if (acquire) acquire.addEventListener('click', () => window.open(acquire.dataset.url, '_blank', 'noopener'));
		// Move focus to the primary action for keyboard users.
		(q('.pg-btn-primary') || q('.pg-btn'))?.focus();
	}

	_html(view) {
		const card = (inner) => `
			<div class="pg-backdrop"></div>
			<div class="pg-card">
				<div class="pg-brand"><img src="/three.svg" alt="" width="30" height="30" /><span>COIN COMMUNITIES</span></div>
				${inner}
			</div>`;

		const min = this.cfg?.minBalance ?? 1;
		const tokenName = (sym) => sym || this.cfg?.symbol || 'the game token';

		switch (view.state) {
			case 'checking':
				return card(`
					<div class="pg-spinner" aria-hidden="true"></div>
					<h1 class="pg-title">Checking access…</h1>
					<p class="pg-sub">One moment while we set up sign-in.</p>`);

			case 'no_wallet':
				return card(`
					<div class="pg-icon" aria-hidden="true">${SVG.wallet}</div>
					<h1 class="pg-title">Connect a Solana wallet</h1>
					<p class="pg-sub">Your wallet is your account here — no email, no password. Install a Solana wallet to sign in and play.</p>
					<a class="pg-btn pg-btn-primary" href="${PHANTOM_INSTALL}" target="_blank" rel="noopener">Get Phantom</a>
					<button class="pg-btn pg-btn-ghost" data-act="retry">I’ve installed one — retry</button>`);

			case 'connect':
				return card(`
					<div class="pg-icon" aria-hidden="true">${SVG.key}</div>
					<h1 class="pg-title">Sign in to play</h1>
					<p class="pg-sub">Connect your Solana wallet and sign a message to prove it’s yours. You’ll need to hold at least <strong>${min} ${tokenName()}</strong> to enter. This never moves your funds.</p>
					${view.error ? `<p class="pg-error" role="alert">${esc(view.error)}</p>` : ''}
					<button class="pg-btn pg-btn-primary" data-act="connect">Connect wallet</button>
					<p class="pg-fine">We’ll never ask for your seed phrase.</p>`);

			case 'working': {
				const label = { connecting: 'Connecting your wallet…', signing: 'Approve the signature in your wallet…', verifying: 'Verifying your balance on-chain…' }[view.stage] || 'Working…';
				return card(`
					<div class="pg-spinner" aria-hidden="true"></div>
					<h1 class="pg-title">${esc(label)}</h1>
					<p class="pg-sub">${view.stage === 'signing' ? 'Check your wallet for a signature request.' : 'This only takes a moment.'}</p>`);
			}

			case 'low': {
				const d = view.data || {};
				const bal = fmt(d.balance ?? 0);
				const need = fmt(d.minBalance ?? min);
				const sym = tokenName(d.symbol);
				return card(`
					<div class="pg-icon" aria-hidden="true">${SVG.ticket}</div>
					<h1 class="pg-title">You need a little more</h1>
					<p class="pg-sub">Entry requires <strong>${need} ${esc(sym)}</strong>. Your wallet holds <strong>${bal} ${esc(sym)}</strong>. Top up, then recheck — no need to sign again.</p>
					<div class="pg-balance">
						<div><span class="pg-balance-k">You hold</span><span class="pg-balance-v">${bal}</span></div>
						<div class="pg-balance-sep">→</div>
						<div><span class="pg-balance-k">Need</span><span class="pg-balance-v pg-balance-need">${need}</span></div>
					</div>
					${d.acquireUrl ? `<button class="pg-btn pg-btn-primary" data-act="acquire" data-url="${esc(d.acquireUrl)}">Get ${esc(sym)}</button>` : ''}
					<button class="pg-btn pg-btn-ghost" data-act="recheck">Recheck balance</button>`);
			}

			case 'granted':
				return card(`
					<div class="pg-check" aria-hidden="true">✓</div>
					<h1 class="pg-title">You’re in</h1>
					<p class="pg-sub">Wallet verified${view.balance != null ? ` — ${fmt(view.balance)} ${esc(tokenName(view.symbol))}` : ''}. Entering the world…</p>`);

			case 'error':
			default:
				return card(`
					<div class="pg-icon" aria-hidden="true">${SVG.warn}</div>
					<h1 class="pg-title">Something went wrong</h1>
					<p class="pg-sub" role="alert">${esc(view.error || 'Please try again.')}</p>
					<button class="pg-btn pg-btn-primary" data-act="retry">Try again</button>`);
		}
	}
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) {
	const v = Number(n) || 0;
	if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
	if (v >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
	return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
