// /communities — the zero-friction door into three.ws coin worlds.
//
// Pick a name, drop in an avatar (or your 3D agent), choose a coin, and you're
// walked straight into that coin's multiplayer world at /walk. Each coin is its
// own room: everyone who picks the same coin lands together. The coin grid is
// real pump.fun data (/api/pump/trending + /api/pump/search); the avatar list
// is the signed-in user's real avatars (/api/avatars). No mocks, no fakes — if
// a source is empty or unreachable, the UI says so and offers a way forward.

const NAME_STORAGE_KEY = 'walk:player-name';
const AVATAR_CHOICE_KEY = 'communities:avatar-choice';
const DEFAULT_AVATAR_URL = '/avatars/default.glb';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const $ = (id) => document.getElementById(id);

const nameInput = $('name-input');
const avatarRow = $('avatar-row');
const avatarUrlInput = $('avatar-url-input');
const coinGrid = $('coin-grid');
const searchInput = $('coin-search');
const mintInput = $('mint-input');
const mintBtn = $('mint-enter');
const mintError = $('mint-error');

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
			? `<img src="${escAttr(thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`
			: `<span class="avatar-glyph">🧍</span>`}</span>
		<span class="avatar-name">${esc(label)}</span>`;
	chip.addEventListener('click', () => {
		selectedAvatar = { kind, value, label, thumb };
		try { localStorage.setItem(AVATAR_CHOICE_KEY, JSON.stringify(selectedAvatar)); } catch {}
		markSelectedAvatar();
		if (kind !== 'url' && avatarUrlInput) avatarUrlInput.value = '';
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

	// Signed-in users get their real avatars to pick from.
	try {
		const res = await fetch('/api/avatars?limit=24', { credentials: 'include' });
		if (res.ok) {
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
			}
		}
	} catch { /* not signed in / offline — default + paste still work */ }

	// "Create one" shortcut so an empty-handed user has a path to their own avatar.
	const create = document.createElement('a');
	create.className = 'avatar-chip avatar-create';
	create.href = '/create';
	create.innerHTML = `<span class="avatar-thumb"><span class="avatar-glyph">+</span></span><span class="avatar-name">Create</span>`;
	avatarRow.appendChild(create);

	markSelectedAvatar();
}

// Paste a direct GLB / VRM / Ready Player Me URL.
if (avatarUrlInput) {
	const apply = () => {
		const url = avatarUrlInput.value.trim();
		if (!url) return;
		if (!/^https?:\/\//i.test(url)) { avatarUrlInput.classList.add('is-error'); return; }
		avatarUrlInput.classList.remove('is-error');
		selectedAvatar = { kind: 'url', value: url, label: 'Custom', thumb: '' };
		try { localStorage.setItem(AVATAR_CHOICE_KEY, JSON.stringify(selectedAvatar)); } catch {}
		// Reflect the choice: clear chip highlight (none of the chips own a URL).
		for (const el of avatarRow.querySelectorAll('.avatar-chip')) el.classList.remove('is-selected');
	};
	avatarUrlInput.addEventListener('change', apply);
	avatarUrlInput.addEventListener('blur', apply);
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
	location.href = `/walk?${p.toString()}`;
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
	const image = coin.image_uri || '';
	const mcap = fmtMcap(coin.usd_market_cap ?? coin.market_cap);

	const card = document.createElement('button');
	card.type = 'button';
	card.className = 'coin-card';
	card.innerHTML = `
		<span class="coin-thumb">${image
			? `<img src="${escAttr(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('no-img')" />`
			: ''}<span class="coin-thumb-fallback">${esc((symbol || name).slice(0, 3).toUpperCase())}</span></span>
		<span class="coin-info">
			<span class="coin-symbol">$${esc(symbol || '—')}</span>
			<span class="coin-name">${esc(name)}</span>
		</span>
		${mcap ? `<span class="coin-mcap">${mcap}</span>` : ''}
		<span class="coin-enter">Enter →</span>`;
	card.addEventListener('click', () => enterWorld({ mint, name, symbol, image }));
	return card;
}

function renderCoins(coins) {
	coinGrid.innerHTML = '';
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
	for (let i = 0; i < n; i++) {
		const sk = document.createElement('div');
		sk.className = 'coin-card is-skeleton';
		sk.innerHTML = `<span class="coin-thumb"></span><span class="coin-info"><span class="sk sk-a"></span><span class="sk sk-b"></span></span>`;
		coinGrid.appendChild(sk);
	}
}

function renderCoinError() {
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
		const r = await fetch('/api/pump/trending?limit=48', { headers: { accept: 'application/json' } });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		renderCoins(Array.isArray(data) ? data : data?.coins || []);
	} catch (err) {
		console.warn('[communities] trending failed:', err?.message ?? err);
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

// ── helpers ────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// ── boot ───────────────────────────────────────────────────────────────────
initAvatars();
loadTrending();
