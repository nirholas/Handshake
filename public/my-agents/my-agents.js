/**
 * /my-agents — all agents for the signed-in user.
 * Shows native three.ws agents (with default.glb fallback) plus any
 * ERC-8004 on-chain agents discovered across linked wallets that have
 * not yet been imported. Ensures every user has at least one agent.
 */

const DEFAULT_GLB = '/avatars/default.glb';

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

// ── Rendering helpers ─────────────────────────────────────────────────────────

const grid = /** @type {HTMLElement} */ (document.getElementById('my-agents-grid'));
const errorBanner = /** @type {HTMLElement} */ (document.getElementById('my-agents-error'));

function showSkeletons(n = 6) {
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

/**
 * Build a card for a native three.ws agent.
 * @param {{ id: string, name: string, description: string|null, avatar_model_url: string|null, avatar_thumbnail_url: string|null, chain_id: number|null, is_registered: boolean }} agent
 */
function buildNativeCard(agent) {
	const card = document.createElement('article');
	card.className = 'my-agents-card';
	card.setAttribute('aria-label', `Agent: ${agent.name}`);

	const modelUrl = agent.avatar_model_url || DEFAULT_GLB;
	const thumbHtml = `<model-viewer
		src="${escapeHtml(modelUrl)}"
		alt="${escapeHtml(agent.name)} 3D avatar"
		camera-controls
		auto-rotate
		shadow-intensity="1"
		exposure="1"
		tone-mapping="aces"
		loading="lazy"
		reveal="auto"
	></model-viewer>`;

	const chainPill = agent.chain_id && agent.is_registered
		? `<span class="my-agents-card__chain-pill" title="Chain ID ${escapeHtml(String(agent.chain_id))}">${escapeHtml(chainName(agent.chain_id))}</span>`
		: `<span class="my-agents-card__source-pill">three.ws</span>`;

	card.innerHTML = `
		<div class="my-agents-card__thumb">${thumbHtml}</div>
		<div class="my-agents-card__body">
			<h2 class="my-agents-card__name" title="${escapeHtml(agent.name)}">${escapeHtml(agent.name)}</h2>
			<div class="my-agents-card__row">${chainPill}</div>
			${agent.description ? `<p class="my-agents-card__desc">${escapeHtml(agent.description)}</p>` : ''}
		</div>
		<div class="my-agents-card__footer">
			<div class="my-agents-card__action-wrap">
				<a class="my-agents-btn" href="/agent/${escapeHtml(agent.id)}">Open agent →</a>
				<a class="my-agents-card__edit-link" href="/agent-edit?id=${escapeHtml(agent.id)}">Edit</a>
			</div>
		</div>`;

	return card;
}

/**
 * Build a card for an unimported ERC-8004 on-chain agent.
 * @param {{ chainId: number, agentId: string, name: string, description: string|null, image: string|null, glbUrl: string|null }} agent
 */
function buildOnchainCard(agent) {
	const card = document.createElement('article');
	card.className = 'my-agents-card';
	card.setAttribute('aria-label', `On-chain agent: ${agent.name}`);

	const thumbHtml = agent.glbUrl
		? `<model-viewer
				src="${escapeHtml(agent.glbUrl)}"
				alt="${escapeHtml(agent.name)} 3D avatar"
				camera-controls
				auto-rotate
				shadow-intensity="1"
				exposure="1"
				tone-mapping="aces"
				loading="lazy"
				reveal="auto"
			></model-viewer>`
		: agent.image
			? `<img src="${escapeHtml(agent.image)}" alt="${escapeHtml(agent.name)} preview" loading="lazy" />`
			: `<span aria-hidden="true">🤖</span>`;

	card.innerHTML = `
		<div class="my-agents-card__thumb">${thumbHtml}</div>
		<div class="my-agents-card__body">
			<h2 class="my-agents-card__name" title="${escapeHtml(agent.name)}">${escapeHtml(agent.name)}</h2>
			<div class="my-agents-card__row">
				<span class="my-agents-card__chain-pill" title="Chain ID ${escapeHtml(String(agent.chainId))}">${escapeHtml(chainName(agent.chainId))}</span>
			</div>
			${agent.description ? `<p class="my-agents-card__desc">${escapeHtml(agent.description)}</p>` : ''}
		</div>
		<div class="my-agents-card__footer">
			<div class="my-agents-card__action-wrap"></div>
		</div>`;

	const wrap = /** @type {HTMLElement} */ (card.querySelector('.my-agents-card__action-wrap'));
	_renderImportAction(wrap, agent);
	return card;
}

function _renderImportAction(wrap, agent, importedId = null) {
	if (importedId) {
		wrap.innerHTML = `
			<button class="my-agents-btn my-agents-btn--done" disabled aria-label="Agent already in library">Already in library</button>
			<a class="my-agents-card__agent-link" href="/agent/${escapeHtml(importedId)}">Open agent →</a>`;
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

// ── Main load ─────────────────────────────────────────────────────────────────

async function loadAgents() {
	showSkeletons();

	try {
		// Ensure user has at least one agent (auto-creates if none)
		await ensureDefaultAgent();

		const [nativeAgents, onchainAgents] = await Promise.all([
			fetchNativeAgents(),
			fetchOnchainAgents(),
		]);

		grid.innerHTML = '';

		// Build a set of (chainId:agentId) keys already imported into native agents
		const importedKeys = new Set();
		for (const a of nativeAgents) {
			if (a.chain_id != null && a.erc8004_agent_id != null) {
				importedKeys.add(`${a.chain_id}:${a.erc8004_agent_id}`);
			}
		}

		// Unimported onchain agents
		const unimportedOnchain = onchainAgents.filter(
			(a) => !importedKeys.has(`${a.chainId}:${a.agentId}`),
		);

		// Render native agents first
		for (const agent of nativeAgents) {
			grid.appendChild(buildNativeCard(agent));
		}

		// Render unimported onchain agents after
		for (const agent of unimportedOnchain) {
			grid.appendChild(buildOnchainCard(agent));
		}

		if (nativeAgents.length === 0 && unimportedOnchain.length === 0) {
			showState(
				'🤖',
				'No agents yet',
				'Create your first agent to get started.',
				{ label: 'Create an agent', href: '/create' },
				{ label: 'Or browse community agents →', href: '/discover' },
			);
		}
	} catch (err) {
		grid.innerHTML = '';
		const msg = err.message || '';
		if (msg.includes('429') || /too many/i.test(msg)) {
			showErrorBanner('Too many requests. Try again in a minute.', true);
		} else {
			showErrorBanner(msg || 'Failed to load agents.', true);
		}
	}
}

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
