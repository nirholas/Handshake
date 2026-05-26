// dashboard-next — activity drawer: live feed (SSE with polling fallback).
//
// Renders a real activity stream for the signed-in user. The data source is
// /api/notifications (the user-scoped event log already wired into the rest
// of the dashboard); /api/events/stream is attempted first so future SSE
// support drops in without a code change.
//
// All work pauses while the drawer is closed — no background fetches, no
// timers — and resumes the moment the topbar toggle opens it again.

import { get, esc, relTime } from '../api.js';

const FILTERS_KEY = 'dn:drawer:filters';
const POLL_INTERVAL_MS = 8_000;
const POLL_MAX_INTERVAL_MS = 60_000;
const RELTIME_TICK_MS = 30_000;
const SSE_CONNECT_TIMEOUT_MS = 5_000;
const NOTIFICATIONS_PATH = '/api/notifications?limit=50';
const SSE_PATH = '/api/events/stream';
const SEEN_IDS_CAP = 1000;

const CATEGORIES = [
	{ key: 'widget.view',          label: 'Widget views' },
	{ key: 'widget.chat_turn',     label: 'Chat turns' },
	{ key: 'payment.received',     label: 'Payments' },
	{ key: 'avatar.updated',       label: 'Avatar edits' },
	{ key: 'withdrawal.completed', label: 'Withdrawals' },
	{ key: 'auth.signin',          label: 'Sign-ins' },
];

const TYPE_TO_CATEGORY = {
	'widget.view':                 'widget.view',
	'widget_view':                 'widget.view',
	'widget.chat_turn':            'widget.chat_turn',
	'widget_chat_turn':            'widget.chat_turn',
	'chat_turn':                   'widget.chat_turn',
	'payment.received':            'payment.received',
	'payment_received':            'payment.received',
	'skill_purchased':             'payment.received',
	'skill_purchase_confirmed':    'payment.received',
	'referral_earned':             'payment.received',
	'tip_received':                'payment.received',
	'avatar.updated':              'avatar.updated',
	'avatar_updated':              'avatar.updated',
	'avatar.created':              'avatar.updated',
	'withdrawal.completed':        'withdrawal.completed',
	'withdrawal_completed':        'withdrawal.completed',
	'withdrawal_failed':           'withdrawal.completed',
	'auth.signin':                 'auth.signin',
	'auth_signin':                 'auth.signin',
	'signin':                      'auth.signin',
};

const ICONS = {
	'widget.view':          `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>`,
	'widget.chat_turn':     `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 3v-3H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>`,
	'payment.received':     `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5v13M11 4.5H6.5a1.8 1.8 0 0 0 0 3.5h3a1.8 1.8 0 0 1 0 3.5H5"/></svg>`,
	'avatar.updated':       `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14l3-1 8-8-2-2-8 8-1 3z"/><path d="M10 4l2 2"/></svg>`,
	'withdrawal.completed': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5v6M5 7.5L8 10.5l3-3"/></svg>`,
	'auth.signin':          `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5l5.5 2v4c0 3.3-2.4 6.2-5.5 7-3.1-.8-5.5-3.7-5.5-7v-4l5.5-2z"/><path d="M5.5 8l2 2 3-3.5"/></svg>`,
	'unknown':              `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.2"/></svg>`,
};

const COLOR_FOR_CATEGORY = {
	'widget.view':          'var(--nxt-ink-dim)',
	'widget.chat_turn':     'var(--nxt-ink-dim)',
	'payment.received':     'var(--nxt-accent)',
	'avatar.updated':       'var(--nxt-ink-dim)',
	'withdrawal.completed': 'var(--nxt-accent)',
	'auth.signin':          'var(--nxt-success)',
	'unknown':              'var(--nxt-ink-dim)',
};

// ── Render: static shell ──────────────────────────────────────────────────

export function renderDrawer() {
	return `
		<aside class="dn-drawer" data-component="drawer" aria-label="Activity">
			<style>
				/* Only impose layout when the shell has opened us. Otherwise the
				   shell's display:none rule must win — without this guard the
				   drawer claims a phantom grid column and crushes the main area. */
				.dn-shell[data-drawer-open='true'] .dn-drawer { display: flex; flex-direction: column; height: 100%; }
				.dnd-head {
					padding: 16px 18px 12px;
					border-bottom: 1px solid var(--nxt-stroke);
					display: flex; align-items: flex-start; justify-content: space-between;
					gap: 12px; flex-shrink: 0;
				}
				.dnd-head h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--nxt-ink); }
				.dnd-head p { margin: 2px 0 0; font-size: 12px; color: var(--nxt-ink-dim); }
				.dnd-status {
					display: none; align-items: center; gap: 6px;
					padding: 3px 8px; border-radius: var(--nxt-radius-pill);
					font-size: 11px; line-height: 1;
					background: rgba(255, 180, 84, 0.10); color: var(--nxt-warn);
					border: 1px solid rgba(255, 180, 84, 0.18);
				}
				.dnd-status[data-state="reconnecting"] { display: inline-flex; }
				.dnd-status[data-state="ok"] {
					display: inline-flex;
					background: rgba(78, 195, 138, 0.10); color: var(--nxt-success);
					border-color: rgba(78, 195, 138, 0.18);
				}
				.dnd-status .dnd-dot {
					width: 6px; height: 6px; border-radius: 50%; background: currentColor;
					animation: dnd-pulse 1.4s ease-in-out infinite;
				}
				.dnd-status[data-state="ok"] .dnd-dot { animation: none; }
				@keyframes dnd-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

				.dnd-chips {
					display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden;
					padding: 10px 14px; border-bottom: 1px solid var(--nxt-stroke);
					scrollbar-width: thin; flex-shrink: 0;
				}
				.dnd-chips::-webkit-scrollbar { height: 4px; }
				.dnd-chips::-webkit-scrollbar-thumb { background: var(--nxt-stroke-strong); border-radius: 4px; }
				.dnd-chip {
					flex-shrink: 0; cursor: pointer; user-select: none;
					padding: 5px 11px; border-radius: var(--nxt-radius-pill);
					border: 1px solid var(--nxt-stroke);
					background: transparent; color: var(--nxt-ink-dim);
					font-size: 12px; font-weight: 500; line-height: 1.2;
					transition: color 120ms, background 120ms, border-color 120ms;
				}
				.dnd-chip:hover { color: var(--nxt-ink); border-color: var(--nxt-stroke-strong); }
				.dnd-chip[aria-pressed="true"] {
					color: var(--nxt-ink);
					background: var(--nxt-accent-soft);
					border-color: var(--nxt-accent-soft);
				}

				.dnd-list { flex: 1 1 auto; overflow-y: auto; padding: 4px 0 24px; }
				.dnd-list::-webkit-scrollbar { width: 6px; }
				.dnd-list::-webkit-scrollbar-thumb { background: var(--nxt-stroke-strong); border-radius: 6px; }

				.dnd-day {
					display: flex; align-items: center; gap: 10px;
					padding: 14px 18px 6px;
					font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
					color: var(--nxt-ink-fade); text-transform: uppercase;
				}
				.dnd-day::before, .dnd-day::after {
					content: ""; flex: 1 1 auto; height: 1px; background: var(--nxt-stroke);
				}

				.dnd-row {
					display: grid; grid-template-columns: 22px 1fr auto;
					align-items: flex-start; gap: 10px;
					padding: 12px 16px; cursor: pointer;
					transition: background 120ms;
				}
				.dnd-row:hover { background: rgba(255, 255, 255, 0.03); }
				.dnd-row[data-read="1"] .dnd-row-title { color: var(--nxt-ink-dim); font-weight: 400; }
				.dnd-row[data-read="1"] .dnd-row-icon { opacity: 0.6; }
				.dnd-row[data-fresh="1"] { animation: dnd-slide-in 200ms ease-out, dnd-highlight 1800ms ease-out; }
				@keyframes dnd-slide-in {
					from { transform: translateY(-6px); opacity: 0; }
					to   { transform: translateY(0); opacity: 1; }
				}
				@keyframes dnd-highlight {
					from { background: var(--nxt-accent-soft); }
					to   { background: transparent; }
				}
				.dnd-row-icon {
					width: 22px; height: 22px; display: inline-flex;
					align-items: center; justify-content: center;
					border-radius: 6px; flex-shrink: 0;
				}
				.dnd-row-body { min-width: 0; }
				.dnd-row-title {
					font-size: 13px; line-height: 1.35; color: var(--nxt-ink);
					font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
				}
				.dnd-row-sub {
					font-size: 12px; color: var(--nxt-ink-dim); margin-top: 2px;
					overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
				}
				.dnd-row-time {
					font-size: 11px; color: var(--nxt-ink-fade); flex-shrink: 0;
					margin-top: 2px; white-space: nowrap;
				}
				.dnd-detail {
					display: none; grid-column: 1 / -1;
					margin: 8px 0 4px; padding: 10px 12px;
					background: var(--nxt-accent-soft);
					border: 1px solid var(--nxt-stroke);
					border-radius: var(--nxt-radius-sm);
					font: 11.5px/1.5 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
					color: var(--nxt-ink-dim);
					word-break: break-all;
				}
				.dnd-row[aria-expanded="true"] .dnd-detail { display: block; }
				.dnd-detail a {
					color: var(--nxt-accent-strong); text-decoration: none;
					font-family: 'Inter', system-ui, sans-serif; font-size: 12px;
					display: inline-block; margin-top: 8px;
				}
				.dnd-detail a:hover { color: var(--nxt-ink); text-decoration: underline; }
				.dnd-detail pre {
					margin: 0; white-space: pre-wrap; color: var(--nxt-ink);
				}

				.dnd-skel-row {
					display: grid; grid-template-columns: 22px 1fr 40px;
					gap: 10px; padding: 12px 16px;
				}
			</style>

			<div class="dnd-head">
				<div>
					<h2>Activity</h2>
					<p>Live events across your account</p>
				</div>
				<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
					<span class="dnd-status" data-slot="status" data-state="">
						<span class="dnd-dot"></span><span data-slot="status-text">Reconnecting…</span>
					</span>
					<button type="button" class="dn-btn ghost" data-action="toggle-drawer" aria-label="Close activity drawer" style="padding:5px 8px">
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>
					</button>
				</div>
			</div>

			<div class="dnd-chips" role="group" aria-label="Filter activity" data-slot="chips">
				<button type="button" class="dnd-chip" data-filter="__all" aria-pressed="true">All</button>
				${CATEGORIES.map((c) => `
					<button type="button" class="dnd-chip" data-filter="${esc(c.key)}" aria-pressed="false">${esc(c.label)}</button>
				`).join('')}
			</div>

			<div class="dnd-list" data-slot="list" role="feed" aria-busy="false"></div>
		</aside>`;
}

// ── State (module-local; one drawer per page) ─────────────────────────────

const state = {
	shell:        null,
	listEl:       null,
	chipsEl:      null,
	statusEl:     null,
	statusTextEl: null,
	events:       [],         // newest first
	seenIds:      new Set(),
	filters:      new Set(),  // empty == all
	open:         false,
	loadedOnce:   false,
	tickTimer:    null,
	pollTimer:    null,
	pollDelay:    POLL_INTERVAL_MS,
	pollFails:    0,
	sse:          null,
	mode:         null,        // 'sse' | 'poll' | null
};

// ── Mount ────────────────────────────────────────────────────────────────

export function mountDrawerBehavior(shellEl) {
	state.shell        = shellEl;
	state.listEl       = shellEl.querySelector('[data-slot="list"]');
	state.chipsEl      = shellEl.querySelector('[data-slot="chips"]');
	state.statusEl     = shellEl.querySelector('[data-slot="status"]');
	state.statusTextEl = shellEl.querySelector('[data-slot="status-text"]');

	state.filters = loadFilters();
	syncChips();

	state.chipsEl.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-filter]');
		if (!btn) return;
		const key = btn.getAttribute('data-filter');
		if (key === '__all') {
			state.filters.clear();
		} else if (state.filters.has(key)) {
			state.filters.delete(key);
		} else {
			state.filters.add(key);
		}
		saveFilters(state.filters);
		syncChips();
		renderList();
	});

	state.listEl.addEventListener('click', (e) => {
		const row = e.target.closest('.dnd-row');
		if (!row) return;
		const expanded = row.getAttribute('aria-expanded') === 'true';
		row.setAttribute('aria-expanded', expanded ? 'false' : 'true');
	});

	window.addEventListener('dn:drawer:toggled', (e) => {
		const open = !!(e?.detail?.open);
		if (open === state.open) return;
		state.open = open;
		if (open) startStreaming();
		else      stopStreaming();
	});

	// Reflect whatever state the shell was mounted in (topbar fires
	// 'dn:drawer:toggled' on boot, but that may have happened before
	// our listener was attached — re-derive from the DOM).
	state.open = shellEl.getAttribute('data-drawer-open') === 'true';
	if (state.open) startStreaming();
}

// ── Filters persistence ──────────────────────────────────────────────────

function loadFilters() {
	try {
		const raw = localStorage.getItem(FILTERS_KEY);
		if (!raw) return new Set();
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return new Set();
		return new Set(arr.filter((k) => CATEGORIES.some((c) => c.key === k)));
	} catch { return new Set(); }
}

function saveFilters(set) {
	try { localStorage.setItem(FILTERS_KEY, JSON.stringify([...set])); }
	catch { /* private mode — silently skip */ }
}

function syncChips() {
	const all = state.filters.size === 0;
	for (const btn of state.chipsEl.querySelectorAll('[data-filter]')) {
		const key = btn.getAttribute('data-filter');
		const on  = key === '__all' ? all : state.filters.has(key);
		btn.setAttribute('aria-pressed', on ? 'true' : 'false');
	}
}

// ── Streaming lifecycle ──────────────────────────────────────────────────

function startStreaming() {
	if (!state.loadedOnce) renderSkeleton();
	startRelTimeTicker();
	tryConnectSSE();
}

function stopStreaming() {
	if (state.sse) { try { state.sse.close(); } catch { /* */ } state.sse = null; }
	if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
	if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
	state.mode = null;
	setStatus('');
}

function startRelTimeTicker() {
	if (state.tickTimer) return;
	state.tickTimer = setInterval(() => {
		if (!state.open) return;
		for (const el of state.listEl.querySelectorAll('[data-rel-iso]')) {
			el.textContent = relTime(el.getAttribute('data-rel-iso'));
		}
	}, RELTIME_TICK_MS);
}

// ── SSE attempt → polling fallback ───────────────────────────────────────

function tryConnectSSE() {
	if (typeof EventSource === 'undefined') { startPolling(); return; }

	let opened = false;
	let timeoutId = null;

	let es;
	try { es = new EventSource(SSE_PATH, { withCredentials: true }); }
	catch { startPolling(); return; }

	state.sse = es;
	state.mode = 'sse-trying';

	const giveUp = () => {
		if (opened) return;
		try { es.close(); } catch { /* */ }
		if (state.sse === es) state.sse = null;
		startPolling();
	};

	timeoutId = setTimeout(giveUp, SSE_CONNECT_TIMEOUT_MS);

	es.onopen = () => { /* the 5s window also requires a real message */ };

	es.onmessage = (ev) => {
		clearTimeout(timeoutId);
		opened = true;
		state.mode = 'sse';
		setStatus('ok');
		handleIncoming(parseSSE(ev.data));
	};

	for (const t of [
		'widget.view', 'widget.chat_turn', 'payment.received',
		'avatar.updated', 'withdrawal.completed', 'auth.signin',
	]) {
		es.addEventListener(t, (ev) => {
			clearTimeout(timeoutId);
			opened = true;
			state.mode = 'sse';
			setStatus('ok');
			handleIncoming(parseSSE(ev.data, t));
		});
	}

	es.onerror = () => {
		clearTimeout(timeoutId);
		if (!opened) giveUp();
		else {
			// Connection dropped after working — fall back to poll.
			try { es.close(); } catch { /* */ }
			state.sse = null;
			setStatus('reconnecting');
			startPolling();
		}
	};
}

function parseSSE(raw, typeOverride) {
	try {
		const obj = JSON.parse(raw);
		if (typeOverride && !obj.type) obj.type = typeOverride;
		return obj;
	} catch {
		return { id: 'sse_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
			type: typeOverride || 'unknown', payload: { raw },
			created_at: new Date().toISOString() };
	}
}

function startPolling() {
	if (!state.open) return;
	state.mode = 'poll';
	pollOnce();
}

async function pollOnce() {
	if (!state.open) return;
	let scheduleNext = true;
	try {
		const data = await get(NOTIFICATIONS_PATH);
		const list = Array.isArray(data?.notifications) ? data.notifications : [];
		const incoming = list.map(normalizeNotification).filter(Boolean);
		// Newest-first from server; insert oldest-first so animations show newest top.
		for (let i = incoming.length - 1; i >= 0; i -= 1) handleIncoming(incoming[i]);

		state.loadedOnce = true;
		state.pollFails = 0;
		state.pollDelay = POLL_INTERVAL_MS;
		pruneSeenIds();
		setStatus(state.events.length ? 'ok' : '');
		if (!state.events.length) renderEmpty();
	} catch (err) {
		state.pollFails += 1;
		if (state.pollFails >= 3) {
			state.pollDelay = Math.min(state.pollDelay * 2, POLL_MAX_INTERVAL_MS);
			setStatus('reconnecting');
		}
		// 401 = signed out. Don't keep nagging the server — give the user a
		// quiet "sign in" empty state instead. Polling resumes on next open.
		if (err && err.status === 401) {
			scheduleNext = false;
			state.loadedOnce = true;
			renderSignedOut();
			setStatus('');
			return;
		}
		// 404 from a missing notifications endpoint: surface the empty state
		// rather than spinning forever, but keep retrying in case the
		// endpoint comes back (handy during local backend restarts).
		if (err && err.status === 404 && !state.loadedOnce) {
			state.loadedOnce = true;
			renderEmpty();
		}
	} finally {
		if (scheduleNext && state.open) {
			state.pollTimer = setTimeout(pollOnce, state.pollDelay);
		}
	}
}

function pruneSeenIds() {
	if (state.seenIds.size <= SEEN_IDS_CAP) return;
	// Keep only IDs that correspond to events we're still rendering.
	const live = new Set(state.events.map((e) => e.id));
	state.seenIds = live;
}

// ── Event normalization ──────────────────────────────────────────────────

function normalizeNotification(n) {
	if (!n || typeof n !== 'object') return null;
	const rawType = String(n.type || '').trim();
	const category = TYPE_TO_CATEGORY[rawType] || 'unknown';
	return {
		id:         String(n.id),
		type:       rawType || 'unknown',
		category,
		payload:    n.payload && typeof n.payload === 'object' ? n.payload : {},
		created_at: n.created_at || n.timestamp || new Date().toISOString(),
		read:       Boolean(n.read_at),
	};
}

function handleIncoming(ev) {
	if (!ev || !ev.id) return;
	if (state.seenIds.has(ev.id)) return;
	state.seenIds.add(ev.id);

	if (!ev.category) ev.category = TYPE_TO_CATEGORY[ev.type] || 'unknown';

	// Insert in chronological order — newest at index 0.
	const t = +new Date(ev.created_at) || 0;
	let i = 0;
	while (i < state.events.length && (+new Date(state.events[i].created_at) || 0) >= t) i += 1;
	state.events.splice(i, 0, ev);

	ev.__fresh = state.loadedOnce; // first load batch shouldn't all flash
	renderList();
}

// ── Render: list + states ────────────────────────────────────────────────

function renderSkeleton() {
	state.listEl.setAttribute('aria-busy', 'true');
	state.listEl.innerHTML = Array.from({ length: 4 }).map(() => `
		<div class="dnd-skel-row">
			<div class="dn-skeleton" style="width:22px;height:22px;border-radius:6px"></div>
			<div>
				<div class="dn-skeleton" style="width:70%;height:11px;border-radius:4px"></div>
				<div class="dn-skeleton" style="width:45%;height:9px;border-radius:4px;margin-top:6px"></div>
			</div>
			<div class="dn-skeleton" style="width:32px;height:9px;border-radius:4px;margin-top:5px"></div>
		</div>
	`).join('');
}

function renderEmpty() {
	state.listEl.setAttribute('aria-busy', 'false');
	state.listEl.innerHTML = `
		<div class="dn-empty" style="margin:18px 16px">
			<h3>No activity yet</h3>
			<p>Embed a widget or issue an API key — events will land here as they happen.</p>
		</div>`;
}

function renderSignedOut() {
	state.listEl.setAttribute('aria-busy', 'false');
	const ret = encodeURIComponent(location.pathname + location.search);
	state.listEl.innerHTML = `
		<div class="dn-empty" style="margin:18px 16px">
			<h3>Sign in to see your activity</h3>
			<p>Your session expired or you're not signed in.</p>
			<a class="dn-btn primary" href="/login?return=${ret}" style="margin-top:10px">Sign in</a>
		</div>`;
}

function renderList() {
	state.listEl.setAttribute('aria-busy', 'false');

	const visible = state.filters.size === 0
		? state.events
		: state.events.filter((e) => state.filters.has(e.category));

	if (!visible.length) {
		if (!state.events.length) renderEmpty();
		else state.listEl.innerHTML = `
			<div class="dn-empty" style="margin:18px 16px">
				<h3>No matches</h3>
				<p>Try removing a filter chip above.</p>
			</div>`;
		return;
	}

	const grouped = groupByDay(visible);
	state.listEl.innerHTML = grouped.map((g) => `
		<div class="dnd-day"><span>${esc(g.label)}</span></div>
		${g.items.map(renderRow).join('')}
	`).join('');

	// Clear the fresh flag so re-renders don't re-trigger the highlight.
	for (const ev of state.events) ev.__fresh = false;
}

function renderRow(ev) {
	const detail = describeEvent(ev);
	const colour = COLOR_FOR_CATEGORY[ev.category] || COLOR_FOR_CATEGORY.unknown;
	const icon   = ICONS[ev.category] || ICONS.unknown;
	const fresh  = ev.__fresh ? '1' : '0';
	const read   = ev.read ? '1' : '0';
	return `
		<div class="dnd-row" role="article" aria-expanded="false" data-id="${esc(ev.id)}" data-fresh="${fresh}" data-read="${read}">
			<span class="dnd-row-icon" style="color:${colour};background:rgba(255,255,255,0.03)">${icon}</span>
			<div class="dnd-row-body">
				<div class="dnd-row-title">${esc(detail.title)}</div>
				${detail.subtitle ? `<div class="dnd-row-sub">${esc(detail.subtitle)}</div>` : ''}
			</div>
			<span class="dnd-row-time" data-rel-iso="${esc(ev.created_at)}" title="${esc(new Date(ev.created_at).toLocaleString())}">${esc(relTime(ev.created_at))}</span>
			<div class="dnd-detail">
				<pre>${esc(JSON.stringify({ id: ev.id, type: ev.type, created_at: ev.created_at, payload: ev.payload }, null, 2))}</pre>
				${detail.link ? `<a href="${esc(detail.link.href)}">${esc(detail.link.label)} →</a>` : ''}
			</div>
		</div>`;
}

// ── Event → human description ────────────────────────────────────────────

function describeEvent(ev) {
	const p = ev.payload || {};
	switch (ev.category) {
		case 'widget.view': {
			const w = p.widget_id || p.widgetId || p.widget || '';
			return {
				title:    'Widget viewed',
				subtitle: w ? String(w) : '',
				link:     w ? { label: 'Open in studio', href: `/widget-studio?id=${encodeURIComponent(w)}` } : null,
			};
		}
		case 'widget.chat_turn': {
			const msg = p.text || p.message || p.utterance || '';
			const w   = p.widget_id || p.widgetId || '';
			return {
				title:    'Chat turn',
				subtitle: msg ? `"${String(msg).slice(0, 90)}"` : '',
				link:     w ? { label: 'Open transcript', href: `/widget-studio?id=${encodeURIComponent(w)}` } : null,
			};
		}
		case 'payment.received': {
			const amount = formatAmount(p);
			const from   = p.from || p.buyer || p.payer || p.referrer || '';
			const title  = ev.type === 'referral_earned' ? 'Referral earned'
			              : ev.type === 'skill_purchased' ? 'Skill purchased'
			              : ev.type === 'skill_purchase_confirmed' ? 'Purchase confirmed'
			              : 'Payment received';
			return {
				title,
				subtitle: [amount, from && `from ${shorten(from)}`].filter(Boolean).join(' · '),
				link:     { label: 'Open monetize', href: '/dashboard/monetize' },
			};
		}
		case 'avatar.updated': {
			const id   = p.avatar_id || p.avatarId || p.id || '';
			const name = p.name || p.label || '';
			return {
				title:    'Avatar updated',
				subtitle: name || (id ? shorten(id) : ''),
				link:     id ? { label: 'Open avatar', href: `/avatars/${encodeURIComponent(id)}` }
				             : { label: 'Open avatars', href: '/dashboard/avatars' },
			};
		}
		case 'withdrawal.completed': {
			const amount = formatAmount(p);
			const status = ev.type === 'withdrawal_failed' ? 'failed' : 'completed';
			return {
				title:    `Withdrawal ${status}`,
				subtitle: amount,
				link:     { label: 'Open wallet', href: '/dashboard/wallets.html' },
			};
		}
		case 'auth.signin': {
			const ip = p.ip || p.location || '';
			return {
				title:    'Sign-in',
				subtitle: ip ? `from ${ip}` : '',
				link:     { label: 'Open sessions', href: '/dashboard/sessions.html' },
			};
		}
		default:
			return {
				title:    titleCase(ev.type),
				subtitle: shorten(JSON.stringify(p), 80),
				link:     null,
			};
	}
}

function formatAmount(p) {
	if (p.amount_usdc != null) return `$${(Number(p.amount_usdc) / 1_000_000).toFixed(2)}`;
	if (p.amount_usd  != null) return `$${Number(p.amount_usd).toFixed(2)}`;
	if (p.amount      != null) return String(p.amount);
	return '';
}

function shorten(s, n = 14) {
	const v = String(s || '');
	if (v.length <= n) return v;
	if (n <= 8) return v.slice(0, n) + '…';
	return v.slice(0, n - 6) + '…' + v.slice(-4);
}

function titleCase(s) {
	return String(s || 'Event').replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Day grouping ─────────────────────────────────────────────────────────

function groupByDay(events) {
	const groups = [];
	let current = null;
	for (const ev of events) {
		const key = dayKey(ev.created_at);
		if (!current || current.key !== key) {
			current = { key, label: dayLabel(ev.created_at), items: [] };
			groups.push(current);
		}
		current.items.push(ev);
	}
	return groups;
}

function dayKey(iso) {
	const d = new Date(iso);
	if (!Number.isFinite(d.getTime())) return 'unknown';
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso) {
	const d = new Date(iso);
	if (!Number.isFinite(d.getTime())) return 'Unknown';
	const now = new Date();
	const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
	if (sameDay) return 'Today';
	const yest = new Date(now);
	yest.setDate(now.getDate() - 1);
	if (d.getFullYear() === yest.getFullYear() && d.getMonth() === yest.getMonth() && d.getDate() === yest.getDate()) {
		return 'Yesterday';
	}
	const diffDays = Math.floor((+now - +d) / 86_400_000);
	if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

// ── Status chip ──────────────────────────────────────────────────────────

function setStatus(stateName) {
	if (!state.statusEl) return;
	state.statusEl.setAttribute('data-state', stateName || '');
	if (stateName === 'reconnecting') state.statusTextEl.textContent = 'Reconnecting…';
	else if (stateName === 'ok')      state.statusTextEl.textContent = 'Live';
}
