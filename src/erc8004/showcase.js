/**
 * /showcase: browsable directory of every ERC-8004 agent with a 3D avatar.
 *
 * Reads from GET /api/showcase (backed by erc8004_agents_index, populated by
 * api/cron/erc8004-crawl.js). Unlike /discover (search-by-input via /api/explore),
 * this page is pure browse: pick a net + chains, scroll a grid of newest-minted
 * agents, click a card to open its 3D viewer at /a/<chainId>/<agentId>.
 *
 * Lazy-loaded by src/app.js `_showShowcasePage`.
 */

import { CHAIN_META, supportedChainIds } from './chain-meta.js';
import { resolveURI } from '../ipfs.js';
import { skeletonHTML, emptyStateHTML, errorStateHTML, ensureStateKitStyles } from '../shared/state-kit.js';
import { onchainBadgeHTML, ensureOnchainBadgeStyles } from '../shared/onchain-badge.js';
ensureStateKitStyles();
ensureOnchainBadgeStyles();

const PAGE_SIZE = 24;
const NET_KEY = '3dagent.showcase.net';
const CHAINS_KEY = '3dagent.showcase.chains';
const SORT_KEY = '3dagent.showcase.sort';

// Returns true if a URL contains signed/expiring query params (GitHub JWT,
// S3/R2 presigned). These reliably 404 after the token expires, so we
// skip rendering the image rather than logging a spurious network error.
function hasExpiringSignature(url) {
	if (!url) return false;
	try {
		const p = new URL(url).searchParams;
		return p.has('jwt') || p.has('X-Amz-Signature') || p.has('X-Goog-Signature');
	} catch { return false; }
}

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function loadNet() {
	try {
		const v = localStorage.getItem(NET_KEY);
		if (v === 'mainnet' || v === 'testnet' || v === 'all') return v;
	} catch {}
	return 'mainnet';
}
function saveNet(v) {
	try {
		localStorage.setItem(NET_KEY, v);
	} catch {}
}

function loadSort() {
	try {
		const v = localStorage.getItem(SORT_KEY);
		if (v === 'newest' || v === 'oldest') return v;
	} catch {}
	return 'newest';
}
function saveSort(v) {
	try {
		localStorage.setItem(SORT_KEY, v);
	} catch {}
}

function loadChains() {
	try {
		const raw = localStorage.getItem(CHAINS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((n) => Number.isInteger(n));
	} catch {
		return [];
	}
}
function saveChains(ids) {
	try {
		localStorage.setItem(CHAINS_KEY, JSON.stringify(ids));
	} catch {}
}

function splitChains() {
	const ids = supportedChainIds();
	const mainnet = [];
	const testnet = [];
	for (const id of ids) {
		const m = CHAIN_META[id];
		if (!m) continue;
		(m.testnet ? testnet : mainnet).push(id);
	}
	return { mainnet, testnet };
}

/**
 * Entry point called by app.js `_showShowcasePage`.
 * @param {HTMLElement} container
 */
export function renderShowcasePage(container) {
	const page = new ShowcasePage(container);
	page.mount();
	return page;
}

class ShowcasePage {
	/** @param {HTMLElement} container */
	constructor(container) {
		this.container = container;
		this._net = loadNet();
		this._sort = loadSort();
		this._chains = loadChains(); // empty = all of `_net`
		this._items = [];
		this._nextCursor = null;
		this._total = 0;
		this._loading = false;
		this._reqSeq = 0;
		this._onHashChange = () => this._readURL({ replace: true });
		this._onScroll = () => this._maybeAutoLoad();
	}

	mount() {
		this.container.innerHTML = `
			<div class="showcase-shell">
				<header class="showcase-hero">
					<div class="showcase-hero-inner">
						<div class="showcase-eyebrow">ERC-8004 · Directory</div>
						<h1 class="showcase-title">Every three.ws on-chain.</h1>
						<p class="showcase-subtitle">
							Browse every ERC-8004 agent with a <code>gltf</code> body, discovered across
							${supportedChainIds().length} chains and indexed from canonical registries. Click any
							card to open it in the 3D viewer.
						</p>
						<div class="showcase-stats" data-role="stats">
							<div class="showcase-stat">
								<span class="showcase-stat-value" data-role="statTotal">-</span>
								<span class="showcase-stat-label">three.wss</span>
							</div>
							<div class="showcase-stat">
								<span class="showcase-stat-value">${splitChains().mainnet.length}+${splitChains().testnet.length}</span>
								<span class="showcase-stat-label">chains</span>
							</div>
							<div class="showcase-stat">
								<span class="showcase-stat-value">v2.0</span>
								<span class="showcase-stat-label">registry</span>
							</div>
						</div>
					</div>
				</header>

				<section class="showcase-controls">
					<div class="showcase-controls-row">
						<div class="showcase-segmented" role="tablist" data-role="netGroup">
							<button type="button" role="tab" class="showcase-seg" data-net="mainnet">Mainnet</button>
							<button type="button" role="tab" class="showcase-seg" data-net="testnet">Testnet</button>
							<button type="button" role="tab" class="showcase-seg" data-net="all">All</button>
						</div>
						<div class="showcase-controls-spacer"></div>
						<div class="showcase-sort">
							<label class="showcase-sort-lbl" for="showcase-sort-sel">Sort</label>
							<select id="showcase-sort-sel" class="showcase-sort-sel" data-role="sortSel">
								<option value="newest">Newest</option>
								<option value="oldest">Oldest</option>
							</select>
						</div>
					</div>
					<div class="showcase-controls-row showcase-controls-row--chains">
						<strong class="showcase-controls-lbl">Chains</strong>
						<div class="showcase-chain-chips" data-role="chainChips"></div>
						<button type="button" class="showcase-chip-reset" data-role="chainReset" hidden>Clear</button>
					</div>
				</section>

				<section class="showcase-results" data-role="results" aria-live="polite"></section>

				<div class="showcase-loadmore" data-role="loadMore" hidden>
					<button type="button" class="showcase-btn" data-role="loadMoreBtn">Load more</button>
				</div>
			</div>
		`;

		this._bindControls();
		this._renderNetSegmented();
		this._renderSortSelect();
		this._renderChainChips();

		window.addEventListener('hashchange', this._onHashChange);
		window.addEventListener('popstate', this._onHashChange);
		window.addEventListener('scroll', this._onScroll, { passive: true });

		this._readURL({ replace: true });
	}

	destroy() {
		window.removeEventListener('hashchange', this._onHashChange);
		window.removeEventListener('popstate', this._onHashChange);
		window.removeEventListener('scroll', this._onScroll);
	}

	// ── URL ↔ state ───────────────────────────────────────────────────────

	_readURL({ replace }) {
		const url = new URL(location.href);
		const net = url.searchParams.get('net');
		const sort = url.searchParams.get('sort');
		const chains = url.searchParams.get('chain');
		if (net && ['mainnet', 'testnet', 'all'].includes(net)) {
			this._net = net;
			saveNet(net);
		}
		if (sort && ['newest', 'oldest'].includes(sort)) {
			this._sort = sort;
			saveSort(sort);
		}
		if (chains !== null) {
			const parsed = chains
				.split(',')
				.map((s) => Number(s.trim()))
				.filter((n) => Number.isInteger(n) && CHAIN_META[n]);
			this._chains = parsed;
			saveChains(parsed);
		}

		this._renderNetSegmented();
		this._renderSortSelect();
		this._renderChainChips();
		this._resetAndLoad();
	}

	_pushURL() {
		const url = new URL(location.href);
		if (this._net !== 'mainnet') url.searchParams.set('net', this._net);
		else url.searchParams.delete('net');
		if (this._sort !== 'newest') url.searchParams.set('sort', this._sort);
		else url.searchParams.delete('sort');
		if (this._chains.length) url.searchParams.set('chain', this._chains.join(','));
		else url.searchParams.delete('chain');
		history.replaceState({}, '', url.toString());
	}

	// ── Controls ──────────────────────────────────────────────────────────

	_bindControls() {
		this.container.querySelector('[data-role="netGroup"]').addEventListener('click', (e) => {
			const btn = e.target.closest('button[data-net]');
			if (!btn) return;
			const next = btn.dataset.net;
			if (next === this._net) return;
			this._net = next;
			saveNet(next);
			// Clearing chain filter makes sense when flipping net (chips re-render anyway).
			this._chains = [];
			saveChains([]);
			this._renderNetSegmented();
			this._renderChainChips();
			this._pushURL();
			this._resetAndLoad();
		});

		this.container.querySelector('[data-role="sortSel"]').addEventListener('change', (e) => {
			const v = e.target.value;
			if (v !== 'newest' && v !== 'oldest') return;
			this._sort = v;
			saveSort(v);
			this._pushURL();
			this._resetAndLoad();
		});

		this.container.querySelector('[data-role="chainReset"]').addEventListener('click', () => {
			this._chains = [];
			saveChains([]);
			this._renderChainChips();
			this._pushURL();
			this._resetAndLoad();
		});

		this.container.querySelector('[data-role="loadMoreBtn"]').addEventListener('click', () => {
			this._loadMore();
		});
	}

	_renderNetSegmented() {
		const group = this.container.querySelector('[data-role="netGroup"]');
		group.querySelectorAll('button[data-net]').forEach((btn) => {
			const active = btn.dataset.net === this._net;
			btn.classList.toggle('showcase-seg--active', active);
			btn.setAttribute('aria-selected', active ? 'true' : 'false');
		});
	}

	_renderSortSelect() {
		const sel = this.container.querySelector('[data-role="sortSel"]');
		sel.value = this._sort;
	}

	_renderChainChips() {
		const root = this.container.querySelector('[data-role="chainChips"]');
		const { mainnet, testnet } = splitChains();
		const pool =
			this._net === 'mainnet'
				? mainnet
				: this._net === 'testnet'
					? testnet
					: [...mainnet, ...testnet];

		const chip = (id) => {
			const m = CHAIN_META[id];
			if (!m) return '';
			const active = this._chains.includes(id);
			return `
				<button type="button"
					class="showcase-chip ${active ? 'showcase-chip--active' : ''} ${m.testnet ? 'showcase-chip--testnet' : ''}"
					data-chain="${id}"
					title="${esc(m.name)}"
					aria-pressed="${active ? 'true' : 'false'}"
				>
					<span class="showcase-chip-dot"></span>
					${esc(m.shortName || m.name)}
				</button>
			`;
		};

		root.innerHTML = pool.map(chip).join('');
		root.querySelectorAll('.showcase-chip').forEach((btn) => {
			btn.addEventListener('click', () => {
				const id = Number(btn.dataset.chain);
				const idx = this._chains.indexOf(id);
				if (idx >= 0) this._chains.splice(idx, 1);
				else this._chains.push(id);
				saveChains(this._chains);
				this._renderChainChips();
				this._pushURL();
				this._resetAndLoad();
			});
		});

		const reset = this.container.querySelector('[data-role="chainReset"]');
		reset.hidden = this._chains.length === 0;
	}

	// ── Data ──────────────────────────────────────────────────────────────

	_resetAndLoad() {
		this._items = [];
		this._nextCursor = null;
		this._reqSeq++;
		this._renderResults({ skeleton: true });
		this._loadMore({ first: true });
	}

	async _loadMore({ first = false } = {}) {
		if (this._loading) return;
		if (!first && !this._nextCursor) return;
		this._loading = true;
		const seq = this._reqSeq;
		this._setLoadMoreState();

		const params = new URLSearchParams();
		params.set('net', this._net);
		params.set('sort', this._sort);
		params.set('limit', String(PAGE_SIZE));
		if (this._chains.length) params.set('chain', this._chains.join(','));
		if (this._nextCursor) params.set('cursor', this._nextCursor);

		try {
			const res = await fetch('/api/showcase?' + params.toString(), {
				headers: { accept: 'application/json' },
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
			}
			const data = await res.json();
			if (seq !== this._reqSeq) return; // superseded
			const agents = Array.isArray(data.agents) ? data.agents : [];
			this._items = this._items.concat(agents);
			this._nextCursor = data.next_cursor || null;
			this._total = Number(data.total) || this._total;
			this._renderStats();
			this._renderResults();
		} catch (err) {
			if (seq !== this._reqSeq) return;
			this._renderError(err.message || String(err));
		} finally {
			if (seq === this._reqSeq) this._loading = false;
			this._setLoadMoreState();
		}
	}

	_maybeAutoLoad() {
		if (this._loading || !this._nextCursor) return;
		const more = this.container.querySelector('[data-role="loadMore"]');
		if (!more || more.hidden) return;
		const rect = more.getBoundingClientRect();
		if (rect.top < window.innerHeight + 400) this._loadMore();
	}

	// ── Render ────────────────────────────────────────────────────────────

	_renderStats() {
		const el = this.container.querySelector('[data-role="statTotal"]');
		if (el) el.textContent = formatCount(this._total);
	}

	_setLoadMoreState() {
		const wrap = this.container.querySelector('[data-role="loadMore"]');
		const btn = this.container.querySelector('[data-role="loadMoreBtn"]');
		if (!wrap || !btn) return;
		wrap.hidden = !this._nextCursor;
		btn.disabled = !!this._loading;
		btn.textContent = this._loading ? 'Loading…' : 'Load more';
	}

	_renderResults({ skeleton = false } = {}) {
		const out = this.container.querySelector('[data-role="results"]');
		if (skeleton) {
			out.setAttribute('aria-busy', 'true');
			out.innerHTML = `<div class="showcase-grid">${skeletonHTML(8, 'card')}</div>`;
			return;
		}

		out.removeAttribute('aria-busy');

		if (!this._items.length) {
			const altNet = this._net === 'mainnet' ? 'Testnet' : 'Mainnet';
			out.innerHTML = emptyStateHTML({
				title: 'No agents found',
				body: `Try a different chain filter, flip to ${altNet}, or <a href="/deploy">deploy your own</a>.`,
				actions: [{ label: 'Deploy an agent', href: '/deploy', primary: true }],
				live: true,
			});
			return;
		}

		out.innerHTML = `
			<div class="showcase-grid">
				${this._items.map((a) => renderCard(a)).join('')}
			</div>
		`;
		this._wireCardShare(out);
	}

	_renderError(message) {
		const out = this.container.querySelector('[data-role="results"]');
		out.removeAttribute('aria-busy');
		out.innerHTML = errorStateHTML({
			title: "Couldn't load the directory",
			body: esc(message),
		});
		out.querySelector('[data-sk-retry]').addEventListener('click', () =>
			this._resetAndLoad(),
		);
	}

	_wireCardShare(root) {
		root.querySelectorAll('[data-role="card-share"]').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				e.preventDefault();
				const href = btn.dataset.share;
				if (!href) return;
				const url = new URL(href, location.origin).toString();
				try {
					await navigator.clipboard.writeText(url);
					btn.textContent = 'Copied ✓';
					setTimeout(() => (btn.textContent = 'Share'), 1400);
				} catch {
					window.prompt('Copy link:', url);
				}
			});
		});
	}
}

// ─── Card ──────────────────────────────────────────────────────────────────

/**
 * @param {object} a Shaped agent from /api/showcase
 */
function renderCard(a) {
	const chainMeta = CHAIN_META[a.chainId];
	const chainShort = chainMeta?.shortName || a.chainName || `#${a.chainId}`;
	const img = (a.image && !hasExpiringSignature(a.image)) ? resolveURI(a.image) : '';
	const title = esc(a.name || `Agent #${a.agentId}`);
	const descLine = a.description
		? `<p class="showcase-card-desc">${esc(truncate(a.description, 140))}</p>`
		: '';
	const ownerLine = a.owner
		? `<a class="showcase-card-owner" href="${esc(a.ownerExplorerUrl || '#')}" target="_blank" rel="noopener" title="${esc(a.owner)}">Owner ${esc(shortAddr(a.owner))} ↗</a>`
		: '';

	const badgeHtml = onchainBadgeHTML(a, { size: 'sm', showChain: true });

	const tags = [];
	tags.push(`<span class="showcase-tag showcase-tag--3d">3D</span>`);
	if (a.x402Support) tags.push(`<span class="showcase-tag showcase-tag--x402">x402 💳</span>`);
	const serviceTypes = new Set();
	for (const s of a.services || []) {
		const name = String(s?.name || '').toLowerCase();
		if (name === 'a2a' || name.startsWith('a2a')) serviceTypes.add('A2A');
		else if (name === 'mcp' || name.startsWith('mcp')) serviceTypes.add('MCP');
		else if (name === 'oasf') serviceTypes.add('OASF');
	}
	for (const t of serviceTypes) tags.push(`<span class="showcase-tag">${t}</span>`);

	return `
		<article class="showcase-card">
			<a class="showcase-card-thumb" href="${esc(a.viewerUrl)}" aria-label="Open Agent #${esc(a.agentId)} in 3D viewer">
				${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : `<div class="showcase-card-ph">🤖</div>`}
				<span class="showcase-chain-badge ${chainMeta?.testnet ? 'showcase-chain-badge--testnet' : ''}" title="${esc(chainMeta?.name || '')}">
					${esc(chainShort)}
				</span>
				<span class="showcase-card-3dpill">▶ 3D</span>
			</a>
			<div class="showcase-card-body">
				<div class="showcase-card-head">
					<a class="showcase-card-title" href="${esc(a.viewerUrl)}">${title}</a>
					<span class="showcase-card-id">#${esc(a.agentId)}</span>
					${badgeHtml}
				</div>
				${descLine}
				<div class="showcase-card-tags">${tags.join('')}</div>
				${ownerLine}
				<div class="showcase-card-actions">
					<a class="showcase-btn showcase-btn--sm showcase-btn--primary" href="${esc(a.viewerUrl)}">Open 3D ↗</a>
					${a.tokenExplorerUrl ? `<a class="showcase-btn showcase-btn--sm" href="${esc(a.tokenExplorerUrl)}" target="_blank" rel="noopener">Explorer ↗</a>` : ''}
					<button type="button" class="showcase-btn showcase-btn--sm showcase-btn--ghost"
						data-role="card-share" data-share="${esc(a.viewerUrl)}" title="Copy shareable link">Share</button>
				</div>
			</div>
		</article>
	`;
}

function truncate(s, n) {
	s = String(s || '');
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatCount(n) {
	if (!Number.isFinite(n)) return '-';
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
	return String(n);
}
