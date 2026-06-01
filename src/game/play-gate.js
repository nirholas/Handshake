// Play gate — the wallet sign-in screen that stands in front of /play.
//
// States (all honest, none a dead end):
//   no_wallet  — no Solana wallet installed, with a link to Phantom
//   connect    — wallet found, ready to connect + sign
//   working    — connecting / signing / verifying (with stage label)
//   low        — balance verified but below the floor; shows exact gap + buy link
//   granted    — cleared; brief confirmation before the world opens
//   error      — retryable error (network, expired nonce, etc.)
//
// Only mounts a DOM overlay when sign-in is actually needed. When /play is open
// (no token pinned) or a fresh pass is already cached, it resolves instantly with
// no visible interruption.

import { fetchPlayConfig, signInToPlay, loadStoredPass, hasWallet, PlayAuthError } from './play-auth.js';

const PHANTOM_INSTALL = 'https://phantom.app/download';

// Monochrome line icons — the design language is strictly greyscale.
const SVG = {
	wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 9h18"/><circle cx="16.5" cy="13" r="1.2"/></svg>',
	key:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/><path d="M11.2 11.2 20 20"/><path d="M16.5 16.5 19 14"/></svg>',
	ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z"/><path d="M14 7v10" stroke-dasharray="1.5 2"/></svg>',
	warn:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>',
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
		this.cfg = null;
		this._resolve = null;
		this._focusTrap = null;
		this._prevFocus = null;
	}

	run() {
		return new Promise((resolve) => {
			this._resolve = resolve;
			this._start();
		});
	}

	async _start() {
		// Probe the gate before mounting anything — no flash when /play is open or a
		// fresh cached pass exists. Only mount if sign-in is actually required.
		let cfg;
		try {
			cfg = await fetchPlayConfig();
		} catch (err) {
			this._mount();
			this._render({ state: 'error', error: err?.message || 'Could not reach sign-in. Check your connection.', onRetry: () => this._start() });
			return;
		}
		this.cfg = cfg;

		if (!cfg.required) {
			this._finish({ required: false });
			return;
		}

		// A still-fresh cached pass for this exact mint skips the wallet prompt.
		const cached = loadStoredPass();
		if (cached && cached.mint === cfg.mint) {
			this._finish({ required: true, wallet: cached.wallet, playPass: cached.playPass, balance: cached.balance, symbol: cached.symbol });
			return;
		}

		this._mount();
		if (!hasWallet()) {
			this._render({ state: 'no_wallet', onRetry: () => this._checkWalletThenConnect() });
		} else {
			this._render({ state: 'connect', onConnect: () => this._attempt() });
		}
	}

	// Called when the player hits "I've installed one — retry": re-detect and
	// either show connect or the no-wallet screen again.
	_checkWalletThenConnect() {
		if (hasWallet()) {
			this._render({ state: 'connect', onConnect: () => this._attempt() });
		} else {
			this._render({ state: 'no_wallet', onRetry: () => this._checkWalletThenConnect() });
		}
	}

	async _attempt() {
		// Fetch a fresh nonce on each attempt (they're short-lived + single-use).
		this._render({ state: 'working', stage: 'connecting' });
		let nonce = this.cfg?.nonce;
		try {
			const fresh = await fetchPlayConfig();
			this.cfg = fresh;
			nonce = fresh.nonce;
		} catch {
			// Fall back to the nonce we have; verify will reject if stale.
		}

		try {
			const res = await signInToPlay({ nonce, onStage: (stage) => this._render({ state: 'working', stage }) });
			if (res.ok && res.playPass) {
				this._render({ state: 'granted', symbol: res.symbol, balance: res.balance });
				setTimeout(() => this._finish({ required: true, wallet: res.wallet, playPass: res.playPass, balance: res.balance, symbol: res.symbol }), 700);
				return;
			}
			// Signature verified but balance is short.
			this._render({ state: 'low', data: res, onRecheck: () => this._attempt(), onAcquire: res.acquireUrl ? () => window.open(res.acquireUrl, '_blank', 'noopener noreferrer') : null });
		} catch (err) {
			const code = err instanceof PlayAuthError ? err.code : 'error';
			if (code === 'no_wallet') {
				this._render({ state: 'no_wallet', onRetry: () => this._checkWalletThenConnect() });
				return;
			}
			if (code === 'rejected') {
				// Wallet cancelled — drop back to the connect screen with the reason.
				this._render({ state: 'connect', error: err.message, onConnect: () => this._attempt() });
				return;
			}
			this._render({ state: 'error', error: err?.message || 'Sign-in failed. Please try again.', onRetry: () => this._attempt() });
		}
	}

	// ── DOM ──────────────────────────────────────────────────────────────────

	_mount() {
		if (this.root) return;
		this._prevFocus = document.activeElement;
		const root = document.createElement('div');
		root.className = 'pg-root';
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'true');
		root.setAttribute('aria-label', 'Sign in to play');
		// Prevent the background lobby receiving Tab events while the gate is up.
		root.setAttribute('tabindex', '-1');
		document.body.appendChild(root);
		this.root = root;
		this._installFocusTrap();
	}

	_installFocusTrap() {
		const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
		const trap = (e) => {
			if (e.key !== 'Tab' || !this.root) return;
			const els = Array.from(this.root.querySelectorAll(FOCUSABLE));
			if (!els.length) { e.preventDefault(); return; }
			const first = els[0], last = els[els.length - 1];
			if (e.shiftKey) {
				if (document.activeElement === first) { e.preventDefault(); last.focus(); }
			} else {
				if (document.activeElement === last) { e.preventDefault(); first.focus(); }
			}
		};
		document.addEventListener('keydown', trap);
		this._focusTrap = trap;
	}

	_finish(result) {
		if (this._focusTrap) { document.removeEventListener('keydown', this._focusTrap); this._focusTrap = null; }
		if (this.root) {
			this.root.classList.add('pg-leaving');
			const el = this.root;
			setTimeout(() => el.remove(), 320);
			this.root = null;
		}
		// Restore focus to where it was before the gate appeared.
		try { this._prevFocus?.focus?.(); } catch {}
		this._resolve?.(result);
		this._resolve = null;
	}

	_render(view) {
		if (!this.root) return;
		this.root.innerHTML = this._html(view);
		// Wire actions to freshly-rendered elements.
		const q = (sel) => this.root.querySelector(sel);
		q('[data-act="connect"]')?.addEventListener('click', () => view.onConnect?.());
		q('[data-act="retry"]')?.addEventListener('click', () => view.onRetry?.());
		q('[data-act="recheck"]')?.addEventListener('click', () => view.onRecheck?.());
		q('[data-act="acquire"]')?.addEventListener('click', () => view.onAcquire?.());
		// Move keyboard focus onto the primary CTA.
		setTimeout(() => (q('.pg-btn-primary') || q('.pg-btn'))?.focus(), 50);
	}

	_html(view) {
		const card = (inner) => `
			<div class="pg-backdrop"></div>
			<div class="pg-card">
				<div class="pg-brand"><img src="/three.svg" alt="" width="30" height="30"><span>COIN COMMUNITIES</span></div>
				${inner}
			</div>`;

		const min = this.cfg?.minBalance ?? 1;
		const sym = this.cfg?.symbol || '';
		const tokenLabel = sym ? `$${esc(sym)}` : 'the game token';

		switch (view.state) {
			case 'no_wallet':
				return card(`
					<div class="pg-icon">${SVG.wallet}</div>
					<h1 class="pg-title">Install a Solana wallet</h1>
					<p class="pg-sub">Your wallet is your account — no email, no password. Install Phantom, then come back and retry.</p>
					<a class="pg-btn pg-btn-primary" href="${PHANTOM_INSTALL}" target="_blank" rel="noopener noreferrer">Get Phantom</a>
					<button class="pg-btn pg-btn-ghost" data-act="retry">I've installed it — retry</button>`);

			case 'connect':
				return card(`
					<div class="pg-icon">${SVG.key}</div>
					<h1 class="pg-title">Sign in to play</h1>
					<p class="pg-sub">Connect your Solana wallet and approve a signature to prove it's yours. You'll need at least <strong>${esc(String(min))} ${tokenLabel}</strong> to enter. This never moves any funds.</p>
					${view.error ? `<p class="pg-error" role="alert">${esc(view.error)}</p>` : ''}
					<button class="pg-btn pg-btn-primary" data-act="connect">Connect wallet</button>
					<p class="pg-fine">We will never ask for your seed phrase.</p>`);

			case 'working': {
				const labels = { connecting: 'Connecting your wallet…', signing: 'Approve the signature in your wallet…', verifying: 'Checking your token balance on-chain…' };
				const label = labels[view.stage] || 'Working…';
				return card(`
					<div class="pg-spinner" aria-live="polite" aria-label="${esc(label)}"></div>
					<h1 class="pg-title">${esc(label)}</h1>
					<p class="pg-sub">${view.stage === 'signing' ? 'Check your wallet — it is waiting for your approval.' : 'This only takes a moment.'}</p>`);
			}

			case 'low': {
				const d = view.data || {};
				const bal = fmt(d.balance ?? 0);
				const need = fmt(d.minBalance ?? min);
				const displaySym = d.symbol ? `$${esc(d.symbol)}` : tokenLabel;
				return card(`
					<div class="pg-icon">${SVG.ticket}</div>
					<h1 class="pg-title">Not enough ${displaySym}</h1>
					<p class="pg-sub">Entry requires <strong>${need} ${displaySym}</strong>. Your wallet has <strong>${bal} ${displaySym}</strong>. Top up then recheck — no need to sign again.</p>
					<div class="pg-balance" aria-label="Balance comparison">
						<div><span class="pg-balance-k">You have</span><span class="pg-balance-v">${bal}</span></div>
						<div class="pg-balance-sep" aria-hidden="true">→</div>
						<div><span class="pg-balance-k">Required</span><span class="pg-balance-v pg-balance-need">${need}</span></div>
					</div>
					${view.onAcquire ? `<button class="pg-btn pg-btn-primary" data-act="acquire">Get ${displaySym}</button>` : ''}
					<button class="pg-btn ${view.onAcquire ? 'pg-btn-ghost' : 'pg-btn-primary'}" data-act="recheck">Recheck balance</button>`);
			}

			case 'granted':
				return card(`
					<div class="pg-check" aria-label="Access granted">✓</div>
					<h1 class="pg-title">You're in</h1>
					<p class="pg-sub">Wallet verified${view.balance != null ? ` — ${fmt(view.balance)} ${view.symbol ? '$' + esc(view.symbol) : tokenLabel}` : ''}. Entering the world…</p>`);

			case 'error':
			default:
				return card(`
					<div class="pg-icon">${SVG.warn}</div>
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
	if (v >= 1_000_000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
	if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
	if (v >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
	return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
