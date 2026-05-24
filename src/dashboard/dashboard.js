// Dashboard single-file app. Uses native DOM — no framework.
// Keeps bundle small and ensures anything rendering <model-viewer> works without bundler.

import { mountAgentSolanaWalletCard } from '/src/agent-solana-wallet.js';
import { mountAgentVanityGrinderCard } from '/src/agent-vanity-grinder.js';

export const state = { user: null };

function visibilityOptionsHtml(currentValue) {
	const opts = [
		{ v: 'public', label: 'Public (discoverable)' },
		{ v: 'unlisted', label: 'Unlisted (anyone with link)' },
		{ v: 'private', label: 'Private (only you)' },
	];
	return opts
		.map(
			(o) =>
				`<option value="${o.v}"${currentValue === o.v ? ' selected' : ''}>${o.label}</option>`,
		)
		.join('');
}

export const api = {
	me: () => j('GET', '/api/auth/me'),
	listAvatars: ({ cursor, limit = 24 } = {}) => {
		const params = new URLSearchParams({ limit: String(limit) });
		if (cursor) params.set('cursor', cursor);
		return j('GET', `/api/avatars?${params.toString()}`);
	},
	deleteAvatar: (id) => j('DELETE', `/api/avatars/${id}`),
	patchAvatar: (id, patch) => j('PATCH', `/api/avatars/${id}`, patch),
	presign: (body) => j('POST', '/api/avatars/presign', body),
	createAvatar: (body) => j('POST', '/api/avatars', body),
	listKeys: () => j('GET', '/api/keys'),
	createKey: (body) => j('POST', '/api/keys', body),
	revokeKey: (id) => j('DELETE', `/api/keys/${id}`),
	listWidgets: () => j('GET', '/api/widgets'),
	getWidget: (id) => j('GET', `/api/widgets/${encodeURIComponent(id)}`),
	patchWidget: (id, patch) => j('PATCH', `/api/widgets/${encodeURIComponent(id)}`, patch),
	deleteWidget: (id) => j('DELETE', `/api/widgets/${encodeURIComponent(id)}`),
	duplicateWidget: (id) => j('POST', `/api/widgets/${encodeURIComponent(id)}/duplicate`),
	widgetStats: (id) => j('GET', `/api/widgets/${encodeURIComponent(id)}/stats`),
	listTranscripts: (id, params = {}) => {
		const qs = new URLSearchParams();
		if (params.limit) qs.set('limit', String(params.limit));
		if (params.before) qs.set('before', params.before);
		const q = qs.toString();
		return j('GET', `/api/widgets/${encodeURIComponent(id)}/transcripts${q ? `?${q}` : ''}`);
	},
	getTranscript: (id, threadId) =>
		j(
			'GET',
			`/api/widgets/${encodeURIComponent(id)}/transcripts?thread_id=${encodeURIComponent(threadId)}`,
		),
	listKnowledge: (id) => j('GET', `/api/widgets/${encodeURIComponent(id)}/knowledge`),
	createAvatarSession: (id) => j('POST', `/api/avatars/${id}/session`),
	getAvatarVersions: (id) => j('GET', `/api/avatars/${id}/versions`),
	patchAgent: (agentId, patch) => j('PUT', `/api/agents/${agentId}`, patch),
	deleteAgent: (agentId) => j('DELETE', `/api/agents/${encodeURIComponent(agentId)}`),
	createAgent: (body) => j('POST', '/api/agents', body),
	getAgentMe: () => j('GET', '/api/agents/me'),
	getAvatar: (id) => j('GET', `/api/avatars/${encodeURIComponent(id)}`),
	patchAgentAnimations: (agentId, animations) =>
		j('PUT', `/api/agents/${encodeURIComponent(agentId)}/animations`, { animations }),
	presignAnimation: (body) => j('POST', '/api/animations/presign', body),
	listAgents: () => j('GET', '/api/agents'),
	getRevenue: (params) => {
		const q = new URLSearchParams();
		if (params.from) q.set('from', params.from);
		if (params.to) q.set('to', params.to);
		if (params.agent_id) q.set('agent_id', params.agent_id);
		if (params.granularity) q.set('granularity', params.granularity);
		return j('GET', `/api/billing/revenue?${q.toString()}`);
	},
	listWithdrawals: ({ status, limit, offset } = {}) => {
		const q = new URLSearchParams();
		if (status) q.set('status', status);
		if (limit) q.set('limit', String(limit));
		if (offset) q.set('offset', String(offset));
		const qs = q.toString();
		return j('GET', `/api/billing/withdrawals${qs ? '?' + qs : ''}`);
	},
	requestWithdrawal: (body) => j('POST', '/api/billing/withdrawals', body),
	listPayoutWallets: () => j('GET', '/api/billing/payout-wallets'),
};

// Single-use CSRF token: fetched lazily, invalidated on consumption. Re-issued
// on the next mutating call.
let _csrfToken = null;
async function getCsrfToken() {
	if (_csrfToken) return _csrfToken;
	const r = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!r.ok) return null;
	const j = await r.json();
	_csrfToken = j?.data?.token || null;
	return _csrfToken;
}

async function j(method, path, body) {
	const headers = body ? { 'content-type': 'application/json' } : {};
	// State-changing methods: attach CSRF token (single-use, server burns it).
	if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
		const csrf = await getCsrfToken();
		if (csrf) headers['x-csrf-token'] = csrf;
		_csrfToken = null;
	}
	const res = await fetch(path, {
		method,
		credentials: 'include',
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = res.headers.get('content-type')?.includes('application/json')
		? await res.json()
		: null;
	if (!res.ok)
		throw Object.assign(new Error((data && data.error_description) || res.statusText), {
			status: res.status,
			data,
		});
	return data;
}

export function signOut() {
	fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).finally(() => {
		try {
			localStorage.removeItem('3dagent:auth-hint');
		} catch {
			/* ignore */
		}
		location.href = '/';
	});
}

const KNOWN_TABS = [
	'agents',
	'avatars',
	'create',
	'edit',
	'upload',
	'animations',
	'widgets',
	'embed',
	'keys',
	'mcp',
	'monetization',
	'payments',
	'subscriptions',
	'billing',
	'revenue',
	'withdrawals',
	'earnings',
	'account',
];

// Read the current dashboard route from the URL. Path-based URLs
// (/dashboard/<tab>[/<param>]) are canonical; legacy #hash URLs are
// honored for back-compat and rewritten to the canonical path.
export function currentRoute() {
	const path = location.pathname.replace(/\/+$/, '');
	const m = path.match(/^\/dashboard(?:\/(.+))?$/);
	if (m && m[1]) return m[1];
	const hash = location.hash.slice(1);
	if (hash) return hash;
	return 'avatars';
}

// Render a route into <main>. Does not touch the URL.
function renderRoute(route) {
	const [base, ...rest] = (route || 'avatars').split('/');
	document
		.querySelectorAll('aside a')
		.forEach((a) => a.classList.toggle('active', a.dataset.tab === base));
	const main = document.getElementById('main');
	main.innerHTML = '';
	const renderer = tabs[base] || tabs.avatars;
	renderer(main, rest);
}

// Programmatic navigation: pushes /dashboard/<route> into history and renders.
// Use this instead of `location.hash = ...`.
export function goto(route) {
	const clean = (route || 'avatars').replace(/^#?\/+|\/+$/g, '').replace(/^#/, '');
	const target = '/dashboard/' + clean;
	if (location.pathname + location.search !== target) {
		history.pushState({ route: clean }, '', target);
	}
	renderRoute(clean);
}

// Initial-load entry: derive route from URL, rewrite legacy hash to path, render.
export function navigate(routeOrNull) {
	const route = routeOrNull || currentRoute();
	if (location.hash) {
		const clean = route.replace(/^\/+|\/+$/g, '');
		history.replaceState({ route: clean }, '', '/dashboard/' + clean);
	}
	renderRoute(route);
}

// Install one-time global handlers for in-app navigation. Idempotent.
let __dashRoutingInstalled = false;
export function installRouting() {
	if (__dashRoutingInstalled) return;
	__dashRoutingInstalled = true;

	// Intercept clicks on in-app links so they use pushState instead of reloading.
	document.addEventListener('click', (e) => {
		if (e.defaultPrevented || e.button !== 0) return;
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const a = e.target.closest('a');
		if (!a) return;
		if (a.target && a.target !== '_self') return;
		const href = a.getAttribute('href');
		if (!href) return;

		// Legacy hash links inside the dashboard.
		if (href.startsWith('#')) {
			const route = href.slice(1);
			if (route && (KNOWN_TABS.includes(route.split('/')[0]) || route === '')) {
				e.preventDefault();
				goto(route);
			}
			return;
		}

		// Same-origin /dashboard/<tab> links.
		if (href.startsWith('/dashboard/')) {
			const tab = href.slice('/dashboard/'.length).split(/[?#]/)[0];
			const base = tab.split('/')[0];
			if (KNOWN_TABS.includes(base)) {
				e.preventDefault();
				goto(tab);
			}
		}
	});

	window.addEventListener('popstate', () => renderRoute(currentRoute()));
}

const tabs = {
	agents: renderAgents,
	avatars: renderAvatars,
	create: renderCreate,
	edit: renderEdit,
	upload: renderUpload,
	animations: renderAnimations,
	widgets: renderWidgets,
	embed: renderEmbed,
	keys: renderKeys,
	mcp: renderMcp,
	monetization: renderMonetization,
	payments: renderPayments,
	subscriptions: renderSubscriptions,
	billing: renderBilling,
	revenue: renderRevenue,
	withdrawals: renderWithdrawals,
	earnings: renderEarnings,
	account: renderAccount,
};

// ── Agents ──────────────────────────────────────────────────────────────────
// On-chain agents discovered from linked wallets live at /my-agents.

const AGENT_CHAIN_NAMES = {
	1: 'Ethereum',
	10: 'Optimism',
	56: 'BNB Chain',
	97: 'BSC Testnet',
	100: 'Gnosis',
	137: 'Polygon',
	250: 'Fantom',
	324: 'zkSync Era',
	1284: 'Moonbeam',
	5000: 'Mantle',
	8453: 'Base',
	42161: 'Arbitrum',
	42220: 'Celo',
	43113: 'Avalanche Fuji',
	43114: 'Avalanche',
	59144: 'Linea',
	80002: 'Polygon Amoy',
	84532: 'Base Sepolia',
	421614: 'Arb Sepolia',
	534352: 'Scroll',
	11155111: 'Sepolia',
	11155420: 'OP Sepolia',
};

function agentChainName(id) {
	if (id == null) return '';
	return AGENT_CHAIN_NAMES[Number(id)] || `Chain ${id}`;
}

async function renderAgents(root) {
	root.innerHTML = `
		<div class="widgets-header">
			<div>
				<h1>Your agents</h1>
				<p class="sub">Agents you've created on three.ws — each has a wallet, skills, and an optional on-chain identity.</p>
			</div>
			<button id="agents-new" class="btn-primary" type="button">New agent</button>
		</div>
		<div id="agents-create-host"></div>
		<div id="agents-list" class="cards"></div>
	`;

	const list = root.querySelector('#agents-list');
	const createHost = root.querySelector('#agents-create-host');
	list.innerHTML = '<div class="muted">Loading…</div>';

	root.querySelector('#agents-new').addEventListener('click', () =>
		openCreateForm(createHost, list),
	);

	let agents = [];
	try {
		const data = await api.listAgents();
		agents = data.agents || [];
	} catch (e) {
		list.innerHTML = `<div class="err">${esc(e.message || 'Failed to load agents')}</div>`;
		return;
	}

	list.innerHTML = '';
	if (!agents.length) {
		renderAgentsEmpty(list, createHost);
		return;
	}

	for (const a of agents)
		list.appendChild(agentCard(a, () => maybeRenderEmpty(list, createHost)));
}

function renderAgentsEmpty(list, createHost) {
	list.innerHTML = `
		<div class="empty" style="grid-column:1/-1; padding:48px 28px; text-align:center;">
			<div style="font-size:48px; line-height:1; margin-bottom:14px;" aria-hidden="true">🤖</div>
			<h2 style="margin:0 0 8px; font-size:20px; color:#eee;">No agents yet</h2>
			<p style="margin:0 0 22px; color:#888; max-width:460px; margin-left:auto; margin-right:auto;">
				Create your first three.ws agent — it gets a wallet, a set of skills, and can be deployed on-chain as an ERC-8004 identity.
			</p>
			<div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
				<button class="btn-primary" id="agents-empty-new">Create agent</button>
				<a href="/my-agents" class="btn-primary" style="background:#222230; color:#ddd;">Import from wallet</a>
			</div>
		</div>`;
	list.querySelector('#agents-empty-new').addEventListener('click', () =>
		openCreateForm(createHost, list),
	);
}

function maybeRenderEmpty(list, createHost) {
	if (!list.querySelector('.card')) renderAgentsEmpty(list, createHost);
}

function agentCard(a, onRemoved) {
	const el = document.createElement('div');
	el.className = 'card';

	const onchainBadge = a.is_registered
		? `<span class="tag" title="Registered on-chain (ERC-8004)" style="background:rgba(106,92,255,0.18); color:#cfc6ff;">on-chain${a.chain_id ? ' · ' + esc(agentChainName(a.chain_id)) : ''}</span>`
		: `<span class="tag" title="Not yet registered on-chain">off-chain</span>`;
	const skillCount = (a.skills || []).length;
	const wallet = a.wallet_address
		? `${a.wallet_address.slice(0, 6)}…${a.wallet_address.slice(-4)}`
		: '';

	const agentIdEnc = encodeURIComponent(a.id);
	const hasAvatar = Boolean(a.avatar_id);
	const embedDisabledAttr = hasAvatar
		? ''
		: 'disabled title="Link an avatar (Edit → Avatar) to enable embed"';
	const token = a.token || a.meta?.token || null;
	const tokenBadge = token?.mint
		? `<span class="tag" title="${attr(token.mint)}" style="background:rgba(120,200,140,0.18); color:#c6f0d6;">$${esc(token.symbol || 'TOKEN')}</span>`
		: '';
	el.innerHTML = `
		<div class="preview" data-agent-preview></div>
		<h3>${esc(a.name || 'Agent')}</h3>
		<p class="meta">${skillCount} skill${skillCount === 1 ? '' : 's'}${wallet ? ' · ' + esc(wallet) : ''} · ${new Date(a.created_at).toLocaleDateString()}</p>
		<div class="row" style="gap:6px; margin-bottom:10px; flex-wrap:wrap">${onchainBadge}${tokenBadge}</div>
		${a.description ? `<p class="meta" style="white-space:normal;color:#aaa;margin:0 0 10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(a.description)}</p>` : ''}
		<details class="agent-inspector" style="margin:0 0 10px;border-top:1px solid #22222e;padding-top:10px">
			<summary style="cursor:pointer;font-size:12px;color:#9a8cff;list-style:none">Inspector ▾</summary>
			<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;margin-top:10px;font-size:12px">
				<a href="/dashboard/memory?agent=${agentIdEnc}">Memory</a>
				<a href="/dashboard/actions?agent=${agentIdEnc}">Action log</a>
				<a href="/dashboard/strategy?agent=${agentIdEnc}">Strategy</a>
				<a href="/dashboard/usage?agent=${agentIdEnc}">LLM usage</a>
				<a href="/dashboard/voice?agent=${agentIdEnc}">Voice</a>
				<a href="/dashboard/sns?agent=${agentIdEnc}">SNS domains</a>
				<a href="/dashboard/delegation?agent=${agentIdEnc}">Delegation</a>
				<a href="/dashboard/embed-policy?agent=${agentIdEnc}">Embed policy</a>
				<a href="/dashboard/portfolio?agent=${agentIdEnc}">Portfolio &amp; NFTs</a>
				<a href="/dashboard/sessions?agent=${agentIdEnc}">Sessions</a>
				<a href="/dashboard/storage?agent=${agentIdEnc}">Storage</a>
				<a href="/dashboard/tokens?agent=${agentIdEnc}">Tokens (Pump.fun)</a>
			</div>
		</details>
		<div class="footer">
			<div class="actions">
				<a class="btn sec" href="/agent/${agentIdEnc}" title="Open public agent page">Open</a>
				<a class="btn sec" href="/agent/${agentIdEnc}/edit" title="Edit name, persona, avatar, skills">Edit</a>
				<button class="btn sec" data-share type="button" title="Copy public agent link">Share</button>
				<button class="btn sec" data-embed type="button" ${embedDisabledAttr}>Embed</button>
				${
					token?.mint
						? `<a class="btn sec" href="/dashboard/tokens?agent=${agentIdEnc}" title="Open pump.fun token dashboard">Token ↗</a>`
						: `<button class="btn sec" data-launch type="button" title="Launch a pump.fun token for this agent">🚀 Launch token</button>`
				}
				${a.is_registered ? '' : `<a class="btn sec" href="/deploy${a.avatar_id ? '?avatar=' + encodeURIComponent(a.avatar_id) : ''}" title="Mint as ERC-8004 agent">Deploy on-chain</a>`}
				<div class="more-menu-wrap"><button class="btn sec" data-more type="button" aria-haspopup="menu" aria-expanded="false">More ▾</button></div>
			</div>
		</div>
	`;

	mountAgentAvatarPreview(el.querySelector('[data-agent-preview]'), a);

	el.querySelector('[data-share]').addEventListener('click', (e) => {
		copyToClipboard(`${location.origin}/agent/${a.id}`, e.currentTarget);
	});
	el.querySelector('[data-embed]').addEventListener('click', (e) => {
		if (e.currentTarget.disabled) return;
		openAgentEmbedModal(a);
	});
	const launchBtn = el.querySelector('[data-launch]');
	if (launchBtn) {
		launchBtn.addEventListener('click', async (e) => {
			const btn = e.currentTarget;
			btn.disabled = true;
			try {
				const { openLaunchTokenModal } = await import('/src/pump/launch-token-modal.js');
				const onchain = a.onchain || a.meta?.onchain || null;
				const needsDeploy = !onchain || onchain.family !== 'solana';
				openLaunchTokenModal({
					agentId: a.id,
					agentName: a.name || 'Agent',
					imageUrl: a.avatar_thumbnail_url || a.meta?.thumbnail_url || '',
					needsDeploy,
					agentForDeploy: needsDeploy
						? {
								id: a.id,
								name: a.name,
								description: a.description || '',
								avatar_id: a.avatar_id || null,
								skills: a.skills || undefined,
							}
						: null,
				});
			} finally {
				btn.disabled = false;
			}
		});
	}
	el.querySelector('[data-more]').addEventListener('click', (e) => {
		const btn = e.currentTarget;
		if (_openMoreMenu?.triggerBtn === btn) {
			closeMoreMenu();
			return;
		}
		openMoreMenu(btn, agentMoreItems(a, el, onRemoved));
	});

	return el;
}

// Items shown in an agent card's "More ▾" dropdown. Each item is wired to a
// real action — no placeholders.
function agentMoreItems(a, el, onRemoved) {
	const agentIdEnc = encodeURIComponent(a.id);
	const items = [
		{
			label: 'Open public page ↗',
			run: () => window.open(`/agent/${agentIdEnc}`, '_blank', 'noopener'),
		},
		{
			label: 'View manifest JSON ↗',
			run: () => window.open(`/api/agents/${agentIdEnc}/manifest`, '_blank', 'noopener'),
		},
		{
			label: 'Show QR code',
			run: () => openQrModal(`${location.origin}/agent/${a.id}`, a.name || 'Agent'),
		},
		{
			label: 'Duplicate',
			run: () => duplicateAgent(a, el),
		},
	];
	if (a.is_registered) {
		items.push({
			label: 'View on-chain passport ↗',
			run: () => {
				const meta = a.meta || {};
				const asset = meta.solana_asset || meta.metaplex_asset || a.solana_asset;
				const url = asset
					? `/agent-passport.html?asset=${encodeURIComponent(asset)}`
					: `/agent-badge.html?id=${agentIdEnc}`;
				window.open(url, '_blank', 'noopener');
			},
		});
	}
	items.push({
		label: 'Delete',
		danger: true,
		run: async () => {
			if (!confirm(`Delete "${a.name}"? This cannot be undone.`)) return;
			try {
				await api.deleteAgent(a.id);
				el.remove();
				toast(`Deleted "${a.name}"`);
				onRemoved?.();
			} catch (err) {
				toast(err.message || 'Delete failed', true);
			}
		},
	});
	return items;
}

async function duplicateAgent(a, sourceEl) {
	const baseName = a.name || 'Agent';
	const newName = `${baseName} copy`.slice(0, 100);
	try {
		const payload = { name: newName };
		if (a.description) payload.description = a.description;
		if (a.skills?.length) payload.skills = a.skills;
		if (a.avatar_id) payload.avatar_id = a.avatar_id;
		const { agent } = await api.createAgent(payload);
		const list = sourceEl.parentElement;
		if (list) {
			const newCard = agentCard(agent, () =>
				maybeRenderEmpty(list, list.previousElementSibling || list),
			);
			sourceEl.insertAdjacentElement('afterend', newCard);
		}
		toast(`Created "${agent.name}"`);
	} catch (err) {
		toast(err.message || 'Duplicate failed', true);
	}
}

// Mount a 3D model-viewer (or thumbnail fallback) for an agent card.
// Lazy-loads when the card scrolls into view. For private linked avatars,
// fetches a short-lived signed URL via /api/avatars/:id.
function mountAgentAvatarPreview(host, agent) {
	if (!host) return;
	const name = agent?.name || 'Agent';
	const showPlaceholder = () => {
		host.innerHTML = `<div class="ph"><div style="font-size:32px;line-height:1;margin-bottom:8px" aria-hidden="true">🤖</div><div>No avatar linked</div></div>`;
	};
	const showSpinner = () => {
		host.innerHTML = '<div class="spinner" aria-label="Loading preview"></div>';
	};
	const showModel = (url) => {
		host.innerHTML = `<model-viewer src="${attr(url)}" camera-controls auto-rotate shadow-intensity="1" exposure="1" tone-mapping="aces" loading="lazy" reveal="auto"></model-viewer>`;
	};
	const showThumb = (url) => {
		host.innerHTML = `<img class="thumb" src="${attr(url)}" alt="${attr(name)} avatar" loading="lazy">`;
	};

	if (!agent?.avatar_id) {
		showPlaceholder();
		return;
	}

	// Seed with the public thumbnail (if any) so the card paints instantly.
	if (agent.avatar_thumbnail_url) showThumb(agent.avatar_thumbnail_url);
	else host.innerHTML = '<div class="ph">Loading preview…</div>';

	let loaded = false;
	const load = async () => {
		if (loaded) return;
		loaded = true;
		if (agent.avatar_model_url) {
			showModel(agent.avatar_model_url);
			return;
		}
		showSpinner();
		try {
			const { avatar } = await api.getAvatar(agent.avatar_id);
			const url = avatar?.url || avatar?.model_url;
			if (url) showModel(url);
			else if (avatar?.thumbnail_url) showThumb(avatar.thumbnail_url);
			else showPlaceholder();
		} catch {
			loaded = false;
			host.innerHTML = `<div class="ph">Preview unavailable<br><button data-retry>Retry</button></div>`;
			host.querySelector('[data-retry]').addEventListener('click', load);
		}
	};

	if ('IntersectionObserver' in window) {
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						io.disconnect();
						load();
					}
				}
			},
			{ rootMargin: '200px' },
		);
		io.observe(host);
	} else {
		load();
	}
}

function openCreateForm(host, listEl) {
	if (host.querySelector('input[name=agent-name]')) {
		host.querySelector('input[name=agent-name]').focus();
		return;
	}
	host.innerHTML = `
		<div class="card" style="margin-bottom:14px">
			<h3 style="margin:0 0 10px">New agent</h3>
			<form id="agents-create-form" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
				<input name="agent-name" type="text" maxlength="100" required placeholder="Name (e.g. Sasha)" style="flex:1; min-width:180px" autofocus>
				<input name="agent-desc" type="text" maxlength="500" placeholder="Description (optional)" style="flex:2; min-width:200px">
				<button class="btn-primary" type="submit">Create</button>
				<button class="btn sec" type="button" data-cancel>Cancel</button>
			</form>
			<div class="muted" data-err style="margin-top:8px; color:#ffb3b3; min-height:1em; font-size:12px"></div>
		</div>`;
	const form = host.querySelector('#agents-create-form');
	const errEl = host.querySelector('[data-err]');
	host.querySelector('[data-cancel]').addEventListener('click', () => {
		host.innerHTML = '';
	});
	form.addEventListener('submit', async (ev) => {
		ev.preventDefault();
		const fd = new FormData(form);
		const name = String(fd.get('agent-name') || '').trim();
		const description = String(fd.get('agent-desc') || '').trim();
		if (!name) return;
		const submitBtn = form.querySelector('button[type=submit]');
		submitBtn.disabled = true;
		submitBtn.textContent = 'Creating…';
		errEl.textContent = '';
		try {
			const { agent } = await api.createAgent(description ? { name, description } : { name });
			host.innerHTML = '';
			const empty = listEl.querySelector('.empty');
			if (empty) listEl.innerHTML = '';
			listEl.prepend(agentCard(agent, () => maybeRenderEmpty(listEl, host)));
			toast(`Created "${agent.name}"`);
		} catch (e) {
			submitBtn.disabled = false;
			submitBtn.textContent = 'Create';
			errEl.textContent = e.message || 'Failed to create agent';
		}
	});
}

// ── Avatars ─────────────────────────────────────────────────────────────────
async function renderAvatars(root) {
	root.innerHTML = `<h1>Your avatars</h1><p class="sub">Each avatar gets a stable URL and can be rendered in Claude or any app via MCP.</p><div id="list" class="cards"></div>`;
	const list = root.querySelector('#list');
	list.innerHTML = '<div class="muted">Loading…</div>';

	let nextCursor = null;
	let loadMoreEl = null;

	const appendPage = ({ avatars, next_cursor }, replace) => {
		if (replace) list.innerHTML = '';
		if (loadMoreEl) loadMoreEl.remove();
		for (const a of avatars) list.appendChild(avatarCard(a));
		nextCursor = next_cursor || null;
		if (nextCursor) {
			loadMoreEl = document.createElement('div');
			loadMoreEl.className = 'load-more';
			loadMoreEl.innerHTML = '<button type="button">Load more</button>';
			loadMoreEl.querySelector('button').addEventListener('click', loadNext);
			list.appendChild(loadMoreEl);
		}
	};

	const loadNext = async () => {
		if (!nextCursor) return;
		const btn = loadMoreEl?.querySelector('button');
		if (btn) {
			btn.disabled = true;
			btn.textContent = 'Loading…';
		}
		try {
			const data = await api.listAvatars({ cursor: nextCursor });
			appendPage(data, false);
		} catch (e) {
			toast(e.message || 'Failed to load more', true);
			if (btn) {
				btn.disabled = false;
				btn.textContent = 'Load more';
			}
		}
	};

	try {
		const data = await api.listAvatars();
		if (!data.avatars.length) {
			list.innerHTML = `
				<div class="empty" style="grid-column:1/-1; padding:48px 28px; text-align:center;">
					<div style="font-size:48px; line-height:1; margin-bottom:14px;" aria-hidden="true">👤</div>
					<h2 style="margin:0 0 8px; font-size:20px; color:#eee;">Create your first agent</h2>
					<p style="margin:0 0 22px; color:#888; max-width:440px; margin-left:auto; margin-right:auto;">
						Turn a selfie into a 3D avatar, upload an existing .glb, or deploy a metadata-only agent on-chain. Each gets a stable URL you can embed anywhere.
					</p>
					<div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
						<a href="/create" class="btn-primary">Take a selfie →</a>
						<a href="/dashboard/upload" class="btn-primary" style="background:#222230; color:#ddd;">Upload .glb</a>
						<a href="/deploy" class="btn-primary" style="background:#222230; color:#ddd;">Deploy on-chain</a>
					</div>
				</div>`;
			return;
		}
		appendPage(data, true);
	} catch (e) {
		list.innerHTML = `<div class="err">${esc(e.message)}</div>`;
	}
}

function avatarCard(a) {
	const el = document.createElement('div');
	el.className = 'card';
	const isPrivate = a.visibility === 'private';
	const studioUrl = `/studio?avatar=${encodeURIComponent(a.id)}`;
	const viewUrl = `/avatars/${encodeURIComponent(a.id)}`;
	const embedDisabledAttr = isPrivate
		? 'disabled title="Set this avatar to public or unlisted to embed it."'
		: '';
	const copyDisabledAttr = isPrivate
		? 'disabled title="Private avatars have no public link. Switch to unlisted or public to share."'
		: '';
	const hasAgent = Boolean(a.agent_id);
	const makeAgentAttrs = hasAgent
		? 'disabled title="This avatar already has an agent linked"'
		: 'title="Create a new agent linked to this avatar"';
	el.innerHTML = `
		<div class="preview" data-preview></div>
		<h3>${esc(a.name)}</h3>
		<p class="meta">${a.size_bytes ? fmtSize(a.size_bytes) : ''} · ${esc(a.visibility)} · ${new Date(a.created_at).toLocaleDateString()}</p>
		<div class="row" style="gap:6px; margin-bottom:10px; flex-wrap:wrap">${a.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
		<div class="footer">
			<select data-vis aria-label="Visibility">${visibilityOptionsHtml(a.visibility)}</select>
			<div class="actions">
				<a class="btn" href="${attr(studioUrl)}" title="Open this avatar in Studio to build an embeddable widget">Studio</a>
				<button class="btn" data-embed ${embedDisabledAttr}>Embed</button>
				<a class="btn sec" href="${attr(viewUrl)}" target="_blank" rel="noopener" title="Open the public viewer in a new tab">View</a>
				<button class="btn sec" data-make-agent type="button" ${makeAgentAttrs}>Make agent</button>
				<button class="btn sec" data-download type="button" title="Download the .glb file">Download</button>
				<div class="more-menu-wrap"><button class="btn sec" data-more type="button" aria-haspopup="menu" aria-expanded="false">More ▾</button></div>
			</div>
		</div>
		<div data-wallet-host></div>
	`;
	const previewEl = el.querySelector('[data-preview]');
	mountAvatarPreview(previewEl, a);
	mountAvatarWalletSection(el.querySelector('[data-wallet-host]'), a);

	el.querySelector('[data-vis]').addEventListener('change', async (e) => {
		const next = e.target.value;
		try {
			await api.patchAvatar(a.id, { visibility: next });
			a.visibility = next;
			const nowPrivate = next === 'private';
			const embedBtn = el.querySelector('[data-embed]');
			const copyBtn = el.querySelector('[data-copy-url]');
			if (embedBtn) {
				embedBtn.disabled = nowPrivate;
				embedBtn.title = nowPrivate
					? 'Set this avatar to public or unlisted to embed it.'
					: '';
			}
			if (copyBtn) {
				copyBtn.disabled = nowPrivate;
				copyBtn.title = nowPrivate
					? 'Private avatars have no public link. Switch to unlisted or public to share.'
					: '';
			}
			const metaEl = el.querySelector('.meta');
			if (metaEl) {
				metaEl.textContent = `${a.size_bytes ? fmtSize(a.size_bytes) : ''} · ${next} · ${new Date(a.created_at).toLocaleDateString()}`;
			}
		} catch (err) {
			toast(err.message || 'Failed to update visibility', true);
			e.target.value = a.visibility;
		}
	});
	el.querySelector('[data-embed]').addEventListener('click', (e) => {
		if (e.currentTarget.disabled) return;
		openAvatarEmbedModal(a);
	});
	el.querySelector('[data-make-agent]').addEventListener('click', async (e) => {
		if (e.currentTarget.disabled) return;
		await makeAgentFromAvatar(a, e.currentTarget);
	});
	el.querySelector('[data-download]').addEventListener('click', async (e) => {
		await downloadAvatarGlb(a, e.currentTarget);
	});
	el.querySelector('[data-more]').addEventListener('click', (e) => {
		const btn = e.currentTarget;
		if (_openMoreMenu?.triggerBtn === btn) {
			closeMoreMenu();
			return;
		}
		openMoreMenu(btn, avatarMoreItems(a, el));
	});
	return el;
}

function avatarMoreItems(a, el) {
	const isPrivate = a.visibility === 'private';
	const items = [];
	if (!isPrivate) {
		items.push({
			label: 'Copy public URL',
			run: () => copyToClipboard(`${location.origin}/avatars/${a.id}`),
		});
	}
	items.push({
		label: 'Show QR code',
		run: () => openQrModal(`${location.origin}/avatars/${a.id}`, a.name || 'Avatar'),
	});
	items.push({
		label: 'Edit details',
		run: () => goto(`edit/${encodeURIComponent(a.id)}`),
	});
	items.push({
		label: 'Replace GLB…',
		run: () => replaceGlbFlow(a, el),
	});
	items.push({
		label: 'Deploy on-chain',
		run: () => {
			location.href = `/deploy?avatar=${encodeURIComponent(a.id)}`;
		},
	});
	items.push({
		label: 'Delete',
		danger: true,
		run: async () => {
			if (!confirm(`Delete "${a.name}"?`)) return;
			try {
				await api.deleteAvatar(a.id);
				el.remove();
				toast(`Deleted "${a.name}"`);
			} catch (err) {
				toast(err.message || 'Delete failed', true);
			}
		},
	});
	return items;
}

async function makeAgentFromAvatar(a, btn) {
	const original = btn.textContent;
	btn.disabled = true;
	btn.textContent = 'Creating…';
	try {
		const baseName = a.name || 'Agent';
		const { agent } = await api.createAgent({
			name: baseName.slice(0, 100),
			avatar_id: a.id,
		});
		toast(`Created agent "${agent.name}"`);
		// Swap the button for a plain link so the original click handler that
		// calls makeAgentFromAvatar can't fire again and race a second create.
		const link = document.createElement('a');
		link.className = 'btn sec';
		link.href = `/agent/${encodeURIComponent(agent.id)}/edit`;
		link.textContent = 'Open agent →';
		link.title = 'Open the newly-created agent';
		btn.replaceWith(link);
	} catch (err) {
		btn.disabled = false;
		btn.textContent = original;
		toast(err.message || 'Failed to create agent', true);
	}
}

async function downloadAvatarGlb(a, btn) {
	const original = btn.textContent;
	btn.disabled = true;
	btn.textContent = 'Preparing…';
	try {
		let url = a.model_url;
		if (!url) {
			const { avatar } = await api.getAvatar(a.id);
			url = avatar?.url || avatar?.model_url;
		}
		if (!url) throw new Error('No download URL available');
		const resp = await fetch(url, { credentials: 'omit' });
		if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
		const blob = await resp.blob();
		const safeName =
			(a.name || 'avatar').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) || 'avatar';
		const link = document.createElement('a');
		const objectUrl = URL.createObjectURL(blob);
		link.href = objectUrl;
		link.download = `${safeName}.glb`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
		btn.textContent = 'Downloaded';
		setTimeout(() => {
			btn.textContent = original;
			btn.disabled = false;
		}, 1200);
	} catch (err) {
		btn.textContent = original;
		btn.disabled = false;
		toast(err.message || 'Download failed', true);
	}
}

// Mount the agent's wallet card under an avatar. If the avatar has no linked
// agent, show a "Create agent" CTA pointing at the on-chain deploy flow.
function mountAvatarWalletSection(host, a) {
	if (!host) return;
	if (!a.agent_id) {
		host.innerHTML = `
			<div class="muted" style="margin-top:10px; padding:10px; border:1px dashed #2a2a36; border-radius:8px; font-size:12px">
				No agent linked to this avatar yet.
				<a href="/deploy?avatar=${encodeURIComponent(a.id)}" style="color:#9a8cff">Deploy on-chain</a> to mint one
				and provision a wallet.
			</div>
		`;
		return;
	}
	const evm = a.agent_wallet_address;
	host.innerHTML = `
		${
			evm
				? `<div style="margin-top:10px; padding:8px 10px; border:1px solid #2a2a36; border-radius:8px; font-size:12px; line-height:1.5">
						<div class="muted" style="font-size:11px">Agent signing wallet (EVM)</div>
						<div class="row" style="gap:6px; align-items:center">
							<code style="font-size:11px; word-break:break-all; flex:1">${esc(evm)}</code>
							<button class="btn sec" type="button" data-copy-evm style="font-size:11px; padding:4px 8px">Copy</button>
						</div>
					</div>`
				: ''
		}
		<div data-sol-wallet style="margin-top:8px"></div>
	`;
	const copyBtn = host.querySelector('[data-copy-evm]');
	if (copyBtn && evm) {
		copyBtn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(evm);
				copyBtn.textContent = 'Copied';
				setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
			} catch {}
		});
	}
	const solPanel = host.querySelector('[data-sol-wallet]');
	const walletCard = mountAgentSolanaWalletCard({
		panel: solPanel,
		identity: { id: a.agent_id, name: a.name },
	});
	mountAgentVanityGrinderCard({
		panel: solPanel,
		identity: { id: a.agent_id, name: a.name },
		onProvisioned: () => walletCard?.refresh?.(),
	});
}

// ── X (Twitter) panel for the agent edit page ──────────────────────────────
// Renders: connect button | quota meter + composer + draft + schedule | disconnect.
function mountAgentXPanel(host, avatar) {
	if (!host) return;
	host.innerHTML = `
		<div class="card" style="padding:16px">
			<div class="row" style="justify-content:space-between;margin-bottom:10px;align-items:baseline">
				<h3 style="margin:0;font-size:14px">Post to X (Twitter)</h3>
				<span class="muted" style="font-size:11px" data-x-meter>Loading…</span>
			</div>
			<div data-x-body><div class="muted" style="font-size:13px">Loading…</div></div>
		</div>
	`;
	const meterEl = host.querySelector('[data-x-meter]');
	const bodyEl = host.querySelector('[data-x-body]');
	loadXPanel({ host, meterEl, bodyEl, avatar }).catch((err) => {
		bodyEl.innerHTML = `<div style="color:#ffb3b3;font-size:13px">${esc(err.message || 'Failed to load')}</div>`;
	});
}

async function loadXPanel({ host, meterEl, bodyEl, avatar }) {
	const status = await fetch('/api/x/status', { credentials: 'include' }).then((r) => r.json());

	if (!status.connected) {
		meterEl.textContent = '';
		bodyEl.innerHTML = `
			<p class="muted" style="font-size:13px;margin:0 0 10px">Connect your X account to let this agent post tweets. Free tier: 5 posts/month per account.</p>
			<a class="btn" href="/api/auth/x/connect?agent_id=${encodeURIComponent(avatar.agent_id || avatar.id)}">Connect X</a>
		`;
		return;
	}

	const used = status.posts_used;
	const quota = status.quota;
	const remaining = Math.max(0, quota - used);
	const tier = status.tier || 'free';
	const tierBadge =
		tier === 'pro'
			? `<span style="background:rgba(106,92,255,0.15);color:#a78bfa;padding:2px 7px;border-radius:99px;font-size:10px;font-weight:600;margin-left:6px">PRO</span>`
			: `<a href="/pricing" style="background:rgba(255,184,77,0.15);color:#ffb84d;padding:2px 7px;border-radius:99px;font-size:10px;font-weight:600;margin-left:6px;text-decoration:none">FREE · upgrade</a>`;
	meterEl.innerHTML = `@${esc(status.username)} ${tierBadge} <span style="color:${remaining === 0 ? '#ffb3b3' : '#9a8cff'};margin-left:6px">${used}/${quota}</span>`;

	bodyEl.innerHTML = `
		<div class="row" style="gap:8px;margin-bottom:8px;font-size:12px;flex-wrap:wrap;align-items:center">
			<label style="color:#888">Tone
				<select data-x-tone style="width:auto;display:inline-block;margin-left:4px">
					<option value="neutral">Neutral</option>
					<option value="hype">Hype</option>
					<option value="sarcastic">Sarcastic</option>
					<option value="technical">Technical</option>
					<option value="deadpan">Deadpan</option>
				</select>
			</label>
			<label style="color:#888"><input type="checkbox" data-x-thread style="width:auto;display:inline-block;margin:0 4px 0 8px"> Thread</label>
			<label style="color:#888"><input type="checkbox" data-x-link checked style="width:auto;display:inline-block;margin:0 4px 0 8px"> Append three.ws link</label>
		</div>
		<textarea data-x-text placeholder="What should your agent tweet? (or click Draft with AI)" rows="3" style="width:100%;font-family:inherit"></textarea>
		<div class="row" style="justify-content:space-between;margin-top:6px;font-size:11px">
			<span class="muted"><span data-x-count>0</span> chars</span>
			<span class="muted">Resets ${new Date(status.month_resets_at).toLocaleDateString()}</span>
		</div>
		<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
			<button class="btn sec" data-x-draft type="button">✨ Draft (1)</button>
			<button class="btn sec" data-x-draft3 type="button">✨ Draft 3 options</button>
			<button class="btn" data-x-post type="button" ${remaining === 0 ? 'disabled' : ''}>Post now</button>
			<button class="btn sec" data-x-schedule type="button" ${remaining === 0 ? 'disabled' : ''}>Schedule…</button>
			<button class="btn sec" data-x-disconnect type="button" style="margin-left:auto;font-size:11px;padding:4px 8px;background:transparent;color:#888">Disconnect</button>
		</div>
		<div data-x-drafts style="margin-top:10px"></div>
		<div data-x-msg style="margin-top:10px;font-size:13px"></div>
		<div data-x-reviews style="margin-top:14px"></div>
		<div data-x-scheduled style="margin-top:14px"></div>
		<div data-x-analytics style="margin-top:14px"></div>
		<div data-x-triggers style="margin-top:18px;padding-top:14px;border-top:1px solid #22222e"></div>
	`;

	const textEl = bodyEl.querySelector('[data-x-text]');
	const countEl = bodyEl.querySelector('[data-x-count]');
	const msgEl = bodyEl.querySelector('[data-x-msg]');
	const draftBtn = bodyEl.querySelector('[data-x-draft]');
	const draft3Btn = bodyEl.querySelector('[data-x-draft3]');
	const postBtn = bodyEl.querySelector('[data-x-post]');
	const scheduleBtn = bodyEl.querySelector('[data-x-schedule]');
	const disconnectBtn = bodyEl.querySelector('[data-x-disconnect]');
	const scheduledEl = bodyEl.querySelector('[data-x-scheduled]');
	const triggersEl = bodyEl.querySelector('[data-x-triggers]');
	const reviewsEl = bodyEl.querySelector('[data-x-reviews]');
	const analyticsEl = bodyEl.querySelector('[data-x-analytics]');
	const draftsEl = bodyEl.querySelector('[data-x-drafts]');
	const toneEl = bodyEl.querySelector('[data-x-tone]');
	const threadEl = bodyEl.querySelector('[data-x-thread]');
	const linkEl = bodyEl.querySelector('[data-x-link]');

	const setMsg = (text, color = '#9a8cff') => {
		msgEl.style.color = color;
		msgEl.innerHTML = text;
	};
	textEl.addEventListener('input', () => {
		countEl.textContent = textEl.value.length;
	});

	function readThreadParts() {
		const raw = textEl.value;
		if (!threadEl.checked) return null;
		return raw
			.split(/\n---+\n|\n\n\n+/)
			.map((s) => s.trim())
			.filter(Boolean);
	}

	async function generateDrafts(count) {
		try {
			const r = await fetch('/api/x/draft', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					agent_id: avatar.agent_id || avatar.id,
					prompt: textEl.value.trim(),
					tone: toneEl.value,
					thread: threadEl.checked,
					count,
				}),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error_description || 'draft failed');
			return data.drafts;
		} catch (err) {
			setMsg(err.message, '#ffb3b3');
			return null;
		}
	}

	function renderDrafts(drafts) {
		if (!drafts || !drafts.length) {
			draftsEl.innerHTML = '';
			return;
		}
		if (drafts.length === 1) {
			const d = drafts[0];
			if (d.thread_parts) textEl.value = d.thread_parts.join('\n\n\n');
			else textEl.value = d.text;
			countEl.textContent = textEl.value.length;
			draftsEl.innerHTML = '';
			setMsg('Draft ready — review and post.');
			return;
		}
		draftsEl.innerHTML = `
			<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px">Pick one</div>
			${drafts
				.map((d, i) => {
					const display = d.thread_parts ? d.thread_parts.join('\n\n— —\n\n') : d.text;
					return `<div data-draft-idx="${i}" style="padding:10px 12px;background:#0f0f17;border:1px solid #22222e;border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px;color:#ccc;white-space:pre-wrap">${esc(display)}</div>`;
				})
				.join('')}
		`;
		draftsEl.querySelectorAll('[data-draft-idx]').forEach((el) => {
			el.addEventListener('click', () => {
				const d = drafts[Number(el.getAttribute('data-draft-idx'))];
				if (d.thread_parts) textEl.value = d.thread_parts.join('\n\n\n');
				else textEl.value = d.text;
				countEl.textContent = textEl.value.length;
				draftsEl.innerHTML = '';
				setMsg('Selected.');
			});
		});
	}

	async function doDraft(count) {
		const btn = count === 1 ? draftBtn : draft3Btn;
		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = 'Drafting…';
		const drafts = await generateDrafts(count);
		btn.disabled = false;
		btn.textContent = original;
		if (drafts) renderDrafts(drafts);
	}

	draftBtn.addEventListener('click', () => doDraft(1));
	draft3Btn.addEventListener('click', () => doDraft(3));

	postBtn.addEventListener('click', async () => {
		const text = textEl.value.trim();
		if (!text) return setMsg('Write something first.', '#ffb3b3');
		postBtn.disabled = true;
		setMsg('Posting…');
		try {
			const parts = readThreadParts();
			const body =
				parts && parts.length > 1
					? {
							thread_parts: parts,
							agent_id: avatar.agent_id || avatar.id,
							append_link: linkEl.checked,
						}
					: { text, agent_id: avatar.agent_id || avatar.id, append_link: linkEl.checked };
			const r = await fetch('/api/x/post', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			const data = await r.json();
			if (!r.ok) {
				if (data.upgrade_url) {
					setMsg(
						`${data.error_description} <a href="${data.upgrade_url}">Upgrade to Pro</a>`,
						'#ffb3b3',
					);
					return;
				}
				throw new Error(data.error_description || 'post failed');
			}
			setMsg(
				`Posted: <a href="${data.url}" target="_blank" rel="noopener">${data.url}</a>${data.thread ? ` (${data.thread.length}-tweet thread)` : ''}`,
			);
			textEl.value = '';
			countEl.textContent = 0;
			loadXPanel({ host, meterEl, bodyEl, avatar });
		} catch (err) {
			setMsg(err.message, '#ffb3b3');
		} finally {
			postBtn.disabled = false;
		}
	});

	scheduleBtn.addEventListener('click', async () => {
		const text = textEl.value.trim();
		if (!text) return setMsg('Write something first.', '#ffb3b3');
		const input = prompt(
			'Schedule for (any date — e.g. "tomorrow 9am" or "2026-05-14T15:00"):',
			new Date(Date.now() + 3600_000).toISOString().slice(0, 16),
		);
		if (!input) return;
		const when = new Date(input);
		if (isNaN(when.getTime())) return setMsg('Could not parse that date.', '#ffb3b3');
		setMsg('Scheduling…');
		try {
			const r = await fetch('/api/x/schedule', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					text,
					scheduled_at: when.toISOString(),
					agent_id: avatar.agent_id || avatar.id,
				}),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error_description || 'schedule failed');
			setMsg(`Scheduled for ${when.toLocaleString()}.`);
			textEl.value = '';
			countEl.textContent = 0;
			loadScheduledPosts(scheduledEl);
		} catch (err) {
			setMsg(err.message, '#ffb3b3');
		}
	});

	disconnectBtn.addEventListener('click', async () => {
		if (!confirm('Disconnect your X account from three.ws?')) return;
		try {
			await fetch('/api/x/status', { method: 'DELETE', credentials: 'include' });
			loadXPanel({ host, meterEl, bodyEl, avatar });
		} catch (err) {
			setMsg(err.message, '#ffb3b3');
		}
	});

	loadScheduledPosts(scheduledEl);
	loadXTriggers(triggersEl, avatar);
	loadXReviews(reviewsEl);
	loadXAnalytics(analyticsEl, avatar);
}

async function loadXReviews(host) {
	if (!host) return;
	try {
		const r = await fetch('/api/x/reviews', { credentials: 'include' });
		const reviews = (await r.json()).reviews || [];
		if (!reviews.length) {
			host.innerHTML = '';
			return;
		}
		host.innerHTML = `
			<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;color:#ffb84d">⚠ ${reviews.length} draft${reviews.length === 1 ? '' : 's'} awaiting your review</div>
			${reviews
				.map(
					(r) => `
				<div style="padding:10px 12px;background:#1a1408;border:1px solid #3a2a14;border-radius:8px;margin-bottom:6px">
					<div style="color:#ccc;font-size:13px;white-space:pre-wrap">${esc(r.text)}</div>
					<div class="row" style="gap:6px;margin-top:8px">
						<button class="btn" data-approve="${attr(r.id)}" style="font-size:11px;padding:4px 10px">Approve & post</button>
						<button class="btn sec" data-reject="${attr(r.id)}" style="font-size:11px;padding:4px 10px">Reject</button>
						<span class="muted" style="font-size:11px;margin-left:auto">${new Date(r.created_at).toLocaleString()}</span>
					</div>
				</div>
			`,
				)
				.join('')}
		`;
		host.querySelectorAll('[data-approve]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.getAttribute('data-approve');
				btn.disabled = true;
				const r = await fetch(`/api/x/reviews?id=${encodeURIComponent(id)}`, {
					method: 'PATCH',
					credentials: 'include',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ action: 'approve', append_link: true }),
				});
				if (!r.ok) {
					alert((await r.json()).error_description || 'approve failed');
					btn.disabled = false;
					return;
				}
				loadXReviews(host);
			});
		});
		host.querySelectorAll('[data-reject]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.getAttribute('data-reject');
				await fetch(`/api/x/reviews?id=${encodeURIComponent(id)}`, {
					method: 'DELETE',
					credentials: 'include',
				});
				loadXReviews(host);
			});
		});
	} catch {}
}

async function loadXAnalytics(host, avatar) {
	if (!host) return;
	try {
		const r = await fetch(
			`/api/x/analytics?agent_id=${encodeURIComponent(avatar.agent_id || avatar.id)}`,
			{ credentials: 'include' },
		);
		const data = await r.json();
		const t = data.totals || {};
		if (!t.posts) {
			host.innerHTML = '';
			return;
		}
		host.innerHTML = `
			<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px">Engagement (last 50 posts)</div>
			<div class="row" style="gap:14px;flex-wrap:wrap;font-size:12px;color:#ccc">
				<div><b>${t.posts}</b> <span class="muted">posts</span></div>
				<div><b>${t.likes}</b> <span class="muted">likes</span></div>
				<div><b>${t.retweets}</b> <span class="muted">RTs</span></div>
				<div><b>${t.replies}</b> <span class="muted">replies</span></div>
				<div><b>${t.impressions.toLocaleString()}</b> <span class="muted">impressions</span></div>
			</div>
		`;
	} catch {}
}

async function loadXTriggers(host, avatar) {
	if (!host) return;
	const agentId = avatar.agent_id || avatar.id;
	host.innerHTML = `<div class="muted" style="font-size:11px">Loading triggers…</div>`;
	let triggers = [];
	try {
		const r = await fetch('/api/x/triggers', { credentials: 'include' });
		triggers = (await r.json()).triggers || [];
	} catch {}
	triggers = triggers.filter((t) => !t.agent_id || t.agent_id === agentId);
	const byKind = Object.fromEntries(triggers.map((t) => [t.kind, t]));

	const row = (kind, label, summary, controlsHtml) => {
		const t = byKind[kind];
		const on = t?.enabled;
		return `
			<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #1a1a24;align-items:flex-start">
				<label style="display:flex;align-items:center;cursor:pointer;padding-top:2px">
					<input type="checkbox" data-trig="${kind}" ${on ? 'checked' : ''} style="margin:0;width:auto">
				</label>
				<div style="flex:1;min-width:0">
					<div style="color:#ccc;font-size:13px;font-weight:500">${label}</div>
					<div class="muted" style="font-size:11px;margin-top:2px">${summary}</div>
					<div data-trig-config="${kind}" style="margin-top:8px;${on ? '' : 'display:none'}">${controlsHtml}</div>
				</div>
			</div>
		`;
	};

	const dailyHour = byKind.daily_persona?.config?.hour_utc ?? 13;
	const dailyTopic = byKind.daily_persona?.config?.topic ?? '';
	const weeklyDay = byKind.weekly_digest?.config?.day_of_week ?? 0;
	const weeklyHour = byKind.weekly_digest?.config?.hour_utc ?? 16;
	const priceThresholds = (
		byKind.price_milestone?.config?.thresholds_usd ?? [10000, 50000, 100000, 500000, 1000000]
	).join(', ');
	const paymentMin = byKind.payment_received?.config?.min_amount_usd ?? 1;

	const anyReviewMode = triggers.some((t) => t.auto_publish === false);

	host.innerHTML = `
		<div class="row" style="justify-content:space-between;margin-bottom:8px">
			<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.07em">Auto-post triggers</div>
			<label class="muted" style="font-size:11px"><input type="checkbox" data-trig-review-all ${anyReviewMode ? 'checked' : ''} style="width:auto;display:inline-block;margin-right:4px;vertical-align:middle"> Review before publish</label>
		</div>
		${row(
			'daily_persona',
			'Daily in-character post',
			'Agent tweets once a day at your chosen UTC hour, in voice.',
			`<label style="font-size:12px;color:#888">UTC hour <input type="number" min="0" max="23" data-trig-input="daily_persona.hour_utc" value="${dailyHour}" style="width:60px;display:inline-block;margin-left:6px"></label>
			 <label style="font-size:12px;color:#888;display:block;margin-top:6px">Topic hint (optional) <input type="text" data-trig-input="daily_persona.topic" value="${attr(dailyTopic)}" placeholder="What should I talk about?" style="width:100%;display:block;margin-top:4px"></label>`,
		)}
		${row(
			'weekly_digest',
			'Weekly digest',
			'Once-a-week recap including token activity if linked.',
			`<label style="font-size:12px;color:#888">Day <select data-trig-input="weekly_digest.day_of_week" style="width:auto;display:inline-block;margin-left:6px">
				${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<option value="${i}" ${i === weeklyDay ? 'selected' : ''}>${d}</option>`).join('')}
			</select></label>
			<label style="font-size:12px;color:#888;margin-left:10px">UTC hour <input type="number" min="0" max="23" data-trig-input="weekly_digest.hour_utc" value="${weeklyHour}" style="width:60px;display:inline-block;margin-left:6px"></label>`,
		)}
		${row(
			'price_milestone',
			'Token market-cap milestones',
			'Auto-tweets when your pump.fun token crosses each threshold.',
			`<label style="font-size:12px;color:#888;display:block">USD thresholds (comma-separated) <input type="text" data-trig-input="price_milestone.thresholds_usd" value="${attr(priceThresholds)}" style="width:100%;display:block;margin-top:4px"></label>`,
		)}
		${row(
			'payment_received',
			'Thank-you on every payment',
			'Tweets a thank-you when a user pays your agent for a skill.',
			`<label style="font-size:12px;color:#888">Minimum amount (USD) <input type="number" min="0" step="0.01" data-trig-input="payment_received.min_amount_usd" value="${paymentMin}" style="width:80px;display:inline-block;margin-left:6px"></label>`,
		)}
		<div data-trig-msg style="margin-top:8px;font-size:12px"></div>
	`;

	const trigMsg = host.querySelector('[data-trig-msg]');
	const setTrigMsg = (text, color = '#9a8cff') => {
		trigMsg.style.color = color;
		trigMsg.textContent = text;
	};

	function readConfigFromUI(kind) {
		const get = (k) => host.querySelector(`[data-trig-input="${kind}.${k}"]`)?.value;
		if (kind === 'daily_persona')
			return {
				hour_utc: parseInt(get('hour_utc') || '0', 10),
				topic: (get('topic') || '').trim() || undefined,
			};
		if (kind === 'weekly_digest')
			return {
				day_of_week: parseInt(get('day_of_week') || '0', 10),
				hour_utc: parseInt(get('hour_utc') || '0', 10),
			};
		if (kind === 'price_milestone') {
			const list = (get('thresholds_usd') || '')
				.split(',')
				.map((s) => parseFloat(s.trim()))
				.filter((n) => Number.isFinite(n) && n > 0);
			return { thresholds_usd: list };
		}
		if (kind === 'payment_received')
			return { min_amount_usd: parseFloat(get('min_amount_usd') || '0') };
		return {};
	}

	async function upsertTrigger(kind, enabled) {
		const config = readConfigFromUI(kind);
		const existing = byKind[kind];
		if (existing) {
			const r = await fetch(`/api/x/triggers?id=${encodeURIComponent(existing.id)}`, {
				method: 'PATCH',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled, config }),
			});
			if (!r.ok) throw new Error((await r.json()).error_description || 'update failed');
			byKind[kind] = (await r.json()).trigger;
		} else {
			const autoPublish = !host.querySelector('[data-trig-review-all]')?.checked;
			const r = await fetch('/api/x/triggers', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind,
					config,
					enabled,
					agent_id: agentId,
					auto_publish: autoPublish,
				}),
			});
			if (!r.ok) throw new Error((await r.json()).error_description || 'create failed');
			byKind[kind] = (await r.json()).trigger;
		}
	}

	const reviewAllEl = host.querySelector('[data-trig-review-all]');
	if (reviewAllEl) {
		reviewAllEl.addEventListener('change', async () => {
			const autoPublish = !reviewAllEl.checked;
			const ids = Object.values(byKind).map((t) => t.id);
			for (const id of ids) {
				try {
					const r = await fetch(`/api/x/triggers?id=${encodeURIComponent(id)}`, {
						method: 'PATCH',
						credentials: 'include',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ auto_publish: autoPublish }),
					});
					if (r.ok) {
						const t = (await r.json()).trigger;
						byKind[t.kind] = t;
					}
				} catch {}
			}
			setTrigMsg(
				autoPublish
					? 'Auto-publish enabled.'
					: 'New trigger drafts will require your review.',
			);
		});
	}

	host.querySelectorAll('[data-trig]').forEach((cb) => {
		cb.addEventListener('change', async () => {
			const kind = cb.getAttribute('data-trig');
			const configBox = host.querySelector(`[data-trig-config="${kind}"]`);
			if (configBox) configBox.style.display = cb.checked ? '' : 'none';
			try {
				await upsertTrigger(kind, cb.checked);
				setTrigMsg(`${cb.checked ? 'Enabled' : 'Disabled'} ${kind.replace('_', ' ')}.`);
			} catch (err) {
				cb.checked = !cb.checked;
				setTrigMsg(err.message, '#ffb3b3');
			}
		});
	});

	host.querySelectorAll('[data-trig-input]').forEach((inp) => {
		let timer;
		inp.addEventListener('input', () => {
			clearTimeout(timer);
			timer = setTimeout(async () => {
				const kind = inp.getAttribute('data-trig-input').split('.')[0];
				const cb = host.querySelector(`[data-trig="${kind}"]`);
				if (!cb?.checked) return;
				try {
					await upsertTrigger(kind, true);
					setTrigMsg('Saved.', '#888');
				} catch (err) {
					setTrigMsg(err.message, '#ffb3b3');
				}
			}, 600);
		});
	});
}

async function loadScheduledPosts(host) {
	if (!host) return;
	try {
		const r = await fetch('/api/x/schedule', { credentials: 'include' });
		const data = await r.json();
		const pending = (data.posts || []).filter((p) => !p.posted_at && !p.error);
		if (!pending.length) {
			host.innerHTML = '';
			return;
		}
		host.innerHTML = `
			<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px">Scheduled</div>
			${pending
				.map(
					(p) => `
				<div class="row" style="justify-content:space-between;padding:8px 10px;background:#0f0f17;border:1px solid #22222e;border-radius:8px;margin-bottom:6px;font-size:12px">
					<div style="flex:1;min-width:0">
						<div style="color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.text)}</div>
						<div class="muted" style="font-size:11px;margin-top:2px">${new Date(p.scheduled_at).toLocaleString()}</div>
					</div>
					<button class="btn sec" data-cancel="${attr(p.id)}" style="font-size:11px;padding:4px 8px">Cancel</button>
				</div>
			`,
				)
				.join('')}
		`;
		host.querySelectorAll('[data-cancel]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.getAttribute('data-cancel');
				await fetch(`/api/x/schedule?id=${encodeURIComponent(id)}`, {
					method: 'DELETE',
					credentials: 'include',
				});
				loadScheduledPosts(host);
			});
		});
	} catch {}
}

// Lazy-load preview when card scrolls into view. For private avatars, fetch
// a short-lived signed URL via /api/avatars/:id. Falls back to a thumbnail or
// placeholder if no preview is available.
function mountAvatarPreview(host, a) {
	const showPlaceholder = (msg) => {
		host.innerHTML = `<div class="ph">${esc(msg)}</div>`;
	};
	const showSpinner = () => {
		host.innerHTML = '<div class="spinner" aria-label="Loading preview"></div>';
	};
	const showModel = (url) => {
		host.innerHTML = `<model-viewer src="${attr(url)}" camera-controls auto-rotate shadow-intensity="1" exposure="1" tone-mapping="aces" loading="lazy" reveal="auto"></model-viewer>`;
	};
	const showThumb = (url) => {
		host.innerHTML = `<img class="thumb" src="${attr(url)}" alt="${attr(a.name)} thumbnail" loading="lazy">`;
	};

	let loaded = false;
	const load = async () => {
		if (loaded) return;
		loaded = true;
		if (a.model_url) {
			showModel(a.model_url);
			return;
		}
		// Private — request a signed URL.
		showSpinner();
		try {
			const { avatar } = await api.getAvatar(a.id);
			const url = avatar?.url || avatar?.model_url;
			if (url) {
				showModel(url);
			} else if (avatar?.thumbnail_url) {
				showThumb(avatar.thumbnail_url);
			} else {
				showPlaceholder('Preview unavailable');
			}
		} catch (err) {
			loaded = false;
			host.innerHTML = `<div class="ph">Preview unavailable<br><button data-retry>Retry</button></div>`;
			host.querySelector('[data-retry]').addEventListener('click', load);
		}
	};

	if (a.thumbnail_url) showThumb(a.thumbnail_url);
	else host.innerHTML = '<div class="ph">Loading preview…</div>';

	if ('IntersectionObserver' in window) {
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						io.disconnect();
						load();
					}
				}
			},
			{ rootMargin: '200px' },
		);
		io.observe(host);
	} else {
		load();
	}
}

// ── Replace GLB ─────────────────────────────────────────────────────────────
// Shows an inline warning banner on the card, then opens a file picker.
// Validates extension, MIME, and GLB magic number before uploading.
// Runs a Mixamo skeleton compatibility check and surfaces a warning if < 50%.
function replaceGlbFlow(a, cardEl) {
	if (cardEl.querySelector('[data-glb-warn]')) return; // already open

	const warn = document.createElement('div');
	warn.setAttribute('data-glb-warn', '');
	warn.style.cssText =
		'margin:8px 0; padding:10px; background:rgba(255,165,0,.08); border:1px solid rgba(255,165,0,.25); border-radius:8px; font-size:12px; color:#d4aa44';
	warn.innerHTML = `
		<p style="margin:0 0 8px">&#9888; This bypasses the three.ws creator &#8212; your avatar may not animate correctly if it isn&rsquo;t rigged to the three.ws humanoid skeleton.</p>
		<div class="row" style="gap:6px">
			<button class="btn" data-glb-pick style="font-size:12px;padding:6px 10px">Choose .glb file</button>
			<button class="btn sec" data-glb-cancel style="font-size:12px;padding:6px 10px">Cancel</button>
		</div>
		<input type="file" accept=".glb,model/gltf-binary" data-glb-file style="display:none">
		<div data-glb-progress style="margin-top:8px; min-height:1em"></div>
	`;
	cardEl.appendChild(warn);

	warn.querySelector('[data-glb-cancel]').addEventListener('click', () => warn.remove());
	warn.querySelector('[data-glb-pick]').addEventListener('click', () => {
		warn.querySelector('[data-glb-file]').click();
	});
	warn.querySelector('[data-glb-file]').addEventListener('change', async (e) => {
		const file = e.target.files[0];
		if (!file) return;
		const pick = warn.querySelector('[data-glb-pick]');
		const cancel = warn.querySelector('[data-glb-cancel]');
		pick.disabled = true;
		cancel.disabled = true;
		await doReplaceUpload(a, file, warn, cardEl);
		pick.disabled = false;
		cancel.disabled = false;
	});
}

async function doReplaceUpload(a, file, warnEl, cardEl) {
	const prog = warnEl.querySelector('[data-glb-progress]');
	const say = (msg, isError = false) => {
		prog.textContent = msg;
		prog.style.color = isError ? '#ffb3b3' : '#888';
	};

	// Extension check — reject .gltf and anything else
	if (!file.name.toLowerCase().endsWith('.glb')) {
		say('Only .glb files accepted. Separate .gltf + .bin packs are not supported.', true);
		return;
	}

	// MIME type check
	if (
		file.type &&
		file.type !== 'model/gltf-binary' &&
		file.type !== 'application/octet-stream'
	) {
		say(`Unexpected file type "${file.type}". Expected model/gltf-binary.`, true);
		return;
	}

	// Magic number check: first 4 bytes must be 'glTF' (0x46546C67 little-endian)
	const header = await file.slice(0, 4).arrayBuffer();
	if (new DataView(header).getUint32(0, true) !== 0x46546c67) {
		say('Not a valid GLB \u2014 magic number check failed. Renamed files are rejected.', true);
		return;
	}

	say('Checking skeleton compatibility\u2026');
	const originalBuf = await file.arrayBuffer();
	let uploadBytes = originalBuf;
	let uploadSize = file.size;
	let uploadBlob = file;
	let retargetReport = null;

	try {
		const { canonicalizeGLBBones } = await import('/src/glb-canonicalize.js');
		const result = canonicalizeGLBBones(originalBuf);
		if (result.renamed > 0) {
			uploadBytes = result.buffer;
			uploadSize = result.buffer.byteLength;
			uploadBlob = new Blob([result.buffer], { type: 'model/gltf-binary' });
			retargetReport = { renamed: result.renamed, samples: result.samples };
		}
	} catch (err) {
		// Canonicalization is non-fatal \u2014 fall back to the original buffer and
		// let the boneMatch warning surface the issue. A malformed GLB will
		// also fail at the R2 upload step with a clearer error.
		console.warn('[upload] canonicalize failed; uploading original', err);
	}

	const boneMatch = checkMixamoSkeleton(uploadBytes);

	say('Requesting upload URL\u2026');
	try {
		const { upload_url, storage_key } = await api.presign({
			size_bytes: uploadSize,
			content_type: 'model/gltf-binary',
		});
		say(`Uploading ${fmtSize(uploadSize)}\u2026`);
		await uploadToR2(upload_url, uploadBlob, (pct) => say(`Uploading ${pct}%\u2026`));
		say('Registering\u2026');
		const { avatar } = await api.createAvatar({
			storage_key,
			parent_avatar_id: a.id,
			name: a.name,
			description: a.description || undefined,
			visibility: a.visibility,
			tags: a.tags,
			size_bytes: uploadSize,
			content_type: 'model/gltf-binary',
			source: 'direct-upload',
			source_meta: retargetReport
				? { replaced_from: a.id, retargeted_bones: retargetReport.renamed }
				: { replaced_from: a.id },
		});

		// Refresh model-viewer preview if the new avatar is public/unlisted
		if (avatar.model_url) {
			const mv = cardEl.querySelector('model-viewer');
			if (mv) mv.src = avatar.model_url;
		}

		if (retargetReport) {
			say(
				`Replaced. Retargeted ${retargetReport.renamed} bones to the three.ws humanoid skeleton so animations play out of the box.`,
			);
		} else if (boneMatch !== null && boneMatch < 0.5) {
			say(
				`Uploaded. \u26a0 Animations may not play \u2014 skeleton mismatch (${Math.round(boneMatch * 100)}% three.ws humanoid bone match).`,
			);
		} else {
			say('Replaced! Your agent now uses the new GLB.');
		}
	} catch (err) {
		say(err.message || 'Upload failed', true);
	}
}

// Parse the GLB JSON chunk and count Mixamo bone name matches.
// Reuses the same strip-prefix logic as AnimationManager._buildBoneNameMap.
// Returns a ratio 0..1, or null if the file has no parseable node names.
function checkMixamoSkeleton(buffer) {
	const MIXAMO_BONES = new Set([
		'Hips',
		'Spine',
		'Spine1',
		'Spine2',
		'Neck',
		'Head',
		'LeftShoulder',
		'LeftArm',
		'LeftForeArm',
		'LeftHand',
		'RightShoulder',
		'RightArm',
		'RightForeArm',
		'RightHand',
		'LeftUpLeg',
		'LeftLeg',
		'LeftFoot',
		'LeftToeBase',
		'RightUpLeg',
		'RightLeg',
		'RightFoot',
		'RightToeBase',
	]);
	try {
		const view = new DataView(buffer);
		const chunkLen = view.getUint32(12, true);
		if (view.getUint32(16, true) !== 0x4e4f534a) return null; // chunk 0 is not JSON
		const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, chunkLen)));
		const nodes = (json.nodes || []).filter((n) => n.name);
		if (!nodes.length) return null;
		const strip = (n) => n.replace(/^mixamorig\d*[_:]?/i, '').replace(/^Armature[_/]?/i, '');
		return nodes.filter((n) => MIXAMO_BONES.has(strip(n.name))).length / MIXAMO_BONES.size;
	} catch {
		return null;
	}
}

// ── Upload ──────────────────────────────────────────────────────────────────
function renderUpload(root) {
	root.innerHTML = `
		<h1>Upload avatar</h1><p class="sub">Upload a .glb file. It's stored on our CDN and made available via API and MCP.</p>
		<form id="up" class="card" style="max-width:520px">
			<label>File<input id="file" type="file" accept=".glb,model/gltf-binary" required></label>
			<label style="display:block;margin-top:12px">Name<input id="name" required maxlength="120" style="width:100%"></label>
			<label style="display:block;margin-top:12px">Description<textarea id="desc" rows="2" style="width:100%"></textarea></label>
			<label style="display:block;margin-top:12px">Visibility
				<select id="vis" style="width:100%">${visibilityOptionsHtml('public')}</select>
			</label>
			<label style="display:block;margin-top:12px">Tags (comma separated)<input id="tags" style="width:100%"></label>
			<div id="progress" class="muted" style="margin-top:12px"></div>
			<button class="btn" style="margin-top:16px" type="submit">Upload</button>
		</form>
	`;
	const form = root.querySelector('#up');
	const progress = root.querySelector('#progress');
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const file = root.querySelector('#file').files[0];
		if (!file) return;

		progress.textContent = 'Checking skeleton compatibility…';
		let uploadBlob = file;
		let uploadSize = file.size;
		let retargetReport = null;
		try {
			const originalBuf = await file.arrayBuffer();
			const { canonicalizeGLBBones } = await import('/src/glb-canonicalize.js');
			const result = canonicalizeGLBBones(originalBuf);
			if (result.renamed > 0) {
				uploadBlob = new Blob([result.buffer], { type: 'model/gltf-binary' });
				uploadSize = result.buffer.byteLength;
				retargetReport = { renamed: result.renamed, samples: result.samples };
				progress.textContent = `Retargeted ${result.renamed} bones to the three.ws humanoid skeleton.`;
			}
		} catch (err) {
			// Canonicalization is non-fatal; let upload proceed with the original.
			console.warn('[upload] canonicalize failed; uploading original', err);
		}

		progress.textContent = 'Requesting upload URL…';
		try {
			const { upload_url, storage_key } = await api.presign({
				size_bytes: uploadSize,
				content_type: 'model/gltf-binary',
			});
			progress.textContent = `Uploading ${fmtSize(uploadSize)}…`;
			await uploadToR2(
				upload_url,
				uploadBlob,
				(pct) => (progress.textContent = `Uploading ${pct}%…`),
			);
			progress.textContent = 'Finalizing…';
			const tags = (root.querySelector('#tags').value || '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const { avatar } = await api.createAvatar({
				storage_key,
				name: root.querySelector('#name').value,
				description: root.querySelector('#desc').value || undefined,
				visibility: root.querySelector('#vis').value,
				tags,
				size_bytes: uploadSize,
				content_type: 'model/gltf-binary',
				source: 'upload',
				source_meta: retargetReport ? { retargeted_bones: retargetReport.renamed } : {},
			});
			progress.innerHTML = `Uploaded! <a href="/dashboard/avatars">View</a>`;
			goto('avatars');
		} catch (err) {
			progress.textContent = '';
			alert(err.message);
		}
	});
}

function uploadToR2(url, file, onProgress) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url);
		xhr.setRequestHeader('content-type', file.type || 'model/gltf-binary');
		xhr.upload.onprogress = (e) =>
			e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
		xhr.onload = () =>
			xhr.status >= 200 && xhr.status < 300
				? resolve()
				: reject(new Error(`Upload failed (${xhr.status})`));
		xhr.onerror = () => reject(new Error('Network error during upload'));
		xhr.send(file);
	});
}

// ── Create avatar ───────────────────────────────────────────────────────────
// The dashboard "Create" entry redirects to the full creation flow at /create,
// which exposes Avaturn (default editor), Ready Player Me (selfie → avatar),
// and direct GLB upload.

function renderCreate(root) {
	root.innerHTML = `
		<div>
			<h1>Create avatar</h1>
			<p class="sub">Opening the avatar creator…</p>
		</div>
	`;
	location.replace('/create');
}

async function fetchGlbBlob(url, urlType) {
	if (urlType === 'dataURL') {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
		return res.blob();
	}
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Fetch avatar failed: ${res.status}`);
	return res.blob();
}

async function saveAvaturnAvatar(blob) {
	const contentType = 'model/gltf-binary';
	const size = blob.size;
	const checksum = await sha256Hex(blob);

	const { upload_url, storage_key } = await api.presign({
		size_bytes: size,
		content_type: contentType,
		checksum_sha256: checksum,
	});

	await new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', upload_url);
		xhr.setRequestHeader('content-type', contentType);
		xhr.onload = () =>
			xhr.status >= 200 && xhr.status < 300
				? resolve()
				: reject(new Error(`Upload failed (${xhr.status})`));
		xhr.onerror = () => reject(new Error('Network error during upload'));
		xhr.send(blob);
	});

	const { avatar } = await api.createAvatar({
		storage_key,
		size_bytes: size,
		content_type: contentType,
		checksum_sha256: checksum,
		name: `Avatar ${new Date().toLocaleDateString()}`,
		visibility: 'public',
		tags: [],
		source: 'import',
		source_meta: { provider: 'avaturn' },
	});

	await attachAvatarToDefaultAgent(avatar.id).catch((e) =>
		console.warn('attach to agent skipped:', e.message),
	);
	return avatar;
}

async function attachAvatarToDefaultAgent(avatarId) {
	const meRes = await fetch('/api/agents/me', { credentials: 'include' });
	if (!meRes.ok) return;
	const { agent } = await meRes.json();
	if (!agent) return;
	await fetch(`/api/agents/${agent.id}`, {
		method: 'PUT',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ avatar_id: avatarId }),
	});
}

// ── Edit avatar ─────────────────────────────────────────────────────────────
async function renderEdit(root, params = []) {
	const id = params[0];
	if (!id) {
		goto('avatars');
		return;
	}

	root.innerHTML = `
		<div class="toolbar">
			<div>
				<h1>Edit avatar</h1>
				<p class="sub">Update the details that appear in MCP results and the public gallery.</p>
			</div>
			<a class="btn sec" href="/dashboard/avatars">Back</a>
		</div>
		<div id="edit-body">
			<div class="muted">Loading…</div>
		</div>
	`;

	const body = root.querySelector('#edit-body');
	let avatar;
	try {
		const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`, {
			credentials: 'include',
		});
		if (!res.ok) throw new Error((await res.json()).error_description || res.statusText);
		avatar = (await res.json()).avatar;
	} catch (err) {
		body.innerHTML = `<div class="err">${esc(err.message)}</div>`;
		return;
	}

	const previewUrl = avatar.url || avatar.model_url;
	body.innerHTML = `
		<div style="display:grid; grid-template-columns:minmax(260px,1fr) minmax(260px,2fr); gap:20px; align-items:start">
			<div class="card" style="padding:10px">
				<div class="preview" style="aspect-ratio:1/1; margin:0; background:#0f0f17; border-radius:10px; overflow:hidden">
					${
						previewUrl
							? `<model-viewer src="${attr(previewUrl)}" camera-controls auto-rotate shadow-intensity="1" exposure="1" tone-mapping="aces" style="width:100%;height:100%"></model-viewer>`
							: `<div style="display:grid;place-items:center;height:100%;color:#555;font-size:12px">Preview unavailable</div>`
					}
				</div>
				<p class="muted" style="margin:10px 4px 0">${fmtSize(avatar.size_bytes || 0)} · ${esc(avatar.source || 'upload')}</p>
			</div>
			<form id="ef" class="card" style="max-width:560px">
				<label style="display:block">Name<input id="ename" value="${attr(avatar.name || '')}" maxlength="120" style="width:100%"></label>
				<label style="display:block;margin-top:12px">Description<textarea id="edesc" rows="3" style="width:100%">${esc(avatar.description || '')}</textarea></label>
				<label style="display:block;margin-top:12px">Visibility
					<select id="evis" style="width:100%">${visibilityOptionsHtml(avatar.visibility)}</select>
				</label>
				<label style="display:block;margin-top:12px">Tags (comma separated)<input id="etags" value="${attr((avatar.tags || []).join(', '))}" style="width:100%"></label>
				<div id="epublink" style="margin-top:16px;${avatar.visibility === 'private' ? 'display:none' : ''}">
					<p class="muted" style="margin:0 0 6px;font-size:11px">Public link</p>
					<div class="row" style="gap:6px;align-items:center">
						<input id="epublinkval" readonly value="${attr(location.origin + '/avatars/' + avatar.id)}" style="width:100%;font-size:12px;color:#9a8cff;cursor:text">
						<button id="ecopybtn" class="btn sec" type="button" style="white-space:nowrap;flex-shrink:0">Copy</button>
					</div>
				</div>
				<div id="emsg" class="muted" style="margin-top:12px"></div>
				<div class="row" style="gap:8px; margin-top:16px">
					<button class="btn" type="submit">Save changes</button>
					<button class="btn sec" id="euse" type="button">Use as my agent's body</button>
				</div>
			</form>
		</div>
		<div data-wallet-host style="margin-top:20px; max-width:560px; margin-left:auto; margin-right:auto"></div>
		<div data-x-host style="margin-top:20px; max-width:560px; margin-left:auto; margin-right:auto"></div>
	`;
	mountAvatarWalletSection(body.querySelector('[data-wallet-host]'), avatar);
	mountAgentXPanel(body.querySelector('[data-x-host]'), avatar);

	const msg = body.querySelector('#emsg');
	body.querySelector('#ef').addEventListener('submit', async (e) => {
		e.preventDefault();
		msg.style.color = '#888';
		msg.textContent = 'Saving…';
		try {
			const tags = (body.querySelector('#etags').value || '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			await api.patchAvatar(id, {
				name: body.querySelector('#ename').value.trim(),
				description: body.querySelector('#edesc').value.trim() || undefined,
				visibility: body.querySelector('#evis').value,
				tags,
			});
			msg.style.color = '#9a8cff';
			msg.textContent = 'Saved.';
		} catch (err) {
			msg.style.color = '#ffb3b3';
			msg.textContent = err.message;
		}
	});

	// Show/hide public link when visibility changes
	body.querySelector('#evis').addEventListener('change', (e) => {
		const publink = body.querySelector('#epublink');
		if (publink) publink.style.display = e.target.value === 'private' ? 'none' : '';
	});

	// Copy public link
	body.querySelector('#ecopybtn')?.addEventListener('click', async () => {
		const btn = body.querySelector('#ecopybtn');
		const val = body.querySelector('#epublinkval')?.value;
		if (!val) return;
		try {
			await navigator.clipboard.writeText(val);
			btn.textContent = 'Copied ✓';
			setTimeout(() => (btn.textContent = 'Copy'), 1800);
		} catch {}
	});

	body.querySelector('#euse').addEventListener('click', async () => {
		msg.style.color = '#888';
		msg.textContent = 'Linking to your agent…';
		try {
			await attachAvatarToDefaultAgent(id);
			msg.style.color = '#9a8cff';
			msg.textContent = 'Your agent will now render with this avatar.';
		} catch (err) {
			msg.style.color = '#ffb3b3';
			msg.textContent = err.message || 'Failed to link avatar to agent';
		}
	});
}

async function sha256Hex(blob) {
	const buf = await blob.arrayBuffer();
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── API keys ────────────────────────────────────────────────────────────────
async function renderKeys(root) {
	root.innerHTML = `
		<h1>API keys</h1><p class="sub">Server-side keys for calling the MCP server without OAuth. Treat like passwords.</p>
		<div class="card" style="margin-bottom:16px">
			<form id="new" class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-start">
				<input id="kname" placeholder="Key name (e.g. my-app prod)" required>
				<select id="kenv" title="Environment">
					<option value="live">live</option>
					<option value="test">test</option>
				</select>
				<select id="kexp" title="Expires">
					<option value="">Never expires</option>
					<option value="30">30 days</option>
					<option value="90">90 days</option>
					<option value="365">1 year</option>
				</select>
				<fieldset id="kscope" style="border:1px solid var(--border,#333);border-radius:6px;padding:6px 10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0">
					<legend style="padding:0 4px;font-size:12px" class="muted">Scopes</legend>
					<label><input type="checkbox" name="scope" value="avatars:read" checked> read</label>
					<label><input type="checkbox" name="scope" value="avatars:write" checked> write</label>
					<label><input type="checkbox" name="scope" value="avatars:delete"> delete</label>
					<label><input type="checkbox" name="scope" value="profile"> profile</label>
				</fieldset>
				<button class="btn" type="submit">Create key</button>
			</form>
			<div id="reveal"></div>
		</div>
		<div id="klist" class="card"></div>
	`;
	const klist = root.querySelector('#klist');
	async function refresh() {
		try {
			const { keys } = await api.listKeys();
			if (!keys.length) {
				klist.innerHTML = '<div class="muted">No keys yet.</div>';
				return;
			}
			klist.innerHTML = keys
				.map((k) => {
					const created = new Date(k.created_at).toLocaleDateString();
					const expired = k.expires_at && new Date(k.expires_at) < new Date();
					const expiresLabel = k.expires_at
						? ` · ${expired ? '<b style="color:#f88">expired</b>' : `expires ${new Date(k.expires_at).toLocaleDateString()}`}`
						: '';
					const revokedLabel = k.revoked_at ? ' · <b style="color:#f88">revoked</b>' : '';
					return `
				<div class="key-row">
					<div>
						<div><code>${esc(k.prefix)}…</code> — ${esc(k.name)}</div>
						<div class="muted">scope: ${esc(k.scope)} · created ${created}${expiresLabel}${revokedLabel}</div>
					</div>
					${k.revoked_at ? '' : `<button class="btn sec" data-id="${esc(k.id)}">Revoke</button>`}
				</div>
			`;
				})
				.join('');
			klist.querySelectorAll('button[data-id]').forEach((b) =>
				b.addEventListener('click', async () => {
					if (!confirm('Revoke this key?')) return;
					try {
						await api.revokeKey(b.dataset.id);
						refresh();
					} catch (e) {
						alert(e.message);
					}
				}),
			);
		} catch (e) {
			klist.innerHTML = `<div class="err">${esc(e.message)}</div>`;
		}
	}
	root.querySelector('#new').addEventListener('submit', async (e) => {
		e.preventDefault();
		try {
			const scopes = Array.from(
				root.querySelectorAll('#kscope input[name=scope]:checked'),
			).map((el) => el.value);
			if (!scopes.length) {
				alert('Select at least one scope.');
				return;
			}
			const expDays = parseInt(root.querySelector('#kexp').value, 10);
			const payload = {
				name: root.querySelector('#kname').value,
				environment: root.querySelector('#kenv').value,
				scope: scopes.join(' '),
			};
			if (Number.isFinite(expDays) && expDays > 0) payload.expires_in_days = expDays;
			const { key } = await api.createKey(payload);
			root.querySelector('#reveal').innerHTML = `
				<div style="margin-top:10px">
					<p class="muted">Copy this key now — you won't see it again.</p>
					<pre><code>${esc(key.secret)}</code></pre>
				</div>
			`;
			root.querySelector('#kname').value = '';
			refresh();
		} catch (err) {
			alert(err.message);
		}
	});
	refresh();
}

// ── MCP integration ─────────────────────────────────────────────────────────
function renderMcp(root) {
	const origin = location.origin;
	root.innerHTML = `
		<h1>Use from Claude &amp; other MCP clients</h1>
		<p class="sub">Connect any MCP-compatible client to render your avatars inline.</p>

		<h3 class="section">Remote MCP server URL</h3>
		<pre><code>${esc(origin)}/api/mcp</code></pre>

		<h3 class="section">Claude Desktop / Claude Code (remote)</h3>
		<p class="muted">Add a Custom Connector in Claude. When prompted, sign in with your three.ws account.</p>
		<pre><code>${esc(
			JSON.stringify(
				{
					mcpServers: {
						'3d-agent': { url: `${origin}/api/mcp` },
					},
				},
				null,
				2,
			),
		)}</code></pre>

		<h3 class="section">Programmatic (API key)</h3>
		<p class="muted">Bypass OAuth for server-to-server usage. Pass key as a bearer token.</p>
		<pre><code>curl -X POST ${esc(origin)}/api/mcp \\
  -H "authorization: Bearer sk_live_…" \\
  -H "content-type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>

		<h3 class="section">Available tools</h3>
		<ul>
			<li><b>list_my_avatars</b> — list avatars</li>
			<li><b>get_avatar</b> — fetch by id or slug</li>
			<li><b>search_public_avatars</b> — discover public avatars</li>
			<li><b>render_avatar</b> — returns &lt;model-viewer&gt; HTML for rendering as a Claude artifact</li>
			<li><b>delete_avatar</b> — remove an avatar (requires <code>avatars:delete</code>)</li>
		</ul>
	`;
}

// ── Embed ───────────────────────────────────────────────────────────────────
// Shows copy-paste snippets for dropping the agent into Lobehub, Claude,
// an iframe on any site, and a postMessage example for piping chat into the
// avatar so it reacts (speaks / emotes) to host-app events.
async function renderEmbed(root) {
	root.innerHTML = `
		<h1>Embed your agent</h1>
		<p class="sub">Drop your agent into chat hosts, Claude Artifacts, your site, or anywhere that can render an iframe. The agent reacts to chat messages via a postMessage bridge.</p>
		<div id="embed-body"><div class="muted">Loading your agent…</div></div>
	`;
	const body = root.querySelector('#embed-body');

	let agent;
	try {
		const res = await fetch('/api/agents/me', { credentials: 'include' });
		if (res.ok) agent = (await res.json()).agent;
	} catch {}

	if (!agent) {
		body.innerHTML = `
			<div class="empty">
				You don't have an agent yet. <a href="/dashboard/create">Create one from a selfie</a> first.
			</div>
		`;
		return;
	}

	const origin = location.origin;
	const embedUrl = `${origin}/agent/${encodeURIComponent(agent.id)}/embed`;
	const homeUrl = `${origin}/agent/${encodeURIComponent(agent.id)}`;
	const iframeSnippet = `<iframe src="${embedUrl}" allow="camera; microphone" style="width:320px;height:420px;border:0;border-radius:16px;overflow:hidden" title="${esc(agent.name || 'Agent')}"></iframe>`;
	const sidecarSnippet = [
		'// Drop into a chat host — renders the agent alongside the chat panel',
		'// and forwards assistant messages to it so the avatar speaks/emotes.',
		"import { useEffect, useRef } from 'react';",
		'',
		'export function AgentSidecar({ latestAssistantMessage }) {',
		`  const AGENT_ID = ${JSON.stringify(agent.id)};`,
		`  const EMBED_URL = ${JSON.stringify(embedUrl)};`,
		'  const ref = useRef(null);',
		'',
		'  useEffect(() => {',
		'    if (!ref.current || !latestAssistantMessage) return;',
		'    ref.current.contentWindow?.postMessage({',
		'      __agent: AGENT_ID,',
		"      type: 'action',",
		"      action: { type: 'speak', payload: { text: latestAssistantMessage.text } },",
		"    }, '*');",
		'  }, [latestAssistantMessage]);',
		'',
		'  return <iframe ref={ref} src={EMBED_URL} allow="camera; microphone"',
		'    style={{ width: 320, height: 420, border: 0, borderRadius: 16 }} />;',
		'}',
	].join('\n');
	const claudeSnippet = [
		'<!-- Paste into Claude as an HTML Artifact. The avatar renders live. -->',
		`<iframe src="${embedUrl}"`,
		'        style="width:100%;height:480px;border:0;border-radius:16px"',
		'        allow="camera; microphone"></iframe>',
	].join('\n');
	const postMessageSnippet = [
		'// From any host page, make the avatar speak + emote:',
		"const frame = document.querySelector('iframe');",
		'frame.contentWindow.postMessage({',
		`  __agent: ${JSON.stringify(agent.id)},`,
		"  type: 'action',",
		"  action: { type: 'speak', payload: { text: 'Hello from the host app' } },",
		"}, '*');",
		'',
		'// Listen for agent readiness:',
		"window.addEventListener('message', (e) => {",
		`  if (e.data?.__agent === ${JSON.stringify(agent.id)} && e.data.type === 'ready') {`,
		"    console.log('agent online:', e.data.name);",
		'  }',
		'});',
	].join('\n');
	const sdkSnippet = [
		'<!-- Drop-in SDK around the postMessage Bridge v1. -->',
		'<!-- See /agent/' + agent.id + '/embed for the wire contract. -->',
		`<iframe id="agent" src="${embedUrl}" allow="camera; microphone"`,
		'        style="width:320px;height:420px;border:0;border-radius:16px"></iframe>',
		`<script src="${origin}/embed-sdk.js"></script>`,
		'<script>',
		"  const bridge = Agent3D.connect(document.getElementById('agent'), {",
		`    agentId: ${JSON.stringify(agent.id)},`,
		"    onReady:  ({ version, capabilities }) => console.log('ready', version, capabilities),",
		"    onAction: (action) => console.log('iframe emitted', action),",
		"    onResize: (h)      => console.log('preferred height', h),",
		"    onError:  (err)    => console.warn('bridge error', err.message),",
		'  });',
		"  bridge.ready.then(() => bridge.send({ type: 'speak', payload: { text: 'Hi from host' } }));",
		'</script>',
	].join('\n');
	const webComponentSnippet = [
		'<!-- Zero-install web component. Works in plain HTML, React, Vue, Svelte. -->',
		`<script type="module" src="${origin}/lib.js"></script>`,
		`<agent-three.ws-id="${esc(agent.id)}"`,
		'          style="width:320px;height:420px;display:block;border-radius:16px;overflow:hidden">',
		'</agent-3d>',
	].join('\n');
	const onchainSnippet = agent.erc8004_agent_id
		? [
				'// Resolve any ERC-8004 agent by chain + tokenId — no central registry needed.',
				"import { resolveOnchainAgent, toPublicUrl } from '@3dagent/sdk/erc8004';",
				'',
				`const ref = { chainId: ${Number(agent.chain_id) || 0}, agentId: ${JSON.stringify(String(agent.erc8004_agent_id))} };`,
				'const record  = await resolveOnchainAgent(ref);     // { manifest, glbUrl, owner, uri }',
				'const embedAt = toPublicUrl(ref, { embed: true });  // canonical iframe URL',
				'',
				'// Drop into any host:',
				"const iframe = document.createElement('iframe');",
				'iframe.src   = embedAt;',
				"iframe.allow = 'camera; microphone';",
				'document.body.appendChild(iframe);',
			].join('\n')
		: null;

	const tabs = [
		{ label: 'SDK · recommended', code: sdkSnippet },
		{ label: 'Web component', code: webComponentSnippet },
		{ label: 'Universal iframe', code: iframeSnippet },
		{ label: 'React sidecar', code: sidecarSnippet },
		{ label: 'Claude Artifact', code: claudeSnippet },
		{ label: 'Raw postMessage', code: postMessageSnippet },
		...(onchainSnippet ? [{ label: 'ERC-8004 resolve', code: onchainSnippet }] : []),
	];

	body.innerHTML = `
		<div class="embed-grid">
			<div class="embed-preview-col">
				<div class="card" style="padding:8px">
					<iframe id="embed-preview-frame" src="${attr(embedUrl + '?preview=1&bg=dark')}" style="width:100%;aspect-ratio:3/4;border:0;border-radius:10px;background:#0f0f17" title="Preview"></iframe>
					<div class="row" style="gap:6px; flex-wrap:wrap; padding:8px 6px 0">
						<button class="btn sec" type="button" data-tryit="speak">Speak</button>
						<button class="btn sec" type="button" data-tryit="emote">Emote</button>
						<button class="btn sec" type="button" data-tryit="gesture">Wave</button>
						<button class="btn sec" type="button" id="embed-verify-btn" title="Run a handshake check against the embedded iframe.">Verify</button>
					</div>
					<div id="embed-capabilities" class="row" style="gap:4px; flex-wrap:wrap; padding:8px 6px 0; min-height:22px"></div>
					<div id="embed-verify-out" class="muted" style="padding:6px 6px 0; font-size:12px; min-height:16px"></div>
					<div class="row" style="justify-content:space-between; padding:10px 6px 4px">
						<strong>${esc(agent.name || 'My Agent')}</strong>
						<a href="${attr(homeUrl)}" target="_blank" class="muted">Home page →</a>
					</div>
					<p class="muted" style="padding:0 6px">Agent ID <code>${esc(agent.id)}</code></p>
					${
						agent.wallet_address
							? `
						<p class="muted" style="padding:0 6px; margin-top:6px; line-height:1.4">
							Agent wallet<br>
							<code style="font-size:11px; word-break:break-all">${esc(agent.wallet_address)}</code><br>
							<span style="font-size:11px">Server-held. Agents sign autonomously via <code style="font-size:11px; word-break:break-all">POST /api/agents/${esc(agent.id)}/sign</code>.</span>
						</p>
					`
							: ''
					}
				</div>
			</div>
			<div>
				${snippetTabs(tabs)}
				<div class="card" style="margin-top:14px">
					<h3 style="margin:0 0 6px">Who can embed?</h3>
					<p class="muted" style="margin:0 0 10px">By default anyone. Lock it down to specific hosts (your chat host, your Substack…) on the <a href="/dashboard/embed-policy?agent=${encodeURIComponent(agent.id)}">embed-policy page</a>.</p>
				</div>
				<div class="card" style="margin-top:14px">
					<h3 style="margin:0 0 6px">Browser permissions &amp; CSP</h3>
					<p class="muted" style="margin:0 0 6px">The iframe needs <code>allow="camera; microphone"</code> for speech I/O. Drop either or both if your host doesn't use them.</p>
					<p class="muted" style="margin:0">If your host enforces a Content-Security-Policy, allow this origin: <code>frame-src ${esc(origin)}</code> and <code>connect-src ${esc(origin)}</code>.</p>
				</div>
				${onchainCard(agent)}
				${myAgentsCard()}
			</div>
		</div>
		<style>
			.embed-grid {
				display: grid;
				grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.4fr);
				gap: 20px;
				align-items: start;
			}
			.embed-preview-col { position: sticky; top: 16px; }
			@media (max-width: 760px) {
				.embed-grid { grid-template-columns: 1fr; }
				.embed-preview-col { position: static; }
			}
			.embed-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
			.embed-tab {
				background: transparent;
				border: 1px solid var(--border);
				color: inherit;
				padding: 6px 10px;
				border-radius: 8px;
				font: inherit;
				font-size: 12px;
				cursor: pointer;
			}
			.embed-tab[aria-selected="true"] {
				background: var(--panel);
				border-color: #6c5cff;
				color: #fff;
			}
			.embed-tab-panel[hidden] { display: none; }
		</style>
	`;

	bindSnippetTabs(body);

	for (const btn of body.querySelectorAll('[data-copy]')) {
		btn.addEventListener('click', async () => {
			const target = body.querySelector(btn.dataset.copy);
			if (!target) return;
			try {
				await navigator.clipboard.writeText(target.textContent);
				const original = btn.textContent;
				btn.textContent = 'Copied';
				setTimeout(() => {
					btn.textContent = original;
				}, 1200);
			} catch {
				btn.textContent = 'Copy failed';
			}
		});
	}

	bindEmbedTryIt(body, agent);
	bindOnchainDeploy(body, agent);
	bindMyAgents(body);
}

function bindEmbedTryIt(body, agent) {
	const frame = body.querySelector('#embed-preview-frame');
	if (!frame) return;
	const samples = {
		speak: { type: 'speak', payload: { text: `Hi, I'm ${agent.name || 'your agent'}.` } },
		emote: { type: 'emote', payload: { name: 'smile' } },
		gesture: { type: 'gesture', payload: { name: 'wave' } },
	};
	let frameOrigin = '';
	try {
		frameOrigin = new URL(frame.src, location.href).origin;
	} catch {}
	for (const btn of body.querySelectorAll('[data-tryit]')) {
		btn.addEventListener('click', () => {
			const action = samples[btn.dataset.tryit];
			if (!action) return;
			if (!frameOrigin) {
				console.warn('[dashboard] embed preview frame has no resolvable origin');
				return;
			}
			frame.contentWindow?.postMessage(
				{ __agent: agent.id, type: 'action', action },
				frameOrigin,
			);
		});
	}
}

function snippetBlock(title, code, _lang) {
	const id = 'snip-' + Math.random().toString(36).slice(2, 8);
	return `
		<div class="card" style="margin-bottom:14px">
			<div class="row" style="justify-content:space-between; margin-bottom:8px">
				<strong>${esc(title)}</strong>
				<button class="btn sec" data-copy="#${id}" type="button">Copy</button>
			</div>
			<pre id="${id}" style="margin:0; max-height:260px; overflow:auto; white-space:pre">${esc(code)}</pre>
		</div>
	`;
}

function snippetTabs(tabs) {
	const groupId = 'tabs-' + Math.random().toString(36).slice(2, 8);
	const buttons = tabs
		.map(
			(t, i) =>
				`<button class="embed-tab" role="tab" type="button" data-tab-index="${i}" aria-selected="${i === 0}">${esc(t.label)}</button>`,
		)
		.join('');
	const panels = tabs
		.map((t, i) => {
			const preId = `${groupId}-pre-${i}`;
			return `
				<div class="embed-tab-panel" role="tabpanel" data-panel-index="${i}"${i === 0 ? '' : ' hidden'}>
					<div class="row" style="justify-content:flex-end; margin-bottom:8px">
						<button class="btn sec" data-copy="#${preId}" type="button">Copy</button>
					</div>
					<pre id="${preId}" style="margin:0; max-height:340px; overflow:auto; white-space:pre">${esc(t.code)}</pre>
				</div>
			`;
		})
		.join('');
	return `
		<div class="card" data-tabs="${groupId}">
			<div class="embed-tabs" role="tablist">${buttons}</div>
			${panels}
		</div>
	`;
}

function bindSnippetTabs(root) {
	for (const group of root.querySelectorAll('[data-tabs]')) {
		const tabs = group.querySelectorAll('.embed-tab');
		const panels = group.querySelectorAll('.embed-tab-panel');
		for (const tab of tabs) {
			tab.addEventListener('click', () => {
				const idx = tab.dataset.tabIndex;
				for (const t of tabs) t.setAttribute('aria-selected', t === tab);
				for (const p of panels) p.hidden = p.dataset.panelIndex !== idx;
			});
		}
	}
}

// ── Onchain deploy card ─────────────────────────────────────────────────────
// Mints the agent on ERC-8004 so any host (Lobehub / Claude / etc.) can resolve
// it from its onchain ID instead of needing the /agent/:id URL. Uses the
// wallet the user already connected for SIWE; pins the avatar GLB + manifest
// to IPFS; calls register() on the Identity Registry; writes the resulting
// agentId back to our DB so the agent row becomes the bridge between our host
// and the onchain record.
function onchainCard(agent) {
	const alreadyDeployed = !!agent.erc8004_agent_id;
	const chainHint = agent.chain_id ? ` on chain ${esc(String(agent.chain_id))}` : '';
	const statusHtml = alreadyDeployed
		? `<p style="margin:0 0 10px; color:#9a8cff">Deployed: agentId <code>${esc(String(agent.erc8004_agent_id))}</code>${chainHint}.</p>`
		: `<p class="muted" style="margin:0 0 10px">Mint your agent as an ERC-8004 onchain identity. Any client that knows the agentId can resolve your avatar, skills, and reputation — no off-chain registry lookup needed.</p>`;
	return `
		<div class="card" id="onchain-card" style="margin-top:14px">
			<h3 style="margin:0 0 6px">Deploy onchain (ERC-8004)</h3>
			${statusHtml}
			<div class="row" style="gap:8px; flex-wrap:wrap">
				<input id="onchain-ipfs-token" placeholder="web3.storage or Filebase API token" style="flex:1; min-width:260px" type="password">
				<button class="btn" id="onchain-deploy" type="button">${alreadyDeployed ? 'Redeploy' : 'Deploy now'}</button>
			</div>
			<div id="onchain-log" class="muted" style="margin-top:10px; font-family: ui-monospace, SF Mono, Menlo, monospace; font-size:12px; white-space:pre-wrap"></div>
		</div>
	`;
}

// Attach the click handler after the embed DOM has been rendered. Called from
// renderEmbed below via a mutation after body.innerHTML is set.
function bindOnchainDeploy(body, agent) {
	const btn = body.querySelector('#onchain-deploy');
	const log = body.querySelector('#onchain-log');
	const token = body.querySelector('#onchain-ipfs-token');
	if (!btn) return;

	btn.addEventListener('click', async () => {
		btn.disabled = true;
		const say = (msg, isError = false) => {
			log.style.color = isError ? '#ffb3b3' : '#888';
			log.textContent = (log.textContent ? log.textContent + '\n' : '') + msg;
		};
		log.textContent = '';

		if (!agent.avatar_id) {
			say('Your agent has no avatar yet. Create one from a selfie first.', true);
			btn.disabled = false;
			return;
		}

		try {
			say('Fetching avatar GLB…');
			const avRes = await fetch(`/api/avatars/${encodeURIComponent(agent.avatar_id)}`, {
				credentials: 'include',
			});
			if (!avRes.ok)
				throw new Error((await avRes.json()).error_description || 'avatar fetch failed');
			const avatarRow = (await avRes.json()).avatar;
			const glbUrl = avatarRow.url || avatarRow.model_url;
			if (!glbUrl) throw new Error('avatar has no URL');
			const glbBlob = await (await fetch(glbUrl)).blob();
			const glbFile = new File([glbBlob], `${agent.id}.glb`, { type: 'model/gltf-binary' });

			say('Opening registration flow… (loading chain module)');
			const { registerAgent } = await import('/src/erc8004/agent-registry.js');

			const result = await registerAgent({
				glbFile,
				name: agent.name || 'Agent',
				description: agent.description || `three.ws ${agent.id}`,
				apiToken: token.value.trim() || undefined,
				onStatus: (msg) => say(msg),
			});

			say(`Persisting onchain IDs to your account…`);
			const wallet = window.ethereum?.selectedAddress || '';
			const chainId =
				Number((await window.ethereum?.request?.({ method: 'eth_chainId' })) || 0) ||
				undefined;
			await fetch(`/api/agents/${encodeURIComponent(agent.id)}/wallet`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					wallet_address: wallet,
					chain_id: chainId
						? parseInt(
								chainId.toString(16) === chainId.toString()
									? chainId
									: String(chainId),
								10,
							) || null
						: null,
					erc8004_agent_id: result.agentId,
				}),
			});

			say(
				`✓ Done. agentId=${result.agentId}, registration=ipfs://${result.registrationCID}, tx=${result.txHash}`,
			);
		} catch (err) {
			say(err.message || String(err), true);
		} finally {
			btn.disabled = false;
		}
	});
}

// ── My on-chain agents card ─────────────────────────────────────────────────
// Lists every ERC-8004 agent owned by the connected wallet — minted here or
// elsewhere. Enumerates via ERC-721: balanceOf + tokenOfOwnerByIndex, falling
// back to a Transfer-event scan if the registry isn't ERC-721-Enumerable.
// Merges in DB-registered agents from /api/agents/by-wallet so "home" links
// work for agents minted through this app.
function myAgentsCard() {
	return `
		<div class="card" id="my-agents-card" style="margin-top:14px">
			<h3 style="margin:0 0 6px">Your on-chain agents</h3>
			<p class="muted" style="margin:0 0 10px">All ERC-8004 agents owned by your connected wallet — minted here or anywhere else.</p>
			<div class="row" style="gap:8px; flex-wrap:wrap; align-items:center">
				<button class="btn sec" id="my-agents-load" type="button">Load from wallet</button>
				<span id="my-agents-status" class="muted" style="font-size:12px"></span>
			</div>
			<div id="my-agents-list" style="margin-top:12px; display:grid; gap:10px"></div>
		</div>
	`;
}

function bindMyAgents(body) {
	const btn = body.querySelector('#my-agents-load');
	const status = body.querySelector('#my-agents-status');
	const list = body.querySelector('#my-agents-list');
	if (!btn) return;

	btn.addEventListener('click', async () => {
		btn.disabled = true;
		status.textContent = 'Connecting wallet…';
		list.innerHTML = '';

		try {
			const [{ connectWallet, getIdentityRegistry }, { REGISTRY_DEPLOYMENTS }] =
				await Promise.all([
					import('/src/erc8004/agent-registry.js'),
					import('/src/erc8004/abi.js'),
				]);

			const { signer, address, chainId } = await connectWallet();
			const deployment = REGISTRY_DEPLOYMENTS[chainId];
			if (!deployment?.identityRegistry) {
				status.textContent = `No ERC-8004 registry on chain ${chainId}. Switch networks and retry.`;
				return;
			}

			status.textContent = 'Reading registry…';
			const registry = getIdentityRegistry(chainId, signer);
			const balance = Number(await registry.balanceOf(address));

			// Fire the DB lookup in parallel with on-chain work.
			const dbPromise = fetch(
				`/api/agents/by-wallet?address=${encodeURIComponent(address)}&chain_id=${chainId}`,
				{ credentials: 'include' },
			)
				.then((r) => (r.ok ? r.json() : { agents: [] }))
				.catch(() => ({ agents: [] }));

			if (balance === 0) {
				const { agents: dbAgents = [] } = await dbPromise;
				if (dbAgents.length === 0) {
					status.textContent = `No agents owned on chain ${chainId}.`;
					return;
				}
				renderAgentRows(list, [], dbAgents);
				status.textContent = `${dbAgents.length} DB record${dbAgents.length === 1 ? '' : 's'} (not on-chain yet).`;
				return;
			}

			status.textContent = `${balance} agent${balance === 1 ? '' : 's'} owned. Enumerating…`;

			// Try ERC-721 Enumerable; fall back to event scan.
			let tokenIds = [];
			try {
				for (let i = 0; i < balance; i++) {
					tokenIds.push(Number(await registry.tokenOfOwnerByIndex(address, i)));
				}
			} catch {
				status.textContent = 'Registry is not Enumerable — scanning Transfer events…';
				const events = await registry.queryFilter(registry.filters.Transfer(null, address));
				const seen = new Set();
				for (const e of events) {
					const id = Number(e.args.tokenId);
					if (seen.has(id)) continue;
					seen.add(id);
					try {
						const owner = await registry.ownerOf(id);
						if (owner.toLowerCase() === address.toLowerCase()) tokenIds.push(id);
					} catch {
						/* token burned/transferred — skip */
					}
				}
			}

			status.textContent = `Fetching metadata for ${tokenIds.length} agent${tokenIds.length === 1 ? '' : 's'}…`;
			const onchain = await Promise.all(tokenIds.map((id) => fetchTokenMeta(registry, id)));
			const { agents: dbAgents = [] } = await dbPromise;

			renderAgentRows(list, onchain, dbAgents);
			status.textContent = `${onchain.length} on-chain agent${onchain.length === 1 ? '' : 's'} on chain ${chainId}.`;
		} catch (err) {
			status.textContent = `Error: ${err.message || String(err)}`;
		} finally {
			btn.disabled = false;
		}
	});
}

async function fetchTokenMeta(registry, tokenId) {
	let uri = '';
	let meta = null;
	try {
		uri = await registry.tokenURI(tokenId);
	} catch {
		/* no URI set */
	}
	if (uri) {
		const httpUrl = uriToHttp(uri);
		try {
			const r = await fetch(httpUrl);
			const ct = r.headers.get('content-type') || '';
			if (r.ok && ct.includes('json')) meta = await r.json();
		} catch {
			/* metadata unreachable */
		}
	}
	return { id: tokenId, uri, meta };
}

function uriToHttp(uri) {
	if (!uri) return '';
	if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
	if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice(5)}`;
	return uri;
}

// Re-pin the agent's on-chain manifest with the current animations. Fetches the
// existing tokenURI metadata to preserve services/registrations/trust fields
// that live outside the DB (so skills, A2A endpoints, x402, etc. aren't lost).
async function rePinAgentManifest({ agent, animations, logEl }) {
	const btn = logEl.parentElement.querySelector('#anim-repin-btn');
	const say = (msg, err = false) => {
		const line = document.createElement('div');
		if (err) line.style.color = '#ffb3b3';
		line.textContent = msg;
		logEl.appendChild(line);
	};

	const agentIdOnchain = agent.erc8004_agent_id;
	const chainIdExpected = Number(agent.chain_id || 0);
	if (!agentIdOnchain || !chainIdExpected) {
		say('Missing erc8004_agent_id or chain_id on this agent.', true);
		return;
	}

	btn.disabled = true;
	logEl.textContent = '';
	try {
		const [
			{ connectWallet, getIdentityRegistry, pinFile, buildRegistrationJSON },
			{ REGISTRY_DEPLOYMENTS },
		] = await Promise.all([
			import('/src/erc8004/agent-registry.js'),
			import('/src/erc8004/abi.js'),
		]);

		say('Connecting wallet…');
		const { signer, chainId } = await connectWallet();
		if (Number(chainId) !== chainIdExpected) {
			throw new Error(
				`Wallet is on chain ${chainId} but this agent lives on chain ${chainIdExpected}. Switch networks and try again.`,
			);
		}

		const deployment = REGISTRY_DEPLOYMENTS[chainId];
		if (!deployment?.identityRegistry) {
			throw new Error(`No ERC-8004 registry deployed on chain ${chainId}.`);
		}

		say('Reading current manifest from chain…');
		const registry = getIdentityRegistry(chainId, signer);
		const currentURI = await registry.tokenURI(agentIdOnchain);
		let currentMeta = {};
		if (currentURI) {
			try {
				const r = await fetch(uriToHttp(currentURI));
				if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
					currentMeta = await r.json();
				}
			} catch {
				/* fall through — treat as empty and rebuild */
			}
		}

		// Preserve non-avatar services (skills, A2A, MCP, etc.) from the existing
		// manifest. The avatar + 3D services are rebuilt from the current GLB URL.
		const preservedServices = (currentMeta.services || []).filter(
			(s) => s?.name !== 'avatar' && s?.name !== '3D',
		);
		const glbUrl =
			currentMeta.body?.uri ||
			(currentMeta.services || []).find((s) => s?.name === 'avatar' && s?.endpoint)
				?.endpoint ||
			'';

		say('Building new registration JSON…');
		const registrationJSON = buildRegistrationJSON({
			name: currentMeta.name || agent.name || 'Agent',
			description: currentMeta.description || agent.description || '',
			imageUrl: currentMeta.image || '',
			glbUrl,
			agentId: Number(agentIdOnchain),
			chainId,
			registryAddr: deployment.identityRegistry,
			services: preservedServices,
			x402Support: !!(currentMeta.x402Support || currentMeta.x402),
			animations,
		});

		say('Pinning new manifest…');
		const jsonBlob = new Blob([JSON.stringify(registrationJSON, null, 2)], {
			type: 'application/json',
		});
		const newUri = await pinFile(jsonBlob);
		say(`New metadata URI: ${newUri}`);

		say('Calling setAgentURI on-chain…');
		const tx = await registry.setAgentURI(agentIdOnchain, newUri);
		say(`Transaction submitted: ${tx.hash}`);
		await tx.wait();
		say('✓ Manifest updated on-chain.');
		toast('On-chain manifest re-pinned');
	} catch (err) {
		say(`Failed: ${err.shortMessage || err.message || String(err)}`, true);
	} finally {
		btn.disabled = false;
	}
}

function renderAgentRows(list, onchainAgents, dbAgents) {
	const dbByAgentId = new Map();
	for (const a of dbAgents) {
		if (a.erc8004_agent_id != null) dbByAgentId.set(String(a.erc8004_agent_id), a);
	}

	list.innerHTML = '';
	for (const { id, uri, meta } of onchainAgents) {
		const dbRow = dbByAgentId.get(String(id));
		const name = meta?.name || dbRow?.name || `Agent #${id}`;
		const desc = meta?.description || dbRow?.description || '';
		const img = uriToHttp(meta?.image || '');
		const homeLink = dbRow ? `/agent/${encodeURIComponent(dbRow.id)}` : '';
		const metaLink = uri ? uriToHttp(uri) : '';

		const el = document.createElement('div');
		el.className = 'row';
		el.style.cssText =
			'gap:12px; padding:10px; border:1px solid #2a2a34; border-radius:10px; align-items:flex-start';
		el.innerHTML = `
			<div style="flex:0 0 64px; width:64px; height:64px; border-radius:8px; background:#0f0f17; overflow:hidden; display:flex; align-items:center; justify-content:center">
				${img ? `<img src="${attr(img)}" alt="" style="max-width:100%;max-height:100%;object-fit:cover" onerror="this.remove()">` : '<span class="muted" style="font-size:10px">no image</span>'}
			</div>
			<div style="flex:1 1 auto; min-width:0">
				<div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap">
					<strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${esc(name)}</strong>
					<span class="muted" style="font-size:12px">#${esc(String(id))}</span>
				</div>
				${desc ? `<p class="muted" style="margin:4px 0 0; font-size:12px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden">${esc(desc)}</p>` : ''}
				<div class="row" style="gap:10px; margin-top:6px; font-size:12px">
					${metaLink ? `<a href="${attr(metaLink)}" target="_blank" rel="noopener" class="muted">Metadata</a>` : ''}
					${homeLink ? `<a href="${attr(homeLink)}" target="_blank" rel="noopener">Open home</a>` : ''}
				</div>
			</div>
		`;
		list.appendChild(el);
	}

	// Surface DB rows that aren't on-chain yet (e.g. registration failed).
	for (const a of dbAgents) {
		const hasOnchain =
			a.erc8004_agent_id != null &&
			onchainAgents.some((o) => String(o.id) === String(a.erc8004_agent_id));
		if (hasOnchain) continue;

		const el = document.createElement('div');
		el.className = 'row';
		el.style.cssText =
			'gap:12px; padding:10px; border:1px dashed #2a2a34; border-radius:10px; align-items:flex-start; opacity:.85';
		el.innerHTML = `
			<div style="flex:0 0 64px; width:64px; height:64px; border-radius:8px; background:#0f0f17; display:flex; align-items:center; justify-content:center">
				<span class="muted" style="font-size:10px">db only</span>
			</div>
			<div style="flex:1 1 auto; min-width:0">
				<div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap">
					<strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${esc(a.name || 'Agent')}</strong>
					<span class="muted" style="font-size:12px">not on-chain</span>
				</div>
				${a.description ? `<p class="muted" style="margin:4px 0 0; font-size:12px">${esc(a.description)}</p>` : ''}
				<div class="row" style="gap:10px; margin-top:6px; font-size:12px">
					<a href="/agent/${encodeURIComponent(a.id)}" target="_blank" rel="noopener">Open home</a>
				</div>
			</div>
		`;
		list.appendChild(el);
	}
}

// ── Monetization ─────────────────────────────────────────────────────────────
async function renderMonetization(root) {
	root.innerHTML = `
		<h1>Monetization</h1>
		<p class="sub">Set prices for your agent's skills and configure payout wallets.</p>
		<div id="mon-body"><div class="muted">Loading…</div></div>
	`;
	const body = root.querySelector('#mon-body');

	const CURRENCIES = [
		{
			label: 'Solana USDC',
			mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			chain: 'solana',
		},
		{ label: 'Base USDC', mint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', chain: 'base' },
	];

	const toHuman = (amount) => (Number(amount) / 1_000_000).toFixed(6).replace(/\.?0+$/, '');
	const toBigint = (human) => Math.round(parseFloat(human) * 1_000_000);

	let agent, prices, wallets;
	try {
		const [agentRes, walletsRes] = await Promise.all([
			fetch('/api/agents/me', { credentials: 'include' }),
			fetch('/api/billing/payout-wallets', { credentials: 'include' }),
		]);
		if (!agentRes.ok) throw new Error('Could not load agent');
		const agentData = await agentRes.json();
		agent = agentData.agent;
		wallets = walletsRes.ok ? (await walletsRes.json()).wallets || [] : [];

		const pricesRes = await fetch(`/api/agents/${agent.id}/pricing`, {
			credentials: 'include',
		});
		prices = pricesRes.ok ? (await pricesRes.json()).prices || [] : [];
	} catch (e) {
		body.innerHTML = `<div class="err">${esc(e.message || 'Failed to load monetization data')}</div>`;
		return;
	}

	const agentId = agent.id;
	const skills = agent.skills || [];

	const priceMap = {};
	prices.forEach((p) => {
		priceMap[p.skill] = p;
	});

	const solWallet = wallets.find((w) => w.chain === 'solana');
	const baseWallet = wallets.find((w) => w.chain === 'base' || w.chain === 'evm');

	body.innerHTML = `
		<div style="margin-bottom:32px">
			<h3 style="margin:0 0 14px; font-size:15px">Skill Prices</h3>
			<div id="mon-prices" style="display:flex;flex-direction:column;gap:8px">
				${skills.length === 0 && prices.length === 0 ? '<div class="muted">No skills registered on this agent yet.</div>' : ''}
			</div>
			<div id="mon-add-price" style="margin-top:10px"></div>
		</div>
		<div>
			<h3 style="margin:0 0 14px; font-size:15px">Payout Wallets</h3>
			<div style="display:flex;flex-direction:column;gap:12px;max-width:520px">
				<div class="card">
					<div class="row" style="gap:8px;margin-bottom:10px">
						<strong style="font-size:13px">Solana (USDC)</strong>
						${solWallet ? `<span class="tag">Configured</span>` : ''}
					</div>
					<div class="row" style="gap:8px">
						<input id="mon-sol-addr" type="text" placeholder="Solana address (base58)" value="${attr(solWallet?.address || '')}" style="flex:1;font-size:13px">
						<button class="btn sec" id="mon-sol-save" style="white-space:nowrap">Set payout</button>
					</div>
					<div id="mon-sol-msg" class="muted" style="margin-top:6px;font-size:12px;min-height:16px"></div>
				</div>
				<div class="card">
					<div class="row" style="gap:8px;margin-bottom:10px">
						<strong style="font-size:13px">Base (USDC)</strong>
						${baseWallet ? `<span class="tag">Configured</span>` : ''}
					</div>
					<div class="row" style="gap:8px">
						<input id="mon-base-addr" type="text" placeholder="Base address (0x…)" value="${attr(baseWallet?.address || '')}" style="flex:1;font-size:13px">
						<button class="btn sec" id="mon-base-save" style="white-space:nowrap">Set payout</button>
					</div>
					<div id="mon-base-msg" class="muted" style="margin-top:6px;font-size:12px;min-height:16px"></div>
				</div>
			</div>
		</div>
	`;

	const pricesEl = body.querySelector('#mon-prices');

	function wireRemove(btn, row, skill) {
		btn.addEventListener('click', async () => {
			const msg = row.querySelector('[data-msg]');
			msg.style.color = '#888';
			msg.textContent = 'Removing…';
			try {
				const r = await fetch(
					`/api/agents/${agentId}/pricing/${encodeURIComponent(skill)}?hard=true`,
					{ method: 'DELETE', credentials: 'include' },
				);
				if (!r.ok) {
					const d = await r.json().catch(() => ({}));
					throw new Error(d.error_description || `HTTP ${r.status}`);
				}
				row.remove();
			} catch (e) {
				msg.style.color = '#ffb3b3';
				msg.textContent = e.message;
			}
		});
	}

	const makeRow = (skill, price) => {
		const row = document.createElement('div');
		row.style.cssText =
			'display:grid;grid-template-columns:minmax(100px,1fr) 150px 1fr auto auto auto;align-items:center;gap:10px;padding:10px 12px;background:var(--panel);border:1px solid var(--border);border-radius:10px';
		const defMint = price?.currency_mint || CURRENCIES[0].mint;
		row.innerHTML = `
			<span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${attr(skill)}">${esc(skill)}</span>
			<input type="number" min="0.000001" step="0.000001" placeholder="Amount (USDC)"
				value="${price ? attr(toHuman(price.amount)) : ''}"
				style="font-size:13px;width:100%" data-amount>
			<select style="font-size:13px;width:100%" data-currency>
				${CURRENCIES.map((c) => `<option value="${attr(c.mint)}" data-chain="${attr(c.chain)}" ${c.mint === defMint ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
			</select>
			<label class="toggle" title="Active">
				<input type="checkbox" ${!price || price.is_active ? 'checked' : ''} data-active>
				<span class="track"></span>
				<span class="label">Active</span>
			</label>
			<div style="display:inline-flex;gap:6px">
				<button class="btn" style="font-size:12px;padding:5px 10px;white-space:nowrap" data-save>Save</button>
				${price ? `<button class="btn sec" style="font-size:12px;padding:5px 10px;color:#ffb3b3" data-remove>Remove</button>` : ''}
			</div>
			<div data-msg style="font-size:12px;min-width:54px"></div>
		`;

		const msg = row.querySelector('[data-msg]');

		row.querySelector('[data-save]').addEventListener('click', async () => {
			const amountRaw = row.querySelector('[data-amount]').value;
			const amount = toBigint(amountRaw);
			if (!amountRaw || isNaN(amount) || amount <= 0) {
				msg.style.color = '#ffb3b3';
				msg.textContent = 'Enter a valid amount';
				return;
			}
			const sel = row.querySelector('[data-currency]');
			const currencyMint = sel.value;
			const chain = sel.options[sel.selectedIndex].dataset.chain;
			const isActive = row.querySelector('[data-active]').checked;
			msg.style.color = '#888';
			msg.textContent = 'Saving…';
			try {
				const r = await fetch(
					`/api/agents/${agentId}/pricing/${encodeURIComponent(skill)}`,
					{
						method: 'PUT',
						credentials: 'include',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							currency_mint: currencyMint,
							chain,
							amount,
							is_active: isActive,
						}),
					},
				);
				if (!r.ok) {
					const d = await r.json().catch(() => ({}));
					throw new Error(d.error_description || `HTTP ${r.status}`);
				}
				if (!row.querySelector('[data-remove]')) {
					const removeBtn = document.createElement('button');
					removeBtn.className = 'btn sec';
					removeBtn.style.cssText = 'font-size:12px;padding:5px 10px;color:#ffb3b3';
					removeBtn.dataset.remove = '';
					removeBtn.textContent = 'Remove';
					row.querySelector('[data-save]').parentNode.appendChild(removeBtn);
					wireRemove(removeBtn, row, skill);
				}
				msg.style.color = '#9a8cff';
				msg.textContent = 'Saved ✓';
				setTimeout(() => {
					msg.textContent = '';
				}, 2000);
			} catch (e) {
				msg.style.color = '#ffb3b3';
				msg.textContent = e.message;
			}
		});

		const removeBtn = row.querySelector('[data-remove]');
		if (removeBtn) wireRemove(removeBtn, row, skill);

		return row;
	};

	const renderedSkills = new Set();
	skills.forEach((skill) => {
		pricesEl.appendChild(makeRow(skill, priceMap[skill] || null));
		renderedSkills.add(skill);
	});
	prices.forEach((p) => {
		if (!renderedSkills.has(p.skill)) pricesEl.appendChild(makeRow(p.skill, p));
	});

	const addPriceEl = body.querySelector('#mon-add-price');
	addPriceEl.innerHTML = `<button class="btn sec" id="mon-add-custom" style="font-size:12px">+ Add custom skill price</button>`;
	addPriceEl.querySelector('#mon-add-custom').addEventListener('click', () => {
		const wrap = document.createElement('div');
		wrap.style.cssText = 'display:flex;gap:8px;margin-top:8px;align-items:center';
		wrap.innerHTML = `
			<input type="text" placeholder="Skill name" style="font-size:13px;width:180px" id="mon-new-skill">
			<button class="btn sec" style="font-size:12px" id="mon-new-confirm">Add</button>
			<button class="btn sec" style="font-size:12px" id="mon-new-cancel">Cancel</button>
		`;
		addPriceEl.appendChild(wrap);
		wrap.querySelector('#mon-new-confirm').addEventListener('click', () => {
			const name = wrap.querySelector('#mon-new-skill').value.trim();
			if (!name) return;
			wrap.remove();
			pricesEl.appendChild(makeRow(name, null));
		});
		wrap.querySelector('#mon-new-cancel').addEventListener('click', () => wrap.remove());
	});

	const saveWallet = async (chain, addrInput, msgEl) => {
		const address = addrInput.value.trim();
		if (!address) {
			msgEl.style.color = '#ffb3b3';
			msgEl.textContent = 'Enter an address';
			return;
		}
		msgEl.style.color = '#888';
		msgEl.textContent = 'Saving…';
		try {
			const r = await fetch('/api/billing/payout-wallets', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ address, chain, agent_id: agentId, is_default: true }),
			});
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.error_description || `HTTP ${r.status}`);
			}
			msgEl.style.color = '#9a8cff';
			msgEl.textContent = 'Saved ✓';
			setTimeout(() => {
				msgEl.textContent = '';
			}, 2000);
		} catch (e) {
			msgEl.style.color = '#ffb3b3';
			msgEl.textContent = e.message;
		}
	};

	body.querySelector('#mon-sol-save').addEventListener('click', () =>
		saveWallet(
			'solana',
			body.querySelector('#mon-sol-addr'),
			body.querySelector('#mon-sol-msg'),
		),
	);
	body.querySelector('#mon-base-save').addEventListener('click', () =>
		saveWallet(
			'base',
			body.querySelector('#mon-base-addr'),
			body.querySelector('#mon-base-msg'),
		),
	);
}

// ── Subscriptions ────────────────────────────────────────────────────────────
async function renderSubscriptions(root) {
	root.innerHTML = `
		<h1>Subscriptions</h1>
		<p class="sub">Manage your creator plans and fan subscriptions.</p>
		<div id="sub-body"><div class="muted">Loading…</div></div>
	`;
	const body = root.querySelector('#sub-body');

	const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');
	const fmtUsd = (n) => '$' + Number(n).toFixed(2);

	let myId, plans, subs;
	try {
		myId = state.user?.id;
		const [plansRes, subsRes] = await Promise.all([
			fetch(`/api/subscriptions/plans?creator_id=${encodeURIComponent(myId)}`, {
				credentials: 'include',
			}),
			fetch('/api/subscriptions/mine', { credentials: 'include' }),
		]);
		plans = plansRes.ok ? (await plansRes.json()).plans || [] : [];
		subs = subsRes.ok ? (await subsRes.json()).subscriptions || [] : [];
	} catch (e) {
		body.innerHTML = `<div class="err">${esc(e.message || 'Failed to load subscriptions')}</div>`;
		return;
	}

	// ── Creator view ─────────────────────────���────────────────────────────────
	let plansHtml = '';
	for (const p of plans) {
		plansHtml += `
			<div class="card" style="margin-bottom:10px">
				<div class="row" style="gap:12px;align-items:flex-start">
					<div style="flex:1">
						<strong>${esc(p.name)}</strong>
						<span class="tag" style="margin-left:6px">${esc(p.interval)}</span>
						<div style="font-size:13px;color:#888;margin-top:4px">${fmtUsd(p.price_usd)}</div>
						${p.perks?.length ? `<ul style="margin:6px 0 0 16px;padding:0;font-size:13px;color:#aaa">${p.perks.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
					</div>
					<button class="btn-sm btn-danger sub-del-plan" data-id="${esc(p.id)}" style="flex-shrink:0">Remove</button>
				</div>
			</div>
		`;
	}

	const createForm =
		plans.length < 3
			? `
		<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:16px">
			<h4 style="margin:0 0 12px;font-size:14px">New plan</h4>
			<div style="display:flex;flex-direction:column;gap:8px;max-width:420px">
				<input id="sub-plan-name" class="input" placeholder="Plan name (e.g. Supporter)" />
				<div class="row" style="gap:8px">
					<input id="sub-plan-price" class="input" type="number" min="0.99" step="0.01" placeholder="Price USD (e.g. 4.99)" style="flex:1" />
					<select id="sub-plan-interval" class="input" style="flex:1">
						<option value="monthly">Monthly</option>
						<option value="weekly">Weekly</option>
					</select>
				</div>
				<textarea id="sub-plan-perks" class="input" rows="2" placeholder="Perks, one per line (optional)"></textarea>
				<div id="sub-plan-msg" class="muted" style="font-size:13px"></div>
				<button id="sub-plan-create" class="btn">Create plan</button>
			</div>
		</div>
	`
			: '<p class="muted" style="font-size:13px">Maximum 3 active plans reached.</p>';

	// ── Subscriber view ───────────────────────────────────────────────────────
	let subsHtml = '';
	for (const s of subs) {
		const statusColor =
			s.status === 'active' ? '#4caf50' : s.status === 'past_due' ? '#e53935' : '#888';
		subsHtml += `
			<div class="card" style="margin-bottom:10px">
				<div class="row" style="gap:12px;align-items:flex-start">
					<div style="flex:1">
						<strong>${esc(s.plan_name)}</strong>
						<span style="color:${statusColor};font-size:12px;margin-left:6px">${esc(s.status)}</span>
						<div style="font-size:13px;color:#888;margin-top:4px">${fmtUsd(s.price_usd)} / ${esc(s.interval)}</div>
						<div style="font-size:12px;color:#666;margin-top:4px">Creator: ${esc(s.creator_name || s.creator_id)} &nbsp;·&nbsp; Next billing: ${fmtDate(s.current_period_end)}</div>
					</div>
					${s.status === 'active' ? `<button class="btn-sm btn-danger sub-cancel" data-id="${esc(s.id)}" style="flex-shrink:0">Cancel</button>` : ''}
				</div>
			</div>
		`;
	}

	body.innerHTML = `
		<div style="display:flex;flex-direction:column;gap:32px">
			<div>
				<h3 style="margin:0 0 14px;font-size:15px">My Plans (Creator)</h3>
				${plans.length === 0 ? '<div class="muted">No plans yet.</div>' : plansHtml}
				${createForm}
			</div>
			<div>
				<h3 style="margin:0 0 14px;font-size:15px">My Subscriptions</h3>
				${subs.length === 0 ? '<div class="muted">Not subscribed to any plans.</div>' : subsHtml}
			</div>
		</div>
	`;

	// Wire delete plan buttons.
	body.querySelectorAll('.sub-del-plan').forEach((btn) => {
		btn.addEventListener('click', async () => {
			if (!confirm('Remove this plan?')) return;
			btn.disabled = true;
			const r = await fetch(`/api/subscriptions/plans/${btn.dataset.id}`, {
				method: 'DELETE',
				credentials: 'include',
			});
			if (r.ok) renderSubscriptions(root);
			else {
				btn.disabled = false;
				alert('Failed to remove plan');
			}
		});
	});

	// Wire cancel subscription buttons.
	body.querySelectorAll('.sub-cancel').forEach((btn) => {
		btn.addEventListener('click', async () => {
			if (!confirm('Cancel this subscription?')) return;
			btn.disabled = true;
			const r = await fetch(`/api/subscriptions/${btn.dataset.id}`, {
				method: 'DELETE',
				credentials: 'include',
			});
			if (r.ok) renderSubscriptions(root);
			else {
				btn.disabled = false;
				alert('Failed to cancel subscription');
			}
		});
	});

	// Wire create plan form.
	const createBtn = body.querySelector('#sub-plan-create');
	if (createBtn) {
		createBtn.addEventListener('click', async () => {
			const name = body.querySelector('#sub-plan-name').value.trim();
			const price = parseFloat(body.querySelector('#sub-plan-price').value);
			const interval = body.querySelector('#sub-plan-interval').value;
			const perksRaw = body.querySelector('#sub-plan-perks').value;
			const perks = perksRaw
				.split('\n')
				.map((s) => s.trim())
				.filter(Boolean);
			const msg = body.querySelector('#sub-plan-msg');
			if (!name) {
				msg.textContent = 'Name required.';
				return;
			}
			if (!price || price < 0.99) {
				msg.textContent = 'Price must be at least $0.99.';
				return;
			}
			createBtn.disabled = true;
			msg.textContent = 'Creating…';
			const r = await fetch('/api/subscriptions/plans', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name, price_usd: price, interval, perks }),
			});
			if (r.ok) {
				renderSubscriptions(root);
			} else {
				const d = await r.json().catch(() => ({}));
				msg.textContent = d.error_description || 'Failed to create plan';
				createBtn.disabled = false;
			}
		});
	}
}

// ── Billing & usage ─────────────────────────────────────────────────────────
async function renderBilling(root) {
	root.innerHTML = `
		<h1>Plan &amp; usage</h1>
		<p class="sub">You're on the <b>${esc(state.user.plan)}</b> plan.</p>
		<div id="billing-body"><div class="muted">Loading…</div></div>
	`;
	const body = root.querySelector('#billing-body');
	let data;
	try {
		const r = await fetch('/api/billing/summary', { credentials: 'include' });
		if (r.ok) data = await r.json();
	} catch {}
	if (!data) {
		body.innerHTML = '<div class="card muted">Could not load usage data.</div>';
		return;
	}
	const { plan, quotas, usage } = data;
	function fmtBytes(n) {
		if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
		if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
		if (n >= 1e3) return Math.round(n / 1e3) + ' KB';
		return n + ' B';
	}
	function meter(label, used, max, fmt = String) {
		const pct = max ? Math.min(100, (used / max) * 100) : 0;
		const c = pct > 90 ? '#ff5c5c' : pct > 70 ? '#f0c14b' : '#6c5cff';
		return `<div style="margin-bottom:16px">
			<div class="row" style="justify-content:space-between;margin-bottom:4px">
				<span>${esc(label)}</span>
				<span class="muted" style="font-size:12px">${esc(fmt(used))} / ${max ? esc(fmt(max)) : '∞'}</span>
			</div>
			<div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
				<div style="height:100%;width:${pct.toFixed(1)}%;background:${c};border-radius:3px;transition:width .4s"></div>
			</div></div>`;
	}
	const C = { free: '#6b7280', pro: '#6c5cff', team: '#00e5a0', enterprise: '#f0c14b' };
	const bc = C[plan] || '#6b7280';
	body.innerHTML = `
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
			<div class="card">
				<div class="row" style="justify-content:space-between;margin-bottom:16px">
					<h3 style="margin:0">Current plan</h3>
					<span style="padding:3px 12px;border-radius:999px;background:${bc}22;color:${bc};font-weight:600;font-size:13px;text-transform:capitalize">${esc(plan)}</span>
				</div>
				${meter('Avatars', usage.avatar_count, quotas?.max_avatars)}
				${meter('Storage', usage.total_bytes, quotas?.max_total_bytes, fmtBytes)}
				${meter('MCP calls (24 h)', usage.mcp_calls_24h, quotas?.mcp_calls_per_day)}
			</div>
			<div class="card">
				<h3 style="margin:0 0 16px">Activity</h3>
				<div class="row" style="justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
					<span class="muted">Agents</span><strong>${esc(String(usage.agent_count ?? 0))}</strong>
				</div>
				<div class="row" style="justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
					<span class="muted">LLM calls this month</span><strong>${esc(String(usage.llm_calls_month ?? 0))}</strong>
				</div>
				<div class="row" style="justify-content:space-between;padding:10px 0">
					<span class="muted">MCP calls today</span><strong>${esc(String(usage.mcp_calls_24h ?? 0))}</strong>
				</div>
				${plan === 'free' ? `<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)"><a class="btn" href="mailto:support@three.ws?subject=Upgrade" style="display:block;text-align:center">Upgrade plan →</a></div>` : ''}
			</div>
		</div>
	`;
}

// ── Revenue dashboard ────────────────────────────────────────────────────────
function formatUSDC(lamports) {
	return (
		(lamports / 1_000_000).toLocaleString('en-US', {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}) + ' USDC'
	);
}

function revenueBarChart(timeseries) {
	if (!timeseries.length)
		return '<div class="muted" style="text-align:center;padding:24px 0">No data for this period.</div>';
	const W = 600,
		H = 160,
		PAD = { top: 12, right: 8, bottom: 28, left: 8 };
	const max = Math.max(...timeseries.map((r) => r.net_total), 1);
	const barW = Math.max(4, Math.floor((W - PAD.left - PAD.right) / timeseries.length) - 2);
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;
	const bars = timeseries.map((r, i) => {
		const x = PAD.left + Math.round((i / timeseries.length) * innerW);
		const barH = Math.max(2, Math.round((r.net_total / max) * innerH));
		const y = PAD.top + innerH - barH;
		const label = r.period.slice(5); // MM-DD
		return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="#6c5cff" rx="2">
			<title>${r.period}: ${formatUSDC(r.net_total)}</title></rect>
			<text x="${x + barW / 2}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--muted)">${label}</text>`;
	});
	return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">${bars.join('')}</svg>`;
}

async function renderRevenue(root) {
	root.innerHTML = `
		<h1>Revenue</h1>
		<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px">
			<select id="rev-agent" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:inherit">
				<option value="">All agents</option>
			</select>
			<select id="rev-range" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:inherit">
				<option value="7">Last 7 days</option>
				<option value="30" selected>Last 30 days</option>
				<option value="90">Last 90 days</option>
			</select>
		</div>
		<div id="rev-body"><div class="muted">Loading…</div></div>
	`;

	const agentSel = root.querySelector('#rev-agent');
	const rangeSel = root.querySelector('#rev-range');

	// Populate agent list
	try {
		const { agents } = await api.listAgents();
		for (const a of agents) {
			const opt = document.createElement('option');
			opt.value = a.id;
			opt.textContent = a.name || a.id.slice(0, 8);
			agentSel.appendChild(opt);
		}
	} catch {}

	async function load() {
		const body = root.querySelector('#rev-body');
		body.innerHTML = '<div class="muted">Loading…</div>';
		const days = parseInt(rangeSel.value, 10);
		const from = new Date(Date.now() - days * 86400_000).toISOString();
		const agentId = agentSel.value || null;
		const gran = days <= 7 ? 'day' : days <= 90 ? 'day' : 'week';
		let data;
		try {
			data = await api.getRevenue({ from, agent_id: agentId, granularity: gran });
		} catch (e) {
			body.innerHTML = `<div class="err">${esc(e.message)}</div>`;
			return;
		}
		const { summary, by_skill, timeseries } = data;

		if (summary.payment_count === 0 && !by_skill.length) {
			body.innerHTML = `
				<div class="card" style="text-align:center;padding:48px 24px">
					<div style="font-size:40px;margin-bottom:12px">💰</div>
					<h3 style="margin:0 0 8px">No revenue yet</h3>
					<p class="muted" style="margin:0">Payments will appear here once your agent skills are called.</p>
				</div>`;
			return;
		}

		body.innerHTML = `
			<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px">
				<div class="card">
					<div class="muted" style="font-size:12px;margin-bottom:4px">Gross earnings</div>
					<div style="font-size:20px;font-weight:700">${esc(formatUSDC(summary.gross_total))}</div>
				</div>
				<div class="card">
					<div class="muted" style="font-size:12px;margin-bottom:4px">Platform fees</div>
					<div style="font-size:20px;font-weight:700;color:#ff5c5c">−${esc(formatUSDC(summary.fee_total))}</div>
				</div>
				<div class="card">
					<div class="muted" style="font-size:12px;margin-bottom:4px">Net earnings</div>
					<div style="font-size:20px;font-weight:700;color:#00e5a0">${esc(formatUSDC(summary.net_total))}</div>
				</div>
				<div class="card">
					<div class="muted" style="font-size:12px;margin-bottom:4px">Payments</div>
					<div style="font-size:20px;font-weight:700">${esc(String(summary.payment_count))}</div>
				</div>
			</div>
			<div class="card" style="margin-bottom:20px">
				<h3 style="margin:0 0 12px">Daily earnings</h3>
				${revenueBarChart(timeseries)}
			</div>
			${
				by_skill.length
					? `
			<div class="card">
				<h3 style="margin:0 0 12px">Skill breakdown</h3>
				<table style="width:100%;border-collapse:collapse">
					<thead>
						<tr style="text-align:left;border-bottom:1px solid var(--border)">
							<th style="padding:6px 8px 10px;font-weight:600;font-size:13px">Skill</th>
							<th style="padding:6px 8px 10px;font-weight:600;font-size:13px;text-align:right">Net earnings</th>
							<th style="padding:6px 8px 10px;font-weight:600;font-size:13px;text-align:right">Transactions</th>
						</tr>
					</thead>
					<tbody>
						${by_skill
							.map(
								(s) => `<tr style="border-bottom:1px solid var(--border)">
							<td style="padding:8px">${esc(s.skill)}</td>
							<td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums">${esc(formatUSDC(s.net_total))}</td>
							<td style="padding:8px;text-align:right">${esc(String(s.count))}</td>
						</tr>`,
							)
							.join('')}
					</tbody>
				</table>
			</div>`
					: ''
			}
		`;
	}

	agentSel.addEventListener('change', load);
	rangeSel.addEventListener('change', load);
	await load();

	// Re-fetch on page focus (no WebSocket needed)
	const onFocus = () => load();
	window.addEventListener('focus', onFocus, { once: true });
}

// ── Withdrawals ─────────────────────────────────────────────────────────────
// Owner-facing UI for pulling earned USDC out to a wallet they control.
// Backend: GET/POST /api/billing/withdrawals (CSRF-gated POST).
// Cron processor (api/cron/[name].js → handleProcessWithdrawals) moves rows
// from pending → processing → completed/failed on-chain.

const USDC_MINTS = {
	solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
const MIN_WITHDRAWAL_LAMPORTS = 1_000_000; // 1 USDC

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function isValidAddrFor(chain, addr) {
	if (chain === 'solana') return SOLANA_ADDR_RE.test(addr);
	if (chain === 'base' || chain === 'evm') return EVM_ADDR_RE.test(addr);
	return false;
}

function shortAddr(a) {
	if (!a) return '—';
	if (a.length <= 14) return a;
	return a.slice(0, 6) + '…' + a.slice(-4);
}

function withdrawalStatusBadge(status) {
	const colors = {
		pending: '#f59e0b',
		processing: '#5cc8ff',
		completed: '#22c55e',
		failed: '#ef4444',
	};
	const c = colors[status] || '#888';
	return `<span style="font-size:11px;padding:2px 7px;border-radius:10px;background:${c}22;color:${c}">${esc(status)}</span>`;
}

function withdrawalTxLink(w) {
	if (!w.tx_signature) return '<span class="muted">—</span>';
	const sig = encodeURIComponent(w.tx_signature);
	const url =
		w.chain === 'solana'
			? `https://solscan.io/tx/${sig}`
			: w.chain === 'base'
				? `https://basescan.org/tx/${sig}`
				: `https://etherscan.io/tx/${sig}`;
	return `<a href="${url}" target="_blank" rel="noopener">view ↗</a>`;
}

async function renderWithdrawals(root) {
	root.innerHTML = `
		<h1>Withdrawals</h1>
		<p class="sub">Pull your earned USDC to a wallet you control.</p>
		<div id="wd-body"><div class="muted">Loading…</div></div>
	`;
	const body = root.querySelector('#wd-body');

	let revenue, withdrawalsResp, walletsResp;
	try {
		[revenue, withdrawalsResp, walletsResp] = await Promise.all([
			api.getRevenue({ from: '1970-01-01T00:00:00Z', granularity: 'month' }),
			api.listWithdrawals({ limit: 50 }),
			api.listPayoutWallets(),
		]);
	} catch (e) {
		body.innerHTML = `<div class="err">${esc(e.message || 'Failed to load withdrawal data')}</div>`;
		return;
	}

	const withdrawals = withdrawalsResp.withdrawals || [];
	const wallets = walletsResp.wallets || [];
	const earned = Number(revenue.summary?.net_total || 0);
	const inflight = withdrawals
		.filter((w) => w.status === 'pending' || w.status === 'processing')
		.reduce((s, w) => s + Number(w.amount), 0);
	const available = Math.max(0, earned - inflight);
	const canWithdraw = available >= MIN_WITHDRAWAL_LAMPORTS;

	const solWallet = wallets.find((w) => w.chain === 'solana');
	const baseWallet = wallets.find((w) => w.chain === 'base' || w.chain === 'evm');

	body.innerHTML = `
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px">
			<div class="card">
				<div class="muted" style="font-size:12px;margin-bottom:4px">Net earned (all time)</div>
				<div style="font-size:20px;font-weight:700">${esc(formatUSDC(earned))}</div>
			</div>
			<div class="card">
				<div class="muted" style="font-size:12px;margin-bottom:4px">In flight</div>
				<div style="font-size:20px;font-weight:700;color:#f59e0b">${esc(formatUSDC(inflight))}</div>
			</div>
			<div class="card">
				<div class="muted" style="font-size:12px;margin-bottom:4px">Available</div>
				<div style="font-size:20px;font-weight:700;color:#00e5a0">${esc(formatUSDC(available))}</div>
			</div>
		</div>

		<div class="card" style="margin-bottom:20px;max-width:560px">
			<h3 style="margin:0 0 12px">Request a withdrawal</h3>
			${
				canWithdraw
					? ''
					: `<div class="muted" style="margin-bottom:12px">Minimum withdrawal is 1 USDC. Available balance is too low.</div>`
			}
			<div style="display:flex;flex-direction:column;gap:12px">
				<label style="display:flex;flex-direction:column;gap:4px">
					<span class="muted" style="font-size:12px">Amount (USDC)</span>
					<div class="row" style="gap:8px">
						<input id="wd-amount" type="number" min="1" step="0.000001" placeholder="0.00" style="flex:1;font-size:14px" ${canWithdraw ? '' : 'disabled'}>
						<button class="btn sec" id="wd-max" type="button" ${canWithdraw ? '' : 'disabled'}>Max</button>
					</div>
				</label>
				<label style="display:flex;flex-direction:column;gap:4px">
					<span class="muted" style="font-size:12px">Chain</span>
					<select id="wd-chain" style="font-size:14px" ${canWithdraw ? '' : 'disabled'}>
						<option value="solana">Solana (USDC)</option>
						<option value="base">Base (USDC)</option>
					</select>
				</label>
				<label style="display:flex;flex-direction:column;gap:4px">
					<span class="muted" style="font-size:12px">Destination address</span>
					<input id="wd-address" type="text" placeholder="destination address" style="font-size:14px;font-family:ui-monospace,monospace" ${canWithdraw ? '' : 'disabled'}>
					<span id="wd-addr-hint" class="muted" style="font-size:12px"></span>
				</label>
				<div class="row" style="gap:8px">
					<button class="btn" id="wd-submit" ${canWithdraw ? '' : 'disabled'}>Request withdrawal</button>
					<span id="wd-msg" class="muted" style="font-size:13px"></span>
				</div>
			</div>
		</div>

		<div class="card">
			<h3 style="margin:0 0 12px">History</h3>
			${
				withdrawals.length === 0
					? '<div class="muted">No withdrawals yet.</div>'
					: `<table style="width:100%;border-collapse:collapse;font-size:13px">
				<thead>
					<tr style="text-align:left;color:#888;border-bottom:1px solid var(--border)">
						<th style="padding:8px 10px">Amount</th>
						<th style="padding:8px 10px">Chain</th>
						<th style="padding:8px 10px">Destination</th>
						<th style="padding:8px 10px">Status</th>
						<th style="padding:8px 10px">Tx</th>
						<th style="padding:8px 10px">Requested</th>
					</tr>
				</thead>
				<tbody>
					${withdrawals
						.map(
							(w) => `<tr style="border-bottom:1px solid var(--border)">
						<td style="padding:8px 10px;font-variant-numeric:tabular-nums">${esc(formatUSDC(Number(w.amount)))}</td>
						<td style="padding:8px 10px">${esc(w.chain)}</td>
						<td style="padding:8px 10px;font-family:ui-monospace,monospace;font-size:11px" title="${attr(w.to_address)}">${esc(shortAddr(w.to_address))}</td>
						<td style="padding:8px 10px">${withdrawalStatusBadge(w.status)}</td>
						<td style="padding:8px 10px">${withdrawalTxLink(w)}</td>
						<td style="padding:8px 10px;color:#888">${new Date(w.created_at).toLocaleString()}</td>
					</tr>`,
						)
						.join('')}
				</tbody>
			</table>`
			}
		</div>
	`;

	if (!canWithdraw) return;

	const amountEl = body.querySelector('#wd-amount');
	const chainEl = body.querySelector('#wd-chain');
	const addrEl = body.querySelector('#wd-address');
	const hintEl = body.querySelector('#wd-addr-hint');
	const maxBtn = body.querySelector('#wd-max');
	const submitBtn = body.querySelector('#wd-submit');
	const msgEl = body.querySelector('#wd-msg');

	function syncDefaultAddress() {
		const chain = chainEl.value;
		const fallback = chain === 'solana' ? solWallet : baseWallet;
		if (fallback) {
			addrEl.value = fallback.address;
			hintEl.textContent = `Pre-filled from your ${chain === 'solana' ? 'Solana' : 'Base'} payout wallet.`;
		} else {
			addrEl.value = '';
			hintEl.innerHTML =
				'No default set. Configure one on the <a href="/dashboard/monetization">Monetization tab</a> to pre-fill.';
		}
	}
	syncDefaultAddress();
	chainEl.addEventListener('change', syncDefaultAddress);

	maxBtn.addEventListener('click', () => {
		amountEl.value = (available / 1_000_000).toString();
	});

	submitBtn.addEventListener('click', async () => {
		msgEl.style.color = '';
		const human = parseFloat(amountEl.value);
		if (!Number.isFinite(human) || human <= 0) {
			msgEl.style.color = '#ffb3b3';
			msgEl.textContent = 'Enter a valid amount.';
			return;
		}
		const amount = Math.round(human * 1_000_000);
		if (amount < MIN_WITHDRAWAL_LAMPORTS) {
			msgEl.style.color = '#ffb3b3';
			msgEl.textContent = 'Minimum withdrawal is 1 USDC.';
			return;
		}
		if (amount > available) {
			msgEl.style.color = '#ffb3b3';
			msgEl.textContent = `Exceeds available (${formatUSDC(available)}).`;
			return;
		}
		const chain = chainEl.value;
		const to_address = addrEl.value.trim();
		if (!to_address) {
			msgEl.style.color = '#ffb3b3';
			msgEl.textContent = 'Destination address required.';
			return;
		}
		if (!isValidAddrFor(chain, to_address)) {
			msgEl.style.color = '#ffb3b3';
			msgEl.textContent =
				chain === 'solana'
					? 'Invalid Solana address (expected base58, 32–44 chars).'
					: 'Invalid Base address (expected 0x + 40 hex chars).';
			return;
		}

		submitBtn.disabled = true;
		msgEl.style.color = '#888';
		msgEl.textContent = 'Submitting…';
		try {
			const resp = await api.requestWithdrawal({
				amount,
				chain,
				currency_mint: USDC_MINTS[chain] || USDC_MINTS.solana,
				to_address,
			});
			msgEl.style.color = '#00e5a0';
			msgEl.textContent = 'Withdrawal requested.';
			if (resp?.withdrawal) withdrawals.unshift(resp.withdrawal);
			renderWithdrawals(root);
		} catch (e) {
			msgEl.style.color = '#ffb3b3';
			msgEl.textContent = e?.data?.error_description || e.message || 'Request failed';
			submitBtn.disabled = false;
		}
	});
}

// ── Widgets ─────────────────────────────────────────────────────────────────
// Saved 3D experiences the user has generated in the Studio. Each gets its own
// card with a live, lazy-loaded preview iframe. Editing happens in /studio —
// the dashboard is for managing what already exists.

const WIDGET_TYPE_META = {
	turntable: { label: 'Turntable', color: '#6a5cff' },
	'animation-gallery': { label: 'Animations', color: '#ff5ca8' },
	'talking-agent': { label: 'Talking Agent', color: '#00e5a0' },
	passport: { label: 'Passport', color: '#f0c14b' },
	'hotspot-tour': { label: 'Hotspot Tour', color: '#5cc8ff' },
};

const WIDGET_PREFS_KEY = 'dashboard.widgets.prefs';
const DEFAULT_WIDGET_PREFS = { sort: 'updated', type: '', q: '' };

function loadWidgetPrefs() {
	try {
		return {
			...DEFAULT_WIDGET_PREFS,
			...JSON.parse(localStorage.getItem(WIDGET_PREFS_KEY) || '{}'),
		};
	} catch {
		return { ...DEFAULT_WIDGET_PREFS };
	}
}
function saveWidgetPrefs(prefs) {
	try {
		localStorage.setItem(WIDGET_PREFS_KEY, JSON.stringify(prefs));
	} catch {}
	scheduleRemotePrefsSync(prefs);
}

// ── Remote prefs sync (best-effort backup) ─────────────────────────────────
let _remotePrefsTimer = null;
function scheduleRemotePrefsSync(prefs) {
	clearTimeout(_remotePrefsTimer);
	_remotePrefsTimer = setTimeout(() => {
		fetch('/api/dashboard/prefs', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prefs: { widgets: prefs } }),
		}).catch(() => {});
	}, 500);
}

let _remotePrefsHydrated = false;
async function hydrateWidgetPrefsFromRemote() {
	if (_remotePrefsHydrated) return;
	_remotePrefsHydrated = true;
	try {
		const res = await fetch('/api/dashboard/prefs', { credentials: 'include' });
		if (!res.ok) return;
		const data = await res.json();
		const remote = data?.prefs?.widgets;
		if (remote && typeof remote === 'object') {
			localStorage.setItem(
				WIDGET_PREFS_KEY,
				JSON.stringify({ ...DEFAULT_WIDGET_PREFS, ...remote }),
			);
		}
	} catch {
		// Network/auth failure → fall back to localStorage silently.
	}
}

// ── Account ──────────────────────────────────────────────────────────────────
async function renderAccount(root) {
	root.innerHTML = `
		<h1>Account</h1>
		<p class="sub">Set your username to get a public profile at three.ws/u/username.</p>
		<div class="card" style="max-width:480px" id="acct-form-wrap">
			<div class="muted">Loading…</div>
		</div>
	`;

	const wrap = root.querySelector('#acct-form-wrap');
	let user;
	try {
		const data = await api.me();
		user = data.user;
	} catch (err) {
		wrap.innerHTML = `<div class="err">${esc(err.message)}</div>`;
		return;
	}
	if (!user) {
		location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
		return;
	}

	const profileUrl = user.username
		? `${location.origin}/u/${encodeURIComponent(user.username)}`
		: null;

	wrap.innerHTML = `
		<form id="acct-form">
			<label style="display:block">
				Display name
				<input id="acct-name" value="${attr(user.display_name || '')}" maxlength="60" placeholder="Your name" style="width:100%">
			</label>
			<label style="display:block;margin-top:12px">
				Username
				<input id="acct-username" value="${attr(user.username || '')}" maxlength="30" placeholder="e.g. nirholas" style="width:100%" autocomplete="off" spellcheck="false">
				<span class="muted" style="font-size:11px;display:block;margin-top:4px">Letters, numbers, _ and - only. 3–30 characters.</span>
			</label>
			${
				profileUrl
					? `
				<div style="margin-top:12px">
					<p class="muted" style="font-size:11px;margin:0 0 4px">Your public profile</p>
					<div class="row" style="gap:6px;align-items:center">
						<a href="${attr(profileUrl)}" target="_blank" style="font-size:12px;color:#9a8cff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(profileUrl)}</a>
						<button id="acct-copy" class="btn sec" type="button" style="flex-shrink:0;white-space:nowrap">Copy</button>
					</div>
				</div>
			`
					: ''
			}
			<div id="acct-msg" class="muted" style="margin-top:12px"></div>
			<div class="row" style="gap:8px;margin-top:16px">
				<button class="btn" type="submit">Save</button>
			</div>
		</form>
	`;

	const msg = wrap.querySelector('#acct-msg');

	wrap.querySelector('#acct-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		msg.style.color = '#888';
		msg.textContent = 'Saving…';
		const username = wrap.querySelector('#acct-username').value.trim();
		const display_name = wrap.querySelector('#acct-name').value.trim();
		const patch = {};
		if (username) patch.username = username;
		if (display_name) patch.display_name = display_name;
		if (!Object.keys(patch).length) {
			msg.style.color = '#ffb3b3';
			msg.textContent = 'No changes.';
			return;
		}
		try {
			const res = await fetch('/api/auth/profile', {
				method: 'PATCH',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error_description || res.statusText);
			msg.style.color = '#9a8cff';
			msg.textContent = 'Saved.';
			if (data.user.username) {
				const url = `${location.origin}/u/${encodeURIComponent(data.user.username)}`;
				msg.innerHTML = `Saved. Your profile is at <a href="${attr(url)}" target="_blank" style="color:#9a8cff">${esc(url)}</a>`;
			}
		} catch (err) {
			msg.style.color = '#ffb3b3';
			msg.textContent = err.message;
		}
	});

	wrap.querySelector('#acct-copy')?.addEventListener('click', async () => {
		const btn = wrap.querySelector('#acct-copy');
		try {
			await navigator.clipboard.writeText(profileUrl);
			btn.textContent = 'Copied ✓';
			setTimeout(() => (btn.textContent = 'Copy'), 1800);
		} catch {}
	});
}

async function renderWidgets(root) {
	await hydrateWidgetPrefsFromRemote();
	const prefs = loadWidgetPrefs();
	root.innerHTML = `
		<div class="widgets-header">
			<div>
				<h1>Your widgets</h1>
				<p class="sub">Embeddable 3D experiences — each gets a stable URL.</p>
			</div>
			<a class="btn-primary" href="/studio">+ New widget</a>
		</div>
		<div class="widget-toolbar" role="toolbar" aria-label="Widget filters">
			<label class="sr-only" for="w-search">Search widgets</label>
			<input id="w-search" type="search" placeholder="Search by name…" value="${attr(prefs.q)}">
			<label class="sr-only" for="w-type">Filter by type</label>
			<select id="w-type" aria-label="Filter by widget type">
				<option value="">All types</option>
				${Object.entries(WIDGET_TYPE_META)
					.map(
						([t, m]) =>
							`<option value="${attr(t)}" ${prefs.type === t ? 'selected' : ''}>${esc(m.label)}</option>`,
					)
					.join('')}
			</select>
			<label class="sr-only" for="w-sort">Sort widgets</label>
			<select id="w-sort" aria-label="Sort widgets">
				<option value="updated" ${prefs.sort === 'updated' ? 'selected' : ''}>Recently updated</option>
				<option value="views"   ${prefs.sort === 'views' ? 'selected' : ''}>Most viewed</option>
				<option value="name"    ${prefs.sort === 'name' ? 'selected' : ''}>Name (A–Z)</option>
			</select>
			<span id="w-count" class="muted" aria-live="polite"></span>
		</div>
		<div id="widget-list" class="cards" aria-busy="true"><div class="muted">Loading…</div></div>
	`;

	const list = root.querySelector('#widget-list');
	const countEl = root.querySelector('#w-count');
	let widgets = [];

	try {
		const data = await api.listWidgets();
		widgets = data.widgets || [];
	} catch (e) {
		list.innerHTML = `<div class="err">${esc(e.message)}</div>`;
		list.setAttribute('aria-busy', 'false');
		return;
	}

	const observer = lazyIframeObserver();

	function rerender() {
		list.setAttribute('aria-busy', 'false');
		if (!widgets.length) {
			list.innerHTML = `
				<div class="empty" style="grid-column:1/-1">
					<p style="font-size:15px;color:#ccc;margin:0 0 8px">No widgets yet.</p>
					<p style="margin:0 0 18px">Your widgets are embeddable 3D experiences — pick an avatar, a type, and we handle the rest.</p>
					<a class="btn-primary" href="/studio">+ Create your first widget</a>
				</div>
			`;
			countEl.textContent = '';
			return;
		}
		const filtered = applyWidgetFilters(widgets, prefs);
		countEl.textContent =
			filtered.length === widgets.length
				? `${widgets.length} widget${widgets.length === 1 ? '' : 's'}`
				: `${filtered.length} of ${widgets.length}`;
		list.innerHTML = '';
		if (!filtered.length) {
			list.innerHTML = `<div class="empty" style="grid-column:1/-1">No widgets match the current filters.</div>`;
			return;
		}
		for (const w of filtered) {
			const card = widgetCard(w, {
				reload: rerender,
				mutate: (next) => mutateLocal(widgets, w.id, next),
				remove: () => {
					widgets = widgets.filter((x) => x.id !== w.id);
					rerender();
				},
			});
			list.appendChild(card);
			const ifr = card.querySelector('iframe[data-src]');
			if (ifr) observer.observe(ifr);
		}
	}

	root.querySelector('#w-search').addEventListener('input', (e) => {
		prefs.q = e.target.value;
		saveWidgetPrefs(prefs);
		rerender();
	});
	root.querySelector('#w-type').addEventListener('change', (e) => {
		prefs.type = e.target.value;
		saveWidgetPrefs(prefs);
		rerender();
	});
	root.querySelector('#w-sort').addEventListener('change', (e) => {
		prefs.sort = e.target.value;
		saveWidgetPrefs(prefs);
		rerender();
	});

	rerender();
}

function mutateLocal(arr, id, next) {
	const i = arr.findIndex((x) => x.id === id);
	if (i >= 0) arr[i] = { ...arr[i], ...next };
}

function applyWidgetFilters(widgets, prefs) {
	let out = widgets;
	if (prefs.type) out = out.filter((w) => w.type === prefs.type);
	if (prefs.q) {
		const q = prefs.q.trim().toLowerCase();
		if (q) out = out.filter((w) => (w.name || '').toLowerCase().includes(q));
	}
	out = [...out];
	if (prefs.sort === 'name') out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
	if (prefs.sort === 'views') out.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
	if (prefs.sort === 'updated' || !prefs.sort) {
		out.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
	}
	return out;
}

function widgetCard(w, ctx) {
	const meta = WIDGET_TYPE_META[w.type] || { label: w.type, color: '#888' };
	const card = document.createElement('div');
	card.className = 'widget-card card';
	card.dataset.id = w.id;

	const previewSrc = `/widget#widget=${encodeURIComponent(w.id)}&kiosk=true&preview=1`;
	const previewHtml = w.avatar
		? `<iframe data-src="${attr(previewSrc)}" loading="lazy" tabindex="-1" title="Preview of ${attr(w.name || 'widget')}"></iframe>`
		: `<div class="placeholder">Avatar unavailable.<br>Edit to pick a replacement.</div>`;

	card.innerHTML = `
		<div class="frame">${previewHtml}</div>
		<div class="title">
			<h3 title="Double-click to rename">${esc(w.name || 'Untitled')}</h3>
			<span class="pill"><span class="dot" style="background:${attr(meta.color)}"></span>${esc(meta.label)}</span>
		</div>
		<div class="row" style="justify-content:space-between; gap:8px">
			<span class="meta">${formatViewCount(w.view_count)} · updated ${timeAgo(w.updated_at)}</span>
			<label class="toggle" title="${w.is_public ? 'Public — anyone with the URL can view' : 'Private — only you can view'}">
				<input type="checkbox" data-public ${w.is_public ? 'checked' : ''}>
				<span class="track"></span>
				<span class="label">${w.is_public ? 'Public' : 'Private'}</span>
			</label>
		</div>
		<div class="actions">
			<a href="/studio?edit=${encodeURIComponent(w.id)}" data-edit>Edit</a>
			<button data-share type="button">Share</button>
			<button data-duplicate type="button">Duplicate</button>
			<button data-details type="button">Details</button>
			<button data-delete class="danger" type="button">Delete</button>
		</div>
	`;

	// Inline rename — double-click on the title swaps in an input.
	const titleEl = card.querySelector('.title h3');
	titleEl.addEventListener('dblclick', () => beginRename(card, w, ctx));

	// Public/private toggle — confirm before disabling so embeds aren't silently broken.
	const toggleInput = card.querySelector('input[data-public]');
	toggleInput.addEventListener('change', async () => {
		const next = toggleInput.checked;
		if (
			!next &&
			!confirm(
				'Making this widget private will break any existing embeds on other sites. Continue?',
			)
		) {
			toggleInput.checked = true;
			return;
		}
		try {
			await api.patchWidget(w.id, { is_public: next });
			ctx.mutate({ is_public: next });
			card.querySelector('.toggle .label').textContent = next ? 'Public' : 'Private';
			toast(next ? 'Now public' : 'Now private');
		} catch (err) {
			toggleInput.checked = !next;
			toast(err.message || 'Failed to update', true);
		}
	});

	card.querySelector('[data-share]').addEventListener('click', () => openShareModal(w));
	card.querySelector('[data-details]').addEventListener('click', () => openWidgetDrawer(w, ctx));
	card.querySelector('[data-duplicate]').addEventListener('click', async () => {
		try {
			await api.duplicateWidget(w.id);
			toast('Duplicated');
			// Re-fetch via navigate so the new row's avatar join is populated.
			navigate('widgets');
		} catch (err) {
			toast(err.message || 'Duplicate failed', true);
		}
	});
	card.querySelector('[data-delete]').addEventListener('click', async () => {
		if (!confirm(`Delete "${w.name || 'this widget'}"? This cannot be undone.`)) return;
		try {
			await api.deleteWidget(w.id);
			card.style.transition = 'opacity .2s';
			card.style.opacity = '0';
			setTimeout(() => ctx.remove(), 220);
			toast('Deleted');
		} catch (err) {
			toast(err.message || 'Delete failed', true);
		}
	});

	return card;
}

function beginRename(card, w, ctx) {
	const titleEl = card.querySelector('.title h3');
	if (!titleEl) return;
	const original = w.name || '';
	const input = document.createElement('input');
	input.type = 'text';
	input.value = original;
	input.maxLength = 120;
	input.setAttribute('aria-label', 'Widget name');
	titleEl.replaceWith(input);
	input.focus();
	input.select();

	let settled = false;
	const restore = (text) => {
		if (settled) return;
		settled = true;
		const h = document.createElement('h3');
		h.textContent = text;
		h.title = 'Double-click to rename';
		input.replaceWith(h);
		h.addEventListener('dblclick', () => beginRename(card, { ...w, name: text }, ctx));
	};

	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			commit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			restore(original);
		}
	});
	input.addEventListener('blur', commit);

	async function commit() {
		const next = input.value.trim();
		if (!next || next === original) {
			restore(original);
			return;
		}
		try {
			await api.patchWidget(w.id, { name: next });
			ctx.mutate({ name: next });
			restore(next);
			toast('Renamed');
		} catch (err) {
			restore(original);
			toast(err.message || 'Rename failed', true);
		}
	}
}

function lazyIframeObserver() {
	if (typeof IntersectionObserver === 'undefined') {
		// Fallback — eagerly hydrate. Old browsers shouldn't pay this a/b cost.
		return {
			observe(el) {
				hydrate(el);
			},
		};
	}
	const io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					hydrate(entry.target);
					io.unobserve(entry.target);
				}
			}
		},
		{ rootMargin: '120px' },
	);
	return io;
	function hydrate(el) {
		const src = el.getAttribute('data-src');
		if (src && !el.src) el.src = src;
	}
}

// ── Widget details drawer ───────────────────────────────────────────────────
async function openWidgetDrawer(w, ctx) {
	const overlay = document.createElement('div');
	overlay.className = 'drawer-overlay';
	const drawer = document.createElement('aside');
	drawer.className = 'drawer';
	drawer.setAttribute('role', 'dialog');
	drawer.setAttribute('aria-label', `Widget details — ${w.name || 'untitled'}`);
	drawer.tabIndex = -1;

	const previewSrc = `/widget#widget=${encodeURIComponent(w.id)}&kiosk=true&preview=1`;
	const pageUrl = `${location.origin}/w/${encodeURIComponent(w.id)}`;
	const iframeSnippet = makeIframeSnippet(w, pageUrl, 600, 600);
	const scriptSnippet = `<script async src="${location.origin}/embed.js" data-widget="${esc(w.id)}"></script>`;
	const meta = WIDGET_TYPE_META[w.type] || { label: w.type, color: '#888' };

	drawer.innerHTML = `
		<header>
			<h2>${esc(w.name || 'Untitled')}</h2>
			<button class="btn sec" data-close type="button" aria-label="Close details">Close</button>
		</header>
		<div class="body">
			<div class="frame-lg"><iframe src="${attr(previewSrc)}" title="Preview"></iframe></div>
			<div>
				<span class="pill"><span class="dot" style="background:${attr(meta.color)}"></span>${esc(meta.label)}</span>
				<span class="muted" style="margin-left:8px">${esc(w.is_public ? 'Public' : 'Private')} · updated ${timeAgo(w.updated_at)}</span>
			</div>
			<div id="stats-region" aria-live="polite"><div class="muted">Loading stats…</div></div>
			${
				w.type === 'talking-agent'
					? `
			<section id="transcripts-region" aria-label="Chat transcripts">
				<h3 style="margin:18px 0 6px; font-size:13px; text-transform:uppercase; letter-spacing:0.06em; color:#aaa">Chat transcripts</h3>
				<div id="transcripts-totals" class="muted" style="font-size:12px"></div>
				<div id="transcripts-list" style="display:flex; flex-direction:column; gap:6px; margin-top:8px"></div>
				<div id="transcripts-detail" hidden></div>
				<div id="knowledge-region" style="margin-top:14px">
					<h3 style="margin:0 0 6px; font-size:13px; text-transform:uppercase; letter-spacing:0.06em; color:#aaa">Knowledge</h3>
					<div id="knowledge-summary" class="muted" style="font-size:12px">Loading…</div>
				</div>
			</section>
			`
					: ''
			}
			<details>
				<summary>Embed code</summary>
				<div style="display:flex; flex-direction:column; gap:10px; margin-top:8px">
					<div>
						<div class="row" style="justify-content:space-between; margin-bottom:4px"><strong style="font-size:12px">Iframe</strong><button class="btn sec" data-copy="iframe" type="button">Copy</button></div>
						<pre id="snip-iframe" style="margin:0">${esc(iframeSnippet)}</pre>
					</div>
					<div>
						<div class="row" style="justify-content:space-between; margin-bottom:4px"><strong style="font-size:12px">One-line script</strong><button class="btn sec" data-copy="script" type="button">Copy</button></div>
						<pre id="snip-script" style="margin:0">${esc(scriptSnippet)}</pre>
					</div>
					<div>
						<div class="row" style="justify-content:space-between; margin-bottom:4px"><strong style="font-size:12px">Direct URL</strong><button class="btn sec" data-copy="url" type="button">Copy</button></div>
						<pre id="snip-url" style="margin:0">${esc(pageUrl)}</pre>
					</div>
				</div>
			</details>
			<details>
				<summary>Configuration (read-only)</summary>
				<pre style="margin:8px 0 0; max-height:220px">${esc(JSON.stringify(w.config || {}, null, 2))}</pre>
			</details>
			<div class="danger-zone">
				<h3>Danger zone</h3>
				<p class="muted" style="margin:0 0 10px; font-size:12px">Deleting removes the widget for everyone. Embeds will return 404.</p>
				<button class="btn-primary btn-danger" data-drawer-delete type="button">Delete this widget</button>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);
	document.body.appendChild(drawer);
	requestAnimationFrame(() => {
		overlay.classList.add('open');
		drawer.classList.add('open');
	});
	drawer.focus();

	const close = () => {
		overlay.classList.remove('open');
		drawer.classList.remove('open');
		setTimeout(() => {
			overlay.remove();
			drawer.remove();
			document.removeEventListener('keydown', onKey);
		}, 220);
	};
	const onKey = (e) => {
		if (e.key === 'Escape') close();
	};
	document.addEventListener('keydown', onKey);
	overlay.addEventListener('click', close);
	drawer.querySelector('[data-close]').addEventListener('click', close);

	for (const btn of drawer.querySelectorAll('[data-copy]')) {
		btn.addEventListener('click', async () => {
			const target = drawer.querySelector(`#snip-${btn.dataset.copy}`);
			if (target) await copyToClipboard(target.textContent, btn);
		});
	}

	drawer.querySelector('[data-drawer-delete]').addEventListener('click', async () => {
		if (!confirm(`Delete "${w.name || 'this widget'}"? This cannot be undone.`)) return;
		try {
			await api.deleteWidget(w.id);
			toast('Deleted');
			close();
			ctx?.remove?.();
		} catch (err) {
			toast(err.message || 'Delete failed', true);
		}
	});

	// Stats — load async, render sparkline.
	try {
		const { stats } = await api.widgetStats(w.id);
		drawer.querySelector('#stats-region').innerHTML = renderStatsPanel(w, stats);
	} catch (err) {
		drawer.querySelector('#stats-region').innerHTML =
			`<div class="err">${esc(err.message || 'Failed to load stats')}</div>`;
	}

	// Transcripts + knowledge — only for talking-agent widgets.
	if (w.type === 'talking-agent') {
		loadTranscripts(drawer, w);
		loadKnowledgeSummary(drawer, w);
	}
}

async function loadTranscripts(drawer, w) {
	const totalsEl = drawer.querySelector('#transcripts-totals');
	const listEl = drawer.querySelector('#transcripts-list');
	const detailEl = drawer.querySelector('#transcripts-detail');
	if (!totalsEl || !listEl || !detailEl) return;

	try {
		const data = await api.listTranscripts(w.id, { limit: 25 });
		const t = data.totals || {};
		totalsEl.textContent = `${formatNum(t.threads || 0)} threads · ${formatNum(t.messages || 0)} messages · ${formatNum(t.unique_visitors || 0)} unique visitors`;

		const threads = data.threads || [];
		if (!threads.length) {
			listEl.innerHTML =
				'<div class="muted" style="font-size:12px">No conversations yet — visitors will appear here as they chat.</div>';
			return;
		}

		listEl.innerHTML = threads.map((t) => renderThreadRow(t)).join('');
		for (const row of listEl.querySelectorAll('[data-thread]')) {
			row.addEventListener('click', () => openThread(drawer, w, row.dataset.thread));
		}
	} catch (err) {
		listEl.innerHTML = `<div class="err">${esc(err.message || 'Failed to load transcripts')}</div>`;
	}
}

function renderThreadRow(t) {
	const preview = (t.preview || '').slice(0, 120);
	const when = t.last_message_at ? timeAgo(t.last_message_at) : '';
	const where = t.referer_host ? esc(t.referer_host) : '(direct)';
	return `
		<button class="transcript-row" data-thread="${attr(t.id)}" type="button"
			style="all:unset; cursor:pointer; padding:8px 10px; border:1px solid var(--border); border-radius:8px; display:grid; grid-template-columns: 1fr auto; gap:8px; background:#0f0f17">
			<div style="min-width:0">
				<div style="font-size:12px; font-weight:600; color:#ccc">${esc(t.visitor_label || 'visitor')}<span class="muted" style="font-weight:400; margin-left:6px">· ${where}</span></div>
				<div class="muted" style="font-size:12px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(preview) || '(no message)'}</div>
			</div>
			<div class="muted" style="font-size:11px; align-self:center">${esc(when)}<br>${t.message_count || 0} msg</div>
		</button>
	`;
}

async function openThread(drawer, w, threadId) {
	const detailEl = drawer.querySelector('#transcripts-detail');
	if (!detailEl) return;
	detailEl.hidden = false;
	detailEl.innerHTML =
		'<div class="muted" style="font-size:12px; padding:8px">Loading thread…</div>';
	try {
		const data = await api.getTranscript(w.id, threadId);
		detailEl.innerHTML = `
			<div style="margin-top:10px; padding:10px; background:#0f0f17; border:1px solid var(--border); border-radius:8px">
				<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
					<strong style="font-size:12px">${esc(data.thread?.visitor_label || 'visitor')} · ${esc(data.thread?.referer_host || '(direct)')}</strong>
					<button class="btn sec" data-thread-close type="button" style="font-size:11px">Close</button>
				</div>
				<div style="display:flex; flex-direction:column; gap:6px; max-height:340px; overflow:auto">
					${(data.messages || []).map(renderMessage).join('') || '<div class="muted">No messages.</div>'}
				</div>
			</div>
		`;
		detailEl.querySelector('[data-thread-close]').addEventListener('click', () => {
			detailEl.hidden = true;
			detailEl.innerHTML = '';
		});
	} catch (err) {
		detailEl.innerHTML = `<div class="err">${esc(err.message || 'Failed to load thread')}</div>`;
	}
}

function renderMessage(m) {
	const isUser = m.role === 'user';
	const bg = isUser ? '#1a1a26' : 'rgba(139, 92, 246, 0.12)';
	const label = isUser ? 'visitor' : m.provider ? `agent · ${esc(m.provider)}` : 'agent';
	const flag = m.redacted
		? ' <span class="muted" style="font-size:10px">(pii redacted)</span>'
		: '';
	return `
		<div style="padding:8px 10px; background:${bg}; border-radius:6px">
			<div class="muted" style="font-size:10px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:3px">${label}${flag}</div>
			<div style="font-size:13px; white-space:pre-wrap; word-break:break-word">${esc(m.content || '')}</div>
		</div>
	`;
}

async function loadKnowledgeSummary(drawer, w) {
	const el = drawer.querySelector('#knowledge-summary');
	if (!el) return;
	try {
		const { docs = [] } = await api.listKnowledge(w.id);
		if (!docs.length) {
			el.innerHTML = `No knowledge attached. <a href="/studio?edit=${encodeURIComponent(w.id)}">Add some in Studio →</a>`;
			return;
		}
		const totalChunks = docs.reduce((s, d) => s + (d.chunk_count || 0), 0);
		el.innerHTML = `
			${docs.length} doc${docs.length === 1 ? '' : 's'} · ${formatNum(totalChunks)} chunks
			<a href="/studio?edit=${encodeURIComponent(w.id)}" style="margin-left:6px">Manage →</a>
			<ul style="margin:6px 0 0; padding-left:18px; font-size:12px; color:#aaa">
				${docs
					.slice(0, 5)
					.map(
						(d) =>
							`<li>${esc(d.title)} <span style="opacity:0.7">(${d.chunk_count || 0} chunks)</span></li>`,
					)
					.join('')}
			</ul>
		`;
	} catch (err) {
		el.textContent = `Couldn't load knowledge: ${err.message}`;
	}
}

function renderStatsPanel(w, stats) {
	const total7d = (stats.recent_views_7d || []).reduce((s, d) => s + (d.count || 0), 0);
	const chatLine =
		stats.chat_count !== null && stats.chat_count !== undefined
			? `<div class="stat"><div class="n">${formatNum(stats.chat_count)}</div><div class="l">Chats (lifetime)</div></div>`
			: '';
	const lastSeen = stats.last_viewed_at
		? `<div class="muted" style="margin-top:4px; font-size:12px">Last viewed ${timeAgo(stats.last_viewed_at)}</div>`
		: '';
	const referers = (stats.top_referers || []).slice(0, 3);
	const refList = referers.length
		? `<details><summary>Top referrers</summary><ul style="margin:6px 0 0; padding-left:18px; font-size:12px; color:#aaa">${referers.map((r) => `<li>${esc(r.host || '(direct)')} — ${formatNum(r.count)}</li>`).join('')}</ul></details>`
		: '';
	return `
		<div class="stat-grid">
			<div class="stat"><div class="n">${formatNum(stats.view_count)}</div><div class="l">Views (lifetime)</div></div>
			<div class="stat"><div class="n">${formatNum(total7d)}</div><div class="l">Views (7 days)</div></div>
			${chatLine}
		</div>
		${lastSeen}
		<div style="margin-top:14px">
			${sparkline(stats.recent_views_7d || [])}
		</div>
		${refList}
	`;
}

function sparkline(days) {
	if (!days.length) return '<div class="muted" style="font-size:12px">No views yet</div>';
	const W = 480,
		H = 60,
		P = 4;
	const max = Math.max(1, ...days.map((d) => d.count || 0));
	const stepX = (W - 2 * P) / Math.max(1, days.length - 1);
	const pts = days.map((d, i) => {
		const x = P + i * stepX;
		const y = H - P - ((d.count || 0) / max) * (H - 2 * P);
		return [x, y];
	});
	const linePath = pts
		.map((p, i) =>
			i === 0
				? `M${p[0].toFixed(1)},${p[1].toFixed(1)}`
				: `L${p[0].toFixed(1)},${p[1].toFixed(1)}`,
		)
		.join(' ');
	const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${H - P} L${pts[0][0].toFixed(1)},${H - P} Z`;
	const allZero = days.every((d) => !d.count);
	const labels = `${esc(days[0].day)} → ${esc(days[days.length - 1].day)}`;
	return `
		<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Views over the last 7 days, ${days.map((d) => `${d.day}: ${d.count}`).join(', ')}">
			<line class="axis" x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}"></line>
			${allZero ? '' : `<path class="area" d="${areaPath}"></path><path class="line" d="${linePath}"></path>`}
		</svg>
		<div class="muted" style="font-size:11px; display:flex; justify-content:space-between; padding:0 4px">
			<span>${labels}</span>
			<span>${allZero ? 'No views yet' : `peak ${max}`}</span>
		</div>
	`;
}

// ── Share modal ─────────────────────────────────────────────────────────────
function openShareModal(w) {
	const SIZES = [
		{ label: 'Small', width: 320, height: 320 },
		{ label: 'Medium', width: 600, height: 600 },
		{ label: 'Banner', width: 1200, height: 400 },
		{ label: 'Custom', width: 0, height: 0 },
	];
	let active = 1;
	let dim = { ...SIZES[active] };
	const pageUrl = `${location.origin}/w/${encodeURIComponent(w.id)}`;

	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	overlay.innerHTML = `
		<div class="modal" role="dialog" aria-label="Share widget">
			<h2>Share "${esc(w.name || 'widget')}"</h2>
			<p class="sub">Pick a size, copy the iframe, and you're done.</p>
			<div class="size-presets" role="tablist">
				${SIZES.map((s, i) => `<button type="button" data-i="${i}" class="${i === active ? 'active' : ''}" role="tab" aria-selected="${i === active}">${esc(s.label)}${s.width ? ` (${s.width}×${s.height})` : ''}</button>`).join('')}
			</div>
			<div class="size-inputs">
				<label class="muted" style="font-size:12px">W <input id="m-w" type="number" min="120" max="2000" value="${dim.width || 600}"></label>
				<label class="muted" style="font-size:12px">H <input id="m-h" type="number" min="120" max="2000" value="${dim.height || 600}"></label>
			</div>
			<div style="background:#0f0f17; border:1px solid var(--border); border-radius:10px; padding:12px; margin-bottom:12px">
				<div class="muted" style="font-size:11px; margin-bottom:8px">Live preview (scaled to fit)</div>
				<div id="m-preview" style="display:grid; place-items:center; min-height:200px; max-height:340px; overflow:hidden"></div>
			</div>
			<div>
				<div class="row" style="justify-content:space-between; margin-bottom:4px"><strong style="font-size:12px">Iframe</strong><button class="btn sec" id="m-copy" type="button">Copy</button></div>
				<pre id="m-snip" style="margin:0"></pre>
			</div>
			<div class="row" style="justify-content:space-between; margin-top:14px">
				<a class="muted" style="font-size:12px" href="mailto:abuse@three.ws?subject=Report+widget+${encodeURIComponent(w.id)}">Report this widget</a>
				<button class="btn sec" id="m-close" type="button">Close</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);
	requestAnimationFrame(() => overlay.classList.add('open'));

	const wInput = overlay.querySelector('#m-w');
	const hInput = overlay.querySelector('#m-h');
	const snipEl = overlay.querySelector('#m-snip');
	const previewEl = overlay.querySelector('#m-preview');

	function refresh() {
		const snippet = makeIframeSnippet(w, pageUrl, dim.width, dim.height);
		snipEl.textContent = snippet;
		// Live preview at scaled size — fit within 320×320 while preserving ratio.
		const maxW = 320,
			maxH = 320;
		const scale = Math.min(maxW / dim.width, maxH / dim.height, 1);
		previewEl.innerHTML = `<iframe src="/widget#widget=${encodeURIComponent(w.id)}&kiosk=true&preview=1" style="width:${dim.width}px; height:${dim.height}px; border:0; transform:scale(${scale}); transform-origin:center" title="Preview"></iframe>`;
		previewEl.style.width = `${dim.width * scale}px`;
		previewEl.style.height = `${dim.height * scale}px`;
	}
	function setPreset(i) {
		active = i;
		overlay.querySelectorAll('.size-presets button').forEach((b, j) => {
			b.classList.toggle('active', i === j);
			b.setAttribute('aria-selected', i === j ? 'true' : 'false');
		});
		if (SIZES[i].width) {
			dim = { width: SIZES[i].width, height: SIZES[i].height };
			wInput.value = dim.width;
			hInput.value = dim.height;
		}
		refresh();
	}
	overlay.querySelectorAll('.size-presets button').forEach((b) => {
		b.addEventListener('click', () => setPreset(Number(b.dataset.i)));
	});
	const onDimChange = () => {
		dim = {
			width: clampInt(wInput.value, 120, 2000, 600),
			height: clampInt(hInput.value, 120, 2000, 600),
		};
		// Switch to "Custom" preset when typing.
		setPresetSilent(SIZES.length - 1);
		refresh();
	};
	function setPresetSilent(i) {
		active = i;
		overlay.querySelectorAll('.size-presets button').forEach((b, j) => {
			b.classList.toggle('active', i === j);
			b.setAttribute('aria-selected', i === j ? 'true' : 'false');
		});
	}
	wInput.addEventListener('input', onDimChange);
	hInput.addEventListener('input', onDimChange);

	const close = () => {
		overlay.classList.remove('open');
		setTimeout(() => {
			overlay.remove();
			document.removeEventListener('keydown', onKey);
		}, 200);
	};
	const onKey = (e) => {
		if (e.key === 'Escape') close();
	};
	document.addEventListener('keydown', onKey);
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});
	overlay.querySelector('#m-close').addEventListener('click', close);
	overlay
		.querySelector('#m-copy')
		.addEventListener('click', (e) => copyToClipboard(snipEl.textContent, e.currentTarget));

	refresh();
}

function clampInt(v, lo, hi, fallback) {
	const n = parseInt(v, 10);
	if (Number.isNaN(n)) return fallback;
	return Math.max(lo, Math.min(hi, n));
}

function makeIframeSnippet(w, pageUrl, width, height) {
	const title = (w.name || 'Widget').replace(/"/g, '&quot;');
	return `<iframe src="${pageUrl}" width="${width}" height="${height}" style="border:0;border-radius:12px;max-width:100%" allow="autoplay; xr-spatial-tracking; clipboard-write" title="${title}" loading="lazy"></iframe>`;
}

// ── Avatar embed modal ──────────────────────────────────────────────────────
// Builds a copy-paste <iframe> for /a-embed.html?avatar=<id> with size presets,
// background choice, and live preview. Mirrors openShareModal() for parity.
function openAvatarEmbedModal(avatar) {
	const SIZES = [
		{ label: 'Square', width: 480, height: 480 },
		{ label: 'Portrait', width: 360, height: 540 },
		{ label: 'Banner', width: 1200, height: 400 },
		{ label: 'Custom', width: 0, height: 0 },
	];
	let active = 0;
	let dim = { ...SIZES[active] };
	const opts = { bg: 'transparent', name: true, openLink: true };

	const buildEmbedUrl = () => {
		const u = new URL('/a-embed.html', location.origin);
		u.searchParams.set('avatar', avatar.id);
		if (opts.bg !== 'transparent') u.searchParams.set('bg', opts.bg);
		if (!opts.name) u.searchParams.set('name', '0');
		if (!opts.openLink) u.searchParams.set('open-link', '0');
		return u.toString();
	};

	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	overlay.innerHTML = `
		<div class="modal" role="dialog" aria-label="Embed avatar">
			<div class="modal-header">
				<div>
					<h2>Embed "${esc(avatar.name || 'avatar')}"</h2>
					<p class="sub" style="margin:0 0 18px">Drop this iframe into any site to render the avatar inline.</p>
				</div>
				<button class="modal-close-x" id="a-em-close-x" aria-label="Close">&times;</button>
			</div>
			<div class="section-label">Size</div>
			<div class="size-presets" role="tablist">
				${SIZES.map((s, i) => `<button type="button" data-i="${i}" class="${i === active ? 'active' : ''}" role="tab" aria-selected="${i === active}">${esc(s.label)}${s.width ? ` (${s.width}×${s.height})` : ''}</button>`).join('')}
			</div>
			<div class="size-inputs">
				<label class="muted" style="font-size:12px">W <input id="a-em-w" type="number" min="120" max="2000" value="${dim.width}"></label>
				<label class="muted" style="font-size:12px">H <input id="a-em-h" type="number" min="120" max="2000" value="${dim.height}"></label>
			</div>
			<div class="section-label">Background</div>
			<div class="size-presets" style="margin-bottom:14px" role="tablist" aria-label="Background">
				<button type="button" data-bg="transparent" class="active">Transparent</button>
				<button type="button" data-bg="dark">Dark</button>
				<button type="button" data-bg="light">Light</button>
			</div>
			<div class="row" style="gap:14px; flex-wrap:wrap; margin-bottom:14px; font-size:12px; color:#bbb">
				<label class="row" style="gap:6px"><input type="checkbox" id="a-em-name" checked> Name plate</label>
				<label class="row" style="gap:6px"><input type="checkbox" id="a-em-link" checked> "Open ↗" link</label>
			</div>
			<div class="preview-wrap">
				<div class="muted" style="font-size:11px; margin-bottom:8px">Live preview (scaled to fit)</div>
				<div id="a-em-preview" class="preview-frame-wrap"></div>
			</div>
			<div>
				<div class="row" style="justify-content:space-between; margin-bottom:4px"><strong style="font-size:12px">Iframe</strong><button class="btn sec" id="a-em-copy" type="button">Copy</button></div>
				<pre id="a-em-snip" style="margin:0"></pre>
			</div>
			<div class="row" style="justify-content:space-between; margin-top:14px">
				<a class="muted" style="font-size:12px" href="/avatars/${encodeURIComponent(avatar.id)}" target="_blank" rel="noopener">Open public page ↗</a>
				<button class="btn sec" id="a-em-close" type="button">Close</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);
	requestAnimationFrame(() => overlay.classList.add('open'));

	const wInput = overlay.querySelector('#a-em-w');
	const hInput = overlay.querySelector('#a-em-h');
	const snipEl = overlay.querySelector('#a-em-snip');
	const previewEl = overlay.querySelector('#a-em-preview');
	const sizeBtns = overlay.querySelectorAll('.size-presets [data-i]');
	const bgBtns = overlay.querySelectorAll('.size-presets [data-bg]');

	const safeName = (avatar.name || 'avatar').replace(/"/g, '&quot;');
	const refresh = () => {
		const url = buildEmbedUrl();
		snipEl.textContent = `<iframe src="${url}" width="${dim.width}" height="${dim.height}" style="border:0;border-radius:12px;max-width:100%" allow="xr-spatial-tracking" title="${safeName}" loading="lazy"></iframe>`;
		const maxW = 480;
		const maxH = 300;
		const scale = Math.min(maxW / dim.width, maxH / dim.height, 1);
		const pw = Math.round(dim.width * scale);
		const ph = Math.round(dim.height * scale);
		previewEl.classList.toggle('preview-checkered', opts.bg === 'transparent');
		previewEl.style.width = `${pw}px`;
		previewEl.style.height = `${ph}px`;
		previewEl.innerHTML = `<iframe src="${attr(url)}" style="width:${dim.width}px; height:${dim.height}px; border:0; transform:scale(${scale}); transform-origin:top left; display:block" title="Preview" allow="xr-spatial-tracking"></iframe>`;
	};
	const setPreset = (i) => {
		active = i;
		sizeBtns.forEach((b, j) => {
			b.classList.toggle('active', i === j);
			b.setAttribute('aria-selected', i === j ? 'true' : 'false');
		});
		if (SIZES[i].width) {
			dim = { width: SIZES[i].width, height: SIZES[i].height };
			wInput.value = dim.width;
			hInput.value = dim.height;
		}
		refresh();
	};
	sizeBtns.forEach((b) => b.addEventListener('click', () => setPreset(Number(b.dataset.i))));
	bgBtns.forEach((b) =>
		b.addEventListener('click', () => {
			opts.bg = b.dataset.bg;
			bgBtns.forEach((x) => x.classList.toggle('active', x === b));
			refresh();
		}),
	);
	const onDimChange = () => {
		dim = {
			width: clampInt(wInput.value, 120, 2000, 480),
			height: clampInt(hInput.value, 120, 2000, 480),
		};
		active = SIZES.length - 1;
		sizeBtns.forEach((b, j) => {
			b.classList.toggle('active', j === active);
			b.setAttribute('aria-selected', j === active ? 'true' : 'false');
		});
		refresh();
	};
	wInput.addEventListener('input', onDimChange);
	hInput.addEventListener('input', onDimChange);
	overlay.querySelector('#a-em-name').addEventListener('change', (e) => {
		opts.name = e.target.checked;
		refresh();
	});
	overlay.querySelector('#a-em-link').addEventListener('change', (e) => {
		opts.openLink = e.target.checked;
		refresh();
	});

	const close = () => {
		overlay.classList.remove('open');
		setTimeout(() => {
			overlay.remove();
			document.removeEventListener('keydown', onKey);
		}, 200);
	};
	const onKey = (e) => {
		if (e.key === 'Escape') close();
	};
	document.addEventListener('keydown', onKey);
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});
	overlay.querySelector('#a-em-close').addEventListener('click', close);
	overlay.querySelector('#a-em-close-x').addEventListener('click', close);
	overlay
		.querySelector('#a-em-copy')
		.addEventListener('click', (e) => copyToClipboard(snipEl.textContent, e.currentTarget));

	refresh();
}

// ── Agent embed modal ──────────────────────────────────────────────────────
// Reuses the avatar embed flow against the agent's linked avatar. Requires
// avatar_id; callers gate the button when no avatar is linked.
function openAgentEmbedModal(agent) {
	if (!agent?.avatar_id) {
		toast('Link an avatar to the agent first', true);
		return;
	}
	openAvatarEmbedModal({
		id: agent.avatar_id,
		name: agent.name || 'Agent',
	});
}

// ── QR modal ────────────────────────────────────────────────────────────────
// Renders a scannable QR code for a URL. Uses the qrcode library via esm.sh,
// matching the existing pattern in src/marketplace.js and dashboard/portfolio.html.
async function openQrModal(url, title) {
	const overlay = document.createElement('div');
	overlay.className = 'modal-overlay';
	overlay.innerHTML = `
		<div class="modal" role="dialog" aria-label="QR code" style="width:min(380px,calc(100vw - 32px))">
			<h2>${esc(title || 'Share')}</h2>
			<p class="sub" style="margin:0 0 16px">Scan to open on another device.</p>
			<div id="qr-host" style="display:grid;place-items:center;padding:14px;background:#fff;border-radius:10px;margin-bottom:14px;min-height:240px">
				<div class="muted" style="color:#666">Generating…</div>
			</div>
			<div style="background:#0f0f17;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:11px;word-break:break-all;color:#bbb;margin-bottom:14px">${esc(url)}</div>
			<div class="row" style="justify-content:space-between;gap:8px">
				<button class="btn sec" id="qr-copy" type="button">Copy URL</button>
				<button class="btn sec" id="qr-close" type="button">Close</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);
	requestAnimationFrame(() => overlay.classList.add('open'));

	const close = () => {
		overlay.classList.remove('open');
		setTimeout(() => {
			overlay.remove();
			document.removeEventListener('keydown', onKey);
		}, 200);
	};
	const onKey = (e) => {
		if (e.key === 'Escape') close();
	};
	document.addEventListener('keydown', onKey);
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});
	overlay.querySelector('#qr-close').addEventListener('click', close);
	overlay
		.querySelector('#qr-copy')
		.addEventListener('click', (e) => copyToClipboard(url, e.currentTarget));

	const host = overlay.querySelector('#qr-host');
	try {
		const mod = await import('https://esm.sh/qrcode@1.5.3');
		const QRCode = mod.default || mod;
		const canvas = document.createElement('canvas');
		await QRCode.toCanvas(canvas, url, {
			width: 240,
			margin: 1,
			color: { dark: '#000000', light: '#ffffff' },
		});
		host.innerHTML = '';
		host.appendChild(canvas);
	} catch (err) {
		host.innerHTML = `<div style="color:#a33;font-size:12px">QR generation failed: ${esc(err.message || 'error')}</div>`;
	}
}

// ── Dropdown "More ▾" menu ──────────────────────────────────────────────────
// Anchors a small menu to the trigger button. Each item is { label, run, danger? }.
// One menu open at a time; closes on outside click, Escape, or item click.
let _openMoreMenu = null;
function openMoreMenu(triggerBtn, items) {
	closeMoreMenu();
	if (!items?.length) return;

	const menu = document.createElement('div');
	menu.className = 'more-menu';
	menu.setAttribute('role', 'menu');
	items.forEach((item, i) => {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.setAttribute('role', 'menuitem');
		btn.className = 'more-menu-item' + (item.danger ? ' danger' : '');
		btn.textContent = item.label;
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			closeMoreMenu();
			try {
				item.run();
			} catch (err) {
				toast(err.message || 'Action failed', true);
			}
		});
		menu.appendChild(btn);
		if (i === 0) requestAnimationFrame(() => btn.focus());
	});

	document.body.appendChild(menu);
	const rect = triggerBtn.getBoundingClientRect();
	const menuRect = menu.getBoundingClientRect();
	let left = rect.right - menuRect.width;
	if (left < 8) left = 8;
	let top = rect.bottom + 4;
	if (top + menuRect.height > window.innerHeight - 8) {
		top = rect.top - menuRect.height - 4;
	}
	menu.style.left = `${Math.round(left + window.scrollX)}px`;
	menu.style.top = `${Math.round(top + window.scrollY)}px`;

	triggerBtn.setAttribute('aria-expanded', 'true');

	const onDocClick = (e) => {
		if (menu.contains(e.target)) return;
		if (triggerBtn.contains(e.target)) return;
		closeMoreMenu();
	};
	const onKey = (e) => {
		if (e.key === 'Escape') closeMoreMenu();
	};
	const onScroll = () => closeMoreMenu();
	document.addEventListener('click', onDocClick, { capture: true });
	document.addEventListener('keydown', onKey);
	window.addEventListener('scroll', onScroll, { capture: true, passive: true });
	window.addEventListener('resize', onScroll);

	_openMoreMenu = {
		menu,
		triggerBtn,
		cleanup: () => {
			document.removeEventListener('click', onDocClick, { capture: true });
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('scroll', onScroll, { capture: true });
			window.removeEventListener('resize', onScroll);
		},
	};
}

function closeMoreMenu() {
	if (!_openMoreMenu) return;
	const { menu, triggerBtn, cleanup } = _openMoreMenu;
	_openMoreMenu = null;
	triggerBtn.setAttribute('aria-expanded', 'false');
	cleanup();
	menu.remove();
}

// ── shared widget UI helpers ────────────────────────────────────────────────
async function copyToClipboard(text, btn) {
	try {
		await navigator.clipboard.writeText(text);
		toast('Copied to clipboard');
		if (btn) {
			const orig = btn.textContent;
			btn.textContent = 'Copied';
			setTimeout(() => {
				btn.textContent = orig;
			}, 1100);
		}
	} catch {
		toast('Copy failed — select and ⌘C manually', true);
	}
}

let _toastTimer;
function toast(message, isError = false) {
	const existing = document.querySelector('.toast');
	if (existing) existing.remove();
	clearTimeout(_toastTimer);
	const el = document.createElement('div');
	el.className = 'toast';
	if (isError) {
		el.style.color = '#ffb3b3';
		el.style.borderColor = 'rgba(255,92,92,.4)';
	}
	el.setAttribute('role', isError ? 'alert' : 'status');
	el.textContent = message;
	document.body.appendChild(el);
	_toastTimer = setTimeout(() => {
		el.style.opacity = '0';
		el.style.transition = 'opacity .25s';
		setTimeout(() => el.remove(), 260);
	}, 2200);
}

function toastUndo(message, onUndo, durationMs = 5000) {
	const existing = document.querySelector('.toast');
	if (existing) existing.remove();
	clearTimeout(_toastTimer);
	const el = document.createElement('div');
	el.className = 'toast toast-undo';
	el.setAttribute('role', 'status');
	const text = document.createElement('span');
	text.textContent = message;
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'toast-undo-btn';
	btn.textContent = 'Undo';
	let undone = false;
	btn.addEventListener('click', () => {
		if (undone) return;
		undone = true;
		clearTimeout(_toastTimer);
		try {
			onUndo();
		} finally {
			el.remove();
		}
	});
	el.appendChild(text);
	el.appendChild(btn);
	document.body.appendChild(el);
	_toastTimer = setTimeout(() => {
		if (undone) return;
		el.style.opacity = '0';
		el.style.transition = 'opacity .25s';
		setTimeout(() => el.remove(), 260);
	}, durationMs);
}

function timeAgo(ts) {
	if (!ts) return 'never';
	const then = new Date(ts).getTime();
	const now = Date.now();
	const sec = Math.max(1, Math.round((now - then) / 1000));
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mo = Math.round(day / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.round(mo / 12)}y ago`;
}

function formatNum(n) {
	const v = Number(n || 0);
	if (v < 1000) return String(v);
	if (v < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
	if (v < 1_000_000) return Math.round(v / 1000) + 'k';
	return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function formatViewCount(n) {
	const v = Number(n || 0);
	if (v === 0) return 'No views';
	if (v === 1) return '1 view';
	return `${formatNum(v)} views`;
}

// ── Animations ───────────────────────────────────────────────────────────────
async function renderAnimations(root) {
	root.innerHTML = `
		<div class="toolbar">
			<div>
				<h1>Animations</h1>
				<p class="sub">Manage animation clips attached to your agent. Changes sync to the viewer automatically.</p>
			</div>
		</div>
		<div id="anim-body"><div class="muted">Loading…</div></div>
	`;
	const body = root.querySelector('#anim-body');

	let agent, avatarUrl;
	try {
		const res = await api.getAgentMe();
		agent = res?.agent;
		if (!agent) {
			body.innerHTML = `<div class="empty">No agent found. <a href="/dashboard/create">Create one first.</a></div>`;
			return;
		}
		if (agent.avatar_id) {
			try {
				const av = await api.getAvatar(agent.avatar_id);
				avatarUrl = av?.avatar?.url || av?.avatar?.model_url;
			} catch {
				/* no avatar URL */
			}
		}
	} catch (e) {
		body.innerHTML = `<div class="err">${esc(e.message)}</div>`;
		return;
	}

	let animations = Array.isArray(agent.meta?.animations) ? [...agent.meta.animations] : [];
	let presets = [];
	let presetsError = null;
	try {
		const r = await fetch('/animations/presets.json');
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		presets = await r.json();
	} catch (e) {
		presetsError = e.message || 'Could not load presets';
	}

	let saveTimer;
	const statusEl = document.createElement('p');
	statusEl.className = 'muted';
	statusEl.style.cssText = 'margin:4px 0 0;font-size:12px;min-height:18px;';

	let saveSeq = 0;
	let clearTimer;
	function debounceSync() {
		clearTimeout(saveTimer);
		clearTimeout(clearTimer);
		saveTimer = setTimeout(async () => {
			const seq = ++saveSeq;
			statusEl.style.color = '#888';
			statusEl.textContent = 'Saving…';
			try {
				await api.patchAgentAnimations(agent.id, animations);
				if (seq !== saveSeq) return;
				statusEl.style.color = '#9a8cff';
				statusEl.textContent = 'Saved.';
				clearTimer = setTimeout(() => {
					if (seq === saveSeq && statusEl.textContent === 'Saved.')
						statusEl.textContent = '';
				}, 2000);
			} catch (err) {
				if (seq !== saveSeq) return;
				statusEl.style.color = '#ffb3b3';
				statusEl.textContent = err.message || 'Save failed.';
			}
		}, 500);
	}

	function isAttached(name) {
		return animations.some((a) => a.name.toLowerCase() === name.toLowerCase());
	}

	function nameTaken(name, except) {
		const lower = name.toLowerCase();
		return animations.some((a) => a !== except && a.name.toLowerCase() === lower);
	}

	let listEl, presetGridEl;

	function renderClipList() {
		listEl.innerHTML = '';
		if (!animations.length) {
			listEl.innerHTML =
				'<div class="muted" style="padding:12px 0">No clips attached yet.</div>';
			return;
		}
		for (const clip of animations) {
			const row = document.createElement('div');
			row.className = 'clip-row';
			row.innerHTML = `
				<span class="clip-name">${esc(clip.name)}</span>
				<span class="clip-source">${esc(clip.source || 'custom')}</span>
				<label class="loop-toggle" title="Toggle loop">
					<input type="checkbox" ${clip.loop !== false ? 'checked' : ''}>
					<span>Loop</span>
				</label>
				<div class="clip-actions">
					<button class="preview-btn">Preview</button>
					<button class="danger detach-btn">Remove</button>
				</div>
			`;
			row.querySelector('.loop-toggle input').addEventListener('change', (e) => {
				clip.loop = e.target.checked;
				debounceSync();
			});
			row.querySelector('.detach-btn').addEventListener('click', () => {
				const idx = animations.indexOf(clip);
				if (idx === -1) return;
				animations.splice(idx, 1);
				renderClipList();
				renderPresetGrid();
				debounceSync();
				toastUndo(`Removed "${clip.name}"`, () => {
					animations.splice(idx, 0, clip);
					renderClipList();
					renderPresetGrid();
					debounceSync();
				});
			});
			row.querySelector('.preview-btn').addEventListener('click', () =>
				openAnimPreview(clip, avatarUrl),
			);
			listEl.appendChild(row);
		}
	}

	function renderPresetGrid() {
		if (!presetGridEl) return;
		presetGridEl.innerHTML = '';
		for (const p of presets) {
			const tile = document.createElement('div');
			const attached = isAttached(p.name);
			tile.className = 'preset-tile' + (attached ? ' attached' : '');
			tile.innerHTML = `<div class="icon">${esc(p.icon || '🎬')}</div><div class="label">${esc(p.label || p.name)}</div>`;
			tile.title = attached ? 'Already attached' : `Add "${p.name}"`;
			tile.addEventListener('click', () => {
				if (isAttached(p.name)) {
					toast('Already attached');
					return;
				}
				animations.push({
					name: p.name,
					url: p.url,
					loop: p.loop !== false,
					clipName: p.clipName || undefined,
					source: 'preset',
					addedAt: new Date().toISOString(),
				});
				renderClipList();
				renderPresetGrid();
				debounceSync();
			});
			presetGridEl.appendChild(tile);
		}
	}

	function addAllPresets() {
		let added = 0;
		for (const p of presets) {
			if (isAttached(p.name)) continue;
			animations.push({
				name: p.name,
				url: p.url,
				loop: p.loop !== false,
				clipName: p.clipName || undefined,
				source: 'preset',
				addedAt: new Date().toISOString(),
			});
			added++;
		}
		if (!added) {
			toast('All presets already attached');
			return;
		}
		renderClipList();
		renderPresetGrid();
		debounceSync();
		toast(`Added ${added} preset${added === 1 ? '' : 's'}`);
	}

	body.innerHTML = '';

	if (agent.is_registered) {
		const warn = document.createElement('div');
		warn.className = 'anim-notice';
		warn.innerHTML = `<strong>On-chain notice:</strong> Your agent has an ERC-8004 registration. Animation changes aren't visible on-chain until you re-pin the manifest. <button class="btn sec" id="anim-repin-btn" style="margin-left:8px;font-size:11px;padding:4px 10px;" title="Pin a new manifest with the current animations and call setAgentURI()">Re-pin manifest</button><div id="anim-repin-log" class="muted" style="font-size:12px;margin-top:6px;white-space:pre-wrap"></div>`;
		body.appendChild(warn);

		warn.querySelector('#anim-repin-btn').addEventListener('click', () =>
			rePinAgentManifest({ agent, animations, logEl: warn.querySelector('#anim-repin-log') }),
		);
	}

	const cols = document.createElement('div');
	cols.className = 'anim-cols';

	const leftCol = document.createElement('div');
	const lh = document.createElement('h3');
	lh.textContent = 'Attached clips';
	leftCol.appendChild(lh);
	listEl = document.createElement('div');
	leftCol.appendChild(listEl);
	leftCol.appendChild(statusEl);

	const rightCol = document.createElement('div');
	const rh = document.createElement('h3');
	rh.textContent = 'Add clips';
	rightCol.appendChild(rh);

	if (presets.length) {
		const presetsHeader = document.createElement('div');
		presetsHeader.className = 'presets-header';
		const pl = document.createElement('p');
		pl.className = 'muted';
		pl.style.margin = '0';
		pl.textContent = 'Presets';
		const addAllBtn = document.createElement('button');
		addAllBtn.className = 'btn sec add-all-btn';
		addAllBtn.textContent = 'Add all';
		addAllBtn.addEventListener('click', addAllPresets);
		presetsHeader.appendChild(pl);
		presetsHeader.appendChild(addAllBtn);
		rightCol.appendChild(presetsHeader);
		presetGridEl = document.createElement('div');
		presetGridEl.className = 'preset-grid';
		rightCol.appendChild(presetGridEl);
	} else if (presetsError) {
		const pe = document.createElement('div');
		pe.className = 'anim-inline-err';
		pe.style.marginBottom = '12px';
		pe.textContent = `Couldn’t load presets (${presetsError}).`;
		rightCol.appendChild(pe);
	}

	const uploadDiv = document.createElement('div');
	uploadDiv.innerHTML = `
		<p class="muted" style="margin:16px 0 8px">Upload custom .glb</p>
		<div class="anim-upload">
			<label style="display:block">Name <input id="anim-name" type="text" placeholder="e.g. my-wave" maxlength="60" style="width:100%;margin-top:4px"></label>
			<label style="display:block;margin-top:8px">File <input id="anim-file" type="file" accept=".glb,model/gltf-binary" style="width:100%;margin-top:4px"></label>
			<div id="anim-progress" class="muted" style="font-size:12px;min-height:18px;margin-top:4px"></div>
			<button class="btn" id="anim-upload-btn" style="align-self:flex-start;margin-top:6px">Upload &amp; attach</button>
			<div id="anim-err" class="anim-inline-err"></div>
		</div>
	`;
	rightCol.appendChild(uploadDiv);
	cols.appendChild(leftCol);
	cols.appendChild(rightCol);
	body.appendChild(cols);

	renderClipList();
	renderPresetGrid();

	const uploadBtn = body.querySelector('#anim-upload-btn');
	const uploadProgress = body.querySelector('#anim-progress');
	const uploadErr = body.querySelector('#anim-err');
	uploadBtn.addEventListener('click', async () => {
		const nameEl = body.querySelector('#anim-name');
		const fileEl = body.querySelector('#anim-file');
		const name = nameEl.value.trim();
		const file = fileEl.files?.[0];
		uploadErr.textContent = '';
		if (!name) {
			uploadErr.textContent = 'Name is required.';
			return;
		}
		if (name.length > 60) {
			uploadErr.textContent = 'Name too long (max 60 chars).';
			return;
		}
		if (isAttached(name)) {
			uploadErr.textContent = `"${name}" is already attached.`;
			return;
		}
		if (!file) {
			uploadErr.textContent = 'Select a .glb file.';
			return;
		}
		uploadBtn.disabled = true;
		uploadProgress.textContent = 'Requesting upload URL…';
		try {
			const slug =
				name
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/^-|-$/g, '') || 'anim';
			const { upload_url, storage_key } = await api.presignAnimation({
				size_bytes: file.size,
				content_type: 'model/gltf-binary',
				slug,
			});
			uploadProgress.textContent = `Uploading ${fmtSize(file.size)}…`;
			await _uploadXHR(upload_url, file, (pct) => {
				uploadProgress.textContent = `Uploading ${pct}%…`;
			});
			animations.push({
				name,
				url: storage_key,
				loop: true,
				source: 'custom',
				addedAt: new Date().toISOString(),
			});
			renderClipList();
			renderPresetGrid();
			debounceSync();
			uploadProgress.textContent = 'Uploaded and attached.';
			nameEl.value = '';
			fileEl.value = '';
		} catch (err) {
			uploadErr.textContent = err.message || 'Upload failed.';
			uploadProgress.textContent = '';
		} finally {
			uploadBtn.disabled = false;
		}
	});
}

function _uploadXHR(url, file, onProgress) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url);
		xhr.setRequestHeader('content-type', 'model/gltf-binary');
		xhr.upload.onprogress = (e) =>
			e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
		xhr.onload = () =>
			xhr.status >= 200 && xhr.status < 300
				? resolve()
				: reject(new Error(`Upload failed (${xhr.status})`));
		xhr.onerror = () => reject(new Error('Network error'));
		xhr.send(file);
	});
}

let _animPreviewEl = null;

async function _ensureAgent3DLib() {
	if (customElements.get('agent-3d')) return true;
	const candidates = ['/agent-3d/latest/agent-3d.js', '/dist-lib/agent-3d.js'];
	for (const url of candidates) {
		try {
			await import(/* @vite-ignore */ url);
			if (customElements.get('agent-3d')) return true;
		} catch {
			/* try next candidate */
		}
	}
	return false;
}

async function openAnimPreview(clip, avatarUrl) {
	if (!avatarUrl) {
		toast('No avatar URL available for preview', true);
		return;
	}

	let overlay = document.getElementById('anim-preview-overlay');
	if (!overlay) {
		overlay = document.createElement('div');
		overlay.id = 'anim-preview-overlay';
		overlay.className = 'modal-overlay';
		overlay.innerHTML = `
			<div class="modal" style="width:min(400px,calc(100vw - 32px));padding:18px">
				<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
					<h2 id="ap-title" style="margin:0;font-size:16px"></h2>
					<button id="ap-close" class="btn sec" style="padding:4px 10px">✕</button>
				</div>
				<div class="preview-stage" id="ap-stage"></div>
				<p id="ap-status" class="muted" style="margin:8px 0 0;font-size:12px">Loading…</p>
			</div>
		`;
		document.body.appendChild(overlay);
		overlay.querySelector('#ap-close').addEventListener('click', closeAnimPreview);
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) closeAnimPreview();
		});
	}

	closeAnimPreview();
	overlay.classList.add('open');
	overlay.querySelector('#ap-title').textContent = `Preview: "${clip.name}"`;
	const stage = overlay.querySelector('#ap-stage');
	const status = overlay.querySelector('#ap-status');
	stage.innerHTML = '';
	status.textContent = 'Loading library…';

	const ok = await _ensureAgent3DLib();
	if (!ok) {
		status.textContent = 'Could not load 3D viewer.';
		return;
	}

	const el = document.createElement('agent-3d');
	el.setAttribute('body', avatarUrl);
	el.setAttribute('kiosk', '');
	el.setAttribute('eager', '');
	el.style.cssText = 'width:100%;height:100%;display:block';
	stage.appendChild(el);
	_animPreviewEl = el;

	status.textContent = 'Loading avatar…';
	try {
		await new Promise((resolve, reject) => {
			const onReady = () => {
				el.removeEventListener('agent:ready', onReady);
				el.removeEventListener('agent:error', onErr);
				resolve();
			};
			const onErr = (e) => {
				el.removeEventListener('agent:ready', onReady);
				el.removeEventListener('agent:error', onErr);
				reject(new Error(e.detail?.error?.message || 'load failed'));
			};
			el.addEventListener('agent:ready', onReady);
			el.addEventListener('agent:error', onErr);
		});
	} catch (e) {
		status.textContent = `Error: ${e.message}`;
		return;
	}

	let hasBones = false;
	el._scene?.content?.traverse?.((n) => {
		if (n.isBone) hasBones = true;
	});
	if (!hasBones) {
		status.textContent = 'This avatar has no skeleton — clips cannot be previewed.';
		return;
	}

	status.textContent = `Loading clip "${clip.name}"…`;
	try {
		const gltf = await el._scene.loadGLB(clip.url);
		const clips = gltf?.animations || [];
		const target = clip.clipName
			? clips.find((c) => c.name === clip.clipName) || clips[0]
			: clips[0];
		if (!target) {
			status.textContent = 'No animation found in clip file.';
			return;
		}
		await el._scene.play(target, { blend: 0.35 });
		status.textContent = `Playing "${clip.name}"`;
	} catch (e) {
		status.textContent = `Preview error: ${e.message}`;
	}
}

function closeAnimPreview() {
	if (_animPreviewEl) {
		try {
			_animPreviewEl.destroy?.();
		} catch {}
		try {
			_animPreviewEl.remove();
		} catch {}
		_animPreviewEl = null;
	}
	const stage = document.getElementById('ap-stage');
	if (stage) stage.innerHTML = '';
	const overlay = document.getElementById('anim-preview-overlay');
	if (overlay) overlay.classList.remove('open');
}

// ── utils ───────────────────────────────────────────────────────────────────
function fmtSize(b) {
	if (b < 1024) return b + ' B';
	if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
	return (b / 1024 / 1024).toFixed(1) + ' MB';
}
function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
function attr(s) {
	return esc(s);
}

// ── Earnings ─────────────────────────────────────────────────────────────────
async function renderEarnings(root) {
	root.innerHTML = `
		<h1>Skill Earnings</h1>
		<p class="sub">Royalties earned when agents invoke your published skills.</p>
		<div id="earn-body"><div class="muted">Loading…</div></div>
	`;

	const body = root.querySelector('#earn-body');
	let data;
	try {
		const resp = await fetch('/api/users/me/earnings', { credentials: 'include' });
		if (!resp.ok) throw new Error(await resp.text());
		data = await resp.json();
	} catch (e) {
		body.innerHTML = `<div class="err">${esc(e.message)}</div>`;
		return;
	}

	const { pending_usd, settled_usd, entries } = data;

	if (!entries.length) {
		body.innerHTML = `
			<div class="card" style="text-align:center;padding:48px 24px">
				<div style="font-size:40px;margin-bottom:12px">💎</div>
				<h3 style="margin:0 0 8px">No earnings yet</h3>
				<p class="muted" style="margin:0">Royalties appear here when agents call your paid skills.</p>
			</div>`;
		return;
	}

	const fmt = (n) => '$' + Number(n).toFixed(4);
	const statusBadge = (s) => {
		const colors = { pending: '#f59e0b', settled: '#22c55e', failed: '#ef4444' };
		return `<span style="font-size:11px;padding:2px 7px;border-radius:10px;background:${colors[s] ?? '#555'}22;color:${colors[s] ?? '#aaa'}">${esc(s)}</span>`;
	};

	body.innerHTML = `
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px">
			<div class="card">
				<div class="muted" style="font-size:12px;margin-bottom:4px">Pending</div>
				<div style="font-size:22px;font-weight:600;color:#f59e0b">${fmt(pending_usd)}</div>
			</div>
			<div class="card">
				<div class="muted" style="font-size:12px;margin-bottom:4px">Settled</div>
				<div style="font-size:22px;font-weight:600;color:#22c55e">${fmt(settled_usd)}</div>
			</div>
			<div class="card">
				<div class="muted" style="font-size:12px;margin-bottom:4px">Total</div>
				<div style="font-size:22px;font-weight:600">${fmt(pending_usd + settled_usd)}</div>
			</div>
		</div>
		<table style="width:100%;border-collapse:collapse;font-size:13px">
			<thead>
				<tr style="color:#888;text-align:left;border-bottom:1px solid var(--border)">
					<th style="padding:8px 10px">Skill</th>
					<th style="padding:8px 10px">Agent</th>
					<th style="padding:8px 10px">Amount</th>
					<th style="padding:8px 10px">Status</th>
					<th style="padding:8px 10px">Date</th>
				</tr>
			</thead>
			<tbody>
				${entries
					.map(
						(e) => `
				<tr style="border-bottom:1px solid var(--border)">
					<td style="padding:8px 10px">${esc(e.skill_name)}</td>
					<td style="padding:8px 10px;color:#888">${esc(e.agent_name)}</td>
					<td style="padding:8px 10px;font-variant-numeric:tabular-nums">${fmt(e.price_usd)}</td>
					<td style="padding:8px 10px">${statusBadge(e.status)}</td>
					<td style="padding:8px 10px;color:#888">${new Date(e.created_at).toLocaleDateString()}</td>
				</tr>`,
					)
					.join('')}
			</tbody>
		</table>
	`;
}

// ── Agent Payments ───────────────────────────────────────────────────────────
async function renderPayments(root) {
	root.innerHTML = `
		<h1>Payments</h1>
		<p class="sub">Payments sent automatically when your agent uses paid skills.</p>
		<div id="pay-body"><div class="muted">Loading…</div></div>
	`;
	const body = root.querySelector('#pay-body');

	let agentId;
	try {
		const data = await api.getAgentMe();
		agentId = data.agent?.id;
	} catch {
		body.innerHTML = '<div class="err">Could not load agent.</div>';
		return;
	}

	if (!agentId) {
		body.innerHTML =
			'<div class="card" style="text-align:center;padding:48px 24px"><p class="muted">No agent found. Create an agent first.</p></div>';
		return;
	}

	let nextPayCursor = null;

	async function loadPayPage(replace) {
		const params = new URLSearchParams({ direction: 'sent', limit: '20' });
		if (nextPayCursor) params.set('cursor', nextPayCursor);
		let data;
		try {
			const res = await fetch(`/api/agents/${agentId}/payments?${params}`, {
				credentials: 'include',
			});
			if (!res.ok) {
				const text = await res.text();
				let msg = text;
				try {
					const j = JSON.parse(text);
					msg = j.error_description || j.message || j.error || text;
				} catch {
					/* not JSON */
				}
				const err = new Error(msg);
				err.status = res.status;
				throw err;
			}
			data = await res.json();
		} catch (e) {
			body.innerHTML = `<div class="err">${esc(String(e.message || e))}</div>`;
			return;
		}

		if (replace && data.payments.length === 0) {
			body.innerHTML = `
				<div class="card" style="text-align:center;padding:48px 24px">
					<div style="font-size:40px;margin-bottom:12px">\u{1F4B3}</div>
					<h3 style="margin:0 0 8px">No payments yet</h3>
					<p class="muted" style="margin:0">Payments are sent automatically when the agent uses paid skills.</p>
				</div>`;
			return;
		}

		if (replace) {
			body.innerHTML = `
				<table style="width:100%;border-collapse:collapse">
					<thead>
						<tr style="text-align:left;border-bottom:1px solid var(--border)">
							<th style="padding:6px 8px 10px;font-size:13px;font-weight:600">Date</th>
							<th style="padding:6px 8px 10px;font-size:13px;font-weight:600">Skill</th>
							<th style="padding:6px 8px 10px;font-size:13px;font-weight:600">Amount (ETH)</th>
							<th style="padding:6px 8px 10px;font-size:13px;font-weight:600">Status</th>
							<th style="padding:6px 8px 10px;font-size:13px;font-weight:600">Tx</th>
						</tr>
					</thead>
					<tbody id="pay-rows"></tbody>
				</table>
				<div id="pay-more"></div>
			`;
		}

		const rows = body.querySelector('#pay-rows');
		const moreEl = body.querySelector('#pay-more');

		for (const p of data.payments) {
			const amountEth = p.amount_wei
				? (Number(BigInt(p.amount_wei)) / 1e18)
						.toFixed(8)
						.replace(/0+$/, '')
						.replace(/\.$/, '.0')
				: '—';
			const statusColor =
				p.status === 'confirmed' ? '#00e5a0' : p.status === 'failed' ? '#ff5c5c' : '#888';
			const explorerBase =
				p.chain_id === 8453
					? 'https://basescan.org/tx/'
					: p.chain_id === 84532
						? 'https://sepolia.basescan.org/tx/'
						: 'https://etherscan.io/tx/';
			const txLink = p.tx_hash
				? `<a href="${explorerBase}${esc(p.tx_hash)}" target="_blank" rel="noopener" style="font-size:12px">${esc(p.tx_hash.slice(0, 10))}…</a>`
				: '—';
			const tr = document.createElement('tr');
			tr.style.borderBottom = '1px solid var(--border)';
			tr.innerHTML = `
				<td style="padding:8px 10px;color:#888;font-size:13px">${new Date(p.created_at).toLocaleDateString()}</td>
				<td style="padding:8px 10px;font-size:13px">${esc(p.skill_name || p.memo || '—')}</td>
				<td style="padding:8px 10px;font-variant-numeric:tabular-nums;font-size:13px">${esc(amountEth)}</td>
				<td style="padding:8px 10px"><span style="color:${statusColor};font-size:12px;font-weight:600;text-transform:uppercase">${esc(p.status)}</span></td>
				<td style="padding:8px 10px">${txLink}</td>
			`;
			rows.appendChild(tr);
		}

		nextPayCursor = data.next_cursor || null;
		if (moreEl) {
			moreEl.innerHTML = '';
			if (nextPayCursor) {
				const btn = document.createElement('button');
				btn.className = 'btn sec';
				btn.style.marginTop = '12px';
				btn.textContent = 'Load more';
				btn.addEventListener('click', () => loadPayPage(false));
				moreEl.appendChild(btn);
			}
		}
	}

	await loadPayPage(true);
}
