/**
 * AvatarGalleryPicker — reusable avatar browser component.
 *
 * Opens as a modal overlay or mounts inline. Fetches avatars from
 * /api/avatars/public (browse mode) or /api/avatars (user's own),
 * renders a searchable/filterable grid with live 3D preview, and
 * fires a callback with the selected avatar.
 *
 * Usage:
 *
 *   // Modal mode — resolves with selected avatar or null
 *   import { openAvatarPicker } from './avatar-gallery-picker.js';
 *   const avatar = await openAvatarPicker({ source: 'public' });
 *
 *   // With pre-selected avatar
 *   const avatar = await openAvatarPicker({ source: 'mine', selectedId: 'abc' });
 */

import './avatar-gallery-picker.css';

const PAGE_SIZE = 24;

let _mvLoaded = false;
function ensureModelViewer() {
	if (_mvLoaded || customElements.get('model-viewer')) return;
	_mvLoaded = true;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = 'https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js';
	document.head.appendChild(s);
}

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en');

const AVATAR_PH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4.5 4.5-7 8-7s6.5 2.5 8 7"/></svg>`;
const SEARCH_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>`;

export class AvatarGalleryPicker {
	/**
	 * @param {Object} opts
	 * @param {'public'|'mine'|'both'} [opts.source='both'] Which API to fetch from
	 * @param {string}  [opts.title='Choose an avatar']
	 * @param {string}  [opts.selectedId] Pre-selected avatar ID
	 * @param {boolean} [opts.showModes=true] Show share/glb/embed handoff modes
	 * @param {string}  [opts.ctaLabel='Select avatar'] Label for the CTA button
	 * @param {Function} [opts.onSelect] Callback with the selected avatar object
	 * @param {Function} [opts.onClose] Called when the picker is closed
	 */
	constructor(opts = {}) {
		this.opts = {
			source: opts.source || 'both',
			title: opts.title || 'Choose an avatar',
			selectedId: opts.selectedId || '',
			showModes: opts.showModes !== false,
			ctaLabel: opts.ctaLabel || 'Select avatar',
			onSelect: opts.onSelect || (() => {}),
			onClose: opts.onClose || (() => {}),
		};

		this._state = {
			query: '',
			tag: '',
			cursor: null,
			loading: false,
			total: null,
			totalLoaded: 0,
			selected: null,
			mode: 'share',
			loadedTags: new Set(),
			cardsById: new Map(),
			firstPageDone: false,
			activeSource: this.opts.source === 'both' ? 'public' : this.opts.source,
		};

		this._overlay = null;
		this._shell = null;
		this._els = {};
		this._io = null;
		this._searchTimer = null;
		this._copyTimer = null;
		this._onKey = this._onKey.bind(this);
	}

	// ── Public API ──────────────────────────────────────────────────────

	openModal() {
		if (this._overlay) return;
		ensureModelViewer();

		this._overlay = document.createElement('div');
		this._overlay.className = 'agp-overlay';
		this._overlay.addEventListener('click', (e) => {
			if (e.target === this._overlay) this.close();
		});

		this._shell = this._buildShell();
		this._overlay.appendChild(this._shell);
		document.body.appendChild(this._overlay);
		document.addEventListener('keydown', this._onKey);

		requestAnimationFrame(() => {
			this._overlay.classList.add('agp-open');
			this._els.searchInput?.focus();
		});

		this._loadPage();
	}

	mountInline(container) {
		ensureModelViewer();
		this._shell = this._buildShell();
		this._shell.classList.add('agp-shell--inline');
		const close = this._shell.querySelector('.agp-close');
		if (close) close.remove();
		container.appendChild(this._shell);
		this._loadPage();
	}

	close() {
		if (this._io) { this._io.disconnect(); this._io = null; }
		document.removeEventListener('keydown', this._onKey);
		if (this._overlay) {
			this._overlay.classList.remove('agp-open');
			setTimeout(() => { this._overlay.remove(); this._overlay = null; }, 200);
		} else if (this._shell) {
			this._shell.remove();
		}
		this._shell = null;
		this.opts.onClose();
	}

	getSelected() { return this._state.selected; }

	// ── Build ───────────────────────────────────────────────────────────

	_buildShell() {
		const shell = document.createElement('div');
		shell.className = 'agp-shell';

		const showSourceToggle = this.opts.source === 'both';
		const showModes = this.opts.showModes;

		shell.innerHTML = `
			<div class="agp-header">
				<span class="agp-title">${esc(this.opts.title)}</span>
				<button type="button" class="agp-close" aria-label="Close">&times;</button>
			</div>

			<div class="agp-toolbar">
				${showSourceToggle ? `
					<div class="agp-source-toggle" role="tablist" aria-label="Avatar source">
						<button type="button" class="agp-source-btn${this._state.activeSource === 'public' ? ' active' : ''}" data-source="public">Public gallery</button>
						<button type="button" class="agp-source-btn${this._state.activeSource === 'mine' ? ' active' : ''}" data-source="mine">My avatars</button>
					</div>
				` : ''}
				<div class="agp-search">
					${SEARCH_SVG}
					<input type="text" placeholder="Search avatars..." autocomplete="off" aria-label="Search avatars" />
					<button type="button" class="agp-search-clear" hidden aria-label="Clear">&times;</button>
				</div>
				<span class="agp-status" aria-live="polite">Loading...</span>
			</div>

			<div class="agp-tags" aria-label="Tag filters"></div>

			<div class="agp-body">
				<div class="agp-grid-col">
					<div class="agp-grid"></div>
				</div>
				<div class="agp-preview-col">
					<div class="agp-preview-stage">
						<div class="agp-preview-empty">Select an avatar to preview</div>
					</div>
					<h2 class="agp-preview-name">No avatar selected</h2>
					<p class="agp-preview-sub">Browse and pick an avatar</p>
					<div class="agp-preview-tags"></div>
					${showModes ? `
						<div class="agp-modes" role="radiogroup" aria-label="Output mode">
							<label><input type="radio" name="agp-mode" value="share" checked /><span>Share link</span></label>
							<label><input type="radio" name="agp-mode" value="glb" /><span>GLB URL</span></label>
							<label><input type="radio" name="agp-mode" value="embed" /><span>Embed</span></label>
						</div>
						<div class="agp-payload">Selected payload appears here</div>
					` : ''}
					<button type="button" class="agp-cta" disabled>${esc(this.opts.ctaLabel)}</button>
				</div>
			</div>
		`;

		this._els = {
			searchInput: shell.querySelector('.agp-search input'),
			searchClear: shell.querySelector('.agp-search-clear'),
			status: shell.querySelector('.agp-status'),
			tags: shell.querySelector('.agp-tags'),
			grid: shell.querySelector('.agp-grid'),
			gridCol: shell.querySelector('.agp-grid-col'),
			previewStage: shell.querySelector('.agp-preview-stage'),
			previewName: shell.querySelector('.agp-preview-name'),
			previewSub: shell.querySelector('.agp-preview-sub'),
			previewTags: shell.querySelector('.agp-preview-tags'),
			payload: shell.querySelector('.agp-payload'),
			cta: shell.querySelector('.agp-cta'),
		};

		this._wireEvents(shell);
		return shell;
	}

	_wireEvents(shell) {
		shell.querySelector('.agp-close')?.addEventListener('click', () => this.close());

		// Source toggle
		shell.querySelectorAll('.agp-source-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				const src = btn.dataset.source;
				if (src === this._state.activeSource) return;
				this._state.activeSource = src;
				shell.querySelectorAll('.agp-source-btn').forEach((b) =>
					b.classList.toggle('active', b === btn));
				this._resetAndLoad();
			});
		});

		// Search
		this._els.searchInput.addEventListener('input', () => {
			this._els.searchClear.hidden = !this._els.searchInput.value;
			clearTimeout(this._searchTimer);
			this._searchTimer = setTimeout(() => {
				this._state.query = this._els.searchInput.value.trim();
				this._resetAndLoad();
			}, 250);
		});

		this._els.searchClear.addEventListener('click', () => {
			this._els.searchInput.value = '';
			this._els.searchClear.hidden = true;
			this._state.query = '';
			this._resetAndLoad();
			this._els.searchInput.focus();
		});

		// Tags
		this._els.tags.addEventListener('click', (e) => {
			const btn = e.target.closest('.agp-tag');
			if (!btn) return;
			this._state.tag = btn.dataset.tag === this._state.tag ? '' : btn.dataset.tag;
			this._renderTags();
			this._resetAndLoad();
		});

		// Mode radio
		shell.querySelectorAll('input[name="agp-mode"]').forEach((input) => {
			input.addEventListener('change', () => {
				if (!input.checked) return;
				this._state.mode = input.value;
				this._updatePayload();
			});
		});

		// CTA
		this._els.cta.addEventListener('click', () => {
			if (!this._state.selected) return;
			if (this.opts.showModes) {
				this._copyPayload();
			} else {
				this.opts.onSelect(this._state.selected);
				this.close();
			}
		});

		// Infinite scroll
		this._setupInfiniteScroll();
	}

	_setupInfiniteScroll() {
		if (!('IntersectionObserver' in window)) return;
		const sentinel = document.createElement('div');
		sentinel.style.height = '1px';
		sentinel.className = 'agp-sentinel';
		this._els.grid.parentNode.appendChild(sentinel);

		this._io = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting && this._state.cursor && !this._state.loading) {
					this._loadPage();
				}
			}
		}, { root: this._els.gridCol, rootMargin: '300px 0px' });
		this._io.observe(sentinel);
	}

	// ── Data ────────────────────────────────────────────────────────────

	_resetAndLoad() {
		this._state.cursor = null;
		this._state.totalLoaded = 0;
		this._state.total = null;
		this._state.loadedTags = new Set();
		this._state.firstPageDone = false;
		this._state.cardsById = new Map();
		this._els.grid.innerHTML = '';
		this._renderSkeletons(6);
		this._loadPage();
	}

	async _loadPage() {
		if (this._state.loading) return;
		this._state.loading = true;
		this._updateStatus();

		const isPublic = this._state.activeSource === 'public';
		const baseUrl = isPublic ? '/api/avatars/public' : '/api/avatars';
		const params = new URLSearchParams();
		if (this._state.query) params.set('q', this._state.query);
		if (this._state.tag) params.set('tag', this._state.tag);
		if (this._state.cursor) params.set('cursor', this._state.cursor);
		params.set('limit', String(PAGE_SIZE));
		if (!this._state.firstPageDone) params.set('totals', '1');

		try {
			const res = await fetch(`${baseUrl}?${params.toString()}`, { credentials: 'include' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const avatars = Array.isArray(data.avatars) ? data.avatars : [];

			// Clear skeletons on first page
			if (!this._state.firstPageDone) {
				this._els.grid.innerHTML = '';
			}

			for (const a of avatars) {
				this._state.cardsById.set(a.id, a);
				this._els.grid.appendChild(this._renderCard(a));
				this._state.totalLoaded += 1;
				for (const t of a.tags || []) this._state.loadedTags.add(t);
			}

			if (!this._state.firstPageDone) {
				if (typeof data.total === 'number') this._state.total = data.total;
				this._state.firstPageDone = true;
			}

			this._state.cursor = data.next_cursor || null;

			if (this._els.grid.children.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'agp-empty';
				empty.textContent = this._state.query || this._state.tag
					? 'No avatars match these filters.'
					: isPublic ? 'No public avatars yet.' : 'You don\'t have any avatars yet.';
				this._els.grid.appendChild(empty);
			}

			this._renderTags();
			this._hydratePreselection();
		} catch (err) {
			if (this._state.totalLoaded === 0) {
				this._els.grid.innerHTML = '';
				const errDiv = document.createElement('div');
				errDiv.className = 'agp-error';
				errDiv.textContent = `Failed to load: ${err.message}`;
				this._els.grid.appendChild(errDiv);
			}
		} finally {
			this._state.loading = false;
			this._updateStatus();
		}
	}

	_hydratePreselection() {
		if (!this.opts.selectedId || this._state.selected) return;
		const match = this._state.cardsById.get(this.opts.selectedId);
		if (match) this._selectAvatar(match);
	}

	// ── Rendering ───────────────────────────────────────────────────────

	_renderSkeletons(n) {
		for (let i = 0; i < n; i++) {
			const sk = document.createElement('div');
			sk.className = 'agp-skel';
			sk.innerHTML = `<div class="agp-skel-thumb"></div><div class="agp-skel-bar"></div><div class="agp-skel-bar"></div>`;
			this._els.grid.appendChild(sk);
		}
	}

	_renderCard(a) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'agp-card';
		card.dataset.id = a.id;
		if (a.id === this._state.selected?.id) card.classList.add('selected');

		const thumb = a.thumbnail_url
			? `<img src="${esc(a.thumbnail_url)}" alt="${esc(a.name || 'Avatar')}" loading="lazy" decoding="async" />`
			: `<div class="agp-card-ph">${AVATAR_PH_SVG}</div>`;

		const tags = (a.tags || []).slice(0, 2).map((t) =>
			`<span class="agp-card-chip">${esc(t)}</span>`).join('');

		const views = Number(a.view_count) || 0;

		card.innerHTML = `
			<div class="agp-card-thumb">${thumb}</div>
			<div class="agp-card-body">
				<div class="agp-card-name">${esc(a.name || 'Untitled')}</div>
				<div class="agp-card-meta">
					${tags}
					${views ? `<span class="agp-card-chip">${compact.format(views)} views</span>` : ''}
				</div>
			</div>
		`;

		card.addEventListener('click', () => this._selectAvatar(a));
		return card;
	}

	_selectAvatar(a) {
		this._state.selected = a;

		// Update card selection visual
		this._els.grid.querySelectorAll('.agp-card.selected').forEach((c) =>
			c.classList.remove('selected'));
		const card = this._els.grid.querySelector(`.agp-card[data-id="${CSS.escape(a.id)}"]`);
		if (card) {
			card.classList.add('selected');
			card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}

		// Preview info
		this._els.previewName.textContent = a.name || 'Untitled';
		const tagBits = (a.tags || []).join(' · ') || 'three.ws avatar';
		const views = Number(a.view_count) || 0;
		this._els.previewSub.textContent = views
			? `${tagBits} · ${compact.format(views)} views`
			: tagBits;

		// Preview tags
		if (this._els.previewTags) {
			this._els.previewTags.innerHTML = (a.tags || []).slice(0, 6).map((t) =>
				`<span class="agp-preview-tag">${esc(t)}</span>`).join('');
		}

		// 3D preview
		this._els.previewStage.innerHTML = '';
		if (a.model_url) {
			const mv = document.createElement('model-viewer');
			mv.setAttribute('src', a.model_url);
			mv.setAttribute('alt', a.name || 'three.ws avatar');
			mv.setAttribute('camera-controls', '');
			mv.setAttribute('auto-rotate', '');
			mv.setAttribute('rotation-per-second', '16deg');
			mv.setAttribute('interaction-prompt', 'none');
			mv.setAttribute('exposure', '1.05');
			mv.setAttribute('shadow-intensity', '0.8');
			mv.setAttribute('environment-image', 'neutral');
			if (a.thumbnail_url) mv.setAttribute('poster', a.thumbnail_url);
			this._els.previewStage.appendChild(mv);
		} else if (a.thumbnail_url) {
			const img = document.createElement('img');
			img.src = a.thumbnail_url;
			img.alt = a.name || 'Avatar';
			img.style.cssText = 'width:100%;height:100%;object-fit:contain';
			this._els.previewStage.appendChild(img);
		} else {
			const div = document.createElement('div');
			div.className = 'agp-preview-empty';
			div.textContent = 'No preview available for this avatar.';
			this._els.previewStage.appendChild(div);
		}

		this._els.cta.disabled = false;
		this._updatePayload();
	}

	_renderTags() {
		const tags = [...this._state.loadedTags].sort((a, b) => a.localeCompare(b)).slice(0, 20);
		if (!tags.length && !this._state.tag) {
			this._els.tags.innerHTML = '';
			return;
		}
		const all = this._state.tag && !tags.includes(this._state.tag)
			? [this._state.tag, ...tags]
			: tags;
		this._els.tags.innerHTML = all.map((t) =>
			`<button type="button" class="agp-tag${t === this._state.tag ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`
		).join('');
	}

	_updateStatus() {
		if (!this._els.status) return;
		if (this._state.loading && this._state.totalLoaded === 0) {
			this._els.status.textContent = 'Loading...';
			return;
		}
		if (this._state.total != null) {
			this._els.status.textContent = `${integer.format(this._state.totalLoaded)} of ${integer.format(this._state.total)}`;
		} else {
			this._els.status.textContent = `${integer.format(this._state.totalLoaded)} avatars`;
		}
	}

	// ── Payload / copy ──────────────────────────────────────────────────

	_buildPayload() {
		const a = this._state.selected;
		if (!a) return '';
		if (this._state.mode === 'share') return `https://three.ws/avatars/${a.id}`;
		if (this._state.mode === 'glb') return a.model_url || '';
		return `<script type="module" src="https://three.ws/avatar-sdk/dist/index.mjs"><\/script>\n<agent-3d avatar-id="${a.id}" style="width:100%;height:480px"></agent-3d>`;
	}

	_updatePayload() {
		if (!this._els.payload) return;
		if (!this._state.selected) {
			this._els.payload.textContent = 'Selected payload appears here';
			return;
		}
		const payload = this._buildPayload();
		this._els.payload.textContent = payload || '(not available for this mode)';
	}

	async _copyPayload() {
		const payload = this._buildPayload();
		if (!payload) return;
		try {
			await navigator.clipboard.writeText(payload);
			const prev = this._els.cta.textContent;
			this._els.cta.classList.add('copied');
			this._els.cta.textContent = 'Copied!';
			if (this._copyTimer) clearTimeout(this._copyTimer);
			this._copyTimer = setTimeout(() => {
				this._els.cta.classList.remove('copied');
				this._els.cta.textContent = prev;
			}, 1400);
		} catch (err) {
			if (this._els.payload) {
				this._els.payload.textContent = `Clipboard blocked: ${err.message}\n\n${payload}`;
			}
		}
	}

	// ── Keyboard ────────────────────────────────────────────────────────

	_onKey(e) {
		if (e.key === 'Escape') this.close();
	}
}

// ── Convenience wrapper: opens modal, returns a promise ─────────────────

export function openAvatarPicker(opts = {}) {
	return new Promise((resolve) => {
		const picker = new AvatarGalleryPicker({
			...opts,
			onSelect: (avatar) => resolve(avatar),
			onClose: () => resolve(null),
		});
		picker.openModal();
	});
}
