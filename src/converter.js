// /converter - crypto and fiat converter, part of the /coins "Markets" surface.
// Reuses the shared /api/coin proxies:
//   · /api/coin/rates            -> curated fiat currencies (units per 1 BTC)
//   · /api/coin/markets?q=<text> -> coin search type-ahead (same UX as /coins)
//   · /api/coin/detail?id=<id>   -> a coin's live USD price (market.price)
//
// The conversion math, formatting, and shareable-URL codec live in
// src/shared/converter-state.js; this module is the DOM layer on top of them.
// Every view is addressable: /converter?from=ethereum&to=EUR&amount=3 restores
// both sides and the amount, and the URL rewrites itself as the user edits so
// the address bar (and the Copy link button) always hold the current result.

import { formatPrice, escapeHtml as esc } from './shared/coin-format.js';
import {
	EMPTY,
	assetCode,
	buildConverterQuery,
	convert as convertAmount,
	formatInAsset,
	parseAmount,
	parseConverterQuery,
	resolveAssetRef,
} from './shared/converter-state.js';

const $ = (id) => document.getElementById(id);

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} -> ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── State ─────────────────────────────────────────────────────────────────────

// rates: { byCode: Map<CODE, {code,name,unit,per_btc}>, usdPerBtc, list:[], updated_at }
// from / to: { kind:'crypto', id, symbol, name, image, priceUSD }
//         or { kind:'fiat', code, name, unit, per_btc }
const state = {
	rates: null,
	from: null,
	to: null,
	amount: 1,
	amountText: '1',
	loading: true,
	error: null,
	pending: { from: false, to: false },
};

const DEFAULT_CRYPTO = 'bitcoin';
const DEFAULT_FIAT = 'USD';

const usdPerBtc = () => state.rates?.usdPerBtc ?? NaN;
const convert = (amount, from, to) => convertAmount(amount, from, to, usdPerBtc());

// ── Shareable URL ─────────────────────────────────────────────────────────────

// Every state change rewrites the query in place. replaceState (not pushState)
// keeps the back button pointing at wherever the visitor came from instead of
// burying it under one entry per keystroke.
function syncUrl() {
	if (state.loading || state.error) return;
	const query = buildConverterQuery(state);
	const next = `${window.location.pathname}${query}`;
	if (next === `${window.location.pathname}${window.location.search}`) return;
	window.history.replaceState(null, '', next);
	const copy = $('cvt-copy');
	if (copy) resetCopyButton(copy);
}

function shareUrl() {
	return `${window.location.origin}${window.location.pathname}${buildConverterQuery(state)}`;
}

const COPY_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function resetCopyButton(btn) {
	btn.classList.remove('is-copied');
	btn.innerHTML = `${COPY_ICON}<span>Copy link</span>`;
}

// Clipboard API first; on a browser or context that refuses it, fall back to a
// scratch textarea so the button still works instead of silently doing nothing.
async function writeClipboard(text) {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Permission denied or an insecure context: try the fallback below.
		}
	}
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	ta.remove();
	return ok;
}

let copyTimer = null;
async function onCopyLink() {
	const btn = $('cvt-copy');
	if (!btn) return;
	const ok = await writeClipboard(shareUrl());
	clearTimeout(copyTimer);
	btn.classList.add('is-copied');
	btn.innerHTML = ok
		? `${CHECK_ICON}<span>Link copied</span>`
		: `${COPY_ICON}<span>Press Ctrl+C</span>`;
	const status = $('cvt-copy-status');
	if (status) {
		status.textContent = ok
			? `Link copied: ${shareUrl()}`
			: 'Copy blocked by the browser. The link is in the address bar.';
	}
	copyTimer = setTimeout(() => resetCopyButton(btn), 2200);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const CHEVRON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const SWAP_ICON =
	'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

function assetButtonInner(asset, side) {
	if (state.pending[side]) {
		return `<span class="cvt-asset-load"><span class="cv-spinner" aria-hidden="true"></span></span>${CHEVRON}`;
	}
	if (!asset) return `<span class="cvt-asset-code">Select</span>${CHEVRON}`;
	if (asset.kind === 'crypto') {
		const icon = asset.image
			? `<img loading="lazy" decoding="async" src="${esc(asset.image)}" alt="" width="22" height="22" data-no-dark-filter />`
			: `<span class="cvt-asset-glyph">${esc((asset.symbol || '?').slice(0, 1))}</span>`;
		return `${icon}<span class="cvt-asset-code">${esc(asset.symbol)}</span>${CHEVRON}`;
	}
	const glyph = asset.unit || asset.code.slice(0, 1);
	return `<span class="cvt-asset-glyph fiat">${esc(glyph)}</span><span class="cvt-asset-code">${esc(asset.code)}</span>${CHEVRON}`;
}

// Accessible name for the asset button, so a screen reader hears the currency
// rather than just "button".
function assetButtonLabel(asset, side) {
	const what = side === 'from' ? 'Convert from' : 'Convert to';
	if (state.pending[side]) return `${what}: loading`;
	if (!asset) return `${what}: choose a currency`;
	return `${what}: ${asset.name || assetCode(asset)}. Change currency`;
}

function assetSubline(asset) {
	if (!asset) return '';
	if (asset.kind === 'crypto') {
		return `${esc(asset.name)} · ${esc(formatPrice(asset.priceUSD))}`;
	}
	return esc(asset.name);
}

function renderRate() {
	const el = $('cvt-rate');
	if (!el) return;
	if (!state.from || !state.to) {
		el.textContent = '';
		return;
	}
	const one = convert(1, state.from, state.to);
	if (one == null) {
		el.innerHTML = `<span class="dim">Live rate unavailable for this pair. Pick another currency or try again shortly.</span>`;
		return;
	}
	el.innerHTML = `1 ${esc(assetCode(state.from))} = <strong>${esc(formatInAsset(one, state.to))}</strong> ${esc(assetCode(state.to))}`;
}

function renderResult() {
	const el = $('cvt-result');
	if (!el) return;
	const out = Number.isFinite(state.amount)
		? convert(state.amount, state.from, state.to)
		: null;
	if (out == null) {
		el.innerHTML = `<span class="cvt-result-empty">${EMPTY}</span>`;
		return;
	}
	el.textContent = formatInAsset(out, state.to);
}

// A typed value the converter cannot use gets an explanation instead of a bare
// placeholder, so the user knows the page is not broken.
function renderAmountHint() {
	const el = $('cvt-amount-hint');
	if (!el) return;
	const raw = state.amountText.trim();
	if (!raw) {
		el.textContent = 'Enter an amount to convert.';
		el.hidden = false;
		return;
	}
	if (!Number.isFinite(state.amount)) {
		el.textContent = 'Enter a positive number, digits only.';
		el.hidden = false;
		return;
	}
	el.hidden = true;
	el.textContent = '';
}

function renderUpdated() {
	const el = $('cvt-updated');
	if (!el || !state.rates) return;
	const d = new Date(state.rates.updated_at);
	if (Number.isNaN(d.getTime())) {
		el.textContent = 'Live market prices';
		return;
	}
	el.textContent = `Rates updated ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · live market prices`;
}

function renderCard() {
	const app = $('cvt-app');
	renderPresets();
	if (state.error) {
		app.innerHTML = `
			<div class="cvt-card cv-card">
				<div class="cv-empty">
					<p style="margin:0 0 0.75rem">We couldn't load live rates just now. Check your connection, then retry.</p>
					<button type="button" class="cvt-retry" id="cvt-retry">Try again</button>
				</div>
			</div>`;
		$('cvt-retry')?.addEventListener('click', boot);
		return;
	}
	if (state.loading) {
		app.innerHTML = `
			<div class="cvt-card cv-card">
				<div class="cv-skel" style="height:5.5rem;margin-bottom:1rem"></div>
				<div class="cv-skel" style="height:5.5rem"></div>
			</div>`;
		return;
	}

	app.innerHTML = `
		<div class="cvt-card cv-card">
			<div class="cvt-side" data-side="from">
				<label class="cvt-label" for="cvt-amount">Amount</label>
				<div class="cvt-row">
					<input
						class="cvt-amount"
						id="cvt-amount"
						type="text"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						size="1"
						aria-describedby="cvt-amount-hint"
						value="${esc(state.amountText)}"
					/>
					<button type="button" class="cvt-asset" id="cvt-from-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(assetButtonLabel(state.from, 'from'))}">
						${assetButtonInner(state.from, 'from')}
					</button>
				</div>
				<p class="cvt-hint" id="cvt-amount-hint" hidden></p>
				<p class="cvt-subline" id="cvt-from-sub">${assetSubline(state.from)}</p>
			</div>

			<div class="cvt-swap-wrap">
				<button type="button" class="cvt-swap" id="cvt-swap" aria-label="Swap the two currencies" title="Swap">
					${SWAP_ICON}
				</button>
			</div>

			<div class="cvt-side" data-side="to">
				<span class="cvt-label" id="cvt-to-label">Converted to</span>
				<div class="cvt-row">
					<output class="cvt-result" id="cvt-result" for="cvt-amount" aria-live="polite" aria-labelledby="cvt-to-label"></output>
					<button type="button" class="cvt-asset" id="cvt-to-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(assetButtonLabel(state.to, 'to'))}">
						${assetButtonInner(state.to, 'to')}
					</button>
				</div>
				<p class="cvt-subline" id="cvt-to-sub">${assetSubline(state.to)}</p>
			</div>

			<p class="cvt-rate" id="cvt-rate"></p>
			<div class="cvt-foot">
				<p class="cv-updated" id="cvt-updated"></p>
				<button type="button" class="cvt-copy" id="cvt-copy">${COPY_ICON}<span>Copy link</span></button>
			</div>
			<p class="cvt-sr-status" id="cvt-copy-status" role="status" aria-live="polite"></p>
		</div>`;

	wireCard();
	renderResult();
	renderRate();
	renderAmountHint();
	renderUpdated();
}

// Refresh just the dynamic bits without tearing down the input (keeps focus and
// caret while typing). Falls back to a full re-render if the card isn't mounted.
function refresh() {
	if (!$('cvt-result')) {
		renderCard();
		return;
	}
	for (const side of ['from', 'to']) {
		const btn = $(`cvt-${side}-btn`);
		if (btn) {
			btn.innerHTML = assetButtonInner(state[side], side);
			btn.setAttribute('aria-label', assetButtonLabel(state[side], side));
		}
		const sub = $(`cvt-${side}-sub`);
		if (sub) sub.innerHTML = assetSubline(state[side]);
	}
	renderResult();
	renderRate();
	renderAmountHint();
	renderUpdated();
	renderPresets();
	syncUrl();
}

function wireCard() {
	const input = $('cvt-amount');
	let debounce = null;
	input?.addEventListener('input', () => {
		state.amountText = input.value;
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			state.amount = parseAmount(input.value);
			renderResult();
			renderAmountHint();
			renderPresets();
			syncUrl();
		}, 120);
	});
	// Select-all on focus so a tap-and-type replaces the value cleanly.
	input?.addEventListener('focus', () => input.select());

	$('cvt-swap')?.addEventListener('click', swap);
	$('cvt-copy')?.addEventListener('click', onCopyLink);
	for (const side of ['from', 'to']) {
		$(`cvt-${side}-btn`)?.addEventListener('click', (e) => {
			e.stopPropagation();
			if (picker.open && picker.side === side) closePicker();
			else openPicker(side, e.currentTarget);
		});
	}
}

function swap() {
	const f = state.from;
	state.from = state.to;
	state.to = f;
	refresh();
}

// ── Asset resolution ──────────────────────────────────────────────────────────

function fiatAsset(code) {
	const f = state.rates?.byCode.get(String(code).toUpperCase());
	if (!f) return null;
	return { kind: 'fiat', code: f.code, name: f.name, unit: f.unit, per_btc: f.per_btc };
}

// Fetch a coin's live USD price and metadata -> a crypto asset.
async function cryptoAsset(id, seed = {}) {
	const { coin } = await getJson(`/api/coin/detail?id=${encodeURIComponent(id)}`);
	const price = coin?.market?.price;
	return {
		kind: 'crypto',
		id: coin?.id || id,
		symbol: coin?.symbol || (seed.symbol || id).toUpperCase(),
		name: coin?.name || seed.name || id,
		image: coin?.image || seed.thumb || null,
		priceUSD: Number.isFinite(price) ? price : NaN,
	};
}

// Load a crypto into `side`, showing a spinner on that side while the price
// request is in flight. Seed carries the search-result metadata so the button
// shows the symbol and icon immediately.
async function selectCrypto(side, id, seed = {}) {
	state.pending[side] = true;
	// Optimistic placeholder so the button updates instantly.
	state[side] = {
		kind: 'crypto',
		id,
		symbol: (seed.symbol || id).toUpperCase(),
		name: seed.name || id,
		image: seed.thumb || null,
		priceUSD: NaN,
	};
	refresh();
	try {
		state[side] = await cryptoAsset(id, seed);
	} catch {
		// Keep the placeholder but leave the price missing: the rate line shows
		// the "unavailable" copy rather than a wrong number.
		state[side] = { ...state[side], priceUSD: NaN };
	}
	state.pending[side] = false;
	refresh();
}

function selectFiat(side, code) {
	const a = fiatAsset(code);
	if (!a) return;
	state[side] = a;
	refresh();
}

// Load whichever kind of asset a URL ref or preset names.
function selectRef(side, ref, seed = {}) {
	if (!ref) return null;
	if (ref.kind === 'fiat') {
		selectFiat(side, ref.code);
		return null;
	}
	return selectCrypto(side, ref.id, seed);
}

// ── Asset picker (fiat + crypto search) ───────────────────────────────────────

const picker = { open: false, side: null, anchor: null, timer: null, active: -1 };

function currencyGlyph(f) {
	return f.unit || f.code.slice(0, 1);
}

function pickerFiatRows(query) {
	const q = query.toLowerCase();
	const rows = state.rates.list.filter(
		(f) => !q || f.code.toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
	);
	if (!rows.length) return '';
	const items = rows
		.map(
			(f) => `
			<button type="button" class="cvt-pick-item" role="option" aria-selected="false" data-kind="fiat" data-code="${esc(f.code)}">
				<span class="cvt-pick-glyph fiat">${esc(currencyGlyph(f))}</span>
				<span class="cvt-pick-name">${esc(f.name)}</span>
				<span class="cvt-pick-code">${esc(f.code)}</span>
			</button>`,
		)
		.join('');
	return `<div class="cvt-pick-group" role="group" aria-label="Fiat currencies"><p class="cvt-pick-head">Fiat currencies</p>${items}</div>`;
}

function pickerCryptoRows(coins) {
	if (!coins.length) return '';
	const items = coins
		.map(
			(c) => `
			<button type="button" class="cvt-pick-item" role="option" aria-selected="false" data-kind="crypto" data-id="${esc(c.id)}" data-symbol="${esc(c.symbol)}" data-name="${esc(c.name)}" data-thumb="${esc(c.thumb || '')}">
				${c.thumb ? `<img loading="lazy" decoding="async" src="${esc(c.thumb)}" alt="" width="22" height="22" data-no-dark-filter />` : `<span class="cvt-pick-glyph">${esc((c.symbol || '?').slice(0, 1))}</span>`}
				<span class="cvt-pick-name">${esc(c.name)}</span>
				<span class="cvt-pick-code">${esc(c.symbol)}</span>
				${c.rank != null ? `<span class="cvt-pick-rank">#${c.rank}</span>` : ''}
			</button>`,
		)
		.join('');
	return `<div class="cvt-pick-group" role="group" aria-label="Cryptocurrencies"><p class="cvt-pick-head">Cryptocurrencies</p>${items}</div>`;
}

// One builder for the results body, used by both the full popover render and
// the list-only refresh, so the two can never drift apart.
function pickerBody({ query = '', coins = null, loading = false } = {}) {
	const fiatRows = pickerFiatRows(query);
	let cryptoSection;
	if (loading) {
		cryptoSection =
			'<div class="cvt-pick-note"><span class="cv-spinner" aria-hidden="true"></span>Searching coins…</div>';
	} else if (coins) {
		cryptoSection = coins.length
			? pickerCryptoRows(coins)
			: `<div class="cvt-pick-note">No coins match “${esc(query)}”.</div>`;
	} else {
		cryptoSection =
			'<div class="cvt-pick-note">Type to search thousands of coins by name or symbol.</div>';
	}
	if (!fiatRows && coins && !coins.length) {
		return `<div class="cvt-pick-note">Nothing matches “${esc(query)}”. Try a ticker such as BTC, or a name such as Euro.</div>`;
	}
	return `${fiatRows}${cryptoSection}`;
}

function renderPicker({ query = '', coins = null, loading = false } = {}) {
	const el = $('cvt-picker');
	el.innerHTML = `
		<div class="cvt-pick-search">
			<svg class="mag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
			<input type="text" id="cvt-pick-input" placeholder="Search currency or coin" autocomplete="off" spellcheck="false"
				role="combobox" aria-expanded="true" aria-controls="cvt-pick-list" aria-autocomplete="list"
				aria-label="Search for a currency or coin" value="${esc(query)}" />
		</div>
		<div class="cvt-pick-list" id="cvt-pick-list" role="listbox" aria-label="Currencies and coins">${pickerBody({ query, coins, loading })}</div>`;

	const input = $('cvt-pick-input');
	input.focus();
	input.addEventListener('input', onPickerInput);
	input.addEventListener('keydown', onPickerKey);
	wirePickerItems();
}

// Re-render the list only (not the whole popover) so the search input keeps
// focus and caret while results stream in.
function renderPickerPreserveFocus(opts) {
	const list = $('cvt-pick-list');
	if (!list) return renderPicker(opts);
	list.innerHTML = pickerBody(opts);
	wirePickerItems();
}

function pickerItems() {
	return [...($('cvt-pick-list')?.querySelectorAll('.cvt-pick-item') || [])];
}

function wirePickerItems() {
	picker.active = -1;
	pickerItems().forEach((btn, i) => {
		btn.id = `cvt-pick-opt-${i}`;
		btn.addEventListener('click', () => choosePickItem(btn));
		btn.addEventListener('mousemove', () => setActiveItem(i, { scroll: false }));
	});
	$('cvt-pick-input')?.removeAttribute('aria-activedescendant');
}

// Roving highlight driven from the search box: the input keeps DOM focus (so
// typing never breaks) and aria-activedescendant points at the current option.
function setActiveItem(index, { scroll = true } = {}) {
	const items = pickerItems();
	if (!items.length) return;
	const next = ((index % items.length) + items.length) % items.length;
	items.forEach((el, i) => {
		const on = i === next;
		el.classList.toggle('is-active', on);
		el.setAttribute('aria-selected', on ? 'true' : 'false');
	});
	picker.active = next;
	const el = items[next];
	if (scroll) el.scrollIntoView({ block: 'nearest' });
	$('cvt-pick-input')?.setAttribute('aria-activedescendant', el.id);
}

function choosePickItem(btn) {
	const side = picker.side;
	if (btn.dataset.kind === 'fiat') {
		selectFiat(side, btn.dataset.code);
	} else {
		selectCrypto(side, btn.dataset.id, {
			symbol: btn.dataset.symbol,
			name: btn.dataset.name,
			thumb: btn.dataset.thumb || null,
		});
	}
	closePicker();
	$(`cvt-${side}-btn`)?.focus();
}

function onPickerInput(e) {
	const q = e.target.value.trim();
	clearTimeout(picker.timer);
	if (!q) {
		renderPickerPreserveFocus({ query: '' });
		return;
	}
	// Show fiat matches plus a loading state immediately, then fill in crypto.
	renderPickerPreserveFocus({ query: q, loading: true });
	picker.timer = setTimeout(async () => {
		try {
			const { coins } = await getJson(`/api/coin/markets?q=${encodeURIComponent(q)}`);
			// Guard against a stale response after the input changed again.
			if ($('cvt-pick-input')?.value.trim() === q) {
				renderPickerPreserveFocus({ query: q, coins: coins || [] });
			}
		} catch {
			if ($('cvt-pick-input')?.value.trim() === q) {
				renderPickerPreserveFocus({ query: q, coins: [] });
			}
		}
	}, 250);
}

function onPickerKey(e) {
	if (e.key === 'Escape') {
		e.preventDefault();
		const anchor = picker.anchor;
		closePicker();
		anchor?.focus();
		return;
	}
	if (e.key === 'ArrowDown') {
		e.preventDefault();
		setActiveItem(picker.active + 1);
		return;
	}
	if (e.key === 'ArrowUp') {
		e.preventDefault();
		setActiveItem(picker.active <= 0 ? pickerItems().length - 1 : picker.active - 1);
		return;
	}
	if (e.key === 'Home') {
		e.preventDefault();
		setActiveItem(0);
		return;
	}
	if (e.key === 'End') {
		e.preventDefault();
		setActiveItem(pickerItems().length - 1);
		return;
	}
	if (e.key === 'Enter') {
		e.preventDefault();
		const items = pickerItems();
		const target = items[picker.active >= 0 ? picker.active : 0];
		if (target) choosePickItem(target);
		return;
	}
	// Tab out of the popover closes it rather than leaving an orphan overlay.
	if (e.key === 'Tab') closePicker();
}

function positionPicker(anchor) {
	// Fixed position (viewport coords) so the offset parent is unambiguous: the
	// popover is a sibling of the card, not a child. Right-aligned under the
	// button and clamped to an 8px viewport gutter on both edges.
	const el = $('cvt-picker');
	const rect = anchor.getBoundingClientRect();
	el.style.top = `${rect.bottom + 6}px`;
	const right = Math.max(8, window.innerWidth - rect.right);
	el.style.right = `${right}px`;
	el.style.left = 'auto';
}

function openPicker(side, anchor) {
	picker.open = true;
	picker.side = side;
	picker.anchor = anchor;
	anchor.setAttribute('aria-expanded', 'true');
	const el = $('cvt-picker');
	el.hidden = false;
	positionPicker(anchor);
	renderPicker({ query: '' });
}

function closePicker() {
	if (!picker.open) return;
	clearTimeout(picker.timer);
	picker.open = false;
	picker.anchor?.setAttribute('aria-expanded', 'false');
	const el = $('cvt-picker');
	el.hidden = true;
	el.innerHTML = '';
	picker.side = null;
	picker.anchor = null;
	picker.active = -1;
}

document.addEventListener('click', (e) => {
	if (!picker.open) return;
	if (e.target.closest('#cvt-picker') || e.target.closest('.cvt-asset')) return;
	closePicker();
});
window.addEventListener('resize', () => {
	if (picker.open && picker.anchor) positionPicker(picker.anchor);
});
// A fixed popover doesn't follow page scroll: keep it pinned to its anchor.
window.addEventListener(
	'scroll',
	() => {
		if (picker.open && picker.anchor) positionPicker(picker.anchor);
	},
	{ passive: true },
);

// ── Presets ───────────────────────────────────────────────────────────────────

const PRESETS = [
	{
		label: 'BTC to USD',
		from: { kind: 'crypto', id: 'bitcoin', symbol: 'BTC' },
		to: { kind: 'fiat', code: 'USD' },
	},
	{
		label: 'ETH to USD',
		from: { kind: 'crypto', id: 'ethereum', symbol: 'ETH' },
		to: { kind: 'fiat', code: 'USD' },
	},
	{
		label: 'SOL to USD',
		from: { kind: 'crypto', id: 'solana', symbol: 'SOL' },
		to: { kind: 'fiat', code: 'USD' },
	},
	{
		label: 'USD to BTC',
		from: { kind: 'fiat', code: 'USD' },
		to: { kind: 'crypto', id: 'bitcoin', symbol: 'BTC' },
	},
];

// A preset reads as pressed only when it fully describes the current view:
// both sides and the amount it would apply.
function presetIsActive(p) {
	const sideMatches = (ref, asset) => {
		if (!asset) return false;
		return ref.kind === 'fiat' ? asset.code === ref.code : asset.id === ref.id;
	};
	return (
		state.amount === 1 && sideMatches(p.from, state.from) && sideMatches(p.to, state.to)
	);
}

function renderPresets() {
	const el = $('cvt-presets');
	if (!el) return;
	// Disabled until rates land, so a preset is never a button that does nothing.
	const ready = Boolean(state.rates);
	const html = PRESETS.map((p, i) => {
		const on = ready && presetIsActive(p);
		return `<button type="button" class="cvt-preset${on ? ' is-active' : ''}" data-preset="${i}" aria-pressed="${on}"${ready ? '' : ' disabled'}>${esc(p.label)}</button>`;
	}).join('');
	if (el.innerHTML === html) return;
	el.innerHTML = html;
	el.querySelectorAll('[data-preset]').forEach((btn) =>
		btn.addEventListener('click', () => applyPreset(PRESETS[Number(btn.dataset.preset)])),
	);
}

function applyPreset(p) {
	if (!state.rates) return;
	closePicker();
	state.amount = 1;
	state.amountText = '1';
	const input = $('cvt-amount');
	if (input) input.value = '1';
	// Set both sides. Fiat resolves instantly; crypto resolves via detail fetch.
	selectRef('from', p.from, { symbol: p.from.symbol });
	selectRef('to', p.to, { symbol: p.to.symbol });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// Turn the current query string into the two asset refs and the amount, falling
// back to the default BTC to USD view for anything the URL doesn't name.
function viewFromUrl() {
	const q = parseConverterQuery(window.location.search);
	const byCode = state.rates?.byCode;
	return {
		from: resolveAssetRef(q.from, byCode) || { kind: 'crypto', id: DEFAULT_CRYPTO },
		to: resolveAssetRef(q.to, byCode) || { kind: 'fiat', code: DEFAULT_FIAT },
		amount: Number.isFinite(q.amount) ? q.amount : 1,
	};
}

async function applyView(view) {
	state.amount = view.amount;
	state.amountText = String(view.amount);
	const input = $('cvt-amount');
	if (input) input.value = state.amountText;
	await Promise.all([selectRef('from', view.from), selectRef('to', view.to)].filter(Boolean));
}

async function boot() {
	state.loading = true;
	state.error = null;
	renderCard();

	let rates;
	try {
		rates = await getJson('/api/coin/rates');
	} catch {
		state.loading = false;
		state.error = 'rates';
		renderCard();
		return;
	}

	const fiats = Array.isArray(rates?.fiats) ? rates.fiats : [];
	const byCode = new Map(fiats.map((f) => [f.code, f]));
	const usd = byCode.get('USD');
	if (!usd || !Number.isFinite(usd.per_btc)) {
		state.loading = false;
		state.error = 'rates';
		renderCard();
		return;
	}
	state.rates = { byCode, list: fiats, usdPerBtc: usd.per_btc, updated_at: rates.updated_at };
	state.loading = false;

	// applyView mounts the card through refresh() with an optimistic placeholder
	// on each side, so the widget is on screen before the coin price lands.
	await applyView(viewFromUrl());
	syncUrl();
}

// Back/forward past the entry the page was opened on: re-apply that view.
window.addEventListener('popstate', () => {
	if (!state.rates) return;
	applyView(viewFromUrl());
});

boot();
