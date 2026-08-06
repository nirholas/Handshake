/**
 * /characters — character discovery feed.
 *
 * Fetches /api/characters and renders a charms-style grid of character cards.
 * Each card links to /character/:id. Supports search, sort, and load-more.
 */

import { walletChipHTML, wireWalletChips } from './shared/agent-wallet-chip.js';
import './ui-juice.css';
import { enterStagger } from './ui-juice.js';

let state = { cursor: null, loading: false, sort: 'new', q: '' };

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
	const letter = (name || '?')[0].toUpperCase();
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

async function fetchCharacters(reset = false) {
	if (state.loading) return;
	state.loading = true;

	const grid = document.getElementById('chs-grid');
	const loadBtn = document.getElementById('chs-load-btn');
	const loadMore = document.getElementById('chs-load-more');

	if (reset) {
		state.cursor = null;
		grid.innerHTML = Array(6).fill('<div class="chs-skeleton-card"></div>').join('');
	}

	if (loadBtn) loadBtn.disabled = true;

	const params = new URLSearchParams({ limit: '24', sort: state.sort });
	if (state.cursor) params.set('cursor', state.cursor);
	if (state.q) params.set('q', state.q);

	let data;
	try {
		const res = await fetch('/api/characters?' + params.toString());
		if (!res.ok) throw new Error('fetch failed');
		data = await res.json();
	} catch {
		grid.innerHTML = '<div class="chs-empty">Failed to load characters. Please try again.</div>';
		state.loading = false;
		return;
	}

	const chars = data.characters || [];

	if (reset) {
		if (!chars.length) {
			grid.innerHTML = '<div class="chs-empty">No characters found.</div>';
			if (loadMore) loadMore.style.display = 'none';
			state.loading = false;
			return;
		}
		grid.innerHTML = chars.map(cardHtml).join('');
		enterStagger(grid.querySelectorAll('.chs-card'));
	} else {
		const before = grid.children.length;
		grid.insertAdjacentHTML('beforeend', chars.map(cardHtml).join(''));
		enterStagger(Array.from(grid.children).slice(before));
	}

	// Wire the wallet chips' copy + Tip actions on the freshly-injected cards.
	// This is a public gallery, so cards default to isOwner:false → the ◎ Tip
	// action; wiring is idempotent per chip, so re-running it on append is safe.
	wireWalletChips(grid);

	state.cursor = data.next_cursor || null;
	if (loadMore) loadMore.style.display = state.cursor ? 'flex' : 'none';
	if (loadBtn) loadBtn.disabled = false;
	state.loading = false;
}

function init() {
	const searchInput = document.getElementById('chs-search');
	const sortBtns = document.querySelectorAll('.chs-sort-btn');
	const loadBtn = document.getElementById('chs-load-btn');

	let searchTimer;
	searchInput?.addEventListener('input', () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			state.q = searchInput.value.trim();
			fetchCharacters(true);
		}, 300);
	});

	sortBtns.forEach(btn => {
		btn.addEventListener('click', () => {
			sortBtns.forEach(b => b.classList.remove('active'));
			btn.classList.add('active');
			state.sort = btn.dataset.sort;
			fetchCharacters(true);
		});
	});

	loadBtn?.addEventListener('click', () => fetchCharacters(false));

	fetchCharacters(true);
}

init();
