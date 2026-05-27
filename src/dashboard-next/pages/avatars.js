// dashboard-next — Avatars page.
//
// Grid of every avatar the signed-in user owns, with live 3D thumbnails
// (via the <threews-avatar> web component from /embed.js), inline rename,
// visibility chips, cursor pagination, and a more-menu with embed / view
// / download / delete actions.

import { mountShell } from '../shell.js';
import { requireUser, get, patch, del, esc, relTime, ApiError } from '../api.js';
import { openSelfieModal } from '../../selfie-modal.js';

const PAGE_SIZE = 24;
const VISIBILITIES = ['public', 'unlisted', 'private'];
const SORTS = [
	{ key: 'newest', label: 'Newest', cmp: (a, b) => ts(b.updated_at) - ts(a.updated_at) },
	{ key: 'oldest', label: 'Oldest', cmp: (a, b) => ts(a.updated_at) - ts(b.updated_at) },
	{ key: 'name_asc', label: 'Name A→Z', cmp: (a, b) => (a.name || '').localeCompare(b.name || '') },
	{ key: 'name_desc', label: 'Name Z→A', cmp: (a, b) => (b.name || '').localeCompare(a.name || '') },
];

const state = {
	all: /** @type {any[]} */ ([]),
	nextCursor: /** @type {string|null} */ (null),
	loadingMore: false,
	filter: { q: '', visibility: 'all', sort: 'newest' },
	io: /** @type {IntersectionObserver|null} */ (null),
};

(async function boot() {
	const main = await mountShell();
	await requireUser();
	injectStyles();

	main.innerHTML = `
		<div class="dn-av-head">
			<div>
				<h1 class="dn-h1">Avatars</h1>
				<p class="dn-h1-sub">Your 3D models, animated and ready to embed.</p>
			</div>
			<div class="dn-av-new-wrap">
				<button class="dn-btn primary" type="button" data-new>+ New avatar</button>
				<div class="dn-av-new-pop" data-new-pop hidden role="menu">
					<button type="button" role="menuitem" data-new-selfie-quick>Snap a selfie</button>
					<a href="/create/selfie" role="menuitem">Full selfie flow</a>
					<a href="/create" role="menuitem">Upload a GLB</a>
					<a href="/marketplace" role="menuitem">From an existing avatar</a>
				</div>
			</div>
		</div>

		<div class="dn-av-filters" data-filters>
			<label class="dn-av-search">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
				<input type="search" placeholder="Search avatars by name…" data-q autocomplete="off" />
			</label>
			<div class="dn-av-chips" role="tablist" aria-label="Visibility filter">
				${['all', ...VISIBILITIES].map((v) => `
					<button type="button" class="dn-av-chip${v === 'all' ? ' active' : ''}" data-vis-chip="${v}" role="tab" aria-selected="${v === 'all'}">${v[0].toUpperCase() + v.slice(1)}</button>
				`).join('')}
			</div>
			<label class="dn-av-sort">
				<select data-sort aria-label="Sort">
					${SORTS.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}
				</select>
			</label>
		</div>

		<div data-error hidden></div>
		<div class="dn-av-grid" data-grid></div>
		<div class="dn-av-loadmore" data-loadmore hidden></div>
		<div class="dn-av-toaster" data-toaster aria-live="polite"></div>
	`;

	wireFilters(main);
	wireNewMenu(main);
	await loadInitial(main);
})();

// ── Data loading ─────────────────────────────────────────────────────────

async function loadInitial(root) {
	const grid = root.querySelector('[data-grid]');
	renderSkeletons(grid, 8);
	hideError(root);

	try {
		const data = await get(`/api/avatars?limit=${PAGE_SIZE}`);
		state.all = Array.isArray(data?.avatars) ? data.avatars : [];
		state.nextCursor = data?.next_cursor || null;
		renderGrid(root);
		setupLoadMore(root);
	} catch (err) {
		showError(root, err, () => loadInitial(root));
		grid.innerHTML = '';
	}
}

async function loadMore(root) {
	if (!state.nextCursor || state.loadingMore) return;
	state.loadingMore = true;
	const btn = root.querySelector('[data-loadmore-btn]');
	if (btn) {
		btn.disabled = true;
		btn.textContent = 'Loading…';
	}
	try {
		const params = new URLSearchParams({ limit: String(PAGE_SIZE), cursor: state.nextCursor });
		const data = await get(`/api/avatars?${params.toString()}`);
		const more = Array.isArray(data?.avatars) ? data.avatars : [];
		state.all = state.all.concat(more);
		state.nextCursor = data?.next_cursor || null;
		renderGrid(root);
		setupLoadMore(root);
	} catch (err) {
		toast(root, err.message || 'Failed to load more', true);
		if (btn) {
			btn.disabled = false;
			btn.textContent = 'Load more';
		}
	} finally {
		state.loadingMore = false;
	}
}

// ── Filter / sort wiring ─────────────────────────────────────────────────

function wireFilters(root) {
	const qInput = root.querySelector('[data-q]');
	qInput.addEventListener('input', () => {
		state.filter.q = qInput.value.trim().toLowerCase();
		renderGrid(root);
	});

	root.querySelectorAll('[data-vis-chip]').forEach((b) => {
		b.addEventListener('click', () => {
			const v = b.getAttribute('data-vis-chip');
			state.filter.visibility = v;
			root.querySelectorAll('[data-vis-chip]').forEach((x) => {
				const on = x === b;
				x.classList.toggle('active', on);
				x.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			renderGrid(root);
		});
	});

	const sortSel = root.querySelector('[data-sort]');
	sortSel.addEventListener('change', () => {
		state.filter.sort = sortSel.value;
		renderGrid(root);
	});
}

function wireNewMenu(root) {
	const btn = root.querySelector('[data-new]');
	const pop = root.querySelector('[data-new-pop]');
	const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
	const open = () => { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
	btn.setAttribute('aria-haspopup', 'menu');
	btn.setAttribute('aria-expanded', 'false');
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		pop.hidden ? open() : close();
	});
	document.addEventListener('click', (e) => {
		if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) close();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !pop.hidden) close();
	});

	const quickSelfie = pop.querySelector('[data-new-selfie-quick]');
	if (quickSelfie) {
		quickSelfie.addEventListener('click', async () => {
			close();
			const result = await openSelfieModal();
			if (result?.avatarId) {
				toast(root, 'Avatar created from selfie');
				state.all = [];
				state.nextCursor = null;
				await loadInitial(root);
			}
		});
	}
}

// ── Filtering / rendering ────────────────────────────────────────────────

function applyFilter(rows) {
	const { q, visibility, sort } = state.filter;
	let out = rows;
	if (q) out = out.filter((a) => (a.name || '').toLowerCase().includes(q));
	if (visibility !== 'all') out = out.filter((a) => (a.visibility || 'private') === visibility);
	const cmp = SORTS.find((s) => s.key === sort)?.cmp;
	if (cmp) out = [...out].sort(cmp);
	return out;
}

function renderGrid(root) {
	const grid = root.querySelector('[data-grid]');
	const filtered = applyFilter(state.all);

	if (!state.all.length) {
		grid.innerHTML = '';
		grid.appendChild(emptyBlock());
		return;
	}
	if (!filtered.length) {
		grid.innerHTML = '';
		const empty = document.createElement('div');
		empty.className = 'dn-empty';
		empty.style.gridColumn = '1 / -1';
		empty.innerHTML = `<h3>No matches</h3><p>No avatars match the current search or filter. Clear them to see everything.</p>`;
		grid.appendChild(empty);
		return;
	}

	// Diff-light: if same set of IDs, leave DOM alone (preserves <threews-avatar>
	// instances and their loaded GLBs). Otherwise rebuild.
	const ids = filtered.map((a) => a.id).join('|');
	if (grid.dataset.ids === ids) return;
	grid.dataset.ids = ids;

	grid.innerHTML = '';
	for (const a of filtered) grid.appendChild(avatarCard(root, a));
}

function setupLoadMore(root) {
	const host = root.querySelector('[data-loadmore]');
	if (state.io) {
		state.io.disconnect();
		state.io = null;
	}
	if (!state.nextCursor) {
		host.hidden = true;
		host.innerHTML = '';
		return;
	}
	host.hidden = false;
	host.innerHTML = `<button class="dn-btn ghost" type="button" data-loadmore-btn>Load more</button>`;
	const btn = host.querySelector('[data-loadmore-btn]');
	btn.addEventListener('click', () => loadMore(root));
	state.io = new IntersectionObserver((entries) => {
		for (const e of entries) {
			if (e.isIntersecting) {
				loadMore(root);
				break;
			}
		}
	}, { rootMargin: '300px 0px' });
	state.io.observe(host);
}

// ── Card ─────────────────────────────────────────────────────────────────

function avatarCard(root, a) {
	const el = document.createElement('div');
	el.className = 'dn-avatar-card';
	el.dataset.id = a.id;

	el.innerHTML = `
		<div class="dn-av-thumb">
			<threews-avatar avatar-id="${esc(a.id)}" hide-chrome bg="transparent"></threews-avatar>
			<div class="dn-av-hover-actions">
				<a class="dn-av-hover-btn" href="/agent-next?id=${encodeURIComponent(a.id)}" target="_blank" rel="noopener">Live page</a>
				<a class="dn-av-hover-btn" href="/app#avatar=${encodeURIComponent(a.id)}">3D Studio</a>
			</div>
			<button type="button" class="dn-av-more" data-more aria-haspopup="menu" aria-label="More actions">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>
			</button>
		</div>
		<div class="dn-av-body">
			<div class="dn-av-name-row">
				<span class="dn-av-name" data-name title="Click to rename">${esc(a.name || 'Untitled')}</span>
				<button type="button" class="dn-av-pencil" data-rename aria-label="Rename">
					<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 1.5 14 4 4.5 13.5 1 14l.5-3.5z"/></svg>
				</button>
			</div>
			<div class="dn-av-meta">
				${visibilityTag(a.visibility)}
				<span class="dn-av-rel">${esc(relTime(a.updated_at || a.created_at))}</span>
			</div>
		</div>
	`;

	wireRename(root, el, a);
	wireMoreMenu(root, el, a);
	return el;
}

function visibilityTag(v) {
	const visibility = v || 'private';
	const cls = visibility === 'public' ? 'success' : visibility === 'private' ? 'warn' : '';
	const label = visibility[0].toUpperCase() + visibility.slice(1);
	return `<span class="dn-tag ${cls}" data-vis-tag>${esc(label)}</span>`;
}

// ── Inline rename ────────────────────────────────────────────────────────

function wireRename(root, card, a) {
	const nameEl = card.querySelector('[data-name]');
	const pencil = card.querySelector('[data-rename]');
	const startEdit = () => {
		if (card.querySelector('input[data-name-input]')) return;
		const input = document.createElement('input');
		input.type = 'text';
		input.value = a.name || '';
		input.maxLength = 100;
		input.setAttribute('data-name-input', '');
		input.className = 'dn-av-name-input';
		nameEl.replaceWith(input);
		input.focus();
		input.select();
		const commit = async () => {
			const next = input.value.trim();
			const restore = (text) => {
				const span = document.createElement('span');
				span.className = 'dn-av-name';
				span.dataset.name = '';
				span.title = 'Click to rename';
				span.textContent = text;
				input.replaceWith(span);
				span.addEventListener('click', startEdit);
			};
			if (!next || next === a.name) {
				restore(a.name || 'Untitled');
				return;
			}
			input.disabled = true;
			try {
				await patch(`/api/avatars/${encodeURIComponent(a.id)}`, { name: next });
				a.name = next;
				restore(next);
				toast(root, 'Renamed');
			} catch (err) {
				toast(root, msgOf(err) || 'Rename failed', true);
				restore(a.name || 'Untitled');
			}
		};
		input.addEventListener('blur', commit, { once: true });
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
			else if (e.key === 'Escape') {
				input.value = a.name || '';
				input.blur();
			}
		});
	};
	nameEl.addEventListener('click', startEdit);
	pencil.addEventListener('click', startEdit);
}

// ── More menu ────────────────────────────────────────────────────────────

let _openMenu = null;

function closeOpenMenu() {
	if (_openMenu) {
		_openMenu.remove();
		_openMenu = null;
	}
}

function wireMoreMenu(root, card, a) {
	const btn = card.querySelector('[data-more]');
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (_openMenu && _openMenu.dataset.for === a.id) {
			closeOpenMenu();
			return;
		}
		closeOpenMenu();
		openMoreMenu(root, btn, card, a);
	});
}

function openMoreMenu(root, anchor, card, a) {
	const menu = document.createElement('div');
	menu.className = 'dn-av-menu';
	menu.dataset.for = a.id;
	menu.setAttribute('role', 'menu');
	const items = [
		{ label: 'View live page', run: () => { window.open(`/agent-next?id=${encodeURIComponent(a.id)}`, '_blank'); } },
		{ label: 'Update from selfie', run: async () => {
			const result = await openSelfieModal({ existingAvatarId: a.id });
			if (result?.avatarId) {
				toast(root, 'Avatar updated from selfie');
				state.all = [];
				state.nextCursor = null;
				await loadInitial(root);
			}
		}},
		{ label: 'Rename', run: () => card.querySelector('[data-rename]')?.click() },
		{ label: 'Change visibility', run: () => openVisibilitySubmenu(root, anchor, card, a) },
		{ label: 'Copy embed snippet', run: () => copyEmbedSnippet(root, a) },
		{ label: 'Open in 3D studio', run: () => { location.href = `/app#avatar=${encodeURIComponent(a.id)}`; } },
		{ label: 'Download GLB', run: () => downloadGlb(root, a) },
		{ label: 'Delete', danger: true, run: () => confirmDelete(root, card, a) },
	];
	menu.innerHTML = items.map((item, i) => `
		<button type="button" class="dn-av-menu-item${item.danger ? ' danger' : ''}" data-i="${i}" role="menuitem">${esc(item.label)}</button>
	`).join('');

	document.body.appendChild(menu);
	positionMenu(menu, anchor);
	requestAnimationFrame(() => menu.classList.add('open'));
	_openMenu = menu;

	menu.querySelectorAll('[data-i]').forEach((b) => {
		b.addEventListener('click', () => {
			const i = Number(b.dataset.i);
			closeOpenMenu();
			items[i].run();
		});
	});

	const onDocClick = (e) => {
		if (menu.contains(e.target) || anchor.contains(e.target)) return;
		closeOpenMenu();
		document.removeEventListener('click', onDocClick);
		document.removeEventListener('keydown', onKey);
	};
	const onKey = (e) => {
		if (e.key === 'Escape') {
			closeOpenMenu();
			document.removeEventListener('click', onDocClick);
			document.removeEventListener('keydown', onKey);
		}
	};
	setTimeout(() => {
		document.addEventListener('click', onDocClick);
		document.addEventListener('keydown', onKey);
	}, 0);
}

function positionMenu(menu, anchor) {
	const r = anchor.getBoundingClientRect();
	menu.style.position = 'fixed';
	menu.style.top = `${Math.round(r.bottom + 6)}px`;
	// Right-align under the button, clamp to viewport.
	const width = 200;
	let left = Math.round(r.right - width);
	if (left < 8) left = 8;
	if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
	menu.style.left = `${left}px`;
	menu.style.width = `${width}px`;
}

function openVisibilitySubmenu(root, anchor, card, a) {
	const menu = document.createElement('div');
	menu.className = 'dn-av-menu';
	menu.dataset.for = a.id;
	menu.setAttribute('role', 'menu');
	menu.innerHTML = VISIBILITIES.map((v, i) => `
		<button type="button" class="dn-av-menu-item${(a.visibility || 'private') === v ? ' active' : ''}" data-i="${i}" data-v="${v}" role="menuitem">
			<span>${v[0].toUpperCase() + v.slice(1)}</span>
			${(a.visibility || 'private') === v ? '<span aria-hidden="true">✓</span>' : ''}
		</button>
	`).join('');
	document.body.appendChild(menu);
	positionMenu(menu, anchor);
	requestAnimationFrame(() => menu.classList.add('open'));
	_openMenu = menu;

	menu.querySelectorAll('[data-i]').forEach((b) => {
		b.addEventListener('click', async () => {
			const next = b.dataset.v;
			closeOpenMenu();
			if ((a.visibility || 'private') === next) return;
			const tag = card.querySelector('[data-vis-tag]');
			const prev = a.visibility;
			try {
				await patch(`/api/avatars/${encodeURIComponent(a.id)}`, { visibility: next });
				a.visibility = next;
				if (tag) tag.outerHTML = visibilityTag(next);
				toast(root, `Visibility set to ${next}`);
				// If the active filter chip excludes the new visibility,
				// re-render so it disappears from view.
				if (state.filter.visibility !== 'all' && state.filter.visibility !== next) {
					renderGrid(root);
				}
			} catch (err) {
				a.visibility = prev;
				toast(root, msgOf(err) || 'Failed to update visibility', true);
			}
		});
	});

	const onDocClick = (e) => {
		if (menu.contains(e.target)) return;
		closeOpenMenu();
		document.removeEventListener('click', onDocClick);
		document.removeEventListener('keydown', onKey);
	};
	const onKey = (e) => {
		if (e.key === 'Escape') {
			closeOpenMenu();
			document.removeEventListener('click', onDocClick);
			document.removeEventListener('keydown', onKey);
		}
	};
	setTimeout(() => {
		document.addEventListener('click', onDocClick);
		document.addEventListener('keydown', onKey);
	}, 0);
}

// ── Embed snippet ────────────────────────────────────────────────────────

async function copyEmbedSnippet(root, a) {
	const safeName = (a.name || 'avatar').replace(/"/g, '&quot;');
	const isPrivate = (a.visibility || 'private') === 'private';
	if (isPrivate) {
		toast(root, 'Private avatars cannot be embedded. Switch to unlisted or public first.', true);
		return;
	}
	const u = new URL('/a-embed.html', location.origin);
	u.searchParams.set('avatar', a.id);
	const snippet = `<iframe src="${u.toString()}" width="360" height="540" style="border:0;border-radius:12px;max-width:100%" allow="xr-spatial-tracking" sandbox="allow-scripts allow-same-origin allow-popups" title="${safeName}" loading="lazy"></iframe>`;
	try {
		await navigator.clipboard.writeText(snippet);
		toast(root, 'Embed snippet copied');
	} catch {
		toast(root, 'Copy failed — clipboard blocked', true);
	}
}

// ── Download GLB ─────────────────────────────────────────────────────────

async function downloadGlb(root, a) {
	toast(root, 'Preparing download…');
	try {
		let url = a.model_url;
		if (!url) {
			const data = await get(`/api/avatars/${encodeURIComponent(a.id)}`);
			url = data?.avatar?.url || data?.avatar?.model_url;
		}
		if (!url) throw new Error('No download URL available');
		const resp = await fetch(url, { credentials: 'omit' });
		if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
		const blob = await resp.blob();
		const safeName = (a.name || 'avatar').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) || 'avatar';
		const link = document.createElement('a');
		const objectUrl = URL.createObjectURL(blob);
		link.href = objectUrl;
		link.download = `${safeName}.glb`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
		toast(root, 'Download started');
	} catch (err) {
		toast(root, msgOf(err) || 'Download failed', true);
	}
}

// ── Delete with confirm modal ────────────────────────────────────────────

function confirmDelete(root, card, a) {
	const overlay = document.createElement('div');
	overlay.className = 'dn-av-overlay';
	overlay.innerHTML = `
		<div class="dn-panel dn-av-confirm" role="dialog" aria-modal="true" aria-label="Delete avatar">
			<div class="dn-panel-title">Delete "${esc(a.name || 'avatar')}"?</div>
			<p class="dn-panel-sub">This permanently removes the avatar and its embed URLs. This cannot be undone.</p>
			<div class="dn-av-confirm-actions">
				<button type="button" class="dn-btn ghost" data-cancel>Cancel</button>
				<button type="button" class="dn-btn danger" data-confirm>Delete</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);
	requestAnimationFrame(() => overlay.classList.add('open'));

	const close = () => {
		overlay.classList.remove('open');
		setTimeout(() => overlay.remove(), 160);
		document.removeEventListener('keydown', onKey);
	};
	const onKey = (e) => { if (e.key === 'Escape') close(); };
	document.addEventListener('keydown', onKey);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	overlay.querySelector('[data-cancel]').addEventListener('click', close);

	const confirmBtn = overlay.querySelector('[data-confirm]');
	confirmBtn.addEventListener('click', async () => {
		confirmBtn.disabled = true;
		confirmBtn.textContent = 'Deleting…';
		// Optimistic remove
		const idx = state.all.findIndex((x) => x.id === a.id);
		const removed = idx >= 0 ? state.all.splice(idx, 1)[0] : null;
		card.remove();
		try {
			await del(`/api/avatars/${encodeURIComponent(a.id)}`);
			toast(root, `Deleted "${a.name || 'avatar'}"`);
			if (!state.all.length) {
				const grid = root.querySelector('[data-grid]');
				grid.innerHTML = '';
				grid.appendChild(emptyBlock());
			} else {
				// Refresh diff key so future renders match
				const grid = root.querySelector('[data-grid]');
				grid.dataset.ids = '';
			}
			close();
		} catch (err) {
			// Undo: restore the row
			if (removed) state.all.splice(idx, 0, removed);
			const grid = root.querySelector('[data-grid]');
			grid.dataset.ids = '';
			renderGrid(root);
			toast(root, msgOf(err) || 'Delete failed', true);
			confirmBtn.disabled = false;
			confirmBtn.textContent = 'Delete';
		}
	});
}

// ── Helpers: skeletons, empty, error, toast ─────────────────────────────

function renderSkeletons(grid, n) {
	grid.innerHTML = '';
	for (let i = 0; i < n; i++) {
		const sk = document.createElement('div');
		sk.className = 'dn-avatar-card dn-av-skeleton-card';
		sk.innerHTML = `
			<div class="dn-skeleton" style="width:100%;height:280px;border-radius:12px"></div>
			<div class="dn-skeleton" style="width:60%;height:14px;margin-top:10px"></div>
			<div class="dn-skeleton" style="width:40%;height:11px;margin-top:6px"></div>
		`;
		grid.appendChild(sk);
	}
}

function emptyBlock() {
	const wrap = document.createElement('div');
	wrap.className = 'dn-empty';
	wrap.style.gridColumn = '1 / -1';
	wrap.innerHTML = `
		<h3>No avatars yet.</h3>
		<p>Build your first 3D agent — drop a selfie or upload a GLB.</p>
		<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
			<a class="dn-btn primary" href="/create/selfie">Create from selfie</a>
			<a class="dn-btn" href="/create">Upload a GLB</a>
		</div>
	`;
	return wrap;
}

function showError(root, err, onRetry) {
	const host = root.querySelector('[data-error]');
	host.hidden = false;
	host.innerHTML = `
		<div class="dn-av-banner-error">
			<div>
				<strong>Couldn't load avatars.</strong>
				<div class="dn-av-banner-sub">${esc(msgOf(err) || 'Network error')}</div>
			</div>
			<button class="dn-btn" type="button" data-retry>Retry</button>
		</div>
	`;
	host.querySelector('[data-retry]').addEventListener('click', () => {
		hideError(root);
		onRetry();
	});
}

function hideError(root) {
	const host = root.querySelector('[data-error]');
	host.hidden = true;
	host.innerHTML = '';
}

function toast(root, message, isError = false) {
	const host = root.querySelector('[data-toaster]');
	if (!host) return;
	const t = document.createElement('div');
	t.className = `dn-av-toast${isError ? ' err' : ''}`;
	t.textContent = message;
	host.appendChild(t);
	requestAnimationFrame(() => t.classList.add('show'));
	setTimeout(() => {
		t.classList.remove('show');
		setTimeout(() => t.remove(), 200);
	}, 3200);
}

function ts(iso) {
	const n = new Date(iso).getTime();
	return Number.isFinite(n) ? n : 0;
}

function msgOf(err) {
	if (err instanceof ApiError) return err.message;
	return err?.message || String(err || '');
}

// ── Styles (page-scoped, injected once) ─────────────────────────────────

function injectStyles() {
	if (document.getElementById('dn-avatars-css')) return;
	const css = document.createElement('style');
	css.id = 'dn-avatars-css';
	css.textContent = `
		.dn-av-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 16px;
			margin-bottom: 18px;
		}
		.dn-av-head .dn-h1, .dn-av-head .dn-h1-sub { margin-bottom: 0; }
		.dn-av-head .dn-h1-sub { margin-top: 4px; }
		.dn-av-new-wrap { position: relative; flex-shrink: 0; }
		.dn-av-new-pop {
			position: absolute;
			right: 0;
			top: calc(100% + 6px);
			min-width: 220px;
			background: linear-gradient(180deg, rgba(28, 29, 39, 0.96), rgba(20, 21, 28, 0.96));
			border: 1px solid var(--nxt-stroke-strong);
			border-radius: var(--nxt-radius-sm);
			box-shadow: 0 12px 36px rgba(0,0,0,0.45);
			padding: 6px;
			z-index: 40;
			backdrop-filter: blur(20px);
		}
		.dn-av-new-pop a,
		.dn-av-new-pop button {
			display: block;
			width: 100%;
			text-align: left;
			padding: 8px 12px;
			border-radius: 7px;
			font-size: 13px;
			color: var(--nxt-ink);
			background: transparent;
			border: none;
			cursor: pointer;
			font-family: inherit;
			transition: background 0.12s ease;
		}
		.dn-av-new-pop a:hover,
		.dn-av-new-pop button:hover { background: rgba(255,255,255,0.06); }

		.dn-av-filters {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 18px;
			flex-wrap: wrap;
		}
		.dn-av-search {
			flex: 1 1 280px;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 7px 12px;
			background: rgba(255,255,255,0.04);
			border: 1px solid var(--nxt-stroke);
			border-radius: var(--nxt-radius-pill);
			color: var(--nxt-ink-dim);
			transition: border-color 0.12s ease, background 0.12s ease;
		}
		.dn-av-search:focus-within {
			border-color: var(--nxt-stroke-strong);
			background: rgba(255,255,255,0.06);
		}
		.dn-av-search input {
			flex: 1;
			background: transparent;
			border: 0;
			outline: 0;
			color: var(--nxt-ink);
			font-size: 13px;
			min-width: 0;
		}
		.dn-av-search input::placeholder { color: var(--nxt-ink-fade); }

		.dn-av-chips { display: flex; gap: 4px; flex-wrap: wrap; }
		.dn-av-chip {
			background: transparent;
			border: 1px solid var(--nxt-stroke);
			color: var(--nxt-ink-dim);
			font-size: 12px;
			padding: 6px 12px;
			border-radius: var(--nxt-radius-pill);
			cursor: pointer;
			transition: all 0.12s ease;
		}
		.dn-av-chip:hover { color: var(--nxt-ink); background: rgba(255,255,255,0.04); }
		.dn-av-chip.active {
			background: rgba(255,255,255,0.08);
			border-color: var(--nxt-stroke-strong);
			color: var(--nxt-ink);
		}

		.dn-av-sort select {
			background: rgba(255,255,255,0.04);
			color: var(--nxt-ink);
			border: 1px solid var(--nxt-stroke);
			border-radius: var(--nxt-radius-sm);
			padding: 7px 28px 7px 12px;
			font-size: 13px;
			cursor: pointer;
			appearance: none;
			background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none' stroke='%239ca0aa' stroke-width='1.5'><path d='M1 1l4 4 4-4'/></svg>");
			background-repeat: no-repeat;
			background-position: right 10px center;
		}

		.dn-av-banner-error {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 14px 16px;
			margin-bottom: 14px;
			border: 1px solid rgba(150,155,163,0.3);
			background: rgba(150,155,163,0.08);
			border-radius: var(--nxt-radius-sm);
			color: var(--nxt-ink);
			font-size: 13px;
		}
		.dn-av-banner-sub { color: var(--nxt-ink-dim); font-size: 12.5px; margin-top: 2px; }

		.dn-av-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
			gap: 16px;
		}

		.dn-avatar-card {
			background: linear-gradient(180deg, rgba(20, 21, 28, 0.7), rgba(14, 15, 22, 0.5));
			border: 1px solid var(--nxt-stroke);
			border-radius: var(--nxt-radius);
			padding: 10px;
			transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
		}
		.dn-avatar-card:hover {
			transform: scale(1.015);
			box-shadow: 0 8px 24px rgba(0,0,0,0.4);
			border-color: var(--nxt-stroke-strong);
		}
		.dn-av-skeleton-card { padding: 10px; }
		.dn-av-skeleton-card:hover { transform: none; box-shadow: none; }

		.dn-av-thumb {
			position: relative;
			width: 100%;
			height: 280px;
			border-radius: 10px;
			overflow: hidden;
			background:
				radial-gradient(ellipse 60% 50% at 50% 100%, rgba(200,202,208,0.06) 0%, transparent 70%),
				linear-gradient(180deg, rgba(28, 29, 39, 0.5), rgba(14, 15, 22, 0.5));
		}
		.dn-av-thumb threews-avatar {
			display: block;
			width: 100%;
			height: 100%;
		}
		.dn-av-more {
			position: absolute;
			top: 8px;
			right: 8px;
			width: 28px;
			height: 28px;
			display: grid;
			place-items: center;
			border: 1px solid var(--nxt-stroke);
			background: rgba(14, 15, 22, 0.7);
			color: var(--nxt-ink);
			border-radius: 8px;
			cursor: pointer;
			opacity: 0;
			transition: opacity 0.16s ease, background 0.12s ease, border-color 0.12s ease;
			backdrop-filter: blur(8px);
		}
		.dn-avatar-card:hover .dn-av-more,
		.dn-av-more:focus-visible { opacity: 1; }
		.dn-av-more:hover { background: var(--nxt-bg-3); border-color: var(--nxt-stroke-strong); }

		.dn-av-hover-actions {
			position: absolute;
			left: 0; right: 0; bottom: 0;
			display: flex;
			gap: 6px;
			justify-content: center;
			padding: 10px 12px 12px;
			background: linear-gradient(0deg, rgba(0,0,0,0.55) 0%, transparent 100%);
			opacity: 0;
			transform: translateY(4px);
			transition: opacity 0.18s ease, transform 0.18s ease;
			pointer-events: none;
			z-index: 2;
		}
		.dn-avatar-card:hover .dn-av-hover-actions {
			opacity: 1;
			transform: translateY(0);
			pointer-events: auto;
		}
		.dn-av-hover-btn {
			padding: 5px 12px;
			font-size: 12px;
			font-weight: 500;
			color: var(--nxt-ink);
			background: rgba(14, 15, 22, 0.7);
			border: 1px solid var(--nxt-stroke);
			border-radius: 8px;
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
			cursor: pointer;
			transition: background 0.12s ease, border-color 0.12s ease;
			white-space: nowrap;
		}
		.dn-av-hover-btn:hover {
			background: rgba(14, 15, 22, 0.9);
			border-color: var(--nxt-stroke-strong);
		}

		.dn-av-body { padding: 10px 4px 4px; }
		.dn-av-name-row {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-bottom: 6px;
		}
		.dn-av-name {
			font-size: 13.5px;
			font-weight: 600;
			color: var(--nxt-ink);
			cursor: pointer;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			flex: 1;
		}
		.dn-av-name:hover { color: var(--nxt-ink); opacity: 0.85; }
		.dn-av-pencil {
			background: transparent;
			border: 0;
			color: var(--nxt-ink-fade);
			cursor: pointer;
			padding: 4px;
			border-radius: 6px;
			opacity: 0;
			transition: opacity 0.16s ease, color 0.12s ease, background 0.12s ease;
		}
		.dn-avatar-card:hover .dn-av-pencil { opacity: 1; }
		.dn-av-pencil:hover { color: var(--nxt-ink); background: rgba(255,255,255,0.05); }
		.dn-av-name-input {
			flex: 1;
			background: rgba(255,255,255,0.06);
			border: 1px solid var(--nxt-stroke-strong);
			color: var(--nxt-ink);
			border-radius: 6px;
			padding: 4px 8px;
			font: inherit;
			font-weight: 600;
			outline: 0;
			min-width: 0;
		}

		.dn-av-meta {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}
		.dn-av-rel {
			font-size: 11.5px;
			color: var(--nxt-ink-fade);
		}

		/* More-menu popover */
		.dn-av-menu {
			background: linear-gradient(180deg, rgba(28, 29, 39, 0.98), rgba(20, 21, 28, 0.98));
			border: 1px solid var(--nxt-stroke-strong);
			border-radius: var(--nxt-radius-sm);
			box-shadow: 0 16px 40px rgba(0,0,0,0.55);
			padding: 5px;
			z-index: 200;
			opacity: 0;
			transform: translateY(4px);
			transition: opacity 120ms ease, transform 120ms ease;
			backdrop-filter: blur(20px);
		}
		.dn-av-menu.open { opacity: 1; transform: translateY(0); }
		.dn-av-menu-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			width: 100%;
			text-align: left;
			background: transparent;
			border: 0;
			padding: 8px 11px;
			font-size: 13px;
			color: var(--nxt-ink);
			border-radius: 6px;
			cursor: pointer;
			gap: 8px;
		}
		.dn-av-menu-item:hover { background: rgba(255,255,255,0.06); }
		.dn-av-menu-item.active { color: var(--nxt-ink); font-weight: 500; }
		.dn-av-menu-item.danger { color: var(--nxt-danger); }
		.dn-av-menu-item.danger:hover { background: rgba(150,155,163,0.12); }

		/* Load more */
		.dn-av-loadmore {
			display: flex;
			justify-content: center;
			padding: 26px 0 4px;
		}

		/* Delete confirm overlay */
		.dn-av-overlay {
			position: fixed;
			inset: 0;
			z-index: 300;
			display: grid;
			place-items: center;
			background: rgba(0, 0, 0, 0.55);
			backdrop-filter: blur(4px);
			opacity: 0;
			transition: opacity 140ms ease;
		}
		.dn-av-overlay.open { opacity: 1; }
		.dn-av-confirm {
			width: min(420px, 92vw);
			transform: translateY(8px);
			transition: transform 160ms ease;
		}
		.dn-av-overlay.open .dn-av-confirm { transform: translateY(0); }
		.dn-av-confirm-actions {
			display: flex;
			gap: 8px;
			justify-content: flex-end;
			margin-top: 16px;
		}

		/* Toaster */
		.dn-av-toaster {
			position: fixed;
			bottom: 24px;
			right: 24px;
			display: flex;
			flex-direction: column;
			gap: 8px;
			z-index: 400;
			pointer-events: none;
		}
		.dn-av-toast {
			padding: 10px 14px;
			background: linear-gradient(180deg, rgba(28, 29, 39, 0.98), rgba(20, 21, 28, 0.98));
			border: 1px solid var(--nxt-stroke-strong);
			border-radius: var(--nxt-radius-sm);
			color: var(--nxt-ink);
			font-size: 13px;
			box-shadow: 0 12px 32px rgba(0,0,0,0.45);
			opacity: 0;
			transform: translateY(8px);
			transition: opacity 200ms ease, transform 200ms ease;
			max-width: 320px;
		}
		.dn-av-toast.show { opacity: 1; transform: translateY(0); }
		.dn-av-toast.err { border-color: rgba(150,155,163,0.4); }

		@media (max-width: 720px) {
			.dn-av-head { flex-direction: column; align-items: stretch; }
			.dn-av-new-wrap { align-self: flex-start; }
			.dn-av-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
			.dn-av-thumb { height: 220px; }
			.dn-av-hover-actions {
				opacity: 1;
				transform: translateY(0);
				pointer-events: auto;
			}
			.dn-av-hover-btn { font-size: 11px; padding: 4px 9px; }
		}
	`;
	document.head.appendChild(css);
}
