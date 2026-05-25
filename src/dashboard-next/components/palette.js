// dashboard-next — command palette.
//
// Full-featured palette: fuzzy search across navigation, recent pages,
// hardcoded actions, live avatar search, and help/doc shortcuts.
// Mounted once by shell.js via mountPaletteBehavior(). Opens on the
// 'dn:palette:open' event (the topbar's ⌘K handler dispatches it).

import { NAV, ICONS, currentRoute } from '../nav.js';
import { esc, get, post, relTime, getMe } from '../api.js';

const RECENT_KEY = 'dn:recent';
const RECENT_LIMIT = 6;
const AVATAR_DEBOUNCE_MS = 200;
const AVATAR_FETCH_LIMIT = 50;

// ── Static items ──────────────────────────────────────────────────────────────

const ACTIONS = [
	{ id: 'upload-glb',   label: 'Upload a GLB',       group: 'Create',     glyph: '⬆',
	  run: () => { location.href = '/create'; } },
	{ id: 'selfie',       label: 'Create from selfie', group: 'Create',     glyph: '📷',
	  run: () => { location.href = '/create/selfie'; } },
	{ id: 'new-widget',   label: 'New widget',         group: 'Distribute', glyph: '✦',
	  run: () => { location.href = '/widget-studio'; } },
	{ id: 'new-api-key',  label: 'Issue API key',      group: 'Distribute', glyph: '🔑',
	  run: () => { window.dispatchEvent(new CustomEvent('dn:action:new-api-key')); } },
	{ id: 'sign-out',     label: 'Sign out',           group: 'Account',    glyph: '↩',
	  run: async () => {
	  	try { await post('/api/auth/logout', {}); }
	  	catch { /* destination matters more than the response */ }
	  	location.href = '/';
	  } },
];

const DOCS = [
	{ id: 'docs-home', label: 'Docs home',     group: 'Help', glyph: '📖', href: '/docs' },
	{ id: 'docs-8004', label: 'ERC-8004 spec', group: 'Help', glyph: '🔗', href: 'https://eips.ethereum.org/EIPS/eip-8004', external: true },
	{ id: 'docs-api',  label: 'API reference', group: 'Help', glyph: '📘', href: '/docs/api' },
];

// ── Module state ──────────────────────────────────────────────────────────────

let overlayEl = null;
let listEl = null;
let inputEl = null;
let activeItems = [];
let activeIndex = 0;

let avatarCache = null;
let avatarFetchInFlight = null;
let avatarDebounceTimer = 0;
let lastFocusedBeforeOpen = null;

// ── Recent history ────────────────────────────────────────────────────────────

function loadRecent() {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		const arr = raw ? JSON.parse(raw) : [];
		return Array.isArray(arr) ? arr : [];
	} catch { return []; }
}

function saveRecent(arr) {
	try { localStorage.setItem(RECENT_KEY, JSON.stringify(arr)); }
	catch { /* private mode — ignore */ }
}

function recordRecent() {
	const here = currentRoute(location.pathname);
	if (!here) return;
	const existing = loadRecent().filter((r) => r.path !== here.path);
	const next = [{ path: here.path, label: here.label, group: here.group, icon: here.icon, ts: Date.now() }, ...existing]
		.slice(0, RECENT_LIMIT);
	saveRecent(next);
}

// ── Fuzzy scorer ──────────────────────────────────────────────────────────────

function score(query, text) {
	const q = String(query || '').toLowerCase();
	const t = String(text || '').toLowerCase();
	if (!q) return 1;
	if (t === q) return 3;
	if (t.startsWith(q)) return 2;
	if (t.includes(q)) return 1;
	let qi = 0;
	for (const c of t) { if (c === q[qi]) qi++; }
	return qi === q.length ? 0.5 : 0;
}

function scoreItem(query, item) {
	const haystacks = [item.label, item.group, ...(item.tags || [])].filter(Boolean);
	let best = 0;
	for (const h of haystacks) { const s = score(query, h); if (s > best) best = s; }
	return best;
}

// ── Avatar search ─────────────────────────────────────────────────────────────

async function ensureAvatarFetch() {
	if (avatarCache || avatarFetchInFlight) return avatarFetchInFlight;
	// /api/auth/me returns 200 with `{ user: null }` for anonymous visitors,
	// so check for an actual id before issuing the avatars request.
	const me = await getMe();
	const signedIn = !!(me && (me.id || me.user?.id));
	if (!signedIn) { avatarCache = []; return avatarCache; }
	setSpinner(true);
	avatarFetchInFlight = get(`/api/avatars?limit=${AVATAR_FETCH_LIMIT}`)
		.then((res) => {
			avatarCache = Array.isArray(res?.avatars) ? res.avatars : [];
			return avatarCache;
		})
		.catch(() => { avatarCache = []; return avatarCache; })
		.finally(() => {
			avatarFetchInFlight = null;
			setSpinner(false);
			if (overlayEl?.style.display === 'flex') render(inputEl.value);
		});
	return avatarFetchInFlight;
}

function avatarItems(query) {
	if (!query || query.length <= 2) return [];
	if (!avatarCache) return [];
	const matches = [];
	for (const a of avatarCache) {
		const name = a.name || a.slug || a.id;
		const s = score(query, name);
		if (s > 0) matches.push({ score: s, avatar: a, name });
	}
	matches.sort((a, b) => b.score - a.score);
	return matches.slice(0, 5).map(({ avatar, name }) => ({
		id: `avatar-${avatar.id}`,
		label: name,
		sublabel: 'Open avatar',
		group: 'Avatars',
		glyph: '👤',
		kind: 'avatar',
		href: avatar.slug ? `/a/${encodeURIComponent(avatar.slug)}` : `/avatar-page.html?id=${encodeURIComponent(avatar.id)}`,
	}));
}

// ── Overlay construction ──────────────────────────────────────────────────────

function injectStylesOnce() {
	if (document.getElementById('dn-palette-style')) return;
	const style = document.createElement('style');
	style.id = 'dn-palette-style';
	style.textContent = `
		#dn-palette { animation: dn-palette-fade 120ms ease-out; }
		@keyframes dn-palette-fade { from { opacity: 0; } to { opacity: 1; } }
		#dn-palette .dn-pal-spinner {
			width: 12px; height: 12px; border-radius: 50%;
			border: 2px solid var(--nxt-stroke); border-top-color: var(--nxt-accent);
			animation: dn-pal-spin 0.7s linear infinite;
			display: none;
		}
		#dn-palette[data-loading="true"] .dn-pal-spinner { display: inline-block; }
		@keyframes dn-pal-spin { to { transform: rotate(360deg); } }
		#dn-palette .dn-pal-item:hover { background: var(--nxt-accent-soft); }
		#dn-palette .dn-pal-item[data-active="true"] { background: var(--nxt-accent-soft); }
		#dn-palette .dn-pal-item[data-active="true"] .dn-pal-icon { color: var(--nxt-accent); }
		#dn-palette .dn-pal-icon svg { width: 16px; height: 16px; display: block; }
	`;
	document.head.appendChild(style);
}

function ensureOverlay() {
	if (overlayEl) return overlayEl;
	injectStylesOnce();
	overlayEl = document.createElement('div');
	overlayEl.id = 'dn-palette';
	overlayEl.setAttribute('role', 'dialog');
	overlayEl.setAttribute('aria-modal', 'true');
	overlayEl.setAttribute('aria-label', 'Command palette');
	overlayEl.style.cssText = `
		position: fixed; inset: 0; z-index: 100;
		background: rgba(2, 3, 6, 0.6);
		backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
		display: none; align-items: flex-start; justify-content: center;
		padding-top: 12vh;
	`;
	overlayEl.innerHTML = `
		<div style="
			width: min(580px, 92vw);
			background: linear-gradient(180deg, rgba(28,29,39,0.97), rgba(18,19,26,0.97));
			border: 1px solid var(--nxt-stroke-strong);
			border-radius: var(--nxt-radius);
			box-shadow: 0 30px 80px rgba(0,0,0,0.6);
			overflow: hidden;
			display: flex; flex-direction: column;
		">
			<div style="display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid var(--nxt-stroke)">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:var(--nxt-ink-dim);flex:0 0 auto"><circle cx="7" cy="7" r="4.5"/><path d="M13 13l-2.6-2.6"/></svg>
				<input type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
					placeholder="Search or jump to…"
					data-role="palette-input"
					aria-label="Search or jump to"
					style="
						flex: 1; min-width: 0;
						background: transparent; border: 0; outline: none;
						padding: 16px 0;
						font: 16px/1.4 'Inter', system-ui, sans-serif;
						color: var(--nxt-ink);
					" />
				<span class="dn-pal-spinner" aria-hidden="true"></span>
				<kbd style="
					font: 11px/1 'Inter',system-ui,sans-serif;
					color: var(--nxt-ink-fade);
					border: 1px solid var(--nxt-stroke);
					border-radius: 4px; padding: 2px 6px;
					background: var(--nxt-bg-2);
				">⌘K</kbd>
			</div>
			<div data-role="palette-list" role="listbox" style="max-height:60vh;overflow-y:auto;padding:6px"></div>
		</div>`;
	document.body.appendChild(overlayEl);

	listEl  = overlayEl.querySelector('[data-role="palette-list"]');
	inputEl = overlayEl.querySelector('[data-role="palette-input"]');

	overlayEl.addEventListener('mousedown', (e) => {
		if (e.target === overlayEl) close();
	});
	inputEl.addEventListener('input', onInput);
	overlayEl.addEventListener('keydown', onKeydown);
	listEl.addEventListener('click', (e) => {
		const btn = e.target.closest?.('[data-pal-index]');
		if (btn) activate(Number(btn.getAttribute('data-pal-index')));
	});
	listEl.addEventListener('mousemove', (e) => {
		const btn = e.target.closest?.('[data-pal-index]');
		if (!btn) return;
		const idx = Number(btn.getAttribute('data-pal-index'));
		if (idx !== activeIndex) { activeIndex = idx; paintActive(); }
	});

	return overlayEl;
}

function setSpinner(on) {
	if (overlayEl) overlayEl.setAttribute('data-loading', on ? 'true' : 'false');
}

// ── Event handlers ────────────────────────────────────────────────────────────

function onInput(e) {
	const q = e.target.value;
	if (q.length > 2 && !avatarCache && !avatarFetchInFlight) {
		clearTimeout(avatarDebounceTimer);
		avatarDebounceTimer = setTimeout(ensureAvatarFetch, AVATAR_DEBOUNCE_MS);
	}
	render(q);
}

function onKeydown(e) {
	if (e.key === 'Escape')    { e.preventDefault(); close(); return; }
	if (e.key === 'ArrowDown') { e.preventDefault(); move(1);  return; }
	if (e.key === 'ArrowUp')   { e.preventDefault(); move(-1); return; }
	if (e.key === 'Enter')     { e.preventDefault(); activate(activeIndex); return; }
}

function move(delta) {
	if (!activeItems.length) return;
	activeIndex = (activeIndex + delta + activeItems.length) % activeItems.length;
	paintActive();
	const el = listEl.querySelector(`[data-pal-index="${activeIndex}"]`);
	if (el) el.scrollIntoView({ block: 'nearest' });
}

function paintActive() {
	listEl.querySelectorAll('[data-pal-index]').forEach((el) => {
		const on = Number(el.getAttribute('data-pal-index')) === activeIndex;
		el.setAttribute('data-active', on ? 'true' : 'false');
		el.setAttribute('aria-selected', on ? 'true' : 'false');
	});
}

function activate(idx) {
	const item = activeItems[idx];
	if (!item) return;
	close();
	if (item.run) { item.run(); return; }
	if (item.href) {
		if (item.external) window.open(item.href, '_blank', 'noopener,noreferrer');
		else location.href = item.href;
	}
}

// ── Item collation ────────────────────────────────────────────────────────────

function navItems() {
	return NAV.map((r) => ({
		id: `nav-${r.path}`,
		label: r.label,
		group: r.group,
		icon: r.icon,
		tags: r.tags,
		kind: 'nav',
		href: r.path,
	}));
}

function actionItems() {
	return ACTIONS.map((a) => ({
		id: `act-${a.id}`,
		label: a.label,
		group: a.group,
		glyph: a.glyph,
		kind: 'action',
		run: a.run,
	}));
}

function docItems() {
	return DOCS.map((d) => ({
		id: `doc-${d.id}`,
		label: d.label,
		group: d.group,
		glyph: d.glyph,
		kind: 'doc',
		href: d.href,
		external: d.external,
	}));
}

function recentItems() {
	return loadRecent().map((r) => ({
		id: `rec-${r.path}`,
		label: r.label,
		group: r.group || 'Recent',
		icon: r.icon,
		kind: 'recent',
		href: r.path,
		ts: r.ts,
	}));
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderIcon(item) {
	if (item.icon && ICONS[item.icon]) {
		return `<span class="dn-pal-icon" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;color:var(--nxt-ink-dim);flex:0 0 auto">${ICONS[item.icon]}</span>`;
	}
	const glyph = item.glyph || '·';
	return `<span class="dn-pal-icon" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;color:var(--nxt-ink-dim);flex:0 0 auto;font-size:14px">${esc(glyph)}</span>`;
}

function renderItem(item, absoluteIndex) {
	const right = item.kind === 'recent' && item.ts
		? esc(relTime(new Date(item.ts).toISOString()))
		: esc(item.group || '');
	const sub = item.sublabel ? `<span style="color:var(--nxt-ink-fade);font-size:11.5px;margin-left:6px">${esc(item.sublabel)}</span>` : '';
	return `
		<div class="dn-pal-item" role="option" data-pal-index="${absoluteIndex}" data-active="false" aria-selected="false" style="
			display:flex;align-items:center;gap:12px;
			padding:10px 12px;border-radius:8px;cursor:pointer;
			color:var(--nxt-ink);font-size:13.5px;
		">
			${renderIcon(item)}
			<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.label)}${sub}</span>
			<span style="font-size:11px;color:var(--nxt-ink-fade);flex:0 0 auto">${right}</span>
		</div>`;
}

function renderSection(title, items, startIndex) {
	if (!items.length) return '';
	const body = items.map((it, i) => renderItem(it, startIndex + i)).join('');
	return `
		<div role="group" aria-label="${esc(title)}">
			<div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:var(--nxt-ink-fade);padding:10px 12px 4px">${esc(title)}</div>
			${body}
		</div>`;
}

function rankKind(kind) {
	return { action: 0, nav: 1, doc: 2, avatar: 3, recent: 4 }[kind] ?? 9;
}

function render(query) {
	const q = String(query || '').trim();
	const nav     = navItems();
	const actions = actionItems();
	const docs    = docItems();
	const recents = recentItems();
	const avatars = avatarItems(q);

	let html = '';
	activeItems = [];

	if (!q) {
		const sections = [
			['Recent',     recents.filter((r) => r.label)],
			['Navigation', nav],
			['Actions',    actions],
			['Help',       docs],
		];
		for (const [title, items] of sections) {
			if (!items.length) continue;
			html += renderSection(title, items, activeItems.length);
			activeItems.push(...items);
		}
	} else {
		const scored = [];
		for (const it of [...actions, ...nav, ...docs]) {
			const s = scoreItem(q, it);
			if (s > 0) scored.push({ s, it });
		}
		for (const it of avatars) scored.push({ s: 2, it });
		scored.sort((a, b) => {
			const kr = rankKind(a.it.kind) - rankKind(b.it.kind);
			if (kr !== 0) return kr;
			return b.s - a.s;
		});
		const flat = scored.map((x) => x.it);
		if (flat.length) {
			html += renderSection(`Results (${flat.length})`, flat, 0);
			activeItems.push(...flat);
		}
	}

	if (!activeItems.length) {
		html = `<div style="padding:24px;text-align:center;color:var(--nxt-ink-fade);font-size:13px">No matches.</div>`;
	}

	listEl.innerHTML = html;
	activeIndex = 0;
	paintActive();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function open() {
	const el = ensureOverlay();
	lastFocusedBeforeOpen = document.activeElement;
	inputEl.value = '';
	render('');
	el.style.display = 'flex';
	requestAnimationFrame(() => inputEl.focus());
}

function close() {
	if (overlayEl) overlayEl.style.display = 'none';
	if (lastFocusedBeforeOpen && typeof lastFocusedBeforeOpen.focus === 'function') {
		try { lastFocusedBeforeOpen.focus(); } catch { /* element gone */ }
	}
	lastFocusedBeforeOpen = null;
}

export function mountPaletteBehavior() {
	recordRecent();
	window.addEventListener('dn:palette:open', open);
	window.addEventListener('dn:palette:close', close);
}
