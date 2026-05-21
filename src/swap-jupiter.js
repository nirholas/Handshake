/**
 * Real Jupiter v6 swap modal.
 *
 * Self-contained: injects its own CSS, builds its own modal DOM on first open,
 * and runs swaps against Jupiter v6 (https://lite-api.jup.ag/swap/v1/) using
 * the connected Phantom wallet on Solana mainnet.
 *
 * Public surface:
 *   openSwapModal({ wallet, getProvider, defaultInputMint?, defaultOutputMint? })
 *
 * - `wallet`        — a @solana/web3.js PublicKey (the connected wallet).
 * - `getProvider()` — must return the Phantom provider (signTransaction/connect).
 * - `defaultInputMint`/`defaultOutputMint` — optional mint addresses (defaults: SOL → USDC).
 */

import {
	Connection,
	PublicKey,
	VersionedTransaction,
} from '@solana/web3.js';

// Solana mint constants used as built-in defaults / quick picks.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Curated quick-pick list. Token picker also accepts any mint via paste.
// Decimals + symbols are baked in so the modal still works if Jupiter's
// /tokens endpoint is rate-limited or offline.
const QUICK_TOKENS = [
	{ symbol: 'SOL',  name: 'Solana',          mint: SOL_MINT,                                            decimals: 9, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
	{ symbol: 'USDC', name: 'USD Coin',        mint: USDC_MINT,                                           decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
	{ symbol: 'USDT', name: 'USDT',            mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',     decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg' },
	{ symbol: 'BONK', name: 'Bonk',            mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',     decimals: 5, logoURI: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I' },
	{ symbol: 'JUP',  name: 'Jupiter',         mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',     decimals: 6, logoURI: 'https://static.jup.ag/jup/icon.png' },
	{ symbol: 'WIF',  name: 'dogwifhat',       mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',     decimals: 6, logoURI: 'https://bafkreibk3covs5ltyqxa272uodhculbr6kea6betidfwy3ajsav2vjzyum.ipfs.nftstorage.link' },
	{ symbol: 'PYTH', name: 'Pyth Network',    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',     decimals: 6, logoURI: 'https://pyth.network/token.svg' },
	{ symbol: 'JTO',  name: 'Jito',            mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',      decimals: 9, logoURI: 'https://metadata.jito.network/token/jto/image' },
];

const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const JUP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP_URL  = 'https://lite-api.jup.ag/swap/v1/swap';
const JUP_PRICE_URL = 'https://lite-api.jup.ag/price/v2';

// Mainnet RPC for swap submission. We route through the same-origin proxy so
// browser-side rate limits don't blow up the flow.
const SWAP_RPC = (typeof window !== 'undefined' ? window.location.origin : 'https://three.ws') + '/api/solana-rpc';

let _ui = null;       // Lazily built DOM root. Created on first open.
let _styleInjected = false;
let _ctx = null;      // Current open call's context: { wallet, getProvider, inputToken, outputToken, ... }
let _quoteSeq = 0;
let _quote = null;    // Last successful quote response from Jupiter.

const STYLE = `
.sj-overlay {
	position: fixed; inset: 0;
	background: rgba(0,0,0,0.7);
	display: flex; align-items: center; justify-content: center;
	z-index: 1100;
}
.sj-overlay.sj-hidden { display: none; }
.sj-modal {
	background: #14181d; color: #e7e9ee;
	border: 1px solid rgba(255,255,255,0.07);
	border-radius: 14px;
	width: 92%; max-width: 460px;
	font-family: 'Inter', system-ui, sans-serif;
	box-shadow: 0 10px 25px rgba(0,0,0,0.4);
}
.sj-modal.sj-picker { max-width: 420px; }
.sj-head {
	display: flex; justify-content: space-between; align-items: center;
	padding: 16px 20px;
	border-bottom: 1px solid rgba(255,255,255,0.07);
}
.sj-head h3 { margin: 0; font-size: 16px; font-weight: 500; }
.sj-net {
	font-size: 11px; color: rgba(231,233,238,0.55);
	font-weight: 400; margin-left: 6px;
}
.sj-close {
	background: none; border: 0;
	font-size: 24px; line-height: 1;
	color: rgba(231,233,238,0.55); cursor: pointer;
}
.sj-close:hover { color: #e7e9ee; }
.sj-body { padding: 20px; }
.sj-foot {
	display: flex; justify-content: flex-end; gap: 10px;
	padding: 14px 20px;
	border-top: 1px solid rgba(255,255,255,0.07);
	background: #111418;
	border-bottom-left-radius: 14px;
	border-bottom-right-radius: 14px;
}

.sj-side {
	background: #111418;
	border: 1px solid rgba(255,255,255,0.07);
	border-radius: 12px;
	padding: 12px 14px;
}
.sj-side + .sj-side { margin-top: 4px; }
.sj-side-head {
	display: flex; justify-content: space-between;
	font-size: 12px; margin-bottom: 8px; color: rgba(231,233,238,0.55);
}
.sj-balance.sj-balance-link {
	cursor: pointer; color: #8b9bff;
}
.sj-balance.sj-balance-link:hover { color: #a7b3ff; }
.sj-row { display: flex; align-items: center; gap: 10px; }
.sj-amount {
	flex: 1; min-width: 0;
	background: transparent; border: 0; outline: none;
	color: #e7e9ee; font-family: inherit;
	font-size: 24px; font-weight: 500; padding: 4px 0;
}
.sj-amount[readonly] { opacity: 0.85; }
.sj-tokenbtn {
	display: inline-flex; align-items: center; gap: 8px;
	background: rgba(255,255,255,0.06);
	border: 1px solid rgba(255,255,255,0.07);
	color: #e7e9ee; padding: 6px 12px;
	border-radius: 999px;
	cursor: pointer;
	font-family: inherit; font-size: 14px; font-weight: 500;
	white-space: nowrap;
}
.sj-tokenbtn:hover { background: rgba(255,255,255,0.10); }
.sj-tokenbtn img {
	width: 18px; height: 18px; border-radius: 50%;
	background: rgba(255,255,255,0.05);
}
.sj-tokenbtn .sj-caret { font-size: 10px; opacity: 0.7; }
.sj-flip {
	display: block; margin: 4px auto;
	width: 32px; height: 32px; border-radius: 50%;
	border: 1px solid rgba(255,255,255,0.07);
	background: #14181d; color: rgba(231,233,238,0.55);
	cursor: pointer; font-size: 16px; line-height: 1;
}
.sj-flip:hover { color: #e7e9ee; background: #111418; }

.sj-meta { margin-top: 12px; font-size: 12px; color: rgba(231,233,238,0.55); min-height: 18px; }
.sj-meta-row { display: flex; justify-content: space-between; padding: 2px 0; }
.sj-warn { color: #f59e0b; }

.sj-controls {
	display: flex; align-items: center; gap: 8px;
	margin-top: 14px; font-size: 12px;
}
.sj-input {
	background: #111418;
	border: 1px solid rgba(255,255,255,0.07);
	color: #e7e9ee;
	border-radius: 8px;
	padding: 8px 10px;
	font-family: inherit;
	font-size: 13px;
}
.sj-input:focus { outline: none; border-color: rgba(255,255,255,0.12); }
.sj-slippage { width: 90px; }

.sj-status { margin-top: 12px; font-size: 12px; min-height: 16px; }
.sj-status.sj-err { color: #ef4444; }
.sj-status.sj-ok { color: #10b981; }
.sj-status a { color: inherit; text-decoration: underline; }

.sj-btn {
	background: #111418; color: #e7e9ee;
	border: 1px solid rgba(255,255,255,0.07);
	border-radius: 8px;
	padding: 8px 16px;
	font-family: inherit; font-size: 13px;
	cursor: pointer;
}
.sj-btn:hover { border-color: rgba(255,255,255,0.12); }
.sj-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.sj-btn.sj-primary { background: #fff; color: #000; border-color: #fff; }
.sj-btn.sj-primary:hover { background: #f0f0f0; }
.sj-btn.sj-primary:disabled { background: rgba(255,255,255,0.5); color: rgba(0,0,0,0.4); }

.sj-picker .sj-body { padding: 16px 20px; }
.sj-search {
	width: 100%;
}
.sj-list {
	margin-top: 12px;
	max-height: 320px; overflow-y: auto;
	border-top: 1px solid rgba(255,255,255,0.07);
}
.sj-list-row {
	display: flex; align-items: center; gap: 10px;
	padding: 10px 4px;
	border-bottom: 1px solid rgba(255,255,255,0.07);
	cursor: pointer;
}
.sj-list-row:hover { background: #111418; }
.sj-list-row img {
	width: 28px; height: 28px; border-radius: 50%;
	background: #111418;
}
.sj-list-row .sj-list-main { flex: 1; min-width: 0; }
.sj-list-row .sj-list-sym { font-weight: 600; font-size: 14px; }
.sj-list-row .sj-list-name {
	font-size: 12px; color: rgba(231,233,238,0.55);
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sj-list-row .sj-list-mint {
	font-family: ui-monospace, monospace;
	font-size: 10px; color: rgba(231,233,238,0.55); opacity: 0.6;
}
.sj-empty {
	padding: 24px 8px; text-align: center;
	color: rgba(231,233,238,0.55); font-size: 13px;
}
`;

function injectStyle() {
	if (_styleInjected) return;
	const s = document.createElement('style');
	s.dataset.swapJupiter = '1';
	s.textContent = STYLE;
	document.head.appendChild(s);
	_styleInjected = true;
}

function el(tag, attrs = {}, ...kids) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const k of kids.flat()) {
		if (k == null) continue;
		node.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
	}
	return node;
}

function buildUI() {
	injectStyle();

	// Swap modal
	const swapOverlay = el('div', { class: 'sj-overlay sj-hidden', id: 'sj-swap-overlay' });
	const swapModal = el('div', { class: 'sj-modal' });

	const head = el('div', { class: 'sj-head' },
		el('h3', {}, 'Swap tokens', el('span', { class: 'sj-net', text: ' · Jupiter · Solana mainnet' })),
		el('button', { class: 'sj-close', type: 'button', 'aria-label': 'Close', onclick: closeSwap }, '×'),
	);

	const fromSide = el('div', { class: 'sj-side' },
		el('div', { class: 'sj-side-head' },
			el('span', { text: 'From' }),
			el('span', { class: 'sj-balance', id: 'sj-from-balance' }),
		),
		el('div', { class: 'sj-row' },
			el('input', { type: 'number', id: 'sj-from-amount', class: 'sj-amount', placeholder: '0.0', inputmode: 'decimal', autocomplete: 'off' }),
			el('button', { type: 'button', class: 'sj-tokenbtn', id: 'sj-from-token', onclick: () => openPicker('from') },
				el('img', { id: 'sj-from-logo', alt: '' }),
				el('span', { id: 'sj-from-sym' }),
				el('span', { class: 'sj-caret', text: '▾' }),
			),
		),
	);

	const flip = el('button', { type: 'button', class: 'sj-flip', 'aria-label': 'Flip direction', onclick: flipSides }, '↕');

	const toSide = el('div', { class: 'sj-side' },
		el('div', { class: 'sj-side-head' },
			el('span', { text: 'To (estimated)' }),
		),
		el('div', { class: 'sj-row' },
			el('input', { type: 'text', id: 'sj-to-amount', class: 'sj-amount', placeholder: '0.0', readonly: 'readonly', tabindex: '-1' }),
			el('button', { type: 'button', class: 'sj-tokenbtn', id: 'sj-to-token', onclick: () => openPicker('to') },
				el('img', { id: 'sj-to-logo', alt: '' }),
				el('span', { id: 'sj-to-sym' }),
				el('span', { class: 'sj-caret', text: '▾' }),
			),
		),
	);

	const meta = el('div', { class: 'sj-meta', id: 'sj-meta', 'aria-live': 'polite' });

	const controls = el('div', { class: 'sj-controls' },
		el('label', { for: 'sj-slippage', text: 'Slippage (bps)' }),
		el('input', { type: 'number', id: 'sj-slippage', class: 'sj-input sj-slippage', value: '50', min: '1', max: '1000', step: '1' }),
		el('span', { id: 'sj-slippage-pct', text: '0.50%' }),
	);

	const status = el('div', { class: 'sj-status', id: 'sj-status', 'aria-live': 'polite' });

	const body = el('div', { class: 'sj-body' }, fromSide, flip, toSide, meta, controls, status);

	const foot = el('div', { class: 'sj-foot' },
		el('button', { type: 'button', class: 'sj-btn', onclick: closeSwap }, 'Cancel'),
		el('button', { type: 'button', class: 'sj-btn sj-primary', id: 'sj-confirm', disabled: 'disabled', onclick: executeSwap }, 'Get quote'),
	);

	swapModal.append(head, body, foot);
	swapOverlay.appendChild(swapModal);
	swapOverlay.addEventListener('click', (e) => { if (e.target === swapOverlay) closeSwap(); });

	// Token picker modal
	const pickerOverlay = el('div', { class: 'sj-overlay sj-hidden', id: 'sj-picker-overlay' });
	const pickerModal = el('div', { class: 'sj-modal sj-picker' });
	const pickerHead = el('div', { class: 'sj-head' },
		el('h3', { text: 'Select a token' }),
		el('button', { class: 'sj-close', type: 'button', 'aria-label': 'Close', onclick: closePicker }, '×'),
	);
	const pickerBody = el('div', { class: 'sj-body' },
		el('input', { type: 'text', class: 'sj-input sj-search', id: 'sj-search', placeholder: 'Search name, symbol, or paste mint address', autocomplete: 'off' }),
		el('div', { class: 'sj-list', id: 'sj-list', role: 'listbox' }),
	);
	pickerModal.append(pickerHead, pickerBody);
	pickerOverlay.appendChild(pickerModal);
	pickerOverlay.addEventListener('click', (e) => { if (e.target === pickerOverlay) closePicker(); });

	document.body.append(swapOverlay, pickerOverlay);

	// Wire input listeners
	document.getElementById('sj-from-amount').addEventListener('input', onAmountInput);
	document.getElementById('sj-slippage').addEventListener('input', onSlippageInput);
	document.getElementById('sj-search').addEventListener('input', renderTokenList);

	return { swapOverlay, pickerOverlay };
}

function ensureUI() {
	if (!_ui) _ui = buildUI();
	return _ui;
}

function $(id) { return document.getElementById(id); }

function setTokenUI(side, token) {
	$(`sj-${side}-sym`).textContent = token.symbol;
	const logo = $(`sj-${side}-logo`);
	if (token.logoURI) {
		logo.src = token.logoURI;
		logo.style.display = '';
		logo.onerror = () => { logo.style.display = 'none'; };
	} else {
		logo.style.display = 'none';
	}
}

function fmtAmount(raw, decimals) {
	const big = BigInt(raw);
	const divisor = 10n ** BigInt(decimals);
	const whole = big / divisor;
	const fracBig = big % divisor;
	if (fracBig === 0n) return whole.toString();
	const frac = fracBig.toString().padStart(decimals, '0').replace(/0+$/, '');
	return `${whole.toString()}.${frac}`;
}

function toBaseUnits(amount, decimals) {
	if (!amount) return null;
	const [whole, fracRaw = ''] = String(amount).trim().split('.');
	if (!/^\d*$/.test(whole) || !/^\d*$/.test(fracRaw)) return null;
	const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
	const merged = `${whole || '0'}${frac}`.replace(/^0+/, '') || '0';
	try { return BigInt(merged).toString(); } catch { return null; }
}

function setStatus(text, cls = '') {
	const node = $('sj-status');
	node.className = `sj-status ${cls}`;
	if (typeof text === 'string') node.textContent = text;
	else { node.textContent = ''; node.append(text); }
}

function onSlippageInput() {
	const bps = Number($('sj-slippage').value);
	if (Number.isFinite(bps)) {
		$('sj-slippage-pct').textContent = `${(bps / 100).toFixed(2)}%`;
		debouncedQuote();
	}
}

let _quoteTimer = null;
function debouncedQuote() {
	if (_quoteTimer) clearTimeout(_quoteTimer);
	_quoteTimer = setTimeout(fetchQuote, 350);
}

function onAmountInput() {
	const v = $('sj-from-amount').value;
	if (!v || Number(v) <= 0) {
		$('sj-to-amount').value = '';
		$('sj-meta').textContent = '';
		_quote = null;
		updateConfirmButton();
		return;
	}
	debouncedQuote();
}

async function fetchQuote() {
	if (!_ctx) return;
	const amountStr = $('sj-from-amount').value;
	const baseUnits = toBaseUnits(amountStr, _ctx.inputToken.decimals);
	if (!baseUnits || baseUnits === '0') return;

	const seq = ++_quoteSeq;
	const slippageBps = Math.max(1, Math.min(1000, Number($('sj-slippage').value) || 50));
	const params = new URLSearchParams({
		inputMint: _ctx.inputToken.mint,
		outputMint: _ctx.outputToken.mint,
		amount: baseUnits,
		slippageBps: String(slippageBps),
		restrictIntermediateTokens: 'true',
	});

	setStatus('Fetching best route…');
	$('sj-confirm').disabled = true;
	$('sj-confirm').textContent = 'Quoting…';

	try {
		const resp = await fetch(`${JUP_QUOTE_URL}?${params}`);
		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`Jupiter quote ${resp.status}: ${text.slice(0, 200)}`);
		}
		const quote = await resp.json();
		if (seq !== _quoteSeq) return; // Stale response.
		_quote = quote;

		$('sj-to-amount').value = fmtAmount(quote.outAmount, _ctx.outputToken.decimals);
		renderQuoteMeta(quote);
		setStatus('');
		updateConfirmButton();
	} catch (err) {
		if (seq !== _quoteSeq) return;
		console.error('[swap-jupiter] quote failed', err);
		_quote = null;
		$('sj-to-amount').value = '';
		setStatus(`Quote failed: ${err.message}`, 'sj-err');
		updateConfirmButton();
	}
}

function renderQuoteMeta(quote) {
	const meta = $('sj-meta');
	meta.innerHTML = '';

	const priceIn = Number(fmtAmount(quote.inAmount,  _ctx.inputToken.decimals));
	const priceOut = Number(fmtAmount(quote.outAmount, _ctx.outputToken.decimals));
	if (priceIn > 0) {
		meta.append(el('div', { class: 'sj-meta-row' },
			el('span', { text: 'Rate' }),
			el('span', { text: `1 ${_ctx.inputToken.symbol} ≈ ${(priceOut / priceIn).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${_ctx.outputToken.symbol}` }),
		));
	}

	const minOut = quote.otherAmountThreshold
		? fmtAmount(quote.otherAmountThreshold, _ctx.outputToken.decimals)
		: priceOut.toString();
	meta.append(el('div', { class: 'sj-meta-row' },
		el('span', { text: 'Min received' }),
		el('span', { text: `${Number(minOut).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${_ctx.outputToken.symbol}` }),
	));

	const impactPct = Number(quote.priceImpactPct || 0) * 100;
	if (impactPct) {
		const warn = impactPct >= 1 ? 'sj-warn' : '';
		meta.append(el('div', { class: `sj-meta-row ${warn}` },
			el('span', { text: 'Price impact' }),
			el('span', { text: `${impactPct.toFixed(2)}%` }),
		));
	}

	const route = (quote.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean);
	if (route.length) {
		meta.append(el('div', { class: 'sj-meta-row' },
			el('span', { text: 'Route' }),
			el('span', { text: route.slice(0, 4).join(' → ') + (route.length > 4 ? ` (+${route.length - 4})` : '') }),
		));
	}
}

function updateConfirmButton() {
	const btn = $('sj-confirm');
	if (!_ctx) { btn.disabled = true; return; }
	const amount = Number($('sj-from-amount').value);
	if (!_quote || !amount || amount <= 0) {
		btn.disabled = !amount || amount <= 0 ? true : false;
		btn.textContent = (amount && amount > 0) ? 'Get quote' : 'Enter amount';
		btn.disabled = !(_quote && amount > 0);
		return;
	}
	btn.disabled = false;
	btn.textContent = `Swap ${_ctx.inputToken.symbol} → ${_ctx.outputToken.symbol}`;
}

function flipSides() {
	if (!_ctx) return;
	const a = _ctx.inputToken;
	_ctx.inputToken = _ctx.outputToken;
	_ctx.outputToken = a;
	setTokenUI('from', _ctx.inputToken);
	setTokenUI('to',   _ctx.outputToken);
	$('sj-from-amount').value = $('sj-to-amount').value || '';
	$('sj-to-amount').value = '';
	_quote = null;
	$('sj-meta').textContent = '';
	refreshBalance();
	if (Number($('sj-from-amount').value) > 0) debouncedQuote();
	updateConfirmButton();
}

async function refreshBalance() {
	if (!_ctx?.wallet) return;
	const target = $('sj-from-balance');
	target.textContent = '';
	target.classList.remove('sj-balance-link');
	try {
		const connection = new Connection(SWAP_RPC, 'confirmed');
		let bal = null;
		if (_ctx.inputToken.mint === SOL_MINT) {
			const lamports = await connection.getBalance(new PublicKey(_ctx.wallet));
			bal = lamports / 1e9;
		} else {
			const owner = new PublicKey(_ctx.wallet);
			const mint = new PublicKey(_ctx.inputToken.mint);
			const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint });
			let total = 0;
			for (const acc of resp.value) {
				const ui = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
				if (typeof ui === 'number') total += ui;
			}
			bal = total;
		}
		if (bal == null) return;
		target.textContent = `Balance: ${bal.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${_ctx.inputToken.symbol}`;
		target.classList.add('sj-balance-link');
		target.onclick = () => {
			// Leave a small buffer for SOL gas.
			const usable = _ctx.inputToken.mint === SOL_MINT ? Math.max(0, bal - 0.01) : bal;
			$('sj-from-amount').value = String(usable);
			onAmountInput();
		};
	} catch (err) {
		console.warn('[swap-jupiter] balance fetch failed', err);
	}
}

// ── Token picker ───────────────────────────────────────────────────────────

let _pickerSide = 'from';
let _remoteTokens = []; // Lazily fetched from Jupiter strict list.

function openPicker(side) {
	_pickerSide = side;
	$('sj-search').value = '';
	renderTokenList();
	_ui.pickerOverlay.classList.remove('sj-hidden');
	setTimeout(() => $('sj-search').focus(), 0);
	loadRemoteTokens();
}

function closePicker() {
	_ui.pickerOverlay.classList.add('sj-hidden');
}

async function loadRemoteTokens() {
	if (_remoteTokens.length) return;
	try {
		const resp = await fetch('https://lite-api.jup.ag/tokens/v1/tagged/verified', { mode: 'cors' });
		if (!resp.ok) return;
		const data = await resp.json();
		if (Array.isArray(data)) {
			_remoteTokens = data
				.filter((t) => t.address && t.symbol && t.decimals != null)
				.map((t) => ({
					symbol: t.symbol,
					name: t.name || t.symbol,
					mint: t.address,
					decimals: t.decimals,
					logoURI: t.logoURI || '',
				}));
			renderTokenList();
		}
	} catch (err) {
		console.warn('[swap-jupiter] verified token list unavailable', err);
	}
}

function dedupeBySymbolMint(list) {
	const seen = new Set();
	const out = [];
	for (const t of list) {
		const key = t.mint;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(t);
	}
	return out;
}

function renderTokenList() {
	const q = ($('sj-search')?.value || '').trim().toLowerCase();
	const list = $('sj-list');
	list.innerHTML = '';

	// Allow direct mint paste.
	if (SOLANA_MINT_RE.test(q)) {
		list.append(buildTokenRow({
			symbol: q.slice(0, 4).toUpperCase(),
			name: 'Custom mint',
			mint: q,
			decimals: 0,
			logoURI: '',
			needsDecimals: true,
		}));
	}

	const pool = dedupeBySymbolMint([...QUICK_TOKENS, ..._remoteTokens]);
	const filtered = !q
		? QUICK_TOKENS
		: pool.filter((t) =>
			t.symbol.toLowerCase().includes(q) ||
			t.name.toLowerCase().includes(q) ||
			t.mint.toLowerCase().includes(q),
		).slice(0, 50);

	if (!filtered.length && !SOLANA_MINT_RE.test(q)) {
		list.append(el('div', { class: 'sj-empty', text: 'No tokens match. Paste a mint address to add a custom token.' }));
		return;
	}
	filtered.forEach((t) => list.append(buildTokenRow(t)));
}

function buildTokenRow(t) {
	const row = el('div', { class: 'sj-list-row', role: 'option', tabindex: '0' },
		el('img', { src: t.logoURI || '', alt: '', onerror: function () { this.style.visibility = 'hidden'; } }),
		el('div', { class: 'sj-list-main' },
			el('div', { class: 'sj-list-sym', text: t.symbol }),
			el('div', { class: 'sj-list-name', text: t.name }),
		),
		el('div', { class: 'sj-list-mint', text: `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}` }),
	);
	row.addEventListener('click', () => selectToken(t));
	row.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectToken(t); });
	return row;
}

async function selectToken(token) {
	if (token.needsDecimals) {
		// Custom-mint path: fetch decimals from chain before continuing.
		try {
			const connection = new Connection(SWAP_RPC, 'confirmed');
			const info = await connection.getParsedAccountInfo(new PublicKey(token.mint));
			const decimals = info?.value?.data?.parsed?.info?.decimals;
			if (typeof decimals !== 'number') throw new Error('Could not read mint decimals');
			token = { ...token, decimals, name: 'Custom mint' };
		} catch (err) {
			setStatus(`Custom mint failed: ${err.message}`, 'sj-err');
			closePicker();
			return;
		}
	}
	if (_pickerSide === 'from') _ctx.inputToken = token;
	else _ctx.outputToken = token;

	// Prevent picking the same token on both sides.
	if (_ctx.inputToken.mint === _ctx.outputToken.mint) {
		_ctx[_pickerSide === 'from' ? 'outputToken' : 'inputToken'] =
			_pickerSide === 'from' ? findToken(USDC_MINT) : findToken(SOL_MINT);
	}

	setTokenUI('from', _ctx.inputToken);
	setTokenUI('to', _ctx.outputToken);
	closePicker();
	refreshBalance();
	if (Number($('sj-from-amount').value) > 0) debouncedQuote();
}

function findToken(mint) {
	return [...QUICK_TOKENS, ..._remoteTokens].find((t) => t.mint === mint)
		|| { symbol: mint.slice(0, 4), name: 'Token', mint, decimals: 6, logoURI: '' };
}

// ── Swap execution ─────────────────────────────────────────────────────────

async function executeSwap() {
	if (!_ctx || !_quote) return;
	const btn = $('sj-confirm');
	btn.disabled = true;
	btn.textContent = 'Preparing transaction…';
	setStatus('Building swap transaction…');

	const provider = _ctx.getProvider();
	if (!provider) {
		setStatus('Phantom wallet provider not available.', 'sj-err');
		btn.disabled = false;
		btn.textContent = 'Swap';
		return;
	}

	try {
		const userPubkey = _ctx.wallet.toString();

		const swapResp = await fetch(JUP_SWAP_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				quoteResponse: _quote,
				userPublicKey: userPubkey,
				wrapAndUnwrapSol: true,
				dynamicComputeUnitLimit: true,
				prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'medium' } },
			}),
		});
		if (!swapResp.ok) {
			const text = await swapResp.text();
			throw new Error(`Jupiter swap ${swapResp.status}: ${text.slice(0, 240)}`);
		}
		const swapData = await swapResp.json();
		if (!swapData.swapTransaction) throw new Error('Jupiter returned no transaction');

		btn.textContent = 'Awaiting wallet signature…';
		setStatus('Approve the transaction in your wallet…');

		const txBuf = Uint8Array.from(atob(swapData.swapTransaction), (c) => c.charCodeAt(0));
		const tx = VersionedTransaction.deserialize(txBuf);

		// Sign via Phantom.
		const signed = await provider.signTransaction(tx);

		btn.textContent = 'Submitting…';
		setStatus('Submitting transaction…');

		const connection = new Connection(SWAP_RPC, 'confirmed');
		const sig = await connection.sendRawTransaction(signed.serialize(), {
			skipPreflight: false,
			maxRetries: 2,
		});

		const explorerLink = `https://solscan.io/tx/${sig}`;
		setStatus(el('span', {},
			'Submitted. ',
			el('a', { href: explorerLink, target: '_blank', rel: 'noopener', text: 'View on Solscan ↗' }),
		), 'sj-ok');

		// Confirm (non-blocking for UX — show signature first).
		btn.textContent = 'Confirming…';
		try {
			const latest = await connection.getLatestBlockhash('confirmed');
			await connection.confirmTransaction(
				{ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
				'confirmed',
			);
			setStatus(el('span', {},
				'Swap confirmed. ',
				el('a', { href: explorerLink, target: '_blank', rel: 'noopener', text: 'View on Solscan ↗' }),
			), 'sj-ok');
			btn.textContent = 'Done';
		} catch (confErr) {
			setStatus(el('span', {},
				'Submitted, awaiting confirmation. ',
				el('a', { href: explorerLink, target: '_blank', rel: 'noopener', text: 'View on Solscan ↗' }),
			), 'sj-ok');
			console.warn('[swap-jupiter] confirm failed', confErr);
			btn.textContent = 'Swap again';
			btn.disabled = false;
		}

		refreshBalance();
	} catch (err) {
		console.error('[swap-jupiter] swap failed', err);
		setStatus(`Swap failed: ${err.message}`, 'sj-err');
		btn.disabled = false;
		btn.textContent = `Swap ${_ctx.inputToken.symbol} → ${_ctx.outputToken.symbol}`;
	}
}

// ── Public API ─────────────────────────────────────────────────────────────

function closeSwap() {
	if (_ui) _ui.swapOverlay.classList.add('sj-hidden');
}

export function openSwapModal({ wallet, getProvider, defaultInputMint, defaultOutputMint } = {}) {
	if (!wallet) {
		alert('Connect your wallet first.');
		return;
	}
	if (typeof getProvider !== 'function') {
		throw new Error('openSwapModal: getProvider is required');
	}

	ensureUI();

	const inputToken =
		(defaultInputMint && findToken(defaultInputMint)) || QUICK_TOKENS[0];
	const outputToken =
		(defaultOutputMint && findToken(defaultOutputMint)) || QUICK_TOKENS[1];

	_ctx = { wallet, getProvider, inputToken, outputToken };
	_quote = null;

	setTokenUI('from', inputToken);
	setTokenUI('to',   outputToken);
	$('sj-from-amount').value = '';
	$('sj-to-amount').value = '';
	$('sj-meta').textContent = '';
	setStatus('');
	$('sj-slippage').value = '50';
	$('sj-slippage-pct').textContent = '0.50%';
	updateConfirmButton();

	_ui.swapOverlay.classList.remove('sj-hidden');
	setTimeout(() => $('sj-from-amount').focus(), 0);

	refreshBalance();
}
