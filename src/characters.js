/**
 * /characters — character discovery feed.
 *
 * Fetches /api/characters and renders a charms-style grid of character cards.
 * Each card links to /character/:id. Supports search, sort, and load-more.
 */

import { walletChipHTML, wireWalletChips } from './shared/agent-wallet-chip.js';
import './ui-juice.css';
import { enterStagger } from './ui-juice.js';

// `gen` is the request generation: every fetch claims one, and a response whose
// generation is no longer current is dropped so a slow reply cannot paint over a
// newer one. `appending` guards only Load more against a double-click.
let state = { cursor: null, sort: 'new', q: '', gen: 0, appending: false };

function formatNum(n) {
	if (!n) return '0';
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
	return String(n);
}

function formatUsd(n) {
	if (n == null) return null;
	if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
	if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
	return '$' + Number(n).toFixed(2);
}

function escHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Only allow http(s) image URLs; anything else (javascript:, data:, etc.) is
// dropped so a hostile image_url can't smuggle script into the src attribute.
function safeUrl(u) {
	const s = String(u ?? '').trim();
	return /^https?:\/\//i.test(s) ? escHtml(s) : '';
}

function avatarPlaceholder(name) {
	// Index by code point, not code unit: a name starting with an emoji or any
	// astral glyph splits its surrogate pair with [0] and renders as a tofu box.
	const letter = ([...(name || '?')][0] || '?').toUpperCase();
	const hue = [...(name || 'X')].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
	return { letter, color: `hsl(${hue}, 55%, 45%)` };
}

function cardHtml(ch) {
	const { letter, color } = avatarPlaceholder(ch.name);
	const name = escHtml(ch.name);
	const imgSrc = safeUrl(ch.image_url);
	const avatarEl = imgSrc
		? `<img loading="lazy" decoding="async" class="chs-card-avatar" src="${imgSrc}" alt="${name}"
		        data-fallback="sibling"  />
		   <div class="chs-card-avatar-ph" style="display:none;background:${color}">${letter}</div>`
		: `<div class="chs-card-avatar-ph" style="background:${color}">${letter}</div>`;

	const creator = ch.author_name
		? `<div class="chs-card-creator">by @${escHtml(ch.author_name.toLowerCase().replace(/\s+/g, ''))}</div>`
		: '';

	let tokenHtml = '';
	if (ch.token?.symbol) {
		const price = formatUsd(ch.token.market_cap_usd ?? ch.token.price_usd);
		const change = ch.token.change_24h_percent;
		const changeEl = change != null
			? `<span class="chs-card-token-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%</span>`
			: '';
		tokenHtml = `
			<div class="chs-card-token">
				<div class="chs-card-token-left">
					<span class="chs-card-token-symbol">$${escHtml(ch.token.symbol)}</span>
					${price ? `<span class="chs-card-token-price">${price}</span>` : ''}
				</div>
				${changeEl}
			</div>`;
	}

	const statsHtml = `
		<div class="chs-card-stats">
			<span class="chs-card-stat">
				<span class="chs-card-stat-num">${formatNum(ch.chat_count)}</span> chats
			</span>
			${ch.token?.holders ? `<span class="chs-card-stat">
				<span class="chs-card-stat-num">${formatNum(ch.token.holders)}</span> holders
			</span>` : ''}
		</div>`;

	return `
		<a class="chs-card" href="/character/${encodeURIComponent(ch.id)}">
			<div class="chs-card-top">
				${avatarEl}
				<div class="chs-card-info">
					<div class="chs-card-name">${name}</div>
					${creator}
				</div>
			</div>
			${ch.description ? `<p class="chs-card-desc">${escHtml(ch.description)}</p>` : ''}
			${statsHtml}
			${tokenHtml}
			${ch.solana_address ? `<div class="chs-card-wallet" style="margin-top:8px">${walletChipHTML(ch, { link: false, popover: false, showPending: false, dense: true })}</div>` : ''}
		</a>`;
}

// A full-grid state (empty / error) spans every column and owns the recovery
// action, so the user is never left staring at a dead panel with no way out.
function noticeHtml({ title, body, actionId, actionLabel, actionHref }) {
	const action = actionHref
		? `<a class="chs-notice-btn" href="${actionHref}">${actionLabel}</a>`
		: `<button type="button" class="chs-notice-btn" id="${actionId}">${actionLabel}</button>`;
	return `
		<div class="chs-notice">
			<p class="chs-notice-title">${escHtml(title)}</p>
			<p class="chs-notice-body">${escHtml(body)}</p>
			${action}
		</div>`;
}

function setStatus(text) {
	const el = document.getElementById('chs-status');
	if (el) el.textContent = text;
}

function showEmpty(grid) {
	// Two different dead ends with two different exits: a search that matched
	// nothing is fixed by clearing the search; a genuinely empty feed is fixed by
	// creating the first character.
	grid.innerHTML = state.q
		? noticeHtml({
			title: `No characters match “${state.q}”.`,
			body: 'Try a shorter word, or clear the search to browse everything.',
			actionId: 'chs-clear-search',
			actionLabel: 'Clear search',
		  })
		: noticeHtml({
			title: 'No characters published yet.',
			body: 'Publish an agent and it shows up here for everyone to chat with.',
			actionLabel: 'Create a character',
			actionHref: '/create-agent',
		  });
	setStatus(state.q ? `No characters match ${state.q}.` : 'No characters published yet.');
	document.getElementById('chs-clear-search')?.addEventListener('click', () => {
		const input = document.getElementById('chs-search');
		if (input) input.value = '';
		state.q = '';
		fetchCharacters(true);
		input?.focus();
	});
}

function showError(grid, appending) {
	if (appending) {
		// The already-rendered cards stay; only the load-more control reports the
		// failure, so a flaky second page never wipes a good first one.
		const loadBtn = document.getElementById('chs-load-btn');
		if (loadBtn) {
			loadBtn.textContent = 'Retry loading more';
			loadBtn.classList.add('chs-load-btn-error');
		}
		setStatus('Could not load more characters. Press retry.');
		return;
	}
	grid.innerHTML = noticeHtml({
		title: 'Could not load characters.',
		body: 'The feed did not respond. Your connection may have dropped.',
		actionId: 'chs-retry',
		actionLabel: 'Try again',
	});
	setStatus('Could not load characters.');
	document.getElementById('chs-retry')?.addEventListener('click', () => fetchCharacters(true));
}

async function fetchCharacters(reset = false) {
	// A reset (search or sort change) always supersedes whatever is in flight;
	// only an append is dropped, and only to swallow a double-click on Load more.
	// A blanket "already loading, ignore" guard meant that clicking Top while the
	// first page was still arriving lit the button up and changed nothing else,
	// so the page then showed New results under a Top label.
	if (!reset && state.appending) return;
	if (!reset) state.appending = true;
	const gen = ++state.gen;
	const superseded = () => gen !== state.gen;

	const grid = document.getElementById('chs-grid');
	const loadBtn = document.getElementById('chs-load-btn');
	const loadMore = document.getElementById('chs-load-more');

	if (reset) {
		state.cursor = null;
		grid.innerHTML = Array(6).fill('<div class="chs-skeleton-card"></div>').join('');
		setStatus('Loading characters…');
	}
	grid.setAttribute('aria-busy', 'true');

	if (loadBtn) {
		loadBtn.disabled = true;
		loadBtn.classList.remove('chs-load-btn-error');
		if (!reset) loadBtn.textContent = 'Loading…';
	}

	const params = new URLSearchParams({ limit: '24', sort: state.sort });
	if (state.cursor) params.set('cursor', state.cursor);
	if (state.q) params.set('q', state.q);

	let data;
	try {
		const res = await fetch('/api/characters?' + params.toString());
		if (!res.ok) throw new Error('characters feed responded ' + res.status);
		data = await res.json();
	} catch {
		state.appending = false;
		if (superseded()) return;
		showError(grid, !reset);
		if (loadBtn) loadBtn.disabled = false;
		grid.setAttribute('aria-busy', 'false');
		return;
	}

	state.appending = false;
	// A newer reset landed while this response was in flight; its render owns the
	// grid now, so drop this one rather than painting stale results over it.
	if (superseded()) return;

	const chars = data.characters || [];

	if (reset) {
		if (!chars.length) {
			showEmpty(grid);
			if (loadMore) loadMore.hidden = true;
			// Flipped last, so anything waiting on aria-busy (assistive tech, the
			// e2e probe) observes the rendered state rather than an empty grid.
			grid.setAttribute('aria-busy', 'false');
			return;
		}
		grid.innerHTML = chars.map(cardHtml).join('');
		enterStagger(grid.querySelectorAll('.chs-card'));
		setStatus(`${chars.length} character${chars.length === 1 ? '' : 's'} loaded.`);
	} else {
		const before = grid.children.length;
		grid.insertAdjacentHTML('beforeend', chars.map(cardHtml).join(''));
		enterStagger(Array.from(grid.children).slice(before));
		setStatus(`${chars.length} more loaded, ${grid.children.length} total.`);
	}

	// Wire the wallet chips' copy + Tip actions on the freshly-injected cards.
	// This is a public gallery, so cards default to isOwner:false → the ◎ Tip
	// action; wiring is idempotent per chip, so re-running it on append is safe.
	wireWalletChips(grid);

	grid.setAttribute('aria-busy', 'false');
	state.cursor = data.next_cursor || null;
	if (loadMore) loadMore.hidden = !state.cursor;
	if (loadBtn) {
		loadBtn.disabled = false;
		loadBtn.textContent = 'Load more';
	}
}

function init() {
	const searchInput = document.getElementById('chs-search');
	const sortBtns = document.querySelectorAll('.chs-sort-btn');
	const loadBtn = document.getElementById('chs-load-btn');

	let searchTimer;
	searchInput?.addEventListener('input', () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			const next = searchInput.value.trim();
			if (next === state.q) return;
			state.q = next;
			fetchCharacters(true);
		}, 300);
	});

	sortBtns.forEach(btn => {
		btn.addEventListener('click', () => {
			if (btn.dataset.sort === state.sort) return;
			sortBtns.forEach(b => {
				const on = b === btn;
				b.classList.toggle('active', on);
				b.setAttribute('aria-pressed', String(on));
			});
			state.sort = btn.dataset.sort;
			fetchCharacters(true);
		});
	});

	loadBtn?.addEventListener('click', () => fetchCharacters(false));

	fetchCharacters(true);
}

init();
