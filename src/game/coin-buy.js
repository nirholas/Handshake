// Native pump.fun buy — the in-world "ape this coin" flow for /play.
//
// Every /play world IS a pump.fun coin, so the most natural action in that
// world is buying it. This is a REAL on-chain buy, not a redirect: the
// three.ws server builds the unsigned transaction (handling both the bonding
// curve and the post-graduation AMM via @pump-fun/pump-sdk), the player's
// Solana wallet signs it, and we broadcast through our same-origin RPC proxy.
//
// Loaded as its own lazy chunk (dynamic import on first Buy click) so the heavy
// Solana/pump SDKs never weigh down the main /play bundle. The read-only quote
// SDK and @solana/web3.js are themselves imported on demand inside here, so the
// modal opens instantly and prices in the background.

import { detectSolanaWallet, SOLANA_RPC, solanaTxExplorerUrl } from '../erc8004/solana-deploy.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const NETWORK = 'mainnet';
const SOL_PRESETS = [0.1, 0.5, 1];
const SLIPPAGE_PRESETS = [100, 300, 500]; // bps — 1% / 3% / 5%
const DEFAULT_SLIPPAGE_BPS = 300;
const PUMP_DECIMALS = 6; // pump.fun mints are always 6 decimals

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

const fmtTokens = (raw) => {
	const n = Number(raw) / 10 ** PUMP_DECIMALS;
	if (!isFinite(n) || n <= 0) return null;
	if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

function shortAddr(a) {
	return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '';
}

/**
 * Open the buy modal for a coin. Idempotent — a second call refocuses the
 * existing modal instead of stacking.
 * @param {{mint:string, name?:string, symbol?:string, image?:string}} coin
 */
export function openBuyModal(coin) {
	if (!coin?.mint) return;
	if (_open) { _open.focus(); return; }
	_open = new BuyModal(coin);
}

class BuyModal {
	constructor(coin) {
		this.coin = coin;
		this.sym = coin.symbol ? '$' + coin.symbol.toUpperCase() : 'this coin';
		this.amount = SOL_PRESETS[0];
		this.slippageBps = DEFAULT_SLIPPAGE_BPS;
		this.busy = false;
		this._quoteSeq = 0;
		this._build();
		this._refreshWallet();
		this._quote();
	}

	// --------------------------------------------------------------- view
	_build() {
		this.amountInput = el('input', {
			type: 'number', min: '0', step: '0.05', inputmode: 'decimal',
			class: 'cc-buy-amount', value: String(this.amount), 'aria-label': 'Amount in SOL',
			oninput: () => { this.amount = Math.max(0, Number(this.amountInput.value) || 0); this._syncPresets(); this._quote(); this._syncCta(); },
		});

		this.presetRow = el('div', { class: 'cc-buy-presets' },
			SOL_PRESETS.map((v) => el('button', {
				class: 'cc-buy-preset' + (v === this.amount ? ' cc-on' : ''), text: v + ' SOL', type: 'button',
				onclick: () => { this.amount = v; this.amountInput.value = String(v); this._syncPresets(); this._quote(); this._syncCta(); },
			})));

		this.quoteLine = el('div', { class: 'cc-buy-quote', role: 'status', 'aria-live': 'polite' }, 'Fetching price…');

		this.slipRow = el('div', { class: 'cc-buy-slip' }, [
			el('span', { class: 'cc-buy-slip-label', text: 'Max slippage' }),
			...SLIPPAGE_PRESETS.map((bps) => el('button', {
				class: 'cc-buy-slip-btn' + (bps === this.slippageBps ? ' cc-on' : ''), type: 'button',
				text: (bps / 100) + '%',
				onclick: () => { this.slippageBps = bps; for (const b of this.slipRow.querySelectorAll('.cc-buy-slip-btn')) b.classList.toggle('cc-on', b.textContent === (bps / 100) + '%'); this._quote(); },
			})),
		]);

		this.walletLine = el('div', { class: 'cc-buy-wallet' });

		this.cta = el('button', { class: 'cc-buy-cta', type: 'button', onclick: () => this._onCta() });
		this.ctaLabel = 'buy';

		this.statusLine = el('div', { class: 'cc-buy-status', role: 'status', 'aria-live': 'polite', hidden: true });

		const pumpLink = el('a', {
			class: 'cc-buy-pumplink', href: `https://pump.fun/coin/${this.coin.mint}`,
			target: '_blank', rel: 'noopener noreferrer',
			text: 'Or trade on pump.fun ↗',
		});

		const head = el('div', { class: 'cc-buy-head' }, [
			this.coin.image ? el('img', { class: 'cc-buy-img', src: this.coin.image, alt: '' }) : el('div', { class: 'cc-buy-img cc-buy-img-ph', text: '◎' }),
			el('div', { class: 'cc-buy-titles' }, [
				el('div', { class: 'cc-buy-name', text: this.coin.name || 'Buy coin' }),
				el('div', { class: 'cc-buy-sym', text: this.coin.symbol ? '$' + this.coin.symbol.toUpperCase() : this.coin.mint.slice(0, 8) + '…' }),
			]),
			el('button', { class: 'cc-buy-x', type: 'button', 'aria-label': 'Close', text: '✕', onclick: () => this.close() }),
		]);

		this.card = el('div', { class: 'cc-buy-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Buy ${this.coin.name || 'coin'}` }, [
			head,
			el('label', { class: 'cc-buy-field' }, [
				el('span', { class: 'cc-buy-field-label', text: 'You pay' }),
				el('div', { class: 'cc-buy-amount-wrap' }, [this.amountInput, el('span', { class: 'cc-buy-unit', text: 'SOL' })]),
			]),
			this.presetRow,
			this.quoteLine,
			this.slipRow,
			this.walletLine,
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
		this._syncCta();
		setTimeout(() => this.amountInput.focus(), 30);
	}

	focus() { this.amountInput?.focus(); }

	close() {
		this.overlay.classList.remove('cc-on');
		setTimeout(() => this.overlay.remove(), 180);
		if (_open === this) _open = null;
	}

	_syncPresets() {
		for (const b of this.presetRow.children) b.classList.toggle('cc-on', b.textContent === this.amount + ' SOL');
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

	_syncCta() {
		const w = detectSolanaWallet();
		const connected = !!w?.publicKey;
		if (this.busy) { this.cta.disabled = true; return; }
		if (!w) { this.cta.textContent = 'Get Phantom to buy'; this.ctaLabel = 'install'; this.cta.disabled = false; return; }
		if (!connected) { this.cta.textContent = 'Connect wallet'; this.ctaLabel = 'connect'; this.cta.disabled = false; return; }
		this.ctaLabel = 'buy';
		this.cta.textContent = this.amount > 0 ? `Buy ${this.amount} SOL of ${this.sym}` : 'Enter an amount';
		this.cta.disabled = !(this.amount > 0);
	}

	// --------------------------------------------------------------- quote
	async _quote() {
		if (!(this.amount > 0)) { this.quoteLine.textContent = ''; return; }
		const seq = ++this._quoteSeq;
		this.quoteLine.classList.remove('cc-buy-quote-warn');
		this.quoteLine.textContent = 'Fetching price…';
		const lamports = Math.floor(this.amount * 1e9);
		try {
			const { quoteSwap } = await import('../pump/pump-swap-quote.js');
			const q = await quoteSwap({ inputMint: WSOL, outputMint: this.coin.mint, amountIn: lamports, slippageBps: this.slippageBps });
			if (seq !== this._quoteSeq) return;
			const tokens = fmtTokens(q.amountOut);
			const impact = (q.priceImpactBps / 100);
			this.quoteLine.textContent = '';
			this.quoteLine.append(
				el('span', { class: 'cc-buy-quote-out', text: tokens ? `≈ ${tokens} ${this.coin.symbol ? '$' + this.coin.symbol.toUpperCase() : 'tokens'}` : 'Quoted at market' }),
				el('span', { class: 'cc-buy-quote-impact' + (impact >= 5 ? ' cc-buy-quote-warn' : ''), text: ` · ${impact < 0.01 ? '<0.01' : impact.toFixed(2)}% impact` }),
			);
		} catch (err) {
			if (seq !== this._quoteSeq) return;
			// No AMM pool yet → the coin is still on the bonding curve. The buy still
			// works (the server prices it on-curve); we just can't pre-quote the exact
			// token amount. Say so honestly instead of pretending.
			this.quoteLine.classList.add('cc-buy-quote-warn');
			this.quoteLine.textContent = `Still on the bonding curve — priced at buy. You'll receive ${this.sym} for ${this.amount} SOL.`;
		}
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
			this._setStatus('', '', true);
			return; // let the user review, then click Buy
		}
		this._buy();
	}

	async _buy() {
		if (!(this.amount > 0)) return;
		this.busy = true; this._syncCta();
		const wallet = detectSolanaWallet();
		const walletAddress = wallet.publicKey.toString();
		try {
			this._setStatus('Building your transaction…', '');
			const prep = await this._fetchJson('/api/pump/buy-prep', {
				mint: this.coin.mint, network: NETWORK, sol: this.amount,
				slippage_bps: this.slippageBps, wallet_address: walletAddress,
			});

			this._setStatus('Approve the purchase in your wallet…', '');
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

			const latest = await conn.getLatestBlockhash('confirmed');
			try {
				await conn.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
			} catch { /* landed but slow to confirm — the explorer link is the source of truth */ }

			// Best-effort server tracking; the buy already settled on-chain, so a
			// failure here must never read as a failed purchase.
			this._fetchJson('/api/pump/buy-confirm', {
				mint: this.coin.mint, network: NETWORK, tx_signature: sig,
				wallet_address: walletAddress, sol: this.amount, route: prep.route, slippage_bps: this.slippageBps,
			}).catch(() => {});

			this.cta.textContent = `Bought ${this.sym} ✓`;
			this._setStatusNode(el('span', {}, [`Bought ${this.sym}. `, el('a', { href: url, target: '_blank', rel: 'noopener', text: 'View on Solscan ↗' })]), 'ok');
			this.busy = false;
			this.cta.disabled = true;
			setTimeout(() => this._refreshWallet(), 1500);
		} catch (err) {
			this.busy = false; this._syncCta();
			if (err.status === 401) {
				this._setStatusNode(el('span', {}, [
					'Sign in to three.ws to trade. ',
					el('button', { class: 'cc-buy-link', type: 'button', text: 'Sign in', onclick: () => this._signInAndRetry() }),
				]), 'err');
				return;
			}
			const msg = err.message || 'Purchase failed.';
			// User rejection in the wallet isn't an error worth shouting about.
			const friendly = /reject|denied|cancell?ed|user/i.test(msg) ? 'Cancelled in wallet.' : msg;
			this._setStatus(friendly, 'err');
		}
	}

	async _signInAndRetry() {
		this._setStatus('Opening sign-in…', '');
		try {
			const { signInWithWallet } = await import('../wallet-auth.js');
			await signInWithWallet();
			this._setStatus('Signed in — retrying…', 'ok');
			this._buy();
		} catch (err) {
			this._setStatus(err?.message || 'Sign-in failed.', 'err');
		}
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
		if (path.includes('buy-prep') && !data.tx_base64) throw new Error('server did not return a transaction');
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
