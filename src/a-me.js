// /a/me — Personal agent hub.
//
// Authenticated-only page showing every agent the user owns with their
// avatars, skills, memory, earnings, and quick actions (view, share,
// embed, edit, monetize, talk, walk, AR).
//
// Real endpoints:
//   GET /api/auth/me
//   GET /api/agents
//   GET /api/avatars?limit=50
//   GET /api/agents/:id/memories
//   GET /api/agents/:id/actions
//   GET /api/agents/:id/reputation
//   GET /api/billing/summary

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function relTime(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const diff = Date.now() - t;
	const s = Math.round(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 14) return `${d}d ago`;
	return new Date(iso).toLocaleDateString();
}

function truncAddr(s, head = 6, tail = 4) {
	const str = String(s || '');
	if (str.length <= head + tail + 1) return str;
	return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

async function api(method, path, body) {
	const headers = { accept: 'application/json' };
	let payload;
	if (body !== undefined) {
		headers['content-type'] = 'application/json';
		payload = JSON.stringify(body);
	}
	const res = await fetch(path, { method, headers, body: payload, credentials: 'include' });
	const text = await res.text();
	let data = null;
	if (text) { try { data = JSON.parse(text); } catch { data = text; } }
	if (!res.ok) throw { status: res.status, message: data?.error || res.statusText, body: data };
	return data;
}

const get = path => api('GET', path);

// ── Toast ────────────────────────────────────────────────────────────────────

function toast(msg) {
	let el = document.getElementById('ame-toast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'ame-toast';
		Object.assign(el.style, {
			position: 'fixed', left: '50%', bottom: '32px',
			transform: 'translateX(-50%) translateY(20px)',
			background: 'rgba(20,21,28,0.95)', border: '1px solid var(--border-strong)',
			color: 'var(--text)', padding: '9px 16px', borderRadius: '999px',
			fontSize: '13px', zIndex: '9999', opacity: '0',
			transition: 'opacity .18s, transform .18s',
			backdropFilter: 'blur(20px)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
			pointerEvents: 'none',
		});
		document.body.appendChild(el);
	}
	el.textContent = msg;
	requestAnimationFrame(() => {
		el.style.opacity = '1';
		el.style.transform = 'translateX(-50%) translateY(0)';
	});
	clearTimeout(el._t);
	el._t = setTimeout(() => {
		el.style.opacity = '0';
		el.style.transform = 'translateX(-50%) translateY(20px)';
	}, 1800);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
	injectStyles();

	document.body.innerHTML = `
		<header class="ame-nav">
			<div class="ame-nav-inner">
				<a class="ame-brand" href="/home-next"><span class="ame-brand-dot"></span><span>three.ws</span></a>
				<nav class="ame-nav-main">
					<a href="/create">Build</a>
					<a href="/discover">Discover</a>
					<a href="/pricing">Pricing</a>
					<a href="/docs">Docs</a>
				</nav>
				<div class="ame-nav-end">
					<a href="/dashboard" class="ame-console-btn">Console</a>
				</div>
			</div>
		</header>
		<div class="ame-loading"><span class="ame-spinner"></span>Loading your agents…</div>
	`;

	let me;
	try {
		const r = await get('/api/auth/me');
		me = r?.user || r;
		if (!me) throw { status: 401 };
	} catch (err) {
		if (err?.status === 401 || !err) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
			return;
		}
		throw err;
	}

	const [agentsRes, avatarsRes, billingRes] = await Promise.all([
		get('/api/agents').catch(() => null),
		get('/api/avatars?limit=50').catch(() => null),
		get('/api/billing/summary').catch(() => null),
	]);

	const agents = agentsRes?.agents || [];
	const avatars = avatarsRes?.avatars || [];
	const billing = billingRes || {};

	document.querySelector('.ame-loading')?.remove();

	const main = document.createElement('main');
	main.className = 'ame-main';
	document.body.appendChild(main);

	renderHub(main, me, agents, avatars, billing);
})();

// ── Render hub ───────────────────────────────────────────────────────────────

function renderHub(main, me, agents, avatars, billing) {
	const displayName = me.display_name || me.handle || me.email?.split('@')[0] || 'You';
	const totalRevenue = billing?.total_revenue != null
		? `$${(Number(billing.total_revenue) / 1_000_000).toFixed(2)}`
		: null;

	main.innerHTML = `
		<section class="ame-hero">
			<div class="ame-hero-left">
				<h1 class="ame-title">${esc(displayName)}'s Agents</h1>
				<p class="ame-subtitle">Manage your AI agents, avatars, skills, memory, and monetization.</p>
			</div>
			<div class="ame-hero-stats">
				<div class="ame-stat"><span class="ame-stat-val">${agents.length}</span><span class="ame-stat-label">Agents</span></div>
				<div class="ame-stat"><span class="ame-stat-val">${avatars.length}</span><span class="ame-stat-label">Avatars</span></div>
				${totalRevenue ? `<div class="ame-stat"><span class="ame-stat-val">${esc(totalRevenue)}</span><span class="ame-stat-label">Revenue</span></div>` : ''}
			</div>
		</section>

		<section class="ame-section">
			<div class="ame-section-header">
				<div>
					<div class="ame-eyebrow">Agents</div>
					<h2 class="ame-h2">Your AI Agents</h2>
				</div>
				<div class="ame-section-actions">
					<a class="ame-btn primary" href="/dashboard/agents">Manage in Console</a>
				</div>
			</div>
			<div class="ame-agent-grid" id="agent-grid"></div>
		</section>

		<section class="ame-section">
			<div class="ame-section-header">
				<div>
					<div class="ame-eyebrow">Avatars</div>
					<h2 class="ame-h2">Your 3D Avatars</h2>
				</div>
				<div class="ame-section-actions">
					<a class="ame-btn" href="/dashboard/avatars">Manage Avatars</a>
					<a class="ame-btn primary" href="/create">+ Create New</a>
				</div>
			</div>
			<div class="ame-avatar-grid" id="avatar-grid"></div>
		</section>
	`;

	renderAgentCards(document.getElementById('agent-grid'), agents, avatars);
	renderAvatarCards(document.getElementById('avatar-grid'), avatars, agents);
}

// ── Agent cards ──────────────────────────────────────────────────────────────

function renderAgentCards(host, agents, avatars) {
	if (!agents.length) {
		host.innerHTML = `
			<div class="ame-empty">
				<div class="ame-empty-icon">🤖</div>
				<h3>No agents yet</h3>
				<p>Create your first AI agent to get started.</p>
				<a class="ame-btn primary" href="/dashboard/agents">+ Create Agent</a>
			</div>
		`;
		return;
	}

	host.innerHTML = agents.map(a => {
		const avatar = avatars.find(av => av.id === a.avatar_id);
		const thumb = avatar?.thumbnail_url || avatar?.url || '';
		const name = esc(a.name || a.display_name || 'Unnamed');
		const tagline = esc((a.persona?.tagline || a.tagline || '').slice(0, 120));
		const wallet = a.wallet_address || a.solana_address || '';
		const onchain = a.onchain_id || a.erc8004_id || a.chain_id;
		const pumpMint = a.meta?.pumpfun?.mint || a.meta?.token?.mint;
		const created = a.created_at ? relTime(a.created_at) : '';
		const avatarId = a.avatar_id || '';

		return `
			<div class="ame-agent-card" data-agent-id="${esc(a.id)}">
				<div class="ame-agent-top">
					<div class="ame-agent-thumb">
						${thumb
							? `<img src="${esc(thumb)}" alt="${name}" loading="lazy" />`
							: `<div class="ame-agent-thumb-placeholder">🤖</div>`
						}
					</div>
					<div class="ame-agent-info">
						<div class="ame-agent-name">${name}</div>
						${tagline ? `<div class="ame-agent-tagline">${tagline}</div>` : ''}
						<div class="ame-agent-meta">
							${onchain ? `<span class="ame-tag ok">on-chain</span>` : `<span class="ame-tag">off-chain</span>`}
							${pumpMint ? `<span class="ame-tag pump">pump.fun</span>` : ''}
							${created ? `<span class="ame-meta-text">${esc(created)}</span>` : ''}
						</div>
						${wallet ? `<div class="ame-wallet">${esc(truncAddr(wallet, 8, 6))}</div>` : ''}
					</div>
				</div>

				<div class="ame-agent-panels" id="panels-${esc(a.id)}"></div>

				<div class="ame-agent-actions">
					<div class="ame-actions-row">
						${avatarId ? `<a class="ame-btn primary small" href="/agent-next?id=${encodeURIComponent(avatarId)}" target="_blank">View Live</a>` : ''}
						${avatarId ? `<button class="ame-btn small" data-action="share" data-avatar-id="${esc(avatarId)}" data-name="${name}">Share</button>` : ''}
						${avatarId ? `<button class="ame-btn small" data-action="embed" data-avatar-id="${esc(avatarId)}">Embed</button>` : ''}
						<a class="ame-btn small" href="/dashboard/monetize">Monetize</a>
					</div>
					<div class="ame-actions-row">
						${avatarId ? `<a class="ame-btn ghost small" href="/walk?avatar=${encodeURIComponent(avatarId)}">Walk</a>` : ''}
						${avatarId ? `<a class="ame-btn ghost small" href="/pose?avatar=${encodeURIComponent(avatarId)}">Pose</a>` : ''}
						${avatarId ? `<a class="ame-btn ghost small" href="/mocap-studio?avatar=${encodeURIComponent(avatarId)}">Mocap</a>` : ''}
						<button class="ame-btn ghost small" data-action="toggle-skills" data-agent-id="${esc(a.id)}">Skills</button>
						<button class="ame-btn ghost small" data-action="toggle-memory" data-agent-id="${esc(a.id)}">Memory</button>
						<button class="ame-btn ghost small" data-action="toggle-actions" data-agent-id="${esc(a.id)}">Activity</button>
					</div>
				</div>
			</div>
		`;
	}).join('');

	host.addEventListener('click', e => {
		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		const action = btn.dataset.action;
		if (action === 'share') handleShare(btn.dataset.avatarId, btn.dataset.name);
		else if (action === 'embed') handleEmbed(btn.dataset.avatarId);
		else if (action === 'toggle-skills') togglePanel(btn.dataset.agentId, 'skills', agents);
		else if (action === 'toggle-memory') togglePanel(btn.dataset.agentId, 'memory', agents);
		else if (action === 'toggle-actions') togglePanel(btn.dataset.agentId, 'actions', agents);
	});
}

// ── Avatar cards ─────────────────────────────────────────────────────────────

function renderAvatarCards(host, avatars, agents) {
	if (!avatars.length) {
		host.innerHTML = `
			<div class="ame-empty">
				<div class="ame-empty-icon">🎭</div>
				<h3>No avatars yet</h3>
				<p>Create a 3D avatar from a selfie or upload a GLB file.</p>
				<a class="ame-btn primary" href="/create">+ Create Avatar</a>
			</div>
		`;
		return;
	}

	host.innerHTML = avatars.map(av => {
		const name = esc(av.name || 'Untitled');
		const thumb = av.thumbnail_url || '';
		const vis = av.visibility || 'public';
		const linked = agents.find(a => a.avatar_id === av.id);
		const created = av.created_at ? relTime(av.created_at) : '';

		return `
			<div class="ame-avatar-card">
				<a class="ame-avatar-preview" href="/agent-next?id=${encodeURIComponent(av.id)}">
					${thumb
						? `<img src="${esc(thumb)}" alt="${name}" loading="lazy" />`
						: `<div class="ame-avatar-placeholder">
							<threews-avatar src="/api/avatars/${esc(av.id)}" style="width:100%;height:100%"></threews-avatar>
						</div>`
					}
					<div class="ame-avatar-overlay">
						<span class="ame-avatar-name">${name}</span>
						<span class="ame-avatar-vis">${esc(vis)}</span>
					</div>
				</a>
				<div class="ame-avatar-footer">
					<div class="ame-avatar-footer-left">
						${linked ? `<span class="ame-tag ok small">→ ${esc((linked.name || linked.display_name || '').slice(0, 20))}</span>` : ''}
						${created ? `<span class="ame-meta-text">${esc(created)}</span>` : ''}
					</div>
					<div class="ame-avatar-footer-right">
						<a class="ame-btn ghost tiny" href="/agent-next?id=${encodeURIComponent(av.id)}" title="View">View</a>
						<button class="ame-btn ghost tiny" data-action="selfie" data-avatar-id="${esc(av.id)}" title="Update from selfie">Selfie</button>
						<button class="ame-btn ghost tiny" data-action="share" data-avatar-id="${esc(av.id)}" data-name="${name}" title="Share">Share</button>
						<a class="ame-btn ghost tiny" href="/walk?avatar=${encodeURIComponent(av.id)}" title="Walk">Walk</a>
					</div>
				</div>
			</div>
		`;
	}).join('');

	host.addEventListener('click', async (e) => {
		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		if (btn.dataset.action === 'share') handleShare(btn.dataset.avatarId, btn.dataset.name);
		if (btn.dataset.action === 'selfie') {
			const { openSelfieModal } = await import('./selfie-modal.js');
			const result = await openSelfieModal({ existingAvatarId: btn.dataset.avatarId });
			if (result?.avatarId) {
				toast('Avatar updated from selfie');
				setTimeout(() => location.reload(), 1200);
			}
		}
	});
}

// ── Expandable panels (skills, memory, activity) ─────────────────────────────

const panelCache = {};

async function togglePanel(agentId, panelType, agents) {
	const host = document.getElementById(`panels-${agentId}`);
	if (!host) return;

	const existing = host.querySelector(`[data-panel="${panelType}"]`);
	if (existing) { existing.remove(); return; }

	const panel = document.createElement('div');
	panel.className = 'ame-panel';
	panel.setAttribute('data-panel', panelType);
	panel.innerHTML = `<div class="ame-panel-loading"><span class="ame-spinner-small"></span>Loading ${panelType}…</div>`;
	host.appendChild(panel);

	const cacheKey = `${agentId}-${panelType}`;
	try {
		let data = panelCache[cacheKey];
		if (!data) {
			if (panelType === 'skills') {
				data = await get(`/api/agents/${encodeURIComponent(agentId)}`).catch(() => null);
			} else if (panelType === 'memory') {
				data = await get(`/api/agents/${encodeURIComponent(agentId)}/memories`).catch(() => null);
			} else if (panelType === 'actions') {
				data = await get(`/api/agents/${encodeURIComponent(agentId)}/actions`).catch(() => null);
			}
			panelCache[cacheKey] = data;
		}
		renderPanel(panel, panelType, data, agentId);
	} catch {
		panel.innerHTML = `<div class="ame-panel-empty">Could not load ${panelType}.</div>`;
	}
}

function renderPanel(panel, type, data, agentId) {
	if (type === 'skills') {
		const agent = data?.agent || data || {};
		const skills = agent.skills || agent.persona?.skills || [];
		const services = agent.services || [];
		const allSkills = [...(Array.isArray(skills) ? skills : []), ...services];
		if (!allSkills.length) {
			panel.innerHTML = `
				<div class="ame-panel-header">Skills</div>
				<div class="ame-panel-empty">No skills configured. <a href="/dashboard/agents">Add skills in Console</a></div>
			`;
			return;
		}
		panel.innerHTML = `
			<div class="ame-panel-header">Skills (${allSkills.length})</div>
			<div class="ame-panel-list">
				${allSkills.map(sk => {
					const name = esc(sk.name || sk.skill_name || sk.type || 'Unnamed skill');
					const desc = esc((sk.description || '').slice(0, 100));
					const price = sk.price_usdc ? `$${(Number(sk.price_usdc) / 1_000_000).toFixed(2)}` : '';
					return `
						<div class="ame-panel-item">
							<div class="ame-panel-item-name">${name}</div>
							${desc ? `<div class="ame-panel-item-desc">${desc}</div>` : ''}
							${price ? `<span class="ame-tag ok small">${price}/call</span>` : ''}
						</div>
					`;
				}).join('')}
			</div>
			<div class="ame-panel-footer"><a href="/dashboard/agents">Manage skills</a></div>
		`;
	} else if (type === 'memory') {
		const memories = data?.memories || data?.items || [];
		if (!memories.length) {
			panel.innerHTML = `
				<div class="ame-panel-header">Memory</div>
				<div class="ame-panel-empty">No memory entries. <a href="/dashboard/agents">Seed memory</a></div>
			`;
			return;
		}
		const byType = {};
		memories.forEach(m => {
			const t = m.type || m.memory_type || 'general';
			if (!byType[t]) byType[t] = [];
			byType[t].push(m);
		});
		panel.innerHTML = `
			<div class="ame-panel-header">Memory (${memories.length} entries)</div>
			<div class="ame-memory-bar">
				${Object.entries(byType).map(([type, items]) => {
					const pct = Math.max(8, Math.round((items.length / memories.length) * 100));
					return `<div class="ame-memory-seg" style="flex:${pct}" title="${esc(type)}: ${items.length}">
						<span class="ame-memory-seg-label">${esc(type)}</span>
					</div>`;
				}).join('')}
			</div>
			<div class="ame-panel-list">
				${memories.slice(0, 10).map(m => {
					const key = esc(m.key || m.name || m.id || '');
					const val = esc((m.value || m.content || '').slice(0, 120));
					const type = esc(m.type || m.memory_type || '');
					return `
						<div class="ame-panel-item">
							<div class="ame-panel-item-name">${key} ${type ? `<span class="ame-tag small">${type}</span>` : ''}</div>
							${val ? `<div class="ame-panel-item-desc">${val}</div>` : ''}
						</div>
					`;
				}).join('')}
				${memories.length > 10 ? `<div class="ame-panel-item" style="color:var(--text-soft)">+ ${memories.length - 10} more entries</div>` : ''}
			</div>
			<div class="ame-panel-footer"><a href="/dashboard/memory">View all memory</a></div>
		`;
	} else if (type === 'actions') {
		const actions = data?.actions || data?.items || [];
		if (!actions.length) {
			panel.innerHTML = `
				<div class="ame-panel-header">Activity</div>
				<div class="ame-panel-empty">No recent activity.</div>
			`;
			return;
		}
		panel.innerHTML = `
			<div class="ame-panel-header">Recent Activity (${actions.length})</div>
			<div class="ame-panel-list">
				${actions.slice(0, 8).map(a => {
					const action = esc(a.action || a.type || a.event || 'action');
					const detail = esc((a.detail || a.description || a.message || '').slice(0, 100));
					const time = a.created_at ? relTime(a.created_at) : '';
					return `
						<div class="ame-panel-item">
							<div class="ame-panel-item-name">${action} ${time ? `<span class="ame-meta-text">${esc(time)}</span>` : ''}</div>
							${detail ? `<div class="ame-panel-item-desc">${detail}</div>` : ''}
						</div>
					`;
				}).join('')}
			</div>
			<div class="ame-panel-footer"><a href="/dashboard/actions">View all activity</a></div>
		`;
	}
}

// ── Share / Embed actions ────────────────────────────────────────────────────

function handleShare(avatarId, name) {
	const link = `${location.origin}/agent-next?id=${encodeURIComponent(avatarId)}`;
	navigator.clipboard.writeText(link).then(() => {
		toast(`Link copied for ${name || 'agent'}`);
	}).catch(() => {
		prompt('Copy this link:', link);
	});
}

function handleEmbed(avatarId) {
	const avatarUrl = `${location.origin}/api/avatars/${avatarId}`;
	const snippet = `<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"><\/script>\n<agent-3d src="${avatarUrl}"><\/agent-3d>`;
	navigator.clipboard.writeText(snippet).then(() => {
		toast('Embed snippet copied');
	}).catch(() => {
		prompt('Copy embed snippet:', snippet);
	});
}

// ── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
	const css = document.createElement('style');
	css.textContent = `
		:root {
			color-scheme: dark;
			--bg: #000000;
			--bg-soft: #0a0a0a;
			--panel: #0a0a0a;
			--panel-soft: #111111;
			--border: #1a1a1a;
			--border-strong: #2a2a2a;
			--text: #e8e8e8;
			--text-soft: #888888;
			--muted: #555555;
			--ok: #e8e8e8;
			--accent: #ffffff;
			--pump: #888888;
			--danger: #f87171;
			--font-sans: "Inter Tight", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
			--font-mono: ${MONO};
		}
		* { box-sizing: border-box; }
		html, body {
			margin: 0; padding: 0;
			background: var(--bg); color: var(--text);
			font-family: var(--font-sans); font-size: 16px; line-height: 1.55;
			min-height: 100vh;
		}
		a { color: inherit; text-decoration: none; }
		button { font-family: inherit; cursor: pointer; }

		/* ── Nav ───────────────────────────────────────────────────── */
		.ame-nav {
			position: sticky; top: 0; z-index: 100;
			backdrop-filter: blur(18px) saturate(140%);
			background: rgba(5,5,5,0.82);
			border-bottom: 1px solid var(--border);
		}
		.ame-nav-inner {
			max-width: 1200px; margin: 0 auto;
			display: flex; align-items: center; gap: 24px;
			padding: 14px 24px;
		}
		.ame-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: -0.02em; font-size: 17px; }
		.ame-brand-dot { width: 22px; height: 22px; border-radius: 6px; background: var(--text); }
		.ame-nav-main { display: flex; gap: 4px; margin-left: 16px; flex: 1; }
		.ame-nav-main a {
			padding: 8px 14px; border-radius: 8px;
			color: var(--text-soft); font-size: 14.5px; font-weight: 500;
			transition: background 0.15s, color 0.15s;
		}
		.ame-nav-main a:hover { background: var(--panel); color: var(--text); }
		.ame-nav-end { display: flex; align-items: center; gap: 10px; }
		.ame-console-btn {
			background: var(--text); color: var(--bg);
			font-weight: 600; padding: 8px 16px;
			border-radius: 8px; font-size: 13px;
		}
		@media (max-width: 720px) { .ame-nav-main { display: none; } }

		/* ── Loading ───────────────────────────────────────────────── */
		.ame-loading {
			display: flex; align-items: center; justify-content: center;
			padding: 120px 24px;
			color: var(--text-soft); font-size: 14px;
		}
		.ame-spinner {
			width: 24px; height: 24px;
			border: 2px solid var(--border-strong);
			border-top-color: var(--text-soft);
			border-radius: 50%;
			animation: ame-spin 0.8s linear infinite;
			margin-right: 12px;
		}
		.ame-spinner-small {
			width: 16px; height: 16px;
			border: 2px solid var(--border-strong);
			border-top-color: var(--text-soft);
			border-radius: 50%;
			animation: ame-spin 0.8s linear infinite;
			margin-right: 8px;
			display: inline-block;
		}
		@keyframes ame-spin { to { transform: rotate(360deg); } }

		/* ── Main ──────────────────────────────────────────────────── */
		.ame-main { max-width: 1200px; margin: 0 auto; padding: 0 24px 80px; }

		/* ── Hero ──────────────────────────────────────────────────── */
		.ame-hero {
			display: flex; align-items: flex-end; justify-content: space-between;
			gap: 24px; padding: 40px 0 32px;
			border-bottom: 1px solid var(--border);
			margin-bottom: 32px;
		}
		.ame-title {
			font-size: 32px; font-weight: 700; letter-spacing: -0.03em;
			margin: 0 0 6px;
		}
		.ame-subtitle { font-size: 15px; color: var(--text-soft); margin: 0; }
		.ame-hero-stats { display: flex; gap: 24px; }
		.ame-stat { display: flex; flex-direction: column; align-items: center; }
		.ame-stat-val { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
		.ame-stat-label { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
		@media (max-width: 720px) {
			.ame-hero { flex-direction: column; align-items: flex-start; }
			.ame-title { font-size: 24px; }
		}

		/* ── Section ───────────────────────────────────────────────── */
		.ame-section { margin-bottom: 40px; }
		.ame-section-header {
			display: flex; align-items: flex-end; justify-content: space-between;
			gap: 16px; margin-bottom: 18px; flex-wrap: wrap;
		}
		.ame-section-actions { display: flex; gap: 8px; flex-wrap: wrap; }
		.ame-eyebrow {
			font-size: 10.5px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
			color: var(--muted); margin-bottom: 4px;
		}
		.ame-h2 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin: 0; }

		/* ── Buttons ───────────────────────────────────────────────── */
		.ame-btn {
			display: inline-flex; align-items: center; justify-content: center;
			padding: 9px 16px; border-radius: 9px;
			font-size: 13.5px; font-weight: 500;
			background: transparent; color: var(--text-soft);
			border: 1px solid var(--border-strong);
			cursor: pointer; transition: all 0.12s;
			text-decoration: none; white-space: nowrap;
		}
		.ame-btn:hover { color: var(--text); border-color: var(--text-soft); }
		.ame-btn.primary { background: var(--text); color: var(--bg); border-color: var(--text); font-weight: 600; }
		.ame-btn.primary:hover { opacity: 0.88; }
		.ame-btn.ghost { background: transparent; border-color: transparent; color: var(--text-soft); }
		.ame-btn.ghost:hover { background: var(--panel-soft); color: var(--text); }
		.ame-btn.small { padding: 6px 12px; font-size: 12.5px; border-radius: 7px; }
		.ame-btn.tiny { padding: 4px 8px; font-size: 11.5px; border-radius: 6px; }

		/* ── Tags ───────────────────────────────────────────────────── */
		.ame-tag {
			display: inline-flex; font-size: 11px; font-weight: 500;
			padding: 2px 8px; border-radius: 99px;
			background: rgba(255,255,255,0.06); color: var(--text-soft);
			border: 1px solid var(--border-strong);
		}
		.ame-tag.ok { color: var(--ok); border-color: rgba(34,197,94,0.3); background: rgba(34,197,94,0.08); }
		.ame-tag.pump { color: var(--pump); border-color: rgba(255,180,84,0.28); background: rgba(255,180,84,0.08); }
		.ame-tag.small { font-size: 10px; padding: 1px 6px; }
		.ame-meta-text { font-size: 12px; color: var(--muted); }
		.ame-wallet { font-family: var(--font-mono); font-size: 12px; color: var(--muted); margin-top: 4px; }

		/* ── Agent grid ────────────────────────────────────────────── */
		.ame-agent-grid { display: flex; flex-direction: column; gap: 16px; }
		.ame-agent-card {
			background: var(--panel); border: 1px solid var(--border);
			border-radius: 14px; padding: 20px;
			transition: border-color 0.2s;
		}
		.ame-agent-card:hover { border-color: var(--border-strong); }
		.ame-agent-top { display: flex; gap: 16px; align-items: flex-start; }
		.ame-agent-thumb {
			width: 56px; height: 56px; border-radius: 12px; overflow: hidden;
			background: linear-gradient(135deg, rgba(140,143,150,0.3), rgba(100,103,110,0.2));
			flex-shrink: 0; border: 1px solid var(--border);
		}
		.ame-agent-thumb img { width: 100%; height: 100%; object-fit: cover; }
		.ame-agent-thumb-placeholder {
			width: 100%; height: 100%;
			display: grid; place-items: center; font-size: 24px;
		}
		.ame-agent-info { min-width: 0; flex: 1; }
		.ame-agent-name { font-size: 16px; font-weight: 600; }
		.ame-agent-tagline { font-size: 13px; color: var(--text-soft); margin-top: 2px; font-style: italic; }
		.ame-agent-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 6px; }

		/* ── Agent actions ─────────────────────────────────────────── */
		.ame-agent-actions {
			margin-top: 16px; padding-top: 14px;
			border-top: 1px solid var(--border);
			display: flex; flex-direction: column; gap: 8px;
		}
		.ame-actions-row { display: flex; gap: 6px; flex-wrap: wrap; }

		/* ── Panels (skills, memory, actions) ──────────────────────── */
		.ame-agent-panels { display: flex; flex-direction: column; gap: 8px; }
		.ame-panel {
			margin-top: 12px; padding: 14px;
			background: var(--bg-soft); border: 1px solid var(--border);
			border-radius: 10px;
			animation: ame-panel-in 0.15s ease-out;
		}
		@keyframes ame-panel-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
		.ame-panel-loading { font-size: 13px; color: var(--text-soft); display: flex; align-items: center; }
		.ame-panel-empty { font-size: 13px; color: var(--muted); }
		.ame-panel-empty a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
		.ame-panel-header {
			font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
			color: var(--text-soft); margin-bottom: 10px;
		}
		.ame-panel-list { display: flex; flex-direction: column; gap: 6px; }
		.ame-panel-item {
			padding: 8px 10px; border-radius: 6px;
			background: rgba(255,255,255,0.02);
		}
		.ame-panel-item-name { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
		.ame-panel-item-desc { font-size: 12px; color: var(--text-soft); margin-top: 2px; }
		.ame-panel-footer {
			margin-top: 10px; font-size: 12px;
		}
		.ame-panel-footer a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }

		/* ── Memory bar ────────────────────────────────────────────── */
		.ame-memory-bar {
			display: flex; height: 8px; border-radius: 4px;
			overflow: hidden; margin-bottom: 12px;
			background: var(--border);
		}
		.ame-memory-seg {
			position: relative; cursor: default;
		}
		.ame-memory-seg:nth-child(1) { background: var(--accent); }
		.ame-memory-seg:nth-child(2) { background: var(--ok); }
		.ame-memory-seg:nth-child(3) { background: var(--pump); }
		.ame-memory-seg:nth-child(4) { background: var(--danger); }
		.ame-memory-seg:nth-child(n+5) { background: var(--muted); }
		.ame-memory-seg-label { display: none; }

		/* ── Avatar grid ───────────────────────────────────────────── */
		.ame-avatar-grid {
			display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
			gap: 14px;
		}
		.ame-avatar-card {
			background: var(--panel); border: 1px solid var(--border);
			border-radius: 14px; overflow: hidden;
			transition: border-color 0.2s, transform 0.2s;
		}
		.ame-avatar-card:hover { border-color: var(--border-strong); transform: translateY(-2px); }
		.ame-avatar-preview {
			display: block; position: relative;
			aspect-ratio: 3/4; overflow: hidden;
			background: var(--bg-soft);
		}
		.ame-avatar-preview img {
			width: 100%; height: 100%; object-fit: cover;
			position: absolute; inset: 0;
		}
		.ame-avatar-placeholder { width: 100%; height: 100%; }
		.ame-avatar-overlay {
			position: absolute; bottom: 0; left: 0; right: 0;
			padding: 12px; z-index: 1;
			background: linear-gradient(transparent, rgba(5,5,5,0.9));
			display: flex; flex-direction: column; gap: 2px;
		}
		.ame-avatar-name { font-size: 14px; font-weight: 600; }
		.ame-avatar-vis { font-size: 11px; color: var(--text-soft); text-transform: capitalize; }
		.ame-avatar-footer {
			padding: 10px 12px;
			display: flex; align-items: center; justify-content: space-between;
			gap: 8px; border-top: 1px solid var(--border);
		}
		.ame-avatar-footer-left { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; }
		.ame-avatar-footer-right { display: flex; gap: 4px; flex-shrink: 0; }

		/* ── Empty ─────────────────────────────────────────────────── */
		.ame-empty {
			grid-column: 1 / -1;
			text-align: center; padding: 48px 24px;
			background: var(--panel); border: 1px solid var(--border);
			border-radius: 14px;
		}
		.ame-empty-icon { font-size: 40px; margin-bottom: 12px; }
		.ame-empty h3 { font-size: 17px; font-weight: 600; margin: 0 0 8px; }
		.ame-empty p { color: var(--text-soft); margin: 0 0 18px; font-size: 14px; }

		@media (max-width: 600px) {
			.ame-agent-top { flex-direction: column; }
			.ame-avatar-grid { grid-template-columns: repeat(2, 1fr); }
		}
	`;
	document.head.appendChild(css);
}
