/**
 * AgentPicker — reusable 3D agent browser.
 *
 * Opens as a modal overlay or mounts inline. Fetches public agents from
 * /api/agents/public, renders a searchable/sortable/skill-filterable grid
 * with a live 3D preview of each agent's avatar, and fires a callback with
 * the selected agent.
 *
 * Unlike the avatar gallery (raw GLBs, including accessories), this picker
 * surfaces deployed *agents* — identities with a name, persona, skills, an
 * optional on-chain identity, and a wearable avatar.
 *
 * Usage:
 *
 *   import { openAgentPicker } from './agent-picker.js';
 *   const agent = await openAgentPicker();           // resolves agent | null
 *   const agent = await openAgentPicker({ onchainOnly: true });
 *
 *   // Or drive it directly for inline / custom flows:
 *   const picker = new AgentPicker({ onSelect: (a) => {...} });
 *   picker.openModal();
 */

import './agent-picker.css';
import './ui-juice.css';
import { enterStagger } from './ui-juice.js';
import { onchainBadgeHTML } from './shared/onchain-badge.js';

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

const AGENT_PH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.4"/><circle cx="9.5" cy="13" r="1.1"/><circle cx="14.5" cy="13" r="1.1"/><path d="M2.5 12v3M21.5 12v3"/></svg>`;
const SEARCH_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>`;

const SORTS = [
	{ key: 'popular', label: 'Popular' },
	{ key: 'newest', label: 'Newest' },
	{ key: 'name', label: 'A–Z' },
];

export class AgentPicker {
	/**
	 * @param {Object} opts
	 * @param {string}  [opts.title='Choose a 3D agent']
	 * @param {string}  [opts.selectedId] Pre-selected agent ID
	 * @param {boolean} [opts.onchainOnly=false] Start filtered to on-chain agents
	 * @param {'popular'|'newest'|'name'} [opts.sort='popular']
	 * @param {string}  [opts.ctaLabel='Select agent']
	 * @param {Function} [opts.onSelect] Callback with the selected agent object
	 * @param {Function} [opts.onClose] Called when the picker is closed
	 */
	constructor(opts = {}) {
		this.opts = {
			title: opts.title || 'Choose a 3D agent',
			selectedId: opts.selectedId || '',
			onchainOnly: !!opts.onchainOnly,
			sort: SORTS.some((s) => s.key === opts.sort) ? opts.sort : 'popular',
			ctaLabel: opts.ctaLabel || 'Select agent',
			onSelect: opts.onSelect || (() => {}),
			onClose: opts.onClose || (() => {}),
		};

		this._state = {
			query: '',
			skill: '',
			sort: this.opts.sort,
			onchainOnly: this.opts.onchainOnly,
			cursor: null,
			loading: false,
			loaded: 0,
			hasMore: false,
			selected: null,
			loadedSkills: new Set(),
			cardsById: new Map(),
			modelCache: new Map(), // id -> { model_url, thumbnail_url } | null (no model)
			firstPageDone: false,
			reqSeq: 0,
		};

		this._overlay = null;
		this._shell = null;
		this._els = {};
		this._io = null;
		this._searchTimer = null;
		this._onKey = this._onKey.bind(this);
	}

	// ── Public API ──────────────────────────────────────────────────────

	openModal() {
		if (this._overlay) return;
		ensureModelViewer();

		this._overlay = document.createElement('div');
		this._overlay.className = 'apk-overlay';
		this._overlay.addEventListener('click', (e) => {
			if (e.target === this._overlay) this.close();
		});

		this._shell = this._buildShell();
		this._overlay.appendChild(this._shell);
		document.body.appendChild(this._overlay);
		document.addEventListener('keydown', this._onKey);

		requestAnimationFrame(() => {
			this._overlay.classList.add('apk-open');
			this._els.searchInput?.focus();
		});

		this._loadPage();
	}

	mountInline(container) {
		ensureModelViewer();
		this._shell = this._buildShell();
		this._shell.classList.add('apk-shell--inline');
		this._shell.querySelector('.apk-close')?.remove();
		container.appendChild(this._shell);
		this._loadPage();
	}

	close() {
		if (this._io) { this._io.disconnect(); this._io = null; }
		document.removeEventListener('keydown', this._onKey);
		clearTimeout(this._searchTimer);
		if (this._overlay) {
			this._overlay.classList.remove('apk-open');
			const ov = this._overlay;
			setTimeout(() => { ov.remove(); }, 200);
			this._overlay = null;
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
		shell.className = 'apk-shell';

		shell.innerHTML = `
			<div class="apk-header">
				<span class="apk-title">${esc(this.opts.title)}</span>
				<button type="button" class="apk-close" aria-label="Close">&times;</button>
			</div>

			<div class="apk-toolbar">
				<div class="apk-search">
					${SEARCH_SVG}
					<input type="text" placeholder="Search 3D agents..." autocomplete="off" aria-label="Search agents" />
					<button type="button" class="apk-search-clear" hidden aria-label="Clear">&times;</button>
				</div>
				<div class="apk-sort" role="tablist" aria-label="Sort agents">
					${SORTS.map((s) => `
						<button type="button" class="apk-sort-btn${s.key === this._state.sort ? ' active' : ''}" data-sort="${s.key}" role="tab" aria-selected="${s.key === this._state.sort}">${s.label}</button>
					`).join('')}
				</div>
				<label class="apk-onchain-toggle">
					<input type="checkbox" ${this._state.onchainOnly ? 'checked' : ''} />
					On-chain
				</label>
				<span class="apk-status" aria-live="polite">Loading...</span>
			</div>

			<div class="apk-skills" aria-label="Skill filters"></div>

			<div class="apk-body">
				<div class="apk-grid-col">
					<div class="apk-grid"></div>
				</div>
				<div class="apk-preview-col">
					<div class="apk-preview-stage">
						<div class="apk-preview-empty">Select an agent to preview</div>
					</div>
					<div class="apk-preview-head">
						<h2 class="apk-preview-name">No agent selected</h2>
					</div>
					<p class="apk-preview-sub">Browse and pick a 3D agent</p>
					<p class="apk-preview-desc" hidden></p>
					<div class="apk-preview-skills"></div>
					<a class="apk-preview-profile" target="_blank" rel="noopener" hidden>View full profile →</a>
					<div class="apk-spacer"></div>
					<button type="button" class="apk-cta" disabled>${esc(this.opts.ctaLabel)}</button>
				</div>
			</div>
		`;

		this._els = {
			searchInput: shell.querySelector('.apk-search input'),
			searchClear: shell.querySelector('.apk-search-clear'),
			status: shell.querySelector('.apk-status'),
			skills: shell.querySelector('.apk-skills'),
			grid: shell.querySelector('.apk-grid'),
			gridCol: shell.querySelector('.apk-grid-col'),
			previewStage: shell.querySelector('.apk-preview-stage'),
			previewName: shell.querySelector('.apk-preview-name'),
			previewHead: shell.querySelector('.apk-preview-head'),
			previewSub: shell.querySelector('.apk-preview-sub'),
			previewDesc: shell.querySelector('.apk-preview-desc'),
			previewSkills: shell.querySelector('.apk-preview-skills'),
			previewProfile: shell.querySelector('.apk-preview-profile'),
			cta: shell.querySelector('.apk-cta'),
		};

		this._wireEvents(shell);
		return shell;
	}

	_wireEvents(shell) {
		shell.querySelector('.apk-close')?.addEventListener('click', () => this.close());

		// Sort
		shell.querySelectorAll('.apk-sort-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				if (btn.dataset.sort === this._state.sort) return;
				this._state.sort = btn.dataset.sort;
				shell.querySelectorAll('.apk-sort-btn').forEach((b) => {
					const on = b === btn;
					b.classList.toggle('active', on);
					b.setAttribute('aria-selected', String(on));
				});
				this._resetAndLoad();
			});
		});

		// On-chain toggle
		shell.querySelector('.apk-onchain-toggle input')?.addEventListener('change', (e) => {
			this._state.onchainOnly = e.target.checked;
			this._resetAndLoad();
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

		// Skill chips
		this._els.skills.addEventListener('click', (e) => {
			const btn = e.target.closest('.apk-skill');
			if (!btn) return;
			this._state.skill = btn.dataset.skill === this._state.skill ? '' : btn.dataset.skill;
			this._renderSkills();
			this._resetAndLoad();
		});

		// CTA — guarantee the avatar (GLB + id) is resolved before handing off,
		// since the list endpoint only ships a thumbnail.
		this._els.cta.addEventListener('click', async () => {
			const a = this._state.selected;
			if (!a || this._els.cta.disabled) return;
			this._els.cta.disabled = true;
			const prev = this._els.cta.textContent;
			this._els.cta.textContent = 'Loading…';
			await this._resolveAvatar(a);
			this._els.cta.textContent = prev;
			this.opts.onSelect(a);
			this.close();
		});

		this._setupInfiniteScroll();
	}

	_setupInfiniteScroll() {
		if (!('IntersectionObserver' in window)) return;
		const sentinel = document.createElement('div');
		sentinel.style.height = '1px';
		sentinel.className = 'apk-sentinel';
		this._els.grid.parentNode.appendChild(sentinel);

		this._io = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting && this._state.hasMore && this._state.cursor && !this._state.loading) {
					this._loadPage();
				}
			}
		}, { root: this._els.gridCol, rootMargin: '300px 0px' });
		this._io.observe(sentinel);
	}

	// ── Data ────────────────────────────────────────────────────────────

	_resetAndLoad() {
		this._state.cursor = null;
		this._state.loaded = 0;
		this._state.hasMore = false;
		this._state.loadedSkills = new Set();
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
		const seq = ++this._state.reqSeq;

		const params = new URLSearchParams();
		if (this._state.query) params.set('q', this._state.query);
		if (this._state.skill) params.set('skill', this._state.skill);
		if (this._state.sort) params.set('sort', this._state.sort);
		if (this._state.onchainOnly) params.set('onchain', '1');
		if (this._state.cursor) params.set('before', this._state.cursor);
		params.set('limit', String(PAGE_SIZE));

		try {
			const res = await fetch(`/api/agents/public?${params.toString()}`, { credentials: 'include' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			// A newer request superseded this one (filters changed mid-flight).
			if (seq !== this._state.reqSeq) return;
			const agents = Array.isArray(data.agents) ? data.agents : [];

			if (!this._state.firstPageDone) this._els.grid.innerHTML = '';

			const fresh = [];
			for (const a of agents) {
				this._state.cardsById.set(a.id, a);
				const card = this._renderCard(a);
				this._els.grid.appendChild(card);
				fresh.push(card);
				this._state.loaded += 1;
				for (const s of a.skills || []) this._state.loadedSkills.add(s);
			}
			// Stagger the freshly-landed cards in (first page + each lazy-loaded page).
			enterStagger(fresh);

			this._state.firstPageDone = true;
			this._state.hasMore = !!data.has_more;
			this._state.cursor = data.next_cursor || null;

			if (this._els.grid.children.length === 0) {
				this._els.grid.appendChild(this._renderEmpty());
			}

			this._renderSkills();
			this._hydratePreselection();
		} catch (err) {
			if (seq !== this._state.reqSeq) return;
			if (this._state.loaded === 0) {
				this._els.grid.innerHTML = '';
				const errDiv = document.createElement('div');
				errDiv.className = 'apk-error';
				errDiv.textContent = `Couldn't load agents: ${err.message}. Check your connection and try again.`;
				this._els.grid.appendChild(errDiv);
			}
		} finally {
			if (seq === this._state.reqSeq) {
				this._state.loading = false;
				this._updateStatus();
			}
		}
	}

	_hydratePreselection() {
		if (!this.opts.selectedId || this._state.selected) return;
		const match = this._state.cardsById.get(this.opts.selectedId);
		if (match) this._selectAgent(match);
	}

	// ── Rendering ───────────────────────────────────────────────────────

	_renderSkeletons(n) {
		for (let i = 0; i < n; i++) {
			const sk = document.createElement('div');
			sk.className = 'apk-skel';
			sk.innerHTML = `<div class="apk-skel-thumb"></div><div class="apk-skel-bar"></div><div class="apk-skel-bar"></div>`;
			this._els.grid.appendChild(sk);
		}
	}

	_renderEmpty() {
		const div = document.createElement('div');
		div.className = 'apk-empty';
		const filtered = this._state.query || this._state.skill || this._state.onchainOnly;
		if (filtered) {
			div.innerHTML = `No agents match these filters.<br>Try a different search or clear the filters.`;
		} else {
			div.innerHTML = `No public 3D agents yet.<a class="apk-empty-cta" href="/create">Deploy the first one →</a>`;
		}
		return div;
	}

	_renderCard(a) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'apk-card';
		card.dataset.id = a.id;
		if (a.id === this._state.selected?.id) card.classList.add('selected');

		const thumb = a.avatar_thumbnail
			? `<img src="${esc(a.avatar_thumbnail)}" alt="${esc(a.name || 'Agent')}" loading="lazy" decoding="async" />`
			: `<div class="apk-card-ph">${AGENT_PH_SVG}</div>`;

		const badge = onchainBadgeHTML(a, { link: false, size: 'sm', showChain: false });
		const skills = (a.skills || []).slice(0, 2).map((s) =>
			`<span class="apk-card-chip">${esc(s)}</span>`).join('');
		const chats = Number(a.chat_count) || 0;
		const desc = a.description
			? `<p class="apk-card-desc">${esc(a.description)}</p>`
			: '';

		card.innerHTML = `
			<div class="apk-card-thumb">
				${badge ? `<span class="apk-card-badge">${badge}</span>` : ''}
				${thumb}
			</div>
			<div class="apk-card-body">
				<div class="apk-card-name">${esc(a.name || 'Untitled agent')}</div>
				${desc}
				<div class="apk-card-meta">
					${skills}
					${chats ? `<span class="apk-card-chip">${compact.format(chats)} chats</span>` : ''}
				</div>
			</div>
		`;

		card.addEventListener('click', () => this._selectAgent(a));
		return card;
	}

	_selectAgent(a) {
		this._state.selected = a;

		// Card selection visual
		this._els.grid.querySelectorAll('.apk-card.selected').forEach((c) =>
			c.classList.remove('selected'));
		const card = this._els.grid.querySelector(`.apk-card[data-id="${CSS.escape(a.id)}"]`);
		if (card) {
			card.classList.add('selected');
			card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}

		// Header: name + on-chain badge
		this._els.previewName.textContent = a.name || 'Untitled agent';
		this._els.previewHead.querySelector('.apk-card-badge')?.remove();
		const badge = onchainBadgeHTML(a, { link: false, size: 'sm', showChain: true });
		if (badge) {
			const span = document.createElement('span');
			span.className = 'apk-card-badge';
			span.innerHTML = badge;
			this._els.previewHead.appendChild(span);
		}

		// Subtitle
		const chats = Number(a.chat_count) || 0;
		const bits = [];
		if (chats) bits.push(`${compact.format(chats)} chats`);
		bits.push(a.is_registered ? 'On-chain agent' : 'three.ws agent');
		this._els.previewSub.textContent = bits.join(' · ');

		// Description
		if (a.description) {
			this._els.previewDesc.textContent = a.description;
			this._els.previewDesc.hidden = false;
		} else {
			this._els.previewDesc.hidden = true;
		}

		// Skills
		this._els.previewSkills.innerHTML = (a.skills || []).slice(0, 8).map((s) =>
			`<span class="apk-preview-skill">${esc(s)}</span>`).join('');

		// Profile link
		this._els.previewProfile.hidden = false;
		this._els.previewProfile.href = a.home_url || `/agents/${a.id}`;

		// CTA
		this._els.cta.disabled = false;

		// 3D preview (lazy — the list endpoint only ships a thumbnail).
		this._renderPreviewModel(a);
	}

	async _renderPreviewModel(a) {
		const stage = this._els.previewStage;
		stage.innerHTML = '';

		// Cached model resolution from a prior selection.
		if (this._state.modelCache.has(a.id)) {
			this._mountPreview(a, this._state.modelCache.get(a.id));
			return;
		}

		// Show the thumbnail immediately while the GLB URL resolves.
		const spinner = document.createElement('div');
		spinner.className = 'apk-preview-spinner';
		if (a.avatar_thumbnail) {
			const img = document.createElement('img');
			img.src = a.avatar_thumbnail;
			img.alt = a.name || 'Agent';
			img.style.cssText = 'width:100%;height:100%;object-fit:contain;opacity:.5';
			stage.appendChild(img);
		}
		stage.appendChild(spinner);

		const resolved = await this._resolveAvatar(a);

		// A different agent was selected while this resolved — drop the stale render.
		if (this._state.selected?.id !== a.id) return;
		stage.innerHTML = '';
		this._mountPreview(a, resolved);
	}

	/**
	 * Resolve an agent's wearable avatar (GLB url, thumbnail, avatar id) from
	 * /api/agents/:id — the public list only ships a thumbnail. Cached per id,
	 * and the resolved fields are stamped onto the agent object so onSelect
	 * callers receive a fully-hydrated record. Returns the resolved descriptor.
	 */
	async _resolveAvatar(a) {
		if (this._state.modelCache.has(a.id)) return this._state.modelCache.get(a.id);
		let resolved = {
			model_url: '',
			thumbnail_url: a.avatar_thumbnail || '',
			avatar_id: a.avatar_id || null,
		};
		try {
			const res = await fetch(`/api/agents/${encodeURIComponent(a.id)}`, { credentials: 'include' });
			if (res.ok) {
				const { agent } = await res.json();
				resolved = {
					model_url: agent?.avatar_model_url || '',
					thumbnail_url: agent?.avatar_thumbnail_url || a.avatar_thumbnail || '',
					avatar_id: agent?.avatar_id || a.avatar_id || null,
				};
			}
		} catch {
			/* fall through to thumbnail-only resolution */
		}
		this._state.modelCache.set(a.id, resolved);
		// Hydrate the agent record so onSelect handoff carries the avatar.
		a.avatar_model_url = resolved.model_url;
		a.avatar_thumbnail_url = resolved.thumbnail_url;
		a.avatar_id = resolved.avatar_id;
		return resolved;
	}

	_mountPreview(a, resolved) {
		const stage = this._els.previewStage;
		stage.innerHTML = '';
		const modelUrl = resolved?.model_url;
		const thumb = resolved?.thumbnail_url || a.avatar_thumbnail;

		if (modelUrl) {
			const mv = document.createElement('model-viewer');
			mv.setAttribute('src', modelUrl);
			mv.setAttribute('alt', a.name || 'three.ws agent');
			mv.setAttribute('camera-controls', '');
			mv.setAttribute('auto-rotate', '');
			mv.setAttribute('rotation-per-second', '16deg');
			mv.setAttribute('interaction-prompt', 'none');
			mv.setAttribute('exposure', '1.05');
			mv.setAttribute('shadow-intensity', '0.8');
			mv.setAttribute('environment-image', 'neutral');
			if (thumb) mv.setAttribute('poster', thumb);
			stage.appendChild(mv);
		} else if (thumb) {
			const img = document.createElement('img');
			img.src = thumb;
			img.alt = a.name || 'Agent';
			img.style.cssText = 'width:100%;height:100%;object-fit:contain';
			stage.appendChild(img);
		} else {
			const div = document.createElement('div');
			div.className = 'apk-preview-empty';
			div.textContent = 'This agent has no avatar yet.';
			stage.appendChild(div);
		}
	}

	_renderSkills() {
		const skills = [...this._state.loadedSkills].sort((a, b) => a.localeCompare(b)).slice(0, 24);
		if (!skills.length && !this._state.skill) {
			this._els.skills.innerHTML = '';
			return;
		}
		const all = this._state.skill && !skills.includes(this._state.skill)
			? [this._state.skill, ...skills]
			: skills;
		this._els.skills.innerHTML = all.map((s) =>
			`<button type="button" class="apk-skill${s === this._state.skill ? ' active' : ''}" data-skill="${esc(s)}">${esc(s)}</button>`
		).join('');
	}

	_updateStatus() {
		if (!this._els.status) return;
		if (this._state.loading && this._state.loaded === 0) {
			this._els.status.textContent = 'Loading...';
			return;
		}
		const n = integer.format(this._state.loaded);
		const word = this._state.loaded === 1 ? 'agent' : 'agents';
		this._els.status.textContent = this._state.hasMore ? `${n}+ ${word}` : `${n} ${word}`;
	}

	// ── Keyboard ────────────────────────────────────────────────────────

	_onKey(e) {
		if (e.key === 'Escape') this.close();
	}
}

// ── Convenience wrapper: opens modal, returns a promise ─────────────────

export function openAgentPicker(opts = {}) {
	return new Promise((resolve) => {
		const picker = new AgentPicker({
			...opts,
			onSelect: (agent) => resolve(agent),
			onClose: () => resolve(null),
		});
		picker.openModal();
	});
}
