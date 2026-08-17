// /communities — the zero-friction door into three.ws coin worlds.
//
// Pick a name, drop in an avatar (or your 3D agent), choose a coin, and you're
// walked straight into that coin's multiplayer world at /walk. Each coin is its
// own room: everyone who picks the same coin lands together. The coin grid is
// real pump.fun data (/api/pump/trending + /api/pump/search); the avatar list
// is the signed-in user's real avatars (/api/avatars). No mocks, no fakes — if
// a source is empty or unreachable, the UI says so and offers a way forward.

import { log } from './shared/log.js';
import { safeUrl } from './safe-url.js';
import { proxiedImageURL } from './ipfs.js';
const NAME_STORAGE_KEY = 'walk:player-name';
const AVATAR_CHOICE_KEY = 'communities:avatar-choice';
const DEFAULT_AVATAR_URL = '/avatars/default.glb';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const $ = (id) => document.getElementById(id);

const nameInput = $('name-input');
const avatarRow = $('avatar-row');
const avatarUrlInput = $('avatar-url-input');
const avatarUrlError = $('avatar-url-error');
const avatarHint = $('avatar-hint');
const coinGrid = $('coin-grid');
const searchInput = $('coin-search');
const mintInput = $('mint-input');
const mintBtn = $('mint-enter');
const mintError = $('mint-error');
const titleEl = document.querySelector('title');

// ── i18n ownership ─────────────────────────────────────────────────────────
// Several nodes here carry a data-i18n key (so the pre-render placeholder is
// translated) but hold live state once this script runs: the document title,
// the coin-profile failure message, the graduation label. The i18n catalog pass
// lands after /api/locale resolves, which is routinely *after* the first render,
// and it would revert those nodes to their declared copy. `data-i18n-owned="1"`
// is that runtime's documented opt-out. Releasing an element hands it back and
// restores the copy the catalog would have written, so a non-English visitor
// keeps a localized page once the live state is gone.
const i18nDefaults = new WeakMap();

function claimI18n(el, text) {
	if (!el) return;
	if (!i18nDefaults.has(el)) i18nDefaults.set(el, el.textContent);
	el.setAttribute('data-i18n-owned', '1');
	el.textContent = text;
}

function releaseI18n(el) {
	if (!el) return;
	el.removeAttribute('data-i18n-owned');
	const key = el.getAttribute('data-i18n');
	const translated = key ? window.threewsI18n?.t?.(key) : '';
	const restored = translated && translated !== key ? translated : i18nDefaults.get(el);
	if (restored != null) el.textContent = restored;
}

const setPageTitle = (text) => claimI18n(titleEl, text);
const releasePageTitle = () => releaseI18n(titleEl);

// Selected avatar: { kind: 'default'|'id'|'url', value, label, thumb }
let selectedAvatar = { kind: 'default', value: DEFAULT_AVATAR_URL, label: 'Default', thumb: '' };

// ── Identity: name ─────────────────────────────────────────────────────────
(function initName() {
	let stored = '';
	try { stored = localStorage.getItem(NAME_STORAGE_KEY) || ''; } catch {}
	nameInput.value = stored || `guest-${Math.random().toString(36).slice(2, 6)}`;
	const commit = () => {
		const v = nameInput.value.trim().slice(0, 24);
		if (v) { try { localStorage.setItem(NAME_STORAGE_KEY, v); } catch {} }
	};
	nameInput.addEventListener('blur', commit);
	nameInput.addEventListener('change', commit);
})();

// ── Identity: avatar ───────────────────────────────────────────────────────
function avatarChip({ kind, value, label, thumb, id }) {
	const chip = document.createElement('button');
	chip.type = 'button';
	chip.className = 'avatar-chip';
	chip.dataset.kind = kind;
	chip.title = label;
	chip.innerHTML = `
		<span class="avatar-thumb">${thumb
			? `<img loading="lazy" decoding="async" src="${escAttr(thumb)}" alt="" referrerpolicy="no-referrer" data-fallback="hide" />`
			: `<span class="avatar-glyph">🧍</span>`}</span>
		<span class="avatar-name">${esc(label)}</span>`;
	chip.addEventListener('click', () => {
		selectedAvatar = { kind, value, label, thumb };
		try { localStorage.setItem(AVATAR_CHOICE_KEY, JSON.stringify(selectedAvatar)); } catch {}
		markSelectedAvatar();
		if (kind !== 'url' && avatarUrlInput) {
			avatarUrlInput.value = '';
			avatarUrlInput.classList.remove('is-error');
			setAvatarUrlMessage('');
		}
	});
	return chip;
}

function markSelectedAvatar() {
	for (const el of avatarRow.querySelectorAll('.avatar-chip')) {
		const k = el.dataset.kind;
		const matches = k === selectedAvatar.kind &&
			(k === 'default' || el.dataset.value === String(selectedAvatar.value));
		el.classList.toggle('is-selected', matches);
	}
}

async function initAvatars() {
	// Default avatar is always available — selected by default for true zero
	// friction (one click on a coin and you're in).
	const defChip = avatarChip({ kind: 'default', value: DEFAULT_AVATAR_URL, label: 'Default', thumb: '/avatars/thumbs/default.png' });
	defChip.dataset.value = DEFAULT_AVATAR_URL;
	defChip.classList.add('is-selected');
	avatarRow.appendChild(defChip);

	// Restore a prior choice if the user picked something before.
	try {
		const saved = JSON.parse(localStorage.getItem(AVATAR_CHOICE_KEY) || 'null');
		if (saved && saved.kind) selectedAvatar = saved;
	} catch {}

	// Signed-in users get their real avatars to pick from. /api/auth/me answers
	// 200 with `{ user: null }` when signed out, so probing it first costs one
	// clean request and skips a roster read that could only 401 (which lands as a
	// red console error on a page most visitors reach signed out).
	let signedIn = false;
	let rosterFailed = false;
	let ownedCount = 0;
	try {
		const me = await fetch('/api/auth/me', { credentials: 'include', headers: { accept: 'application/json' } });
		signedIn = me.ok && !!(await me.json())?.user;
	} catch { /* offline: treat as signed out, default + paste still work */ }

	if (signedIn) {
		try {
			const res = await fetch('/api/avatars?limit=24', { credentials: 'include', headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const avatars = data?.avatars ?? [];
			for (const a of avatars) {
				if (!a?.id) continue;
				const chip = avatarChip({
					kind: 'id', value: a.id,
					label: a.name || 'Avatar',
					thumb: a.thumbnail_url || a.thumbnailUrl || a.image_url || '',
				});
				chip.dataset.value = a.id;
				avatarRow.appendChild(chip);
				ownedCount++;
			}
		} catch (err) {
			rosterFailed = true;
			log.warn('[communities] avatar roster', err?.message ?? err);
		}
	}

	// "Create one" shortcut so an empty-handed user has a path to their own avatar.
	const create = document.createElement('a');
	create.className = 'avatar-chip avatar-create';
	create.href = '/create';
	create.innerHTML = `<span class="avatar-thumb"><span class="avatar-glyph">+</span></span><span class="avatar-name">Create</span>`;
	avatarRow.appendChild(create);

	renderAvatarHint({ signedIn, rosterFailed, ownedCount });
	markSelectedAvatar();
}

// A row holding only "Default" and "Create" looks broken unless it says why.
function renderAvatarHint({ signedIn, rosterFailed, ownedCount }) {
	if (!avatarHint) return;
	if (rosterFailed) {
		avatarHint.innerHTML = 'Your saved avatars could not be loaded. The default avatar and a pasted URL still work.';
		return;
	}
	if (!signedIn) {
		avatarHint.innerHTML = '<a href="/login">Sign in</a> to pick from your saved avatars, or walk in with the default.';
		return;
	}
	if (!ownedCount) {
		avatarHint.innerHTML = 'No saved avatars yet. <a href="/create">Create one</a> and it shows up here.';
		return;
	}
	avatarHint.textContent = '';
}

// Paste a direct GLB / VRM / Ready Player Me URL.
function setAvatarUrlMessage(text, ok = false) {
	if (!avatarUrlError) return;
	avatarUrlError.textContent = text;
	avatarUrlError.classList.toggle('is-ok', ok && !!text);
}

if (avatarUrlInput) {
	const apply = () => {
		const url = avatarUrlInput.value.trim();
		if (!url) {
			avatarUrlInput.classList.remove('is-error');
			setAvatarUrlMessage('');
			return;
		}
		// A silent red border tells the visitor nothing. Say what is wrong and what
		// a working value looks like.
		if (!/^https?:\/\//i.test(url)) {
			avatarUrlInput.classList.add('is-error');
			setAvatarUrlMessage('Enter a full https:// link to a .glb or .gltf file.');
			return;
		}
		avatarUrlInput.classList.remove('is-error');
		setAvatarUrlMessage('Custom avatar selected.', true);
		selectedAvatar = { kind: 'url', value: url, label: 'Custom', thumb: '' };
		try { localStorage.setItem(AVATAR_CHOICE_KEY, JSON.stringify(selectedAvatar)); } catch {}
		// Reflect the choice: clear chip highlight (none of the chips own a URL).
		for (const el of avatarRow.querySelectorAll('.avatar-chip')) el.classList.remove('is-selected');
	};
	avatarUrlInput.addEventListener('change', apply);
	avatarUrlInput.addEventListener('blur', apply);
	// Clear a stale complaint as soon as the visitor starts fixing the value.
	avatarUrlInput.addEventListener('input', () => {
		if (!avatarUrlInput.classList.contains('is-error')) return;
		avatarUrlInput.classList.remove('is-error');
		setAvatarUrlMessage('');
	});
}

// ── Hand-off into the world ────────────────────────────────────────────────
function enterWorld(coin) {
	// coin: null → mainland (shared world); else { mint, name, symbol, image }
	const p = new URLSearchParams();
	if (coin?.mint) {
		p.set('coin', coin.mint);
		if (coin.name) p.set('coinName', coin.name.slice(0, 48));
		if (coin.symbol) p.set('coinSymbol', coin.symbol.slice(0, 16));
		if (coin.image) p.set('coinImage', coin.image.slice(0, 1024));
	}
	const name = nameInput.value.trim().slice(0, 24);
	if (name) { p.set('name', name); try { localStorage.setItem(NAME_STORAGE_KEY, name); } catch {} }
	if (selectedAvatar.kind === 'id') p.set('avatar', selectedAvatar.value);
	else if (selectedAvatar.kind === 'url') p.set('avatarUrl', selectedAvatar.value);
	location.href = `/temporary?${p.toString()}`;
}

// ── Coin grid ──────────────────────────────────────────────────────────────
function fmtMcap(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return '';
	if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
	return `$${n.toFixed(0)}`;
}

function coinCard(coin) {
	const mint = coin.mint;
	const symbol = coin.symbol || '';
	const name = coin.name || symbol || `${mint.slice(0, 4)}…`;
	// Coin art comes from whatever host the launch used: IPFS gateways,
	// imagedelivery.net, gmgn.ai. Hot-linked they fail in the browser (ORB, or a
	// Cross-Origin-Resource-Policy that refuses a cross-site load), leaving a
	// broken tile on the coin grid. /api/img fetches them server-side, follows a
	// metadata document to the real art, and always hands back a valid image.
	const image = proxiedImageURL(coin.image_uri || '', coin.mint || '');
	const mcap = fmtMcap(coin.usd_market_cap ?? coin.market_cap);

	const card = document.createElement('button');
	card.type = 'button';
	card.className = 'coin-card';
	card.innerHTML = `
		<span class="coin-thumb">${image
			? `<img src="${escAttr(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="keep" data-fallback-parent-class="no-img" />`
			: ''}<span class="coin-thumb-fallback">${esc((symbol || name).slice(0, 3).toUpperCase())}</span></span>
		<span class="coin-info">
			<span class="coin-symbol">$${esc(symbol || '—')}</span>
			<span class="coin-name">${esc(name)}</span>
		</span>
		${mcap ? `<span class="coin-mcap">${mcap}</span>` : ''}
		<span class="coin-enter">View →</span>`;
	// Cards open the coin's profile; the profile has the "Enter 3D world" CTA.
	card.addEventListener('click', () => navTo(`/communities/${mint}`));
	return card;
}

function renderCoins(coins) {
	coinGrid.innerHTML = '';
	coinGrid.setAttribute('aria-busy', 'false');
	const usable = (coins || []).filter((c) => c && c.mint && MINT_RE.test(c.mint));
	if (!usable.length) {
		coinGrid.innerHTML = `<div class="coin-empty">No coins matched. Try a different search, or paste a mint address below.</div>`;
		return;
	}
	const frag = document.createDocumentFragment();
	for (const c of usable) frag.appendChild(coinCard(c));
	coinGrid.appendChild(frag);
}

function renderSkeleton(n = 12) {
	coinGrid.innerHTML = '';
	coinGrid.setAttribute('aria-busy', 'true');
	for (let i = 0; i < n; i++) {
		const sk = document.createElement('div');
		sk.className = 'coin-card is-skeleton';
		sk.innerHTML = `<span class="coin-thumb"></span><span class="coin-info"><span class="sk sk-a"></span><span class="sk sk-b"></span></span>`;
		coinGrid.appendChild(sk);
	}
}

function renderCoinError() {
	coinGrid.setAttribute('aria-busy', 'false');
	coinGrid.innerHTML = `
		<div class="coin-empty">
			<p>Couldn't reach the pump.fun feed.</p>
			<button type="button" id="coin-retry" class="ghost-btn">Retry</button>
			<p class="coin-empty-sub">Or paste any mint address below to drop into its world directly.</p>
		</div>`;
	$('coin-retry')?.addEventListener('click', loadTrending);
}

async function loadTrending() {
	renderSkeleton();
	try {
		const r = await fetch('/api/pump/trending?limit=48&rich=1', { headers: { accept: 'application/json' } });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		renderCoins(Array.isArray(data) ? data : data?.data || data?.coins || []);
	} catch (err) {
		log.warn('[communities] trending failed:', err?.message ?? err);
		renderCoinError();
	}
}

// Debounced search → /api/pump/search, falling back to trending when cleared.
let searchTimer = null;
let searchSeq = 0;
if (searchInput) {
	searchInput.addEventListener('input', () => {
		const q = searchInput.value.trim();
		clearTimeout(searchTimer);
		if (!q) { loadTrending(); return; }
		searchTimer = setTimeout(async () => {
			const seq = ++searchSeq;
			renderSkeleton(6);
			try {
				const r = await fetch(`/api/pump/search?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
				if (seq !== searchSeq) return; // a newer query superseded this one
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				const data = await r.json();
				renderCoins(Array.isArray(data) ? data : data?.coins || []);
			} catch {
				if (seq === searchSeq) renderCoinError();
			}
		}, 280);
	});
}

// ── Enter any mint directly ────────────────────────────────────────────────
function enterByMint() {
	const mint = mintInput.value.trim();
	if (!MINT_RE.test(mint)) {
		mintError.textContent = 'That doesn’t look like a Solana mint address.';
		mintInput.classList.add('is-error');
		return;
	}
	mintError.textContent = '';
	mintInput.classList.remove('is-error');
	enterWorld({ mint });
}
if (mintBtn) mintBtn.addEventListener('click', enterByMint);
if (mintInput) mintInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterByMint(); });

// Mainland card (shared world, no coin).
$('enter-mainland')?.addEventListener('click', () => enterWorld(null));

// ── Coin profile (deep-linkable at /communities/:mint) ─────────────────────
// Card clicks land here instead of jumping straight into the world. The
// profile pulls real pump.fun data — coin meta, live price + graduation, and
// recent trades — and offers the "Enter 3D world" hand-off as the primary CTA.

const heroEl = document.querySelector('.hero');
const browseEl = document.querySelector('main.wrap:not(.coin-profile)');
const profileEl = $('coin-profile');

let _coinProfileMint = null;

function navTo(path, replace = false) {
	const url = new URL(path, location.origin);
	if (replace) history.replaceState({}, '', url);
	else history.pushState({}, '', url);
	routeView();
}

function routeView() {
	const m = location.pathname.match(/^\/communities\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
	const showProfile = !!m;
	if (heroEl) heroEl.hidden = showProfile;
	if (browseEl) browseEl.hidden = showProfile;
	if (profileEl) profileEl.hidden = !showProfile;
	if (showProfile) {
		window.scrollTo(0, 0);
		loadCoinProfile(m[1]);
	} else {
		_coinProfileMint = null;
		// Back to the browse view: the coin's title no longer describes the page.
		releasePageTitle();
	}
}
window.addEventListener('popstate', routeView);

function fmtPrice(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return '';
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n >= 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toExponential(2)}`;
}

function fmtAge(ts) {
	// pump.fun returns unix seconds (created_timestamp) or ISO strings (trades).
	let ms;
	if (typeof ts === 'number' || /^\d+$/.test(String(ts))) {
		const t = Number(ts);
		if (!Number.isFinite(t) || t <= 0) return '';
		ms = t < 1e12 ? t * 1000 : t;
	} else {
		ms = new Date(ts).getTime();
		if (!Number.isFinite(ms)) return '';
	}
	const sec = (Date.now() - ms) / 1000;
	if (sec < 60) return 'just now';
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}

function shortAddr(a) { return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : ''; }

async function loadCoinProfile(mint, { force = false } = {}) {
	// Retry re-requests the mint the page is already showing, so the
	// already-loaded guard has to yield to an explicit retry or the button is
	// dead on exactly the failure it exists for.
	if (_coinProfileMint === mint && !force) return;
	_coinProfileMint = mint;

	$('coin-profile-skeleton').hidden = false;
	$('coin-profile-body').hidden = true;
	$('coin-profile-empty').hidden = true;

	let coin = null;
	let loadFailed = false;
	try {
		const r = await fetch(`/api/pump/coin?mint=${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' } });
		if (r.ok) coin = await r.json();
		// A 5xx (or any non-404 non-ok) is a transient failure, not a real "missing
		// coin" — track it so we offer a retry instead of a misleading "not found".
		else if (r.status !== 404) loadFailed = true;
	} catch (err) {
		loadFailed = true;
		log.warn('[communities] coin profile', err?.message ?? err);
	}

	// User may have navigated away during the fetch.
	if (_coinProfileMint !== mint) return;

	if (!coin || !coin.mint) {
		$('coin-profile-skeleton').hidden = true;
		$('coin-profile-empty').hidden = false;
		$('coin-profile-empty-mint').textContent = mint;
		const retryBtn = $('coin-profile-retry');
		if (loadFailed) {
			// Couldn't reach the feed — distinguish from a genuine 404 and let the
			// user retry the same mint without re-navigating.
			claimI18n($('coin-profile-empty-msg'), 'Couldn’t load this coin right now.');
			setPageTitle('Couldn’t load coin · three.ws');
			if (retryBtn) {
				retryBtn.hidden = false;
				retryBtn.onclick = () => loadCoinProfile(mint, { force: true });
			}
		} else {
			releaseI18n($('coin-profile-empty-msg'));
			setPageTitle('Coin not found · three.ws');
			if (retryBtn) retryBtn.hidden = true;
		}
		return;
	}
	const retryBtn = $('coin-profile-retry');
	if (retryBtn) retryBtn.hidden = true;

	renderCoinProfile(coin);
	// Live market data + trades enrich the page once the core render is up.
	loadCoinMarket(mint);
	loadCoinTrades(mint);
}

function renderCoinProfile(coin) {
	const symbol = coin.symbol || '';
	const name = coin.name || symbol || `${coin.mint.slice(0, 4)}…`;
	// Raw for the /walk hand-off (that world resolves art its own way); proxied
	// for what this page paints, so a hot-linked host cannot break the tile.
	const image = coin.image_uri || coin.image || '';
	const imageSrc = proxiedImageURL(image, coin.mint || '');

	const avatarEl = $('cp-avatar');
	const fallback = $('cp-avatar-fallback');
	avatarEl.querySelectorAll('img').forEach((el) => el.remove());
	if (imageSrc) {
		const img = document.createElement('img');
		img.src = imageSrc; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
		img.onerror = () => img.remove();
		avatarEl.appendChild(img);
	}
	fallback.textContent = (symbol || name).slice(0, 3).toUpperCase();

	$('cp-symbol').textContent = `$${symbol || '—'}`;
	$('cp-name').textContent = name;

	const mintBtn = $('cp-mint');
	mintBtn.textContent = shortAddr(coin.mint);
	mintBtn.onclick = () => {
		navigator.clipboard?.writeText(coin.mint).then(() => {
			mintBtn.textContent = 'Copied ✓';
			mintBtn.classList.add('copied');
			setTimeout(() => { mintBtn.textContent = shortAddr(coin.mint); mintBtn.classList.remove('copied'); }, 1500);
		});
	};

	// Core stats from the coin record; price/graduation arrive via loadCoinMarket.
	const mcap = fmtMcap(coin.usd_market_cap ?? coin.market_cap);
	$('cp-stats').innerHTML = [
		mcap ? statHtml('Market cap', mcap, true) : '',
		statHtml('Price', '—', false, 'cp-stat-price'),
		statHtml('Created', fmtAge(coin.created_timestamp) || '—'),
		coin.reply_count != null ? statHtml('Replies', String(coin.reply_count)) : '',
	].filter(Boolean).join('');

	const descEl = $('cp-desc');
	if (coin.description) { descEl.hidden = false; descEl.textContent = coin.description; }
	else descEl.hidden = true;

	// Actions.
	$('cp-enter').onclick = () => enterWorld({ mint: coin.mint, name, symbol, image });
	$('cp-pumpfun').href = `https://pump.fun/${coin.mint}`;
	const shareBtn = $('cp-share');
	shareBtn.onclick = async () => {
		const url = location.href;
		const title = `$${symbol || name} on three.ws`;
		const text = `Join the ${name} community in 3D on three.ws`;
		if (navigator.share) { try { await navigator.share({ title, text, url }); return; } catch {} }
		try {
			await navigator.clipboard.writeText(url);
			claimI18n(shareBtn, 'Link copied ✓');
			setTimeout(() => releaseI18n(shareBtn), 1500);
		} catch {
			// Clipboard denied (permission or an insecure origin): the address bar
			// already holds the shareable URL, so say that instead of failing mute.
			claimI18n(shareBtn, 'Copy the page URL');
			setTimeout(() => releaseI18n(shareBtn), 2500);
		}
	};

	// Social links when pump.fun provides them.
	const socials = [];
	if (coin.twitter) socials.push(['Twitter', coin.twitter]);
	if (coin.telegram) socials.push(['Telegram', coin.telegram]);
	if (coin.website) socials.push(['Website', coin.website]);
	$('cp-socials').innerHTML = socials
		.map(([label, href]) => `<a class="cp-social" href="${escAttr(safeUrl(href))}" target="_blank" rel="noopener">${esc(label)} ↗</a>`)
		.join('');

	$('coin-profile-skeleton').hidden = true;
	$('coin-profile-body').hidden = false;

	setPageTitle(`$${symbol || name} · Coin Communities · three.ws`);
}

function statHtml(label, value, up = false, id = '') {
	return `<div class="cp-stat">
		<div class="cp-stat-label">${esc(label)}</div>
		<div class="cp-stat-value${up ? ' up' : ''}"${id ? ` id="${id}"` : ''}>${esc(value)}</div>
	</div>`;
}

async function loadCoinMarket(mint) {
	try {
		const r = await fetch(`/api/pump/curve?mint=${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' } });
		if (!r.ok) return;
		const data = await r.json();
		if (_coinProfileMint !== mint) return;

		// Graduated coins carry no bonding-curve price object; their live DEX price
		// arrives under graduatedPrice instead. Prefer the curve price, fall back.
		const usd = data?.price?.usdPrice ?? data?.graduatedPrice?.priceUsd;
		const priceEl = $('cp-stat-price');
		if (priceEl && usd) priceEl.textContent = fmtPrice(usd) || priceEl.textContent;

		// Graduation comes as progressBps (0–10000) + isGraduated.
		const g = data?.graduation || {};
		const bps = Number(g.progressBps);
		const gradWrap = $('cp-graduation');
		if (gradWrap && Number.isFinite(bps)) {
			const pct = Math.max(0, Math.min(100, bps / 100));
			gradWrap.hidden = false;
			$('cp-grad-ring').style.setProperty('--pct', `${pct.toFixed(0)}%`);
			$('cp-grad-pct').textContent = g.isGraduated ? '✓' : `${pct.toFixed(0)}%`;
			const lbl = gradWrap.querySelector('.cp-grad-label');
			if (g.isGraduated) claimI18n(lbl, 'graduated');
			else releaseI18n(lbl);
		}
	} catch (err) {
		log.warn('[communities] coin market', err?.message ?? err);
	}
}

async function loadCoinTrades(mint) {
	const wrap = $('cp-trades-wrap');
	const list = $('cp-trades');
	try {
		const r = await fetch(`/api/pump/coin-trades?mint=${encodeURIComponent(mint)}&limit=20`, { headers: { accept: 'application/json' } });
		if (!r.ok) return;
		const data = await r.json();
		if (_coinProfileMint !== mint) return;
		const trades = Array.isArray(data?.trades) ? data.trades : [];
		if (!trades.length) return;

		// Price fallback: graduated coins have no bonding-curve price, so use the
		// most recent trade's USD price if loadCoinMarket left the stat empty.
		const priceEl = $('cp-stat-price');
		if (priceEl && (!priceEl.textContent || priceEl.textContent === '…' || priceEl.textContent === '—')) {
			const last = trades.find((t) => Number(t.price_usd) > 0);
			if (last) priceEl.textContent = fmtPrice(last.price_usd) || '—';
		}

		list.innerHTML = trades.map((t) => {
			const buy = !!t.is_buy;
			const usd = Number(t.usd_amount);
			const amt = Number.isFinite(usd) && usd > 0 ? fmtMcap(usd) : `${Number(t.sol_amount || 0).toFixed(3)} SOL`;
			return `<div class="cp-trade">
				<span class="cp-trade-side ${buy ? 'buy' : 'sell'}">${buy ? 'Buy' : 'Sell'}</span>
				<span class="cp-trade-user">${esc(shortAddr(t.user || ''))}</span>
				<span class="cp-trade-amt">${esc(amt)}</span>
				<span class="cp-trade-time">${esc(fmtAge(t.timestamp))}</span>
			</div>`;
		}).join('');
		$('cp-trades-hint').textContent = `Last ${trades.length}`;
		wrap.hidden = false;
	} catch (err) {
		log.warn('[communities] coin trades', err?.message ?? err);
	}
}

$('coin-profile-back')?.addEventListener('click', () => navTo('/communities'));

// ── helpers ────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// ── boot ───────────────────────────────────────────────────────────────────
initAvatars();
loadTrending();
routeView();
