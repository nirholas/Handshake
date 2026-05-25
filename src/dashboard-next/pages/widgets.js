// dashboard-next — Widgets page
//
// Grid of every widget the user has configured, with live iframe previews
// (gated behind an IntersectionObserver + OG poster), per-card stats, and a
// row-level menu for studio/embed/duplicate/transcripts/delete.

import { mountShell } from '../shell.js';
import { requireUser, get, post, del, esc } from '../api.js';
import {
	sumDaily,
	formatCount,
	formatDuration,
	weightedAvgSessionSeconds,
} from './widgets-helpers.js';

const STATS_DAYS = 7;
const SKELETON_COUNT = 6;

// Module-scoped cache so card-level handlers and duplicate flows can look up
// a widget by id without re-querying the list.
const WIDGETS = new Map();

(async function boot() {
	const main = await mountShell();
	await requireUser();

	main.innerHTML = `
		<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap">
			<div style="flex:1;min-width:240px">
				<h1 class="dn-h1">Widgets</h1>
				<p class="dn-h1-sub">Embed your agents anywhere — and see how they're performing.</p>
			</div>
			<a class="dn-btn primary" href="/widget-studio">+ New widget</a>
		</div>

		<div data-slot="stat-strip" class="dn-wx-strip" hidden></div>
		<div data-slot="grid" class="dn-wx-grid"></div>

		<div class="dn-wx-popover" data-slot="popover" hidden></div>
		<div class="dn-wx-toast" data-slot="toast" hidden></div>
	`;

	injectStyles();
	await render(main);
})();

async function render(main) {
	const grid = main.querySelector('[data-slot="grid"]');
	const strip = main.querySelector('[data-slot="stat-strip"]');

	grid.innerHTML = skeletonGrid();

	let widgets;
	try {
		const res = await get('/api/widgets');
		widgets = Array.isArray(res) ? res : res?.widgets || [];
	} catch (err) {
		grid.innerHTML = errorBanner(err);
		grid.querySelector('[data-retry]')?.addEventListener('click', () => render(main));
		return;
	}

	if (!widgets.length) {
		grid.innerHTML = emptyState();
		return;
	}

	// Refresh the lookup cache; render cards immediately (poster-first, stats
	// pending in parallel below).
	WIDGETS.clear();
	for (const w of widgets) WIDGETS.set(w.id, w);
	grid.innerHTML = widgets.map(cardHtml).join('');

	wireCardBehavior(grid);
	observeIframes(grid);

	// Fetch stats per widget in parallel; update each card + the aggregate strip.
	const statsResults = await Promise.allSettled(
		widgets.map((w) =>
			get(`/api/widgets/${encodeURIComponent(w.id)}/stats?days=${STATS_DAYS}`),
		),
	);

	statsResults.forEach((r, i) => {
		const w = widgets[i];
		const card = grid.querySelector(`[data-card="${cssEscape(w.id)}"]`);
		if (!card) return;
		if (r.status === 'fulfilled') {
			applyStatsToCard(card, r.value?.stats || {});
		} else {
			markStatsFailed(card);
		}
	});

	renderStatStrip(strip, widgets.length, statsResults);
}

// ── Cards ────────────────────────────────────────────────────────────────

function cardHtml(w) {
	const poster = `/api/widgets/${encodeURIComponent(w.id)}/og`;
	const previewSrc = `/widget#widget=${encodeURIComponent(w.id)}&kiosk=true`;

	return `
		<div class="dn-wx-card dn-panel" data-card="${esc(w.id)}" data-type="${esc(w.type || '')}">
			<div class="dn-wx-frame" data-frame data-src="${esc(previewSrc)}" data-poster="${esc(poster)}">
				<div class="dn-wx-poster" data-poster-img
				     style="background-image:url('${esc(poster)}')"></div>
				<button class="dn-wx-poster-play" data-poster-play type="button" aria-label="Click to preview">
					<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>
					<span>Click to preview</span>
				</button>
			</div>
			<div class="dn-wx-body">
				<div class="dn-wx-head">
					<a class="dn-wx-name" href="/widget-studio?id=${encodeURIComponent(w.id)}" title="${esc(w.name || 'Untitled widget')}">
						${esc(w.name || 'Untitled widget')}
					</a>
					<span class="dn-tag" data-status>Idle</span>
				</div>
				<div class="dn-wx-stats">
					<div class="dn-wx-stat">
						<div class="dn-wx-stat-label">Views 7d</div>
						<div class="dn-wx-stat-val" data-stat="views"><span class="dn-skeleton" style="display:inline-block;width:32px;height:14px"></span></div>
					</div>
					<div class="dn-wx-stat">
						<div class="dn-wx-stat-label">Turns 7d</div>
						<div class="dn-wx-stat-val" data-stat="turns"><span class="dn-skeleton" style="display:inline-block;width:32px;height:14px"></span></div>
					</div>
				</div>
			</div>
			<button class="dn-wx-menu-btn" data-menu type="button"
			        aria-label="Widget menu" aria-haspopup="menu" aria-expanded="false">
				<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
					<circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/>
				</svg>
			</button>
		</div>
	`;
}

function applyStatsToCard(card, stats) {
	const views7d = sumDaily(stats.recent_views_7d);
	const turns7d = sumDaily(stats.recent_chats_7d);
	setText(card.querySelector('[data-stat="views"]'), formatCount(views7d));
	setText(card.querySelector('[data-stat="turns"]'), formatCount(turns7d));

	const last = stats.last_viewed_at ? new Date(stats.last_viewed_at).getTime() : 0;
	const active = last && Date.now() - last < 24 * 3600 * 1000;
	const badge = card.querySelector('[data-status]');
	if (badge) {
		badge.textContent = active ? 'Active' : 'Idle';
		badge.classList.toggle('success', !!active);
	}
}

function markStatsFailed(card) {
	setText(card.querySelector('[data-stat="views"]'), '—');
	setText(card.querySelector('[data-stat="turns"]'), '—');
}

// ── Aggregate stat strip ─────────────────────────────────────────────────

function renderStatStrip(strip, widgetCount, statsResults) {
	let views = 0;
	let turns = 0;
	let anyStat = false;
	const fulfilled = [];
	for (const r of statsResults) {
		if (r.status !== 'fulfilled') continue;
		anyStat = true;
		const s = r.value?.stats || {};
		fulfilled.push(s);
		views += sumDaily(s.recent_views_7d);
		turns += sumDaily(s.recent_chats_7d);
	}

	const avgSec = weightedAvgSessionSeconds(fulfilled);
	const avgSession = avgSec == null ? '—' : formatDuration(avgSec);

	const allZero = widgetCount === 0 && views === 0 && turns === 0;
	if (allZero) {
		strip.hidden = true;
		return;
	}

	const parts = [
		`<span><strong>${formatCount(widgetCount)}</strong> ${widgetCount === 1 ? 'widget' : 'widgets'}</span>`,
		`<span><strong>${anyStat ? formatCount(views) : '—'}</strong> views (7d)</span>`,
		`<span><strong>${anyStat ? formatCount(turns) : '—'}</strong> chat turns (7d)</span>`,
		`<span><strong>${avgSession}</strong> avg session</span>`,
	];
	strip.innerHTML = parts.join('<span class="dn-wx-sep">·</span>');
	strip.hidden = false;
}

// ── Card interactions (menu, popover, duplicate, delete) ─────────────────

function wireCardBehavior(grid) {
	grid.addEventListener('click', (ev) => {
		const menuBtn = ev.target.closest('[data-menu]');
		if (menuBtn) {
			ev.preventDefault();
			const card = menuBtn.closest('[data-card]');
			const w = WIDGETS.get(card?.dataset.card);
			if (w) openMenu(menuBtn, card, w);
			return;
		}

		const playBtn = ev.target.closest('[data-poster-play]');
		if (playBtn) {
			ev.preventDefault();
			const frame = playBtn.closest('[data-frame]');
			activateIframe(frame, /* force */ true);
		}
	});
}

function openMenu(anchor, card, widget) {
	closeAllMenus();
	anchor.setAttribute('aria-expanded', 'true');

	const menu = document.createElement('div');
	menu.className = 'dn-wx-menu';
	menu.setAttribute('role', 'menu');
	menu.dataset.anchor = anchor.dataset.cardAnchor || '';
	menu.innerHTML = `
		<button role="menuitem" data-act="studio">Open studio</button>
		<button role="menuitem" data-act="embed">Copy embed snippet</button>
		<button role="menuitem" data-act="duplicate">Duplicate</button>
		<button role="menuitem" data-act="transcripts">Open transcripts</button>
		<div class="dn-wx-menu-sep"></div>
		<button role="menuitem" data-act="delete" class="danger">Delete</button>
	`;
	document.body.appendChild(menu);

	const r = anchor.getBoundingClientRect();
	menu.style.top = `${Math.round(r.bottom + window.scrollY + 4)}px`;
	menu.style.left = `${Math.round(r.right + window.scrollX - menu.offsetWidth)}px`;

	const firstItem = menu.querySelector('button[role="menuitem"]');
	firstItem?.focus({ preventScroll: true });

	const dismiss = (ev) => {
		if (ev && menu.contains(ev.target)) return;
		menu.remove();
		anchor.setAttribute('aria-expanded', 'false');
		document.removeEventListener('mousedown', dismiss, true);
		document.removeEventListener('keydown', onKey, true);
	};
	const onKey = (ev) => {
		if (ev.key === 'Escape') {
			dismiss();
			anchor.focus({ preventScroll: true });
			return;
		}
		if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
			ev.preventDefault();
			const items = [...menu.querySelectorAll('button[role="menuitem"]')];
			const i = items.indexOf(document.activeElement);
			const next = ev.key === 'ArrowDown'
				? items[(i + 1 + items.length) % items.length]
				: items[(i - 1 + items.length) % items.length];
			next?.focus({ preventScroll: true });
		}
	};
	setTimeout(() => {
		document.addEventListener('mousedown', dismiss, true);
		document.addEventListener('keydown', onKey, true);
	}, 0);

	menu.addEventListener('click', async (ev) => {
		const btn = ev.target.closest('button[data-act]');
		if (!btn) return;
		const act = btn.dataset.act;
		dismiss();

		if (act === 'studio') {
			location.href = `/widget-studio?id=${encodeURIComponent(widget.id)}`;
		} else if (act === 'embed') {
			openEmbedPopover(anchor, widget);
		} else if (act === 'duplicate') {
			await duplicateWidget(card, widget);
		} else if (act === 'transcripts') {
			location.href = `/dashboard?tab=widgets&w=${encodeURIComponent(widget.id)}&pane=transcripts`;
		} else if (act === 'delete') {
			await deleteWidget(card, widget);
		}
	});
}

function closeAllMenus() {
	document.querySelectorAll('.dn-wx-menu-btn[aria-expanded="true"]').forEach((b) => {
		b.setAttribute('aria-expanded', 'false');
	});
	document.querySelectorAll('.dn-wx-menu').forEach((m) => m.remove());
	document.querySelectorAll('.dn-wx-popover.open').forEach((p) => p.classList.remove('open'));
}

async function duplicateWidget(card, widget) {
	try {
		const res = await post(`/api/widgets/${encodeURIComponent(widget.id)}/duplicate`);
		const created = res?.widget;
		if (!created) throw new Error('No widget returned');

		const grid = card.parentElement;
		WIDGETS.set(created.id, created);
		const tmp = document.createElement('div');
		tmp.innerHTML = cardHtml(created);
		const newCard = tmp.firstElementChild;
		grid.insertBefore(newCard, grid.firstChild);
		observeIframes(grid);

		// Pull stats for the new widget.
		try {
			const s = await get(
				`/api/widgets/${encodeURIComponent(created.id)}/stats?days=${STATS_DAYS}`,
			);
			applyStatsToCard(newCard, s?.stats || {});
		} catch {
			markStatsFailed(newCard);
		}

		toast('Duplicated');
	} catch (err) {
		toast(err?.message || 'Duplicate failed', true);
	}
}

async function deleteWidget(card, widget) {
	const ok = await confirmModal({
		title: 'Delete this widget?',
		body: `“${widget.name || 'Untitled widget'}” will be removed. Any sites embedding this widget will stop loading it.`,
		confirmLabel: 'Delete widget',
		danger: true,
	});
	if (!ok) return;

	const prev = card.style.cssText;
	card.style.transition = 'opacity .18s ease';
	card.style.opacity = '0.3';
	card.style.pointerEvents = 'none';

	try {
		await del(`/api/widgets/${encodeURIComponent(widget.id)}`);
		card.remove();
		toast('Deleted');
		const grid = document.querySelector('[data-slot="grid"]');
		if (grid && !grid.querySelector('[data-card]')) {
			grid.innerHTML = emptyState();
		}
	} catch (err) {
		card.style.cssText = prev;
		toast(err?.message || 'Delete failed', true);
	}
}

// ── Embed snippet popover ────────────────────────────────────────────────

function openEmbedPopover(anchor, widget) {
	closeAllMenus();

	const origin =
		location.origin && /^https?:/.test(location.origin)
			? location.origin
			: 'https://three.ws';
	const avatarId = widget.avatar?.id || widget.avatar_id || '';

	const snippets = {
		script:
			`<script async src="${origin}/embed.js"\n` +
			`        data-widget="${widget.id}"\n` +
			`        data-reveal="interaction"\n` +
			`        data-poster="auto"><\/script>`,
		iframe:
			`<iframe src="${origin}/widget#widget=${widget.id}&kiosk=true"\n` +
			`        width="600" height="600" frameborder="0"><\/iframe>`,
		webc: avatarId
			? `<threews-avatar avatar-id="${avatarId}" hide-chrome></threews-avatar>`
			: '<!-- This widget has no avatar attached. Pick one in the Studio first. -->',
	};

	const pop = document.querySelector('[data-slot="popover"]');
	pop.setAttribute('role', 'dialog');
	pop.setAttribute('aria-label', 'Embed snippet');
	pop.innerHTML = `
		<div class="dn-wx-pop-head">
			<div class="dn-wx-pop-title">Embed snippet</div>
			<button class="dn-wx-pop-close" data-close type="button" aria-label="Close">×</button>
		</div>
		<div class="dn-wx-pop-tabs" role="tablist">
			<button role="tab" data-tab="script" aria-selected="true">Script tag</button>
			<button role="tab" data-tab="iframe" aria-selected="false">iframe</button>
			<button role="tab" data-tab="webc" aria-selected="false">Web component</button>
		</div>
		<pre class="dn-wx-pop-code" data-code></pre>
		<div class="dn-wx-pop-foot">
			<span class="dn-wx-pop-hint" data-hint>Easiest — auto-loads the runtime.</span>
			<button class="dn-btn primary" data-copy type="button">Copy</button>
		</div>
	`;

	const codeEl = pop.querySelector('[data-code]');
	const hintEl = pop.querySelector('[data-hint]');
	const HINTS = {
		script: 'Easiest — auto-loads the runtime.',
		iframe: 'Maximum isolation. No JS on host page.',
		webc: 'Use after loading /embed.js once on the page.',
	};

	let activeTab = 'script';
	const paint = () => {
		codeEl.textContent = snippets[activeTab];
		hintEl.textContent = HINTS[activeTab];
		pop.querySelectorAll('[data-tab]').forEach((b) => {
			b.setAttribute('aria-selected', b.dataset.tab === activeTab ? 'true' : 'false');
		});
	};
	paint();

	pop.addEventListener('click', async (ev) => {
		const tab = ev.target.closest('[data-tab]');
		if (tab) {
			activeTab = tab.dataset.tab;
			paint();
			return;
		}
		if (ev.target.closest('[data-copy]')) {
			try {
				await navigator.clipboard.writeText(snippets[activeTab]);
				toast('Copied');
			} catch {
				toast('Copy failed — select and copy manually', true);
			}
			return;
		}
		if (ev.target.closest('[data-close]')) {
			pop.classList.remove('open');
		}
	});

	// Position near the menu anchor.
	const r = anchor.getBoundingClientRect();
	pop.classList.add('open');
	pop.hidden = false;
	// Defer measurement so the browser lays out the popover before we read its size.
	requestAnimationFrame(() => {
		const w = pop.offsetWidth;
		let left = r.right + window.scrollX - w;
		left = Math.max(12 + window.scrollX, left);
		pop.style.top = `${Math.round(r.bottom + window.scrollY + 8)}px`;
		pop.style.left = `${Math.round(left)}px`;
	});

	const dismiss = (ev) => {
		if (pop.contains(ev.target)) return;
		pop.classList.remove('open');
		document.removeEventListener('mousedown', dismiss, true);
		document.removeEventListener('keydown', onKey, true);
	};
	const onKey = (ev) => {
		if (ev.key === 'Escape') {
			pop.classList.remove('open');
			document.removeEventListener('mousedown', dismiss, true);
			document.removeEventListener('keydown', onKey, true);
		}
	};
	setTimeout(() => {
		document.addEventListener('mousedown', dismiss, true);
		document.addEventListener('keydown', onKey, true);
	}, 0);
}

// ── Lazy iframe activation ───────────────────────────────────────────────

function observeIframes(grid) {
	if (!('IntersectionObserver' in window)) {
		grid.querySelectorAll('[data-frame]').forEach((f) => activateIframe(f, false));
		return;
	}
	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (e.isIntersecting) {
					activateIframe(e.target, false);
					io.unobserve(e.target);
				}
			}
		},
		{ rootMargin: '120px' },
	);
	grid.querySelectorAll('[data-frame]:not([data-loaded])').forEach((f) => io.observe(f));
}

function activateIframe(frame, force) {
	if (!frame || frame.dataset.loaded) return;
	frame.dataset.loaded = '1';
	const src = frame.dataset.src;
	if (!src) return;

	// On `force`, swap immediately; on observer hit, hold the poster behind the
	// iframe so first paint stays calm while WebGL warms up.
	const iframe = document.createElement('iframe');
	iframe.src = src;
	iframe.loading = 'lazy';
	iframe.title = 'Widget preview';
	iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
	iframe.style.opacity = force ? '1' : '0';
	frame.appendChild(iframe);

	const play = frame.querySelector('[data-poster-play]');
	const poster = frame.querySelector('[data-poster-img]');
	if (force && play) play.style.display = 'none';

	// Reveal on real load, but cap the wait — three.js + GLB downloads inside
	// the widget can stall behind a slow network and we'd rather show a
	// half-loaded iframe than a poster forever. Also handles error events so
	// embeds that 404 still surface the failure to the user.
	let revealed = false;
	const reveal = () => {
		if (revealed) return;
		revealed = true;
		iframe.style.opacity = '1';
		if (poster) poster.style.opacity = '0';
		if (play) play.style.display = 'none';
	};
	iframe.addEventListener('load', reveal);
	iframe.addEventListener('error', reveal);
	setTimeout(reveal, 4000);
}

// ── Confirm modal ────────────────────────────────────────────────────────

function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
	return new Promise((resolve) => {
		const root = document.createElement('div');
		root.className = 'dn-wx-modal-root';
		root.innerHTML = `
			<div class="dn-wx-modal-back"></div>
			<div class="dn-wx-modal" role="dialog" aria-modal="true">
				<div class="dn-wx-modal-title">${esc(title)}</div>
				<div class="dn-wx-modal-body">${esc(body)}</div>
				<div class="dn-wx-modal-actions">
					<button class="dn-btn" data-no type="button">Cancel</button>
					<button class="dn-btn ${danger ? 'danger' : 'primary'}" data-yes type="button">${esc(confirmLabel)}</button>
				</div>
			</div>
		`;
		document.body.appendChild(root);

		const close = (ans) => {
			root.remove();
			document.removeEventListener('keydown', onKey, true);
			resolve(ans);
		};
		const onKey = (ev) => {
			if (ev.key === 'Escape') close(false);
			else if (ev.key === 'Enter') close(true);
		};
		document.addEventListener('keydown', onKey, true);

		root.querySelector('[data-yes]').addEventListener('click', () => close(true));
		root.querySelector('[data-no]').addEventListener('click', () => close(false));
		root.querySelector('.dn-wx-modal-back').addEventListener('click', () => close(false));
		setTimeout(() => root.querySelector('[data-yes]').focus(), 0);
	});
}

// ── Toast ────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(message, isError = false) {
	const el = document.querySelector('[data-slot="toast"]');
	if (!el) return;
	el.textContent = message;
	el.classList.toggle('error', !!isError);
	el.hidden = false;
	requestAnimationFrame(() => el.classList.add('show'));
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.classList.remove('show');
		setTimeout(() => {
			el.hidden = true;
		}, 220);
	}, 2200);
}

// ── Skeleton / empty / error ─────────────────────────────────────────────

function skeletonGrid() {
	const card = `
		<div class="dn-wx-card dn-panel" aria-hidden="true">
			<div class="dn-wx-frame"><div class="dn-skeleton" style="position:absolute;inset:0"></div></div>
			<div class="dn-wx-body">
				<div class="dn-skeleton" style="height:14px;width:60%;margin-bottom:10px"></div>
				<div class="dn-skeleton" style="height:12px;width:40%"></div>
			</div>
		</div>`;
	return Array.from({ length: SKELETON_COUNT }, () => card).join('');
}

function emptyState() {
	return `
		<div class="dn-empty" style="grid-column:1 / -1">
			<h3>No widgets yet.</h3>
			<p>Turn any avatar into an embeddable agent — from a brand widget to a talking guide.</p>
			<a class="dn-btn primary" href="/widget-studio">Open widget studio</a>
		</div>
	`;
}

function errorBanner(err) {
	const msg = esc(err?.message || 'Unable to load widgets right now.');
	return `
		<div class="dn-panel" style="grid-column:1 / -1;border-color:rgba(255,107,138,0.35);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
			<div>
				<div class="dn-panel-title" style="color:var(--nxt-danger)">Couldn't load widgets</div>
				<div class="dn-panel-sub" style="margin:0">${msg}</div>
			</div>
			<button class="dn-btn" data-retry type="button">Retry</button>
		</div>
	`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function setText(el, text) {
	if (!el) return;
	el.textContent = text;
}

function cssEscape(s) {
	if (window.CSS?.escape) return window.CSS.escape(s);
	return String(s).replace(/["\\]/g, '\\$&');
}

// ── Styles (scoped to this page) ─────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('dn-widgets-styles')) return;
	const css = `
		.dn-wx-strip {
			display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
			margin: -6px 0 18px;
			font-size: 13px; color: var(--nxt-ink-dim);
		}
		.dn-wx-strip strong { color: var(--nxt-ink); font-weight: 600; }
		.dn-wx-sep { color: var(--nxt-ink-fade); margin: 0 2px; }

		.dn-wx-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
			gap: 14px;
		}

		.dn-wx-card {
			position: relative;
			padding: 0;
			overflow: hidden;
			display: flex; flex-direction: column;
		}
		.dn-wx-card:hover { border-color: var(--nxt-stroke-strong); }

		.dn-wx-frame {
			position: relative;
			height: 220px;
			overflow: hidden;
			background: #07080c;
			border-bottom: 1px solid var(--nxt-stroke);
		}
		.dn-wx-frame iframe {
			position: absolute; inset: 0;
			width: 100%; height: 100%;
			border: 0; display: block;
			transition: opacity 0.25s ease;
		}
		.dn-wx-poster {
			position: absolute; inset: 0;
			background-size: cover; background-position: center;
			background-color: #0f1018;
			transition: opacity 0.25s ease;
		}
		.dn-wx-poster-play {
			position: absolute; left: 50%; bottom: 12px;
			transform: translateX(-50%);
			display: inline-flex; align-items: center; gap: 7px;
			padding: 7px 12px;
			border-radius: 999px;
			background: rgba(8, 9, 14, 0.7);
			border: 1px solid rgba(255,255,255,0.16);
			color: var(--nxt-ink);
			font-size: 12px; cursor: pointer;
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
			transition: background 0.12s ease;
		}
		.dn-wx-poster-play:hover { background: rgba(8,9,14,0.92); }
		.dn-wx-poster-play svg { color: var(--nxt-accent); }

		.dn-wx-body { padding: 12px 14px 14px; }
		.dn-wx-head {
			display: flex; justify-content: space-between; align-items: center;
			gap: 10px; margin-bottom: 10px;
		}
		.dn-wx-name {
			font-size: 14px; font-weight: 600; color: var(--nxt-ink);
			letter-spacing: -0.005em;
			text-overflow: ellipsis; white-space: nowrap; overflow: hidden;
			min-width: 0; flex: 1;
		}
		.dn-wx-name:hover { color: var(--nxt-accent-strong); }

		.dn-wx-stats {
			display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
		}
		.dn-wx-stat-label {
			font-size: 11px; color: var(--nxt-ink-fade);
			text-transform: uppercase; letter-spacing: 0.06em;
			margin-bottom: 2px;
		}
		.dn-wx-stat-val { font-size: 16px; font-weight: 600; color: var(--nxt-ink); }

		.dn-wx-menu-btn {
			position: absolute; top: 8px; right: 8px;
			width: 28px; height: 28px;
			display: inline-grid; place-items: center;
			border-radius: 8px;
			background: rgba(8, 9, 14, 0.6);
			border: 1px solid rgba(255,255,255,0.12);
			color: var(--nxt-ink-dim);
			cursor: pointer;
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
			transition: all 0.12s ease;
			z-index: 2;
		}
		.dn-wx-menu-btn:hover { color: var(--nxt-ink); background: rgba(8,9,14,0.88); }

		.dn-wx-menu {
			position: absolute; z-index: 1000;
			min-width: 196px;
			padding: 6px;
			background: var(--nxt-bg-1, #14151c);
			border: 1px solid var(--nxt-stroke);
			border-radius: 10px;
			box-shadow: 0 16px 40px rgba(0,0,0,0.45);
			display: flex; flex-direction: column; gap: 1px;
		}
		.dn-wx-menu button {
			text-align: left;
			padding: 8px 10px;
			background: transparent;
			border: 0;
			color: var(--nxt-ink);
			font-size: 13px;
			cursor: pointer;
			border-radius: 6px;
		}
		.dn-wx-menu button:hover { background: rgba(255,255,255,0.06); }
		.dn-wx-menu button.danger { color: var(--nxt-danger); }
		.dn-wx-menu-sep { height: 1px; background: var(--nxt-stroke); margin: 4px 0; }

		.dn-wx-popover {
			position: absolute; z-index: 1100;
			width: 460px; max-width: calc(100vw - 24px);
			padding: 14px;
			background: var(--nxt-bg-1, #14151c);
			border: 1px solid var(--nxt-stroke);
			border-radius: 12px;
			box-shadow: 0 22px 48px rgba(0,0,0,0.55);
			opacity: 0; transform: translateY(-4px);
			transition: opacity 0.12s ease, transform 0.12s ease;
			pointer-events: none;
		}
		.dn-wx-popover.open { opacity: 1; transform: translateY(0); pointer-events: auto; }
		.dn-wx-pop-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
		.dn-wx-pop-title { font-size: 13px; font-weight: 600; color: var(--nxt-ink); letter-spacing: -0.005em; }
		.dn-wx-pop-close {
			background: transparent; border: 0; color: var(--nxt-ink-dim);
			font-size: 18px; line-height: 1; cursor: pointer; padding: 0 4px;
		}
		.dn-wx-pop-close:hover { color: var(--nxt-ink); }
		.dn-wx-pop-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
		.dn-wx-pop-tabs button {
			padding: 6px 10px; font-size: 12px;
			background: transparent; border: 1px solid transparent; border-radius: 7px;
			color: var(--nxt-ink-dim); cursor: pointer;
		}
		.dn-wx-pop-tabs button:hover { color: var(--nxt-ink); background: rgba(255,255,255,0.04); }
		.dn-wx-pop-tabs button[aria-selected="true"] {
			background: var(--nxt-accent-soft); color: var(--nxt-ink);
			border-color: var(--nxt-stroke-strong);
		}
		.dn-wx-pop-code {
			margin: 0;
			padding: 12px;
			background: rgba(8, 9, 14, 0.7);
			border: 1px solid var(--nxt-stroke);
			border-radius: 8px;
			font-family: 'JetBrains Mono', ui-monospace, monospace;
			font-size: 12px; line-height: 1.45;
			color: #d6d8e2;
			white-space: pre-wrap; word-break: break-word;
			max-height: 220px; overflow: auto;
		}
		.dn-wx-pop-foot {
			display: flex; justify-content: space-between; align-items: center;
			gap: 10px; margin-top: 12px;
		}
		.dn-wx-pop-hint { font-size: 12px; color: var(--nxt-ink-fade); }

		.dn-wx-toast {
			position: fixed; left: 50%; bottom: 24px;
			transform: translateX(-50%) translateY(8px);
			padding: 10px 16px;
			background: var(--nxt-bg-1, #14151c);
			border: 1px solid var(--nxt-stroke-strong);
			border-radius: 999px;
			color: var(--nxt-ink);
			font-size: 13px;
			box-shadow: 0 12px 32px rgba(0,0,0,0.4);
			opacity: 0;
			transition: opacity 0.18s ease, transform 0.18s ease;
			z-index: 2000;
		}
		.dn-wx-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
		.dn-wx-toast.error { border-color: rgba(255,107,138,0.5); color: var(--nxt-danger); }

		.dn-wx-modal-root {
			position: fixed; inset: 0; z-index: 2500;
			display: grid; place-items: center;
		}
		.dn-wx-modal-back {
			position: absolute; inset: 0;
			background: rgba(4, 5, 9, 0.62);
			backdrop-filter: blur(4px);
			-webkit-backdrop-filter: blur(4px);
		}
		.dn-wx-modal {
			position: relative;
			width: 380px; max-width: calc(100vw - 24px);
			padding: 20px;
			background: var(--nxt-bg-1, #14151c);
			border: 1px solid var(--nxt-stroke);
			border-radius: 14px;
			box-shadow: 0 28px 60px rgba(0,0,0,0.55);
		}
		.dn-wx-modal-title {
			font-size: 16px; font-weight: 600; color: var(--nxt-ink);
			margin-bottom: 6px;
		}
		.dn-wx-modal-body {
			font-size: 13.5px; color: var(--nxt-ink-dim);
			margin-bottom: 16px; line-height: 1.5;
		}
		.dn-wx-modal-actions {
			display: flex; justify-content: flex-end; gap: 8px;
		}
	`;
	const style = document.createElement('style');
	style.id = 'dn-widgets-styles';
	style.textContent = css;
	document.head.appendChild(style);
}
