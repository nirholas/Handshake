/**
 * /my-agents — all agents for the signed-in user.
 * Shows native three.ws agents (with default.glb fallback) plus any
 * ERC-8004 on-chain agents discovered across linked wallets that have
 * not yet been imported. Ensures every user has at least one agent.
 *
 * 3D avatars are expensive (each model-viewer holds a live WebGL context and
 * browsers cap concurrent contexts at ~16). Cards therefore render a static
 * poster by default and mount an interactive model-viewer on demand — on hover
 * for pointer devices, or on tap of the preview for touch — disposing it when
 * the pointer leaves so the context budget is never exhausted.
 */

const DEFAULT_GLB = '/avatars/default.glb';
const MAX_LIVE_VIEWERS = 6;

// ── API helpers ───────────────────────────────────────────────────────────────

async function ensureDefaultAgent() {
	// /me auto-creates an agent for the user if none exist
	await fetch('/api/agents/me', { credentials: 'include' }).catch(() => null);
}

async function fetchNativeAgents() {
	const res = await fetch('/api/agents', { credentials: 'include' });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json();
	return data.agents || [];
}

async function fetchOnchainAgents() {
	const res = await fetch('/api/erc8004/hydrate', { method: 'GET', credentials: 'include' });
	if (!res.ok) return []; // no wallets linked or error — not fatal
	const data = await res.json().catch(() => ({}));
	return data.agents || [];
}

async function importAgent({ chainId, agentId }) {
	const res = await fetch('/api/erc8004/import', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ chainId, agentId }),
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error_description || `HTTP ${res.status}`);
	}
	const data = await res.json();
	return data.agent;
}

// ── Session ───────────────────────────────────────────────────────────────────

async function getSession() {
	try {
		const res = await fetch('/api/auth/me', { credentials: 'include' });
		if (!res.ok) return null;
		const { user } = await res.json();
		return user ?? null;
	} catch {
		return null;
	}
}

// ── Chain name map ────────────────────────────────────────────────────────────

const CHAIN_NAMES = {
	1: 'Ethereum', 10: 'Optimism', 56: 'BNB Chain', 97: 'BSC Testnet',
	100: 'Gnosis', 137: 'Polygon', 250: 'Fantom', 324: 'zkSync Era',
	1284: 'Moonbeam', 5000: 'Mantle', 8453: 'Base', 42161: 'Arbitrum',
	42220: 'Celo', 43113: 'Avalanche Fuji', 43114: 'Avalanche',
	59144: 'Linea', 80002: 'Polygon Amoy', 84532: 'Base Sepolia',
	421614: 'Arb Sepolia', 534352: 'Scroll', 11155111: 'Sepolia',
	11155420: 'OP Sepolia',
};

function chainName(id) {
	return CHAIN_NAMES[id] || `Chain ${id}`;
}

function escapeHtml(text) {
	if (text == null) return '';
	const d = document.createElement('div');
	d.textContent = String(text);
	return d.innerHTML;
}

// ── Formatting helpers ──────────────────────────────────────────────────────────

function formatCount(n) {
	const num = Number(n) || 0;
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(num % 1_000 === 0 ? 0 : 1)}k`;
	return String(num);
}

function relativeTime(iso) {
	if (!iso) return '';
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';
	const secs = Math.max(1, Math.floor((Date.now() - then) / 1000));
	const units = [
		['y', 31536000], ['mo', 2592000], ['w', 604800],
		['d', 86400], ['h', 3600], ['m', 60],
	];
	for (const [label, size] of units) {
		const v = Math.floor(secs / size);
		if (v >= 1) return `${v}${label} ago`;
	}
	return 'just now';
}

// ── DOM refs ────────────────────────────────────────────────────────────────────

const grid = /** @type {HTMLElement} */ (document.getElementById('my-agents-grid'));
const errorBanner = /** @type {HTMLElement} */ (document.getElementById('my-agents-error'));
const statsEl = /** @type {HTMLElement} */ (document.getElementById('my-agents-stats'));
const toolbarEl = /** @type {HTMLElement} */ (document.getElementById('my-agents-toolbar'));
const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('my-agents-search-input'));
const sortSelect = /** @type {HTMLSelectElement} */ (document.getElementById('my-agents-sort-select'));
const newTopBtn = /** @type {HTMLElement} */ (document.getElementById('my-agents-new-top'));

// ── State ───────────────────────────────────────────────────────────────────────

/** @type {any[]} */ let nativeAgents = [];
/** @type {any[]} */ let unimportedOnchain = [];
let searchQuery = '';
let sortMode = 'recent';

// ── Lazy 3D viewer management ────────────────────────────────────────────────────
// Bound the number of live WebGL contexts. Oldest-mounted viewers are torn down
// first when the budget is exceeded.

/** @type {HTMLElement[]} */ const liveViewers = [];

function mountViewer(thumb, modelUrl, name) {
	if (thumb.dataset.mounted === '1') return;
	thumb.dataset.mounted = '1';

	while (liveViewers.length >= MAX_LIVE_VIEWERS) {
		const oldest = liveViewers.shift();
		if (oldest && oldest !== thumb) disposeViewer(oldest);
	}

	const mv = document.createElement('model-viewer');
	mv.setAttribute('src', modelUrl);
	mv.setAttribute('alt', `${name} 3D avatar`);
	mv.setAttribute('camera-controls', '');
	mv.setAttribute('auto-rotate', '');
	mv.setAttribute('rotation-per-second', '24deg');
	mv.setAttribute('interaction-prompt', 'none');
	mv.setAttribute('shadow-intensity', '1');
	mv.setAttribute('exposure', '1');
	mv.setAttribute('tone-mapping', 'aces');
	mv.setAttribute('reveal', 'auto');
	mv.setAttribute('disable-tap', '');
	thumb.appendChild(mv);
	thumb.classList.add('is-live');
	liveViewers.push(thumb);
}

function disposeViewer(thumb) {
	thumb.querySelector('model-viewer')?.remove();
	thumb.classList.remove('is-live');
	thumb.dataset.mounted = '';
	const i = liveViewers.indexOf(thumb);
	if (i !== -1) liveViewers.splice(i, 1);
}

const canHover =
	typeof window.matchMedia === 'function' &&
	window.matchMedia('(hover: hover)').matches;

/**
 * Wire a thumb element for on-demand 3D. Posterless avatars (no thumbnail image)
 * mount eagerly when scrolled into view so the card is never an empty void.
 */
function wireThumb(thumb, modelUrl, name, hasPoster) {
	if (canHover) {
		let leaveTimer = 0;
		thumb.addEventListener('pointerenter', () => {
			clearTimeout(leaveTimer);
			mountViewer(thumb, modelUrl, name);
		});
		thumb.addEventListener('pointerleave', () => {
			// Keep posterless viewers alive (nothing to fall back to); tear down
			// hover-mounted ones shortly after the pointer leaves.
			if (!hasPoster) return;
			leaveTimer = window.setTimeout(() => disposeViewer(thumb), 240);
		});
	} else {
		// Touch: explicit tap on the preview affordance.
		const btn = thumb.querySelector('.my-agents-card__preview-btn');
		btn?.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			mountViewer(thumb, modelUrl, name);
		});
	}

	if (!hasPoster) {
		observer.observe(thumb);
	}
}

const observer = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const thumb = /** @type {HTMLElement} */ (entry.target);
			mountViewer(thumb, thumb.dataset.model || DEFAULT_GLB, thumb.dataset.name || 'Agent');
			observer.unobserve(thumb);
		}
	},
	{ rootMargin: '200px' },
);

// ── Rendering helpers ─────────────────────────────────────────────────────────

function showSkeletons(n = 6) {
	grid.setAttribute('aria-busy', 'true');
	grid.innerHTML = Array.from(
		{ length: n },
		() => `
		<div class="my-agents-skeleton" aria-hidden="true">
			<div class="my-agents-skeleton__thumb"></div>
			<div class="my-agents-skeleton__body">
				<div class="my-agents-skeleton__line"></div>
				<div class="my-agents-skeleton__line my-agents-skeleton__line--short"></div>
				<div class="my-agents-skeleton__line my-agents-skeleton__line--btn"></div>
			</div>
		</div>`,
	).join('');
}

function showState(icon, title, msg, cta = null, secondary = null) {
	statsEl.hidden = true;
	toolbarEl.hidden = true;
	newTopBtn.hidden = true;
	grid.setAttribute('aria-busy', 'false');
	grid.innerHTML = `
		<div class="my-agents-state" style="grid-column: 1 / -1" role="status">
			<div class="my-agents-state__icon" aria-hidden="true">${icon}</div>
			<p class="my-agents-state__title">${escapeHtml(title)}</p>
			<p class="my-agents-state__msg">${escapeHtml(msg)}</p>
			${cta ? `<a class="my-agents-btn" style="display:inline-block;width:auto;padding:9px 22px" href="${escapeHtml(cta.href)}">${escapeHtml(cta.label)}</a>` : ''}
			${secondary ? `<div><a class="my-agents-secondary" href="${escapeHtml(secondary.href)}">${escapeHtml(secondary.label)}</a></div>` : ''}
		</div>`;
}

function showErrorBanner(msg, retry = true) {
	const showRetry = retry !== false;
	errorBanner.innerHTML = `
		<span class="my-agents-error-banner__msg">${escapeHtml(msg)}</span>
		${showRetry ? `<button class="my-agents-btn my-agents-btn--sec" id="my-agents-retry" style="width:auto;padding:7px 14px;font-size:12px" aria-label="Retry loading agents">Retry</button>` : ''}`;
	errorBanner.hidden = false;
	if (showRetry) {
		const handler = typeof retry === 'function' ? retry : () => loadAgents();
		document.getElementById('my-agents-retry')?.addEventListener('click', () => {
			errorBanner.hidden = true;
			grid.innerHTML = '';
			handler();
		});
	}
}

function previewAffordance(hasPoster) {
	// On touch, surface an explicit control to load the interactive model.
	if (canHover) return '';
	return `<button class="my-agents-card__preview-btn" type="button" aria-label="Load interactive 3D preview">
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5v14l11-7-11-7Z" fill="currentColor"/></svg>
		${hasPoster ? '3D' : 'Preview'}
	</button>`;
}

function buildThumb(modelUrl, name, posterUrl) {
	const hasPoster = Boolean(posterUrl);
	const thumb = document.createElement('div');
	thumb.className = 'my-agents-card__thumb';
	thumb.dataset.model = modelUrl;
	thumb.dataset.name = name;
	thumb.innerHTML = hasPoster
		? `<img class="my-agents-card__poster" src="${escapeHtml(posterUrl)}" alt="${escapeHtml(name)} avatar" loading="lazy" />
			<span class="my-agents-card__badge3d" aria-hidden="true">3D</span>
			${previewAffordance(true)}`
		: `<span class="my-agents-card__placeholder" aria-hidden="true">🤖</span>
			${previewAffordance(false)}`;
	wireThumb(thumb, modelUrl, name, hasPoster);
	return thumb;
}

function metaPill(text, variant = '') {
	return `<span class="my-agents-card__pill${variant ? ` my-agents-card__pill--${variant}` : ''}">${text}</span>`;
}

/**
 * Build a card for a native three.ws agent.
 */
function buildNativeCard(agent) {
	const card = document.createElement('article');
	card.className = 'my-agents-card';
	card.setAttribute('role', 'listitem');
	card.setAttribute('aria-label', `Agent: ${agent.name}`);

	const modelUrl = agent.avatar_model_url || DEFAULT_GLB;
	const posterUrl = agent.avatar_thumbnail_url || null;
	card.appendChild(buildThumb(modelUrl, agent.name, posterUrl));

	const sourcePill = agent.chain_id && agent.is_registered
		? metaPill(escapeHtml(chainName(agent.chain_id)), 'chain')
		: metaPill('three.ws', 'source');
	const publishedPill = agent.is_published
		? metaPill('Published', 'live')
		: metaPill('Draft', 'draft');

	const stats = [];
	if (agent.chat_count > 0) {
		stats.push(`<span class="my-agents-card__stat" title="${escapeHtml(String(agent.chat_count))} chats">
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z" stroke="currentColor" stroke-width="1.6"/></svg>
			${formatCount(agent.chat_count)}</span>`);
	}
	if (Array.isArray(agent.skills) && agent.skills.length) {
		stats.push(`<span class="my-agents-card__stat" title="${escapeHtml(String(agent.skills.length))} skills">
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m13 2-3 7h6l-7 13 2-9H6l4-11Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
			${agent.skills.length}</span>`);
	}
	if (agent.created_at) {
		stats.push(`<span class="my-agents-card__stat" title="Created ${escapeHtml(new Date(agent.created_at).toLocaleString())}">${escapeHtml(relativeTime(agent.created_at))}</span>`);
	}

	const body = document.createElement('div');
	body.className = 'my-agents-card__body';
	body.innerHTML = `
		<a class="my-agents-card__name-link" href="/agent/${escapeHtml(agent.id)}">
			<h2 class="my-agents-card__name" title="${escapeHtml(agent.name)}">${escapeHtml(agent.name)}</h2>
		</a>
		<div class="my-agents-card__row">${sourcePill}${publishedPill}</div>
		${agent.description ? `<p class="my-agents-card__desc">${escapeHtml(agent.description)}</p>` : ''}
		${stats.length ? `<div class="my-agents-card__stats">${stats.join('')}</div>` : ''}`;
	card.appendChild(body);

	const footer = document.createElement('div');
	footer.className = 'my-agents-card__footer';
	footer.innerHTML = `
		<a class="my-agents-btn" href="/agent/${escapeHtml(agent.id)}">Open</a>
		<a class="my-agents-btn my-agents-btn--ghost" href="/agent-edit?id=${escapeHtml(agent.id)}">Edit</a>`;
	card.appendChild(footer);

	return card;
}

/**
 * Build a card for an unimported ERC-8004 on-chain agent.
 */
function buildOnchainCard(agent) {
	const card = document.createElement('article');
	card.className = 'my-agents-card my-agents-card--onchain';
	card.setAttribute('role', 'listitem');
	card.setAttribute('aria-label', `On-chain agent: ${agent.name}`);

	if (agent.glbUrl) {
		card.appendChild(buildThumb(agent.glbUrl, agent.name, agent.image || null));
	} else {
		const thumb = document.createElement('div');
		thumb.className = 'my-agents-card__thumb';
		thumb.innerHTML = agent.image
			? `<img class="my-agents-card__poster" src="${escapeHtml(agent.image)}" alt="${escapeHtml(agent.name)} preview" loading="lazy" />`
			: `<span class="my-agents-card__placeholder" aria-hidden="true">🤖</span>`;
		card.appendChild(thumb);
	}

	const body = document.createElement('div');
	body.className = 'my-agents-card__body';
	body.innerHTML = `
		<h2 class="my-agents-card__name" title="${escapeHtml(agent.name)}">${escapeHtml(agent.name)}</h2>
		<div class="my-agents-card__row">
			${metaPill(escapeHtml(chainName(agent.chainId)), 'chain')}
			${metaPill('Not imported', 'draft')}
		</div>
		${agent.description ? `<p class="my-agents-card__desc">${escapeHtml(agent.description)}</p>` : ''}`;
	card.appendChild(body);

	const footer = document.createElement('div');
	footer.className = 'my-agents-card__footer';
	const wrap = document.createElement('div');
	wrap.className = 'my-agents-card__action-wrap';
	footer.appendChild(wrap);
	card.appendChild(footer);

	_renderImportAction(wrap, agent);
	return card;
}

function _renderImportAction(wrap, agent, importedId = null) {
	if (importedId) {
		wrap.innerHTML = `
			<button class="my-agents-btn my-agents-btn--done" disabled aria-label="Agent already in library">In library ✓</button>
			<a class="my-agents-btn my-agents-btn--ghost" href="/agent/${escapeHtml(importedId)}">Open</a>`;
		return;
	}

	const btn = document.createElement('button');
	btn.className = 'my-agents-btn';
	btn.textContent = 'Import to library';
	btn.setAttribute('aria-label', `Import ${agent.name}`);
	btn.addEventListener('click', () => _handleImport(btn, wrap, agent));
	wrap.appendChild(btn);
}

async function _handleImport(btn, wrap, agent) {
	btn.disabled = true;
	btn.textContent = 'Importing…';
	wrap.querySelector('.my-agents-card__inline-err')?.remove();

	try {
		const result = await importAgent({ chainId: agent.chainId, agentId: agent.agentId });
		_renderImportAction(wrap, agent, result.id);
	} catch (err) {
		btn.disabled = false;
		btn.textContent = 'Import to library';
		const errEl = document.createElement('span');
		errEl.className = 'my-agents-card__inline-err';
		errEl.textContent = err.message || 'Import failed';
		errEl.setAttribute('role', 'alert');
		wrap.appendChild(errEl);
	}
}

function buildNewCard() {
	const a = document.createElement('a');
	a.className = 'my-agents-card my-agents-card--new';
	a.href = '/create';
	a.setAttribute('role', 'listitem');
	a.setAttribute('aria-label', 'Create a new agent');
	a.innerHTML = `
		<span class="my-agents-card--new__icon" aria-hidden="true">
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
		</span>
		<span class="my-agents-card--new__label">New agent</span>
		<span class="my-agents-card--new__sub">Design an avatar and bring it to life</span>`;
	return a;
}

// ── Stats + toolbar ─────────────────────────────────────────────────────────────

function renderStats() {
	const total = nativeAgents.length;
	const chats = nativeAgents.reduce((sum, a) => sum + (Number(a.chat_count) || 0), 0);
	const onchain =
		nativeAgents.filter((a) => a.is_registered).length + unimportedOnchain.length;
	const published = nativeAgents.filter((a) => a.is_published).length;

	const items = [
		{ label: total === 1 ? 'Agent' : 'Agents', value: formatCount(total) },
		{ label: 'Published', value: formatCount(published) },
		{ label: 'On-chain', value: formatCount(onchain) },
		{ label: 'Total chats', value: formatCount(chats) },
	];
	statsEl.innerHTML = items
		.map(
			(it) => `<div class="my-agents-stat">
				<span class="my-agents-stat__value">${it.value}</span>
				<span class="my-agents-stat__label">${it.label}</span>
			</div>`,
		)
		.join('');
	statsEl.hidden = false;
}

function sortAgents(list) {
	const arr = [...list];
	switch (sortMode) {
		case 'oldest':
			return arr.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
		case 'name':
			return arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
		case 'chats':
			return arr.sort((a, b) => (Number(b.chat_count) || 0) - (Number(a.chat_count) || 0));
		case 'recent':
		default:
			return arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
	}
}

function matchesQuery(agent) {
	if (!searchQuery) return true;
	const q = searchQuery.toLowerCase();
	return (
		(agent.name || '').toLowerCase().includes(q) ||
		(agent.description || '').toLowerCase().includes(q)
	);
}

function renderGrid() {
	// Reset any live viewers from the previous render.
	liveViewers.splice(0).forEach((t) => t.querySelector('model-viewer')?.remove());
	grid.setAttribute('aria-busy', 'false');
	grid.innerHTML = '';

	const native = sortAgents(nativeAgents.filter(matchesQuery));
	const onchain = unimportedOnchain.filter(matchesQuery);

	if (searchQuery && native.length === 0 && onchain.length === 0) {
		grid.innerHTML = `
			<div class="my-agents-state my-agents-state--inline" style="grid-column: 1 / -1" role="status">
				<div class="my-agents-state__icon" aria-hidden="true">🔍</div>
				<p class="my-agents-state__title">No agents match “${escapeHtml(searchQuery)}”</p>
				<p class="my-agents-state__msg">Try a different name or clear the search.</p>
			</div>`;
		return;
	}

	const frag = document.createDocumentFragment();
	for (const agent of native) frag.appendChild(buildNativeCard(agent));
	for (const agent of onchain) frag.appendChild(buildOnchainCard(agent));
	if (!searchQuery) frag.appendChild(buildNewCard());
	grid.appendChild(frag);
}

// ── Main load ─────────────────────────────────────────────────────────────────

async function loadAgents() {
	showSkeletons();
	errorBanner.hidden = true;

	try {
		// Ensure user has at least one agent (auto-creates if none)
		await ensureDefaultAgent();

		const [native, onchain] = await Promise.all([
			fetchNativeAgents(),
			fetchOnchainAgents(),
		]);

		// Build a set of (chainId:agentId) keys already imported into native agents
		const importedKeys = new Set();
		for (const a of native) {
			if (a.chain_id != null && a.erc8004_agent_id != null) {
				importedKeys.add(`${a.chain_id}:${a.erc8004_agent_id}`);
			}
		}

		nativeAgents = native;
		unimportedOnchain = onchain.filter(
			(a) => !importedKeys.has(`${a.chainId}:${a.agentId}`),
		);

		if (nativeAgents.length === 0 && unimportedOnchain.length === 0) {
			showState(
				'🤖',
				'No agents yet',
				'Create your first agent to get started.',
				{ label: 'Create an agent', href: '/create' },
				{ label: 'Or browse community agents →', href: '/discover' },
			);
			return;
		}

		renderStats();
		toolbarEl.hidden = nativeAgents.length + unimportedOnchain.length < 2;
		newTopBtn.hidden = false;
		renderGrid();
	} catch (err) {
		statsEl.hidden = true;
		toolbarEl.hidden = true;
		grid.innerHTML = '';
		const msg = err.message || '';
		if (msg.includes('429') || /too many/i.test(msg)) {
			showErrorBanner('Too many requests. Try again in a minute.', true);
		} else {
			showErrorBanner(msg || 'Failed to load agents.', true);
		}
	}
}

// ── Toolbar wiring ──────────────────────────────────────────────────────────────

let searchDebounce = 0;
searchInput?.addEventListener('input', () => {
	clearTimeout(searchDebounce);
	searchDebounce = window.setTimeout(() => {
		searchQuery = searchInput.value.trim();
		renderGrid();
	}, 120);
});
searchInput?.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		searchInput.value = '';
		searchQuery = '';
		renderGrid();
	}
});
sortSelect?.addEventListener('change', () => {
	sortMode = sortSelect.value;
	renderGrid();
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
	const user = await getSession();

	if (!user) {
		showState(
			'🔐',
			'Sign in to see your agents',
			'Sign in to manage your agents and avatars.',
			{ label: 'Sign in', href: '/login.html' },
			{ label: 'Or browse community agents →', href: '/discover' },
		);
		return;
	}

	await loadAgents();
})();
