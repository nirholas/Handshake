// Native pump.fun trade widget — the in-world "ape this coin" flow for /play.
//
// Every /play world IS a pump.fun coin, so the most natural action in that
// world is trading it. This is a REAL on-chain buy/sell, not a redirect: the
// three.ws server builds the unsigned transaction (handling the bonding curve
// and the post-graduation AMM, SOL- and USDC-paired, via @pump-fun/pump-sdk),
// the player's Solana wallet signs it, and we broadcast through our same-origin
// RPC proxy.
//
// Denomination-aware: a coin's quote asset (SOL or USDC) is detected on mount
// from the on-chain bonding curve, and every label, input suffix, balance, and
// quote is driven off it. SOL-paired coins behave exactly as the original
// SOL-only widget; USDC-paired coins denominate the buy input in USDC, show the
// wallet's USDC balance, and price/settle against the USDC curve.
//
// Loaded as its own lazy chunk (dynamic import on first Buy click) so the heavy
// Solana/pump SDKs never weigh down the main /play bundle. The read-only quote
// SDK and @solana/web3.js are themselves imported on demand inside here, so the
// modal opens instantly and prices in the background.

import './coin-buy.css';
import { detectSolanaWallet, SOLANA_RPC, solanaTxExplorerUrl } from '../erc8004/solana-deploy.js';
import { createSafetyPanel } from '../shared/safety-panel.js';
import { createSmartMoneyPanel } from '../shared/smart-money-panel.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT = {
	mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
const NETWORK = 'mainnet';
const SLIPPAGE_PRESETS = [100, 300, 500]; // bps — 1% / 3% / 5%
const DEFAULT_SLIPPAGE_BPS = 300;
const PUMP_DECIMALS = 6; // pump.fun mints are always 6 decimals

// Per-quote-asset denomination descriptors. SOL is the default until the coin's
// pairing is detected, so a SOL coin never flickers and renders exactly as the
// original widget; a USDC coin upgrades in place once detection resolves.
const SOL_DENOM = { kind: 'sol', label: 'SOL', mint: WSOL, decimals: 9, presets: [0.1, 0.5, 1], step: 0.05 };
function usdcDenom(network = NETWORK) {
	return { kind: 'usdc', label: 'USDC', mint: USDC_MINT[network] || USDC_MINT.mainnet, decimals: 6, presets: [5, 25, 100], step: 1 };
}

// Sell uses fractions of the wallet's holdings instead of fixed amounts.
const SELL_PRESETS = [['25%', 0.25], ['50%', 0.5], ['Max', 1]];

let _open = null; // the live modal controller, so a second click reuses it

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) if (kid != null && kid !== false) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	return n;
}

// Base-units (raw, decimals applied) → compact human token count.
const fmtTokens = (raw) => {
	const n = Number(raw) / 10 ** PUMP_DECIMALS;
	if (!isFinite(n) || n <= 0) return null;
	return compactCount(n);
};

// A UI token count (already divided) → compact human string.
function compactCount(n) {
	if (!isFinite(n) || n <= 0) return '0';
	if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// A decimal quote amount → string with asset-appropriate precision.
function fmtQuote(n, denom) {
	const v = Number(n);
	if (!isFinite(v)) return '0';
	const frac = denom.kind === 'usdc' ? (v >= 1 ? 2 : 4) : v >= 1 ? 3 : 5;
	return v.toLocaleString(undefined, { maximumFractionDigits: frac });
}

function shortAddr(a) {
	return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
}

/**
 * Map a trade failure to copy the player can act on. A bare "Trade failed."
 * tells them nothing; each branch points at the actual next step (add SOL,
 * widen slippage, retry, reconnect). User cancellation isn't an error to shout
 * about, so it gets the softest message.
 * @param {Error & {status?: number}} err
 * @param {'buy'|'sell'} [mode]
 */
function friendlyTradeError(err, mode = 'buy') {
	const raw = (err && (err.message || String(err))) || '';
	const m = raw.toLowerCase();
	const noun = mode === 'sell' ? 'this sale' : 'this buy';
	if (/reject|denied|cancell?ed|user declined/.test(m)) return 'Cancelled in wallet.';
	if (/insufficient (lamports|funds)|custom program error: 0x1\b|debit an account/.test(m))
		return `Not enough SOL to cover ${noun} + network fees. Add SOL and try again.`;
	if (/slippage|0x1771|exceeds desired|too little output|price moved/.test(m))
		return 'Price moved beyond your slippage limit. Raise max slippage or try again.';
	if (/blockhash not found|block height exceeded|expired|too old/.test(m))
		return 'The network was busy and the order expired. Try again.';
	if (/failed to fetch|networkerror|load failed|timed out|timeout|fetch failed|did not return a transaction|502|503|504/.test(m))
		return "Couldn't reach the network. Check your connection and try again.";
	return raw.replace(/\s+/g, ' ').trim().slice(0, 140) || `${mode === 'sell' ? 'Sale' : 'Purchase'} failed. Try again.`;
}

/**
 * Open the trade modal for a coin. Idempotent — a second call refocuses the
 * existing modal instead of stacking. Opens in Buy mode; the user can switch to
 * Sell inside the modal.
 * @param {{mint:string, name?:string, symbol?:string, image?:string}} coin
 * @param {{mode?: 'buy'|'sell'}} [opts]
 */
export function openBuyModal(coin, opts = {}) {
	if (!coin?.mint) return;
	if (_open) { _open.focus(); return; }
	_open = new TradeModal(coin, opts.mode === 'sell' ? 'sell' : 'buy');
}

export { openBuyModal as openTradeModal };

class TradeModal {
	constructor(coin, mode = 'buy') {
		this.coin = coin;
		this.symPlain = coin.symbol ? '$' + coin.symbol.toUpperCase() : '';
		this.sym = coin.symbol ? '$' + coin.symbol.toUpperCase() : 'this coin';
		this.symTokens = coin.symbol ? '$' + coin.symbol.toUpperCase() : 'tokens';
		this.mode = mode;
		// Optimistic SOL until detection confirms/upgrades the pairing, so a SOL
		// coin renders identically to the original widget with no flicker.
		this.denom = SOL_DENOM;
		this.amount = mode === 'buy' ? SOL_DENOM.presets[0] : 0;
		this._sellMax = false;
		this.slippageBps = DEFAULT_SLIPPAGE_BPS;
		this.busy = false;
		this._quoteSeq = 0;
		this._balSeq = 0;
		this.quoteBalance = null; // wallet's USDC balance (USDC buys only)
		this.holdings = null;     // wallet's holding of this coin (for sells)
		// null = unknown (first quote pending), true = graduated to the PumpSwap
		// AMM, false = still on the bonding curve. Drives the stage pill so a
		// graduated coin is visually unmistakable from a curve coin.
		this.graduated = null;
		// Platform trade fee (basis points), learned from the quote endpoint. null
		// until the first quote resolves; 0 disables the fee line. Disclosed in the
		// modal so a fee never lands as a surprise.
		this.platformFeeBps = null;
		// Firewall verdict for the current (mint, amount). 'block' disables Buy.
		this.safetyVerdict = null;
		this._safetySeq = 0;
		this._build();
		this._detectP = this._detectDenom();
		this._refreshWallet();
		this._refreshBalances();
		this._quote();
	}

	// --------------------------------------------------------------- view
	_build() {
		this.tabs = el('div', { class: 'cc-buy-tabs', role: 'tablist', 'aria-label': 'Trade direction' }, [
			el('button', { class: 'cc-buy-tab' + (this.mode === 'buy' ? ' cc-on' : ''), type: 'button', role: 'tab', 'aria-selected': this.mode === 'buy', text: 'Buy', onclick: () => this._setMode('buy') }),
			el('button', { class: 'cc-buy-tab' + (this.mode === 'sell' ? ' cc-on' : ''), type: 'button', role: 'tab', 'aria-selected': this.mode === 'sell', text: 'Sell', onclick: () => this._setMode('sell') }),
		]);

		this.fieldLabel = el('span', { class: 'cc-buy-field-label', text: this.mode === 'buy' ? 'You pay' : 'You sell' });
		this.unitEl = el('span', { class: 'cc-buy-unit', text: this.denom.label });
		this.amountInput = el('input', {
			type: 'number', min: '0', step: String(this.denom.step), inputmode: 'decimal',
			class: 'cc-buy-amount', value: this.mode === 'buy' ? String(this.amount) : '',
			'aria-label': this._amountAria(),
			oninput: () => { this._onAmountInput(); },
		});

		this.presetRow = el('div', { class: 'cc-buy-presets' });
		this.balLine = el('div', { class: 'cc-buy-bal', role: 'status', 'aria-live': 'polite', hidden: true });
		this.quoteLine = el('div', { class: 'cc-buy-quote', role: 'status', 'aria-live': 'polite' }, 'Fetching price…');
		// Subtle, always-honest fee disclosure — rate + estimated amount, updated
		// live with the trade size. Hidden only when the platform fee is 0.
		this.feeLine = el('div', { class: 'cc-buy-fee', role: 'note', hidden: true });

		this.slipRow = el('div', { class: 'cc-buy-slip' }, [
			el('span', { class: 'cc-buy-slip-label', text: 'Max slippage' }),
			...SLIPPAGE_PRESETS.map((bps) => el('button', {
				class: 'cc-buy-slip-btn' + (bps === this.slippageBps ? ' cc-on' : ''), type: 'button',
				text: (bps / 100) + '%',
				onclick: () => { this.slippageBps = bps; for (const b of this.slipRow.querySelectorAll('.cc-buy-slip-btn')) b.classList.toggle('cc-on', b.textContent === (bps / 100) + '%'); this._quote(); },
			})),
		]);

		this.walletLine = el('div', { class: 'cc-buy-wallet' });

		// Pre-trade rug/honeypot firewall verdict — rendered right above the CTA on
		// buys. A 'block' disables the Buy button; the user can still review checks.
		this.safety = createSafetyPanel({
			onVerdict: (v) => { this.safetyVerdict = v; this._syncCta(); },
		});
		this.safetyHost = el('div', { class: 'cc-buy-safety-host' });
		this.safetyHost.appendChild(this.safety.el);

		// Who is buying this coin — the smart-money wallet-reputation read. Coin-level
		// intel (independent of buy amount/denomination), shown for any selected coin.
		this.smartMoney = createSmartMoneyPanel();
		this.smartMoneyHost = el('div', { class: 'cc-buy-smartmoney-host' });
		this.smartMoneyHost.appendChild(this.smartMoney.el);

		this.cta = el('button', { class: 'cc-buy-cta', type: 'button', onclick: () => this._onCta() });
		this.ctaLabel = 'buy';

		this.statusLine = el('div', { class: 'cc-buy-status', role: 'status', 'aria-live': 'polite', hidden: true });

		const pumpLink = el('a', {
			class: 'cc-buy-pumplink', href: `https://pump.fun/coin/${this.coin.mint}`,
			target: '_blank', rel: 'noopener noreferrer',
			text: 'Or trade on pump.fun ↗',
		});

		this.stagePill = el('span', { class: 'cc-buy-stage', role: 'status', 'aria-live': 'polite', hidden: true });

		const head = el('div', { class: 'cc-buy-head' }, [
			this.coin.image ? el('img', { class: 'cc-buy-img', src: this.coin.image, alt: '' }) : el('div', { class: 'cc-buy-img cc-buy-img-ph', text: '◎' }),
			el('div', { class: 'cc-buy-titles' }, [
				el('div', { class: 'cc-buy-name', text: this.coin.name || 'Trade coin' }),
				el('div', { class: 'cc-buy-sub' }, [
					el('span', { class: 'cc-buy-sym', text: this.symPlain || this.coin.mint.slice(0, 8) + '…' }),
					this.stagePill,
				]),
			]),
			el('button', { class: 'cc-buy-x', type: 'button', 'aria-label': 'Close', text: '✕', onclick: () => this.close() }),
		]);

		this.card = el('div', { class: 'cc-buy-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Trade ${this.coin.name || 'coin'}` }, [
			head,
			this.tabs,
			el('label', { class: 'cc-buy-field' }, [
				this.fieldLabel,
				el('div', { class: 'cc-buy-amount-wrap' }, [this.amountInput, this.unitEl]),
			]),
			this.presetRow,
			this.balLine,
			this.quoteLine,
			this.feeLine,
			this.slipRow,
			this.walletLine,
			this.smartMoneyHost,
			this.safetyHost,
			this.cta,
			this.statusLine,
			pumpLink,
		]);

		this.overlay = el('div', { class: 'cc-buy-overlay', onpointerdown: (e) => { if (e.target === this.overlay) this.close(); } }, [this.card]);
		// Keep the game from swallowing typing/keys while the modal is up.
		this.card.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') this.close();
			e.stopPropagation();
		});
		document.body.appendChild(this.overlay);
		requestAnimationFrame(() => this.overlay.classList.add('cc-on'));
		this._syncMode();
		this.smartMoney?.loadForMint({ mint: this.coin.mint, network: NETWORK });
		setTimeout(() => this.amountInput.focus(), 30);
	}

	focus() { this.amountInput?.focus(); }

	close() {
		this.overlay.classList.remove('cc-on');
		setTimeout(() => this.overlay.remove(), 180);
		this.safety?.destroy();
		this.smartMoney?.destroy();
		if (_open === this) _open = null;
	}

	_amountAria() {
		return this.mode === 'buy' ? `Amount in ${this.denom.label}` : `Amount of ${this.symTokens} to sell`;
	}

	_onAmountInput() {
		this._sellMax = false;
		this.amount = Math.max(0, Number(this.amountInput.value) || 0);
		this._syncPresets();
		this._renderBalance();
		this._quote();
		this._syncCta();
	}

	// Rebuild presets + labels + balance for the current (mode, denom). Called on
	// mount, on mode switch, and when detection upgrades the pairing to USDC.
	_syncMode() {
		this.fieldLabel.textContent = this.mode === 'buy' ? 'You pay' : 'You sell';
		this.unitEl.textContent = this.mode === 'buy' ? this.denom.label : this.symTokens;
		this.amountInput.setAttribute('aria-label', this._amountAria());
		this.amountInput.step = String(this.mode === 'buy' ? this.denom.step : 1);
		for (const t of this.tabs.children) {
			const on = t.textContent.toLowerCase() === this.mode;
			t.classList.toggle('cc-on', on);
			t.setAttribute('aria-selected', String(on));
		}

		this.presetRow.textContent = '';
		if (this.mode === 'buy') {
			for (const v of this.denom.presets) {
				this.presetRow.appendChild(el('button', {
					class: 'cc-buy-preset' + (v === this.amount ? ' cc-on' : ''), type: 'button',
					text: v + ' ' + this.denom.label,
					onclick: () => { this._sellMax = false; this.amount = v; this.amountInput.value = String(v); this._syncPresets(); this._renderBalance(); this._quote(); this._syncCta(); },
				}));
			}
		} else {
			for (const [label, frac] of SELL_PRESETS) {
				this.presetRow.appendChild(el('button', {
					class: 'cc-buy-preset', type: 'button', text: label,
					onclick: () => this._applySellFraction(label, frac),
				}));
			}
		}
		this._renderBalance();
		this._syncPresets();
	}

	_applySellFraction(label, frac) {
		const hold = this.holdings;
		if (!hold || !(hold.ui > 0)) return;
		this._sellMax = frac >= 1;
		this.amount = this._sellMax ? hold.ui : Math.max(0, hold.ui * frac);
		this.amountInput.value = this._sellMax ? String(hold.ui) : trimNum(this.amount);
		for (const b of this.presetRow.children) b.classList.toggle('cc-on', b.textContent === label);
		this._quote();
		this._syncCta();
	}

	_syncPresets() {
		if (this.mode === 'buy') {
			for (const b of this.presetRow.children) b.classList.toggle('cc-on', b.textContent === this.amount + ' ' + this.denom.label);
		} else if (!this._sellMax) {
			for (const b of this.presetRow.children) b.classList.remove('cc-on');
		}
	}

	// --------------------------------------------------------------- detection
	// Read the coin's quote asset (and graduation status) from the on-chain
	// curve. The buy/sell-prep endpoints auto-detect server-side too — this is
	// purely so the UI denominates correctly before the user enters an amount.
	async _detectDenom() {
		try {
			const r = await fetch(`/api/pump/quote?mint=${encodeURIComponent(this.coin.mint)}&network=${NETWORK}`);
			const data = await r.json().catch(() => ({}));
			if (!r.ok || !data?.quote_mint) return;
			this.graduated = !!data.graduated;
			this._captureFee(data);
			this._renderStage();
			if (data.quote_mint !== WSOL && this.denom.kind !== 'usdc') {
				this.denom = usdcDenom(NETWORK);
				if (this.mode === 'buy') {
					this.amount = this.denom.presets[0];
					this.amountInput.value = String(this.amount);
				}
				this._syncMode();
				this._refreshBalances();
				this._quote();
				this._syncCta();
			}
		} catch { /* keep optimistic SOL — prep still auto-detects server-side */ }
	}

	// --------------------------------------------------------------- wallet
	_refreshWallet() {
		const w = detectSolanaWallet();
		const addr = w?.publicKey?.toString?.();
		if (!w) {
			this.walletLine.textContent = '';
			this.walletLine.append(el('span', { class: 'cc-buy-wallet-off', text: 'No Solana wallet detected' }));
			this._wallet = null;
		} else if (addr) {
			this.walletLine.textContent = '';
			this.walletLine.append(
				el('span', { class: 'cc-buy-wallet-dot' }),
				el('span', { text: `Wallet ${shortAddr(addr)}` }),
			);
			this._wallet = w;
		} else {
			this.walletLine.textContent = '';
			this.walletLine.append(el('span', { text: 'Wallet not connected' }));
			this._wallet = w;
		}
		this._syncCta();
	}

	// Fetch the wallet's USDC balance (USDC buys) and coin holdings (sells). A
	// SOL buy needs neither, so it makes no extra RPC call — keeping that path
	// identical to the original SOL-only widget.
	async _refreshBalances() {
		const needsQuoteBal = this.mode === 'buy' && this.denom.kind === 'usdc';
		const needsHoldings = this.mode === 'sell';
		if (!needsQuoteBal && !needsHoldings) { this.quoteBalance = null; this.holdings = null; this._renderBalance(); return; }
		const w = detectSolanaWallet();
		const owner = w?.publicKey?.toString?.();
		if (!owner) { this.quoteBalance = null; this.holdings = null; this._renderBalance(); this._syncCta(); return; }
		const seq = ++this._balSeq;
		try {
			const { Connection, PublicKey } = await import('@solana/web3.js');
			const conn = new Connection(SOLANA_RPC[NETWORK], 'confirmed');
			const ownerPk = new PublicKey(owner);
			const [coinRes, quoteRes] = await Promise.all([
				needsHoldings ? conn.getParsedTokenAccountsByOwner(ownerPk, { mint: new PublicKey(this.coin.mint) }).catch(() => null) : Promise.resolve(null),
				needsQuoteBal ? conn.getParsedTokenAccountsByOwner(ownerPk, { mint: new PublicKey(this.denom.mint) }).catch(() => null) : Promise.resolve(null),
			]);
			if (seq !== this._balSeq) return;
			this.holdings = needsHoldings ? parseTokenAmount(coinRes) : null;
			this.quoteBalance = needsQuoteBal ? parseTokenAmount(quoteRes) : null;
			this._renderBalance();
			this._syncCta();
		} catch { /* leave balances null; states fall back to neutral */ }
	}

	_renderBalance() {
		this.balLine.textContent = '';
		this.balLine.classList.remove('cc-buy-bal-warn');
		if (this.mode === 'buy' && this.denom.kind === 'usdc') {
			this.balLine.hidden = false;
			if (this.quoteBalance) {
				const low = this.amount > 0 && this.amount > this.quoteBalance.ui + 1e-9;
				this.balLine.classList.toggle('cc-buy-bal-warn', low);
				this.balLine.append(el('span', { text: `Balance ${fmtQuote(this.quoteBalance.ui, this.denom)} USDC` }));
				if (low) this.balLine.append(el('span', { class: 'cc-buy-bal-sep', text: ' · ' }), el('button', { class: 'cc-buy-link', type: 'button', text: 'Add USDC', onclick: () => this._openFund() }));
			} else {
				this.balLine.append(el('span', { text: 'Balance —' }));
			}
		} else if (this.mode === 'sell') {
			this.balLine.hidden = false;
			if (this.holdings) {
				if (this.holdings.ui > 0) {
					const over = this.amount > this.holdings.ui + 1e-9;
					this.balLine.classList.toggle('cc-buy-bal-warn', over);
					this.balLine.append(el('span', { text: `You hold ${compactCount(this.holdings.ui)} ${this.symTokens}` }));
					if (over) this.balLine.append(el('span', { class: 'cc-buy-bal-sep', text: ' · ' }), el('span', { text: `more than you hold` }));
				} else {
					this.balLine.append(el('span', { class: 'cc-buy-wallet-off', text: `You don't hold any ${this.symTokens} yet` }));
				}
			} else {
				this.balLine.append(el('span', { text: 'Holdings —' }));
			}
		} else {
			this.balLine.hidden = true;
		}
	}

	_setMode(mode) {
		if (this.mode === mode) return;
		this.mode = mode;
		this._sellMax = false;
		this.amount = mode === 'buy' ? this.denom.presets[0] : 0;
		this.amountInput.value = mode === 'buy' ? String(this.amount) : '';
		this.quoteLine.textContent = '';
		this.quoteLine.classList.remove('cc-buy-quote-warn');
		this._setStatus('', '', true);
		this._syncMode();
		this._refreshBalances();
		this._quote();
		this._syncCta();
		setTimeout(() => this.amountInput.focus(), 0);
	}

	_syncCta() {
		// createSafetyPanel fires onVerdict(null) synchronously while _build is
		// still assembling the modal — before this.cta exists. Nothing to sync yet;
		// _build calls _syncCta again once the CTA is in place.
		if (!this.cta) return;
		const w = detectSolanaWallet();
		const connected = !!w?.publicKey;
		if (this.busy) { this.cta.disabled = true; return; }
		const verb = this.mode === 'sell' ? 'sell' : 'buy';
		if (!w) { this.cta.textContent = `Get Phantom to ${verb}`; this.ctaLabel = 'install'; this.cta.disabled = false; return; }
		if (!connected) { this.cta.textContent = 'Connect wallet'; this.ctaLabel = 'connect'; this.cta.disabled = false; return; }

		if (this.mode === 'sell') {
			// Holdings are advisory: a read can lag the chain, so a typed sell is
			// never blocked on our balance read — the chain is the source of truth and
			// an over-sell surfaces as an actionable error. We only flag it (below).
			this.ctaLabel = 'sell';
			this.cta.textContent = this.amount > 0 ? `Sell ${compactCount(this.amount)} ${this.symTokens}` : 'Enter an amount';
			this.cta.disabled = !(this.amount > 0);
			return;
		}

		// Buy. Insufficient USDC routes the CTA to the fund flow instead of a dead
		// disabled button.
		if (this.denom.kind === 'usdc' && this.quoteBalance && this.amount > 0 && this.amount > this.quoteBalance.ui + 1e-9) {
			this.cta.textContent = 'Add USDC to buy'; this.ctaLabel = 'fund'; this.cta.disabled = false; return;
		}
		// Hard-stop a buy the firewall blocked (honeypot / unsellable / no venue).
		// The user can still read the verdict above; the action is what's refused.
		if (this.denom.kind === 'sol' && this.safetyVerdict?.verdict === 'block') {
			this.ctaLabel = 'buy';
			this.cta.textContent = 'Blocked — unsafe to buy';
			this.cta.disabled = true;
			return;
		}
		this.ctaLabel = 'buy';
		this.cta.textContent = this.amount > 0 ? `Buy ${this.amount} ${this.denom.label} of ${this.sym}` : 'Enter an amount';
		this.cta.disabled = !(this.amount > 0);
	}

	// Reflect the coin's lifecycle stage (bonding curve vs graduated to the
	// PumpSwap AMM) as a distinct, unmistakable pill next to the symbol.
	_renderStage() {
		const pill = this.stagePill;
		if (!pill) return;
		pill.classList.remove('cc-buy-stage-curve', 'cc-buy-stage-grad');
		if (this.graduated === true) {
			pill.hidden = false;
			pill.classList.add('cc-buy-stage-grad');
			pill.textContent = '🎓 Graduated · PumpSwap AMM';
			pill.title = 'This coin filled its bonding curve and now trades on the PumpSwap AMM.';
		} else if (this.graduated === false) {
			pill.hidden = false;
			pill.classList.add('cc-buy-stage-curve');
			pill.textContent = '📈 On bonding curve';
			pill.title = 'This coin is still on its pump.fun bonding curve and has not graduated yet.';
		} else {
			pill.hidden = true;
			pill.textContent = '';
		}
	}

	// Learn the platform fee rate from any quote-endpoint payload, then refresh
	// the disclosure line. Honest by construction: the rate is whatever the
	// server will actually charge, never a client-side guess.
	_captureFee(data) {
		if (data && typeof data.platform_fee_bps === 'number') {
			this.platformFeeBps = data.platform_fee_bps;
			this._renderFee();
		}
	}

	// The fee disclosure line: "Platform fee 1% · ~0.0100 SOL" on a buy (the fee
	// is added on top of what you pay) and "Platform fee 1% of proceeds" on a
	// sell (taken from what you receive). Hidden when the fee is zero/unknown.
	_renderFee() {
		const line = this.feeLine;
		if (!line) return;
		const bps = this.platformFeeBps;
		if (!bps || bps <= 0) { line.hidden = true; line.textContent = ''; return; }
		const pct = bps / 100;
		const pctStr = (Number.isInteger(pct) ? pct : pct.toFixed(2)) + '%';
		line.hidden = false;
		line.textContent = '';
		line.append(el('span', { class: 'cc-buy-fee-label', text: 'Platform fee' }));
		if (this.mode === 'buy' && this.amount > 0) {
			const fee = this.amount * (bps / 10_000);
			line.append(el('span', { class: 'cc-buy-fee-val', text: ` ${pctStr} · ~${fmtQuote(fee, this.denom)} ${this.denom.label}` }));
		} else if (this.mode === 'sell') {
			line.append(el('span', { class: 'cc-buy-fee-val', text: ` ${pctStr} of proceeds` }));
		} else {
			line.append(el('span', { class: 'cc-buy-fee-val', text: ` ${pctStr}` }));
		}
		line.title = 'A platform fee at pump.fun’s trade-fee rate, included in this transaction alongside the standard Solana network fee.';
	}

	// ----------------------------------------------------------- safety firewall
	// Fetch the pre-trade firewall verdict for the current (mint, SOL amount). Only
	// meaningful for SOL buys (the firewall guards the buy direction on the curve).
	// Hidden for sells and USDC buys, where the SOL round-trip simulation doesn't
	// apply — the panel resets to idle so a stale verdict never gates the CTA.
	_refreshSafety() {
		if (!this.safety) return;
		const isSolBuy = this.mode === 'buy' && this.denom.kind === 'sol';
		this.safetyHost.hidden = !isSolBuy;
		if (!isSolBuy) {
			this.safetyVerdict = null;
			this.safety.setState('idle');
			this._syncCta();
			return;
		}
		if (!(this.amount > 0)) {
			this.safetyVerdict = null;
			this.safety.setState('idle');
			this._syncCta();
			return;
		}
		this.safety.loadForMint({ mint: this.coin.mint, network: NETWORK, amountSol: this.amount });
	}

	// --------------------------------------------------------------- quote
	async _quote() {
		await this._detectP;
		this._renderFee();
		this._refreshSafety();
		// SOL buys keep the original client-side AMM quote (price impact + honest
		// bonding-curve fallback). Everything else (USDC buys, all sells) prices
		// through the server quote endpoint, which handles USDC and both routes.
		if (this.mode === 'buy' && this.denom.kind === 'sol') return this._quoteSolBuy();
		return this._quoteServer();
	}

	async _quoteSolBuy() {
		if (!(this.amount > 0)) { this.quoteLine.textContent = ''; return; }
		const seq = ++this._quoteSeq;
		this.quoteLine.classList.remove('cc-buy-quote-warn');
		this.quoteLine.textContent = 'Fetching price…';
		const lamports = Math.floor(this.amount * 1e9);
		try {
			const { quoteSwap } = await import('../pump/pump-swap-quote.js');
			const q = await quoteSwap({ inputMint: WSOL, outputMint: this.coin.mint, amountIn: lamports, slippageBps: this.slippageBps });
			if (seq !== this._quoteSeq) return;
			// A live AMM quote means the coin graduated off the bonding curve.
			this.graduated = true;
			this._renderStage();
			const tokens = fmtTokens(q.amountOut);
			const impact = (q.priceImpactBps / 100);
			this.quoteLine.textContent = '';
			this.quoteLine.append(
				el('span', { class: 'cc-buy-quote-out', text: tokens ? `≈ ${tokens} ${this.symTokens}` : 'Quoted at market' }),
				el('span', { class: 'cc-buy-quote-impact' + (impact >= 5 ? ' cc-buy-quote-warn' : ''), text: ` · ${impact < 0.01 ? '<0.01' : impact.toFixed(2)}% impact` }),
			);
		} catch (err) {
			if (seq !== this._quoteSeq) return;
			// "Pool unavailable" means there's no AMM pool yet → the coin is still on
			// the bonding curve. Any other error (RPC down, bad mint) leaves the stage
			// unknown rather than wrongly claiming a stage. The buy still works
			// on-curve (the server prices it); we just can't pre-quote the exact
			// token amount. Say so honestly instead of pretending.
			const onCurve = /pool unavailable|account does not exist|could not find/i.test(err?.message || '');
			this.graduated = onCurve ? false : this.graduated;
			this._renderStage();
			this.quoteLine.classList.add('cc-buy-quote-warn');
			this.quoteLine.textContent = `Still on the bonding curve — priced at buy. You'll receive ${this.sym} for ${this.amount} SOL.`;
		}
	}

	async _quoteServer() {
		const seq = ++this._quoteSeq;
		this.quoteLine.classList.remove('cc-buy-quote-warn');

		if (this.mode === 'buy') {
			if (!(this.amount > 0)) { this.quoteLine.textContent = ''; return; }
			this.quoteLine.textContent = 'Fetching price…';
			const u = new URLSearchParams({ mint: this.coin.mint, network: NETWORK, direction: 'buy', usdc: String(this.amount), slippage_bps: String(this.slippageBps) });
			try {
				const data = await fetch(`/api/pump/quote?${u}`).then((r) => r.json());
				if (seq !== this._quoteSeq) return;
				if (typeof data?.graduated === 'boolean') { this.graduated = data.graduated; this._renderStage(); }
				this._captureFee(data);
				const out = data?.quote?.tokens_out;
				this.quoteLine.textContent = '';
				if (out) {
					const tokens = fmtTokens(out);
					this.quoteLine.append(el('span', { class: 'cc-buy-quote-out', text: tokens ? `≈ ${tokens} ${this.symTokens}` : 'Quoted at market' }));
					this.quoteLine.append(el('span', { class: 'cc-buy-quote-impact', text: ` · for ${this.amount} USDC` }));
				} else {
					this.quoteLine.classList.add('cc-buy-quote-warn');
					this.quoteLine.textContent = `Priced at buy — you'll receive ${this.sym} for ${this.amount} USDC.`;
				}
			} catch {
				if (seq !== this._quoteSeq) return;
				this.quoteLine.classList.add('cc-buy-quote-warn');
				this.quoteLine.textContent = `Priced at buy — you'll receive ${this.sym} for ${this.amount} USDC.`;
			}
			return;
		}

		// Sell.
		const tokens = this._sellBaseUnits();
		if (!tokens || tokens === '0') { this.quoteLine.textContent = ''; return; }
		this.quoteLine.textContent = 'Fetching price…';
		const u = new URLSearchParams({ mint: this.coin.mint, network: NETWORK, direction: 'sell', token: tokens, slippage_bps: String(this.slippageBps) });
		try {
			const data = await fetch(`/api/pump/quote?${u}`).then((r) => r.json());
			if (seq !== this._quoteSeq) return;
			if (typeof data?.graduated === 'boolean') { this.graduated = data.graduated; this._renderStage(); }
			this._captureFee(data);
			const q = data?.quote || {};
			const out = this.denom.kind === 'usdc' ? q.usdc_out : q.sol_out;
			this.quoteLine.textContent = '';
			if (out != null) {
				this.quoteLine.append(el('span', { class: 'cc-buy-quote-out', text: `≈ ${fmtQuote(out, this.denom)} ${this.denom.label}` }));
				this.quoteLine.append(el('span', { class: 'cc-buy-quote-impact', text: ` · you receive` }));
			} else {
				this.quoteLine.classList.add('cc-buy-quote-warn');
				this.quoteLine.textContent = `Priced at sale — you'll receive ${this.denom.label}.`;
			}
		} catch {
			if (seq !== this._quoteSeq) return;
			this.quoteLine.classList.add('cc-buy-quote-warn');
			this.quoteLine.textContent = `Priced at sale — you'll receive ${this.denom.label}.`;
		}
	}

	// Exact base-units to sell: the precise on-chain holding for "Max" (so no
	// dust is left behind), otherwise the typed amount clamped to the balance.
	_sellBaseUnits() {
		const hold = this.holdings;
		const haveHoldings = !!hold && hold.ui > 0 && !!hold.base;
		if (this._sellMax && haveHoldings) return hold.base;
		if (!(this.amount > 0)) return '0';
		let want;
		try { want = BigInt(Math.floor(this.amount * 10 ** PUMP_DECIMALS)); } catch { return '0'; }
		if (want <= 0n) return '0';
		// Only clamp against a real, positive holdings read — a 0/failed read is
		// treated as unknown, not as "sell nothing", so the chain can reject it.
		if (haveHoldings) {
			const max = BigInt(hold.base);
			if (want > max) want = max;
		}
		return want.toString();
	}

	// --------------------------------------------------------------- actions
	async _onCta() {
		if (this.busy) return;
		const w = detectSolanaWallet();
		if (!w) { window.open('https://phantom.app/', '_blank', 'noopener'); return; }
		if (!w.publicKey) {
			this._setStatus('Approve the connection in your wallet…', '');
			try { await w.connect(); } catch { this._setStatus('Wallet connection cancelled.', 'err'); return; }
			this._refreshWallet();
			this._refreshBalances();
			this._setStatus('', '', true);
			return; // let the user review, then click again
		}
		if (this.ctaLabel === 'fund') return this._openFund();
		if (this.mode === 'sell') return this._sell();
		this._buy();
	}

	async _openFund() {
		const w = detectSolanaWallet();
		const addr = w?.publicKey?.toString?.();
		if (!addr) return this._onCta();
		try {
			const { showAddFunds } = await import('../shared/add-funds.js');
			const res = await showAddFunds({ walletAddress: addr, requiredUsdc: this.amount });
			if (res) {
				this._setStatus('USDC added — you can buy now.', 'ok');
				await this._refreshBalances();
			}
		} catch (err) {
			this._setStatus(err?.message || 'Could not open the funding flow.', 'err');
		}
	}

	async _buy() {
		await this._detectP;
		if (!(this.amount > 0)) return;
		// Never broadcast a buy the firewall blocked, even if the CTA were somehow
		// reached — the verdict above explains why.
		if (this.denom.kind === 'sol' && this.safetyVerdict?.verdict === 'block') {
			this._setStatus('This coin failed the safety check — buying is blocked.', 'err');
			return;
		}
		const isUsdc = this.denom.kind === 'usdc';
		this.busy = true; this._syncCta();
		const wallet = detectSolanaWallet();
		const walletAddress = wallet.publicKey.toString();
		try {
			this._setStatus('Building your transaction…', '');
			const prepBody = { mint: this.coin.mint, network: NETWORK, slippage_bps: this.slippageBps, wallet_address: walletAddress };
			if (isUsdc) prepBody.usdc_amount = this.amount; else prepBody.sol = this.amount;
			const prep = await this._fetchJson('/api/pump/buy-prep', prepBody);

			this._setStatus(`Approve the purchase in your wallet…${this._feeNote(prep)}`, '');
			const { VersionedTransaction, Connection } = await import('@solana/web3.js');
			const tx = VersionedTransaction.deserialize(
				Uint8Array.from(atob(prep.tx_base64), (c) => c.charCodeAt(0)),
			);
			const signed = await wallet.signTransaction(tx);

			this._setStatus('Submitting on-chain…', '');
			const conn = new Connection(SOLANA_RPC[NETWORK], 'confirmed');
			const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });

			const url = solanaTxExplorerUrl(NETWORK, sig);
			this._setStatusNode(el('span', {}, ['Submitted — ', el('a', { href: url, target: '_blank', rel: 'noopener', text: 'view ↗' }), ' · confirming…']), 'ok');

			await this._confirmOnChain(conn, sig);

			// Best-effort server tracking; the buy already settled on-chain, so a
			// failure here must never read as a failed purchase.
			const confirmBody = { mint: this.coin.mint, network: NETWORK, tx_signature: sig, wallet_address: walletAddress, route: prep.route, slippage_bps: this.slippageBps };
			if (isUsdc) confirmBody.usdc_amount = this.amount; else confirmBody.sol = this.amount;
			this._fetchJson('/api/pump/buy-confirm', confirmBody).catch(() => {});

			this.cta.textContent = `Bought ${this.sym} ✓`;
			this._setStatusNode(el('span', {}, [`Bought ${this.sym}. `, el('a', { href: url, target: '_blank', rel: 'noopener', text: 'View on Solscan ↗' })]), 'ok');
			this.busy = false;
			this.cta.disabled = true;
			setTimeout(() => { this._refreshWallet(); this._refreshBalances(); }, 1500);
		} catch (err) {
			this.busy = false; this._syncCta();
			this._handleTradeError(err, 'buy', () => this._buy());
		}
	}

	async _sell() {
		await this._detectP;
		const tokens = this._sellBaseUnits();
		if (!tokens || tokens === '0') { this._setStatus('Enter an amount to sell.', 'err'); return; }
		this.busy = true; this._syncCta();
		const wallet = detectSolanaWallet();
		const walletAddress = wallet.publicKey.toString();
		try {
			this._setStatus('Building your transaction…', '');
			// sell-prep prepends an idempotent quote-ATA create for USDC sells. We
			// sign and broadcast the FULL returned transaction unchanged — never
			// stripping or re-ordering instructions — so that create lands with the
			// sale atomically.
			const prep = await this._fetchJson('/api/pump/sell-prep', {
				mint: this.coin.mint, network: NETWORK, tokens, slippage_bps: this.slippageBps, wallet_address: walletAddress,
			});

			this._setStatus(`Approve the sale in your wallet…${this._feeNote(prep)}`, '');
			const { VersionedTransaction, Connection } = await import('@solana/web3.js');
			const tx = VersionedTransaction.deserialize(
				Uint8Array.from(atob(prep.tx_base64), (c) => c.charCodeAt(0)),
			);
			const signed = await wallet.signTransaction(tx);

			this._setStatus('Submitting on-chain…', '');
			const conn = new Connection(SOLANA_RPC[NETWORK], 'confirmed');
			const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });

			const url = solanaTxExplorerUrl(NETWORK, sig);
			this._setStatusNode(el('span', {}, ['Submitted — ', el('a', { href: url, target: '_blank', rel: 'noopener', text: 'view ↗' }), ' · confirming…']), 'ok');

			await this._confirmOnChain(conn, sig);

			this._fetchJson('/api/pump/sell-confirm', {
				mint: this.coin.mint, network: NETWORK, tx_signature: sig, wallet_address: walletAddress, tokens, route: prep.route, slippage_bps: this.slippageBps,
			}).catch(() => {});

			this.cta.textContent = `Sold ${this.symTokens} ✓`;
			this._setStatusNode(el('span', {}, [`Sold ${this.symTokens}. `, el('a', { href: url, target: '_blank', rel: 'noopener', text: 'View on Solscan ↗' })]), 'ok');
			this.busy = false;
			this.cta.disabled = true;
			setTimeout(() => { this._refreshWallet(); this._refreshBalances(); }, 1500);
		} catch (err) {
			this.busy = false; this._syncCta();
			this._handleTradeError(err, 'sell', () => this._sell());
		}
	}

	async _confirmOnChain(conn, sig) {
		const latest = await conn.getLatestBlockhash('confirmed');
		try {
			await conn.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
		} catch { /* landed but slow to confirm — the explorer link is the source of truth */ }
	}

	_handleTradeError(err, mode, retry) {
		if (err?.status === 401) {
			this._setStatusNode(el('span', {}, [
				'Sign in to three.ws to trade. ',
				el('button', { class: 'cc-buy-link', type: 'button', text: 'Sign in', onclick: () => this._signInAndRetry(retry) }),
			]), 'err');
			return;
		}
		this._setStatus(friendlyTradeError(err, mode), 'err');
	}

	async _signInAndRetry(retry) {
		this._setStatus('Opening sign-in…', '');
		try {
			const { signInWithWallet } = await import('../wallet-auth.js');
			await signInWithWallet();
			this._setStatus('Signed in — retrying…', 'ok');
			(retry || (() => this._buy()))();
		} catch (err) {
			this._setStatus(err?.message || 'Sign-in failed.', 'err');
		}
	}

	// The exact platform fee for a prepared trade, as a short suffix shown at the
	// approval step so the precise amount is visible before the wallet signs.
	// Empty when no fee applies. fee.amount_ui is the human amount in fee.asset.
	_feeNote(prep) {
		const fee = prep?.platform_fee;
		if (!fee || !fee.amount_ui) return '';
		const pct = fee.bps / 100;
		const pctStr = (Number.isInteger(pct) ? pct : pct.toFixed(2)) + '%';
		const amt = fee.asset === 'USDC' ? fee.amount_ui.toFixed(fee.amount_ui >= 1 ? 2 : 4)
			: Number(fee.amount_ui).toLocaleString(undefined, { maximumFractionDigits: 6 });
		return ` (incl. ${pctStr} platform fee ~${amt} ${fee.asset})`;
	}

	// POST helper that surfaces the HTTP status on the thrown error so callers can
	// branch on 401 (needs sign-in) vs. other failures.
	async _fetchJson(path, body) {
		const res = await fetch(path, {
			method: 'POST', credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			const e = new Error(data.error_description || data.error || `request failed (${res.status})`);
			e.status = res.status;
			throw e;
		}
		if (path.includes('-prep') && !data.tx_base64) throw new Error('server did not return a transaction');
		return data;
	}

	_setStatus(text, kind, hide) {
		this.statusLine.hidden = !!hide || !text;
		this.statusLine.textContent = text || '';
		this.statusLine.setAttribute('data-kind', kind || '');
	}
	_setStatusNode(node, kind) {
		this.statusLine.hidden = false;
		this.statusLine.textContent = '';
		this.statusLine.setAttribute('data-kind', kind || '');
		this.statusLine.appendChild(node);
	}
}

// Pull the token amount out of a getParsedTokenAccountsByOwner response. The
// mint filter can return more than one account (rare), so sum them.
function parseTokenAmount(res) {
	const accts = res?.value || [];
	if (!accts.length) return { ui: 0, base: '0', decimals: PUMP_DECIMALS };
	let base = 0n;
	let decimals = PUMP_DECIMALS;
	for (const a of accts) {
		const ta = a?.account?.data?.parsed?.info?.tokenAmount;
		if (!ta) continue;
		try { base += BigInt(ta.amount || '0'); } catch { /* skip */ }
		if (typeof ta.decimals === 'number') decimals = ta.decimals;
	}
	const ui = Number(base) / 10 ** decimals;
	return { ui, base: base.toString(), decimals };
}

// Render a number with up to 6 fraction digits, no trailing zeros — for echoing
// a chosen sell amount back into the input.
function trimNum(n) {
	if (!isFinite(n)) return '0';
	return String(Number(n.toFixed(6)));
}
