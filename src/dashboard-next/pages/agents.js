// dashboard-next — Agents page.
//
// Lists every agent the signed-in user owns. Supports creating a new agent,
// editing name / avatar assignment, viewing on-chain registration status,
// reputation score, recent earnings, and deleting agents.
//
// Real endpoints used:
//   GET  /api/agents              { agents: [...] }
//   POST /api/agents              body { name, avatar_id? } → { agent }
//   PUT  /api/agents/:id          body patch → { agent }
//   DELETE /api/agents/:id
//   GET  /api/avatars             { avatars: [...] }
//   GET  /api/agents/:id/reputation  { score, reviews_count, ... }

import { mountShell } from '../shell.js';
import { requireUser, get, post, put, del, esc, relTime, ApiError } from '../api.js';
import { openAvatarPicker } from '../../avatar-gallery-picker.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

function toast(msg) {
	let el = document.getElementById('dn-toast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'dn-toast';
		el.style.cssText = `
			position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);
			background:rgba(20,21,28,0.95);border:1px solid var(--nxt-stroke-strong);
			color:var(--nxt-ink);padding:9px 16px;border-radius:999px;font-size:13px;
			z-index:9999;opacity:0;transition:opacity .18s,transform .18s;
			backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
			box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:none;`;
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

function truncMid(s, head = 6, tail = 4) {
	const str = String(s || '');
	if (str.length <= head + tail + 1) return str;
	return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();
		injectStyles();

		main.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:6px">
				<div>
					<h1 class="dn-h1">Agents</h1>
					<p class="dn-h1-sub">On-chain AI identities. Each agent has its own wallet, persona, skills, and payment address.</p>
				</div>
				<button class="dn-btn primary" data-action="create-agent">+ New agent</button>
			</div>

			<div data-slot="filter-bar" class="dn-agents-filter-bar">
				<div class="dn-agents-search-wrap">
					<svg class="dn-agents-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M13 13l-3-3"/></svg>
					<input type="text" class="dn-agents-search" placeholder="Filter agents..." data-action="filter-search" autocomplete="off" spellcheck="false" aria-label="Filter agents" />
				</div>
				<div class="dn-agents-sort-wrap">
					<label style="font-size:12px;color:var(--nxt-ink-fade);white-space:nowrap">Sort by</label>
					<select class="dn-agents-sort" data-action="sort-select" aria-label="Sort agents">
						<option value="created-desc">Newest first</option>
						<option value="created-asc">Oldest first</option>
						<option value="name-asc">Name A-Z</option>
						<option value="name-desc">Name Z-A</option>
					</select>
				</div>
				<span class="dn-agents-count" data-slot="agents-count"></span>
			</div>

			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px"></div>
		`;

		const host = main.querySelector('[data-slot="content"]');
		host.innerHTML = `<div class="dn-skeleton" style="height:220px;border-radius:12px"></div>`;

		const [agentsResp, avatarsResp] = await Promise.all([
			safeGet('/api/agents'),
			safeGet('/api/avatars?limit=50'),
		]);

		const agents = agentsResp?.agents || [];
		const avatars = avatarsResp?.avatars || [];

		let currentFilter = '';
		let currentSort = 'created-desc';

		function getFilteredAgents() {
			let filtered = agents;
			if (currentFilter) {
				const q = currentFilter.toLowerCase();
				filtered = agents.filter((a) => {
					const name = (a.name || a.display_name || '').toLowerCase();
					const wallet = (a.wallet_address || a.solana_address || '').toLowerCase();
					const tagline = (a.persona?.tagline || a.tagline || '').toLowerCase();
					return name.includes(q) || wallet.includes(q) || tagline.includes(q);
				});
			}
			filtered = [...filtered].sort((a, b) => {
				switch (currentSort) {
					case 'created-asc':
						return new Date(a.created_at || 0) - new Date(b.created_at || 0);
					case 'name-asc':
						return (a.name || '').localeCompare(b.name || '');
					case 'name-desc':
						return (b.name || '').localeCompare(a.name || '');
					case 'created-desc':
					default:
						return new Date(b.created_at || 0) - new Date(a.created_at || 0);
				}
			});
			return filtered;
		}

		function rerender() {
			const filtered = getFilteredAgents();
			const countEl = main.querySelector('[data-slot="agents-count"]');
			if (countEl) {
				countEl.textContent = currentFilter
					? `${filtered.length} of ${agents.length} agent${agents.length !== 1 ? 's' : ''}`
					: `${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
			}
			renderAgents(host, filtered, avatars, main);
		}

		rerender();

		const searchInput = main.querySelector('[data-action="filter-search"]');
		let searchTimeout = null;
		searchInput.addEventListener('input', () => {
			clearTimeout(searchTimeout);
			searchTimeout = setTimeout(() => {
				currentFilter = searchInput.value.trim();
				rerender();
			}, 150);
		});
		searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				searchInput.value = '';
				currentFilter = '';
				rerender();
				searchInput.blur();
			}
		});

		main.querySelector('[data-action="sort-select"]').addEventListener('change', (e) => {
			currentSort = e.target.value;
			rerender();
		});

		main.querySelector('[data-action="create-agent"]').addEventListener('click', () => {
			openCreateModal(host, agents, avatars);
		});
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else {
			throw err;
		}
	}
})();

async function safeGet(url) {
	try { return await get(url); }
	catch { return null; }
}

// ── Render agent list ──────────────────────────────────────────────────────

function renderAgents(host, agents, avatars, root) {
	if (!agents.length) {
		host.innerHTML = `
			<div class="dn-panel" style="text-align:center;padding:48px 24px">
				<div style="font-size:40px;margin-bottom:16px">🤖</div>
				<h3 style="font-size:17px;font-weight:600;margin:0 0 8px">No agents yet</h3>
				<p style="color:var(--nxt-ink-dim);margin:0 0 20px;font-size:14px">Create your first agent to get an on-chain AI identity with its own wallet and skills.</p>
				<button class="dn-btn primary" data-action="create-first">+ Create your first agent</button>
			</div>
		`;
		host.querySelector('[data-action="create-first"]').addEventListener('click', () => {
			openCreateModal(host, agents, avatars);
		});
		return;
	}

	host.innerHTML = agents.map((a) => agentCard(a, avatars)).join('');

	host.querySelectorAll('[data-action="edit-agent"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.id;
			const agent = agents.find((a) => a.id === id);
			if (agent) openEditModal(host, agent, avatars, agents);
		});
	});

	host.querySelectorAll('[data-action="delete-agent"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const id = btn.dataset.id;
			const agent = agents.find((a) => a.id === id);
			const name = agent?.name || agent?.display_name || 'this agent';
			if (!confirm(`Delete agent "${name}"? This is permanent.`)) return;
			btn.disabled = true;
			btn.textContent = 'Deleting…';
			try {
				await del(`/api/agents/${encodeURIComponent(id)}`);
				toast('Agent deleted');
				const updated = agents.filter((a) => a.id !== id);
				renderAgents(host, updated, avatars, root);
			} catch (err) {
				toast(err?.message || 'Delete failed');
				btn.disabled = false;
				btn.textContent = 'Delete';
			}
		});
	});

	host.querySelectorAll('[data-action="persona-agent"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.id;
			const agent = agents.find((a) => a.id === id);
			if (agent) openPersonaModal(host, agent, agents, avatars);
		});
	});

	host.querySelectorAll('[data-action="view-reputation"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const id = btn.dataset.id;
			btn.disabled = true;
			btn.textContent = 'Loading…';
			try {
				const r = await get(`/api/agents/${encodeURIComponent(id)}/reputation`);
				showReputationPanel(btn.closest('.dn-panel'), r);
			} catch {
				toast('Reputation data unavailable');
			} finally {
				btn.disabled = false;
				btn.textContent = 'Reputation';
			}
		});
	});

	loadInlineReviewStats(host, agents);
}

const BRAIN_LABELS = {
	'claude-sonnet-4-6':                                'Claude Sonnet 4.6',
	'claude-haiku-4-5-20251001':                        'Claude Haiku 4.5',
	'claude-opus-4-6':                                  'Claude Opus 4.6',
	'claude-opus-4-7':                                  'Claude Opus 4.7',
	'llama-3.3-70b-versatile':                          'Llama 3.3 70B · Groq',
	'llama-3.1-8b-instant':                             'Llama 3.1 8B · Groq',
	'meta-llama/llama-3.3-70b-instruct:free':           'Llama 3.3 70B · OpenRouter',
	'meta-llama/llama-3.1-8b-instruct:free':            'Llama 3.1 8B · OpenRouter',
	'openai/gpt-oss-120b:free':                         'GPT-OSS 120B · OpenRouter',
	'nousresearch/hermes-3-llama-3.1-405b:free':        'Hermes 3 405B · OpenRouter',
};

function brainLabel(agent) {
	const model = agent.meta?.brain?.model;
	if (!model) return 'Llama 3.3 70B · OpenRouter'; // runtime default
	return BRAIN_LABELS[model] || model.split('/').pop() || model;
}

function agentCard(a, avatars) {
	const name = esc(a.name || a.display_name || 'Unnamed agent');
	const wallet = a.wallet_address || a.solana_address || '';
	const avatar = avatars.find((av) => av.id === a.avatar_id);
	const avatarThumb = avatar?.thumbnail_url || avatar?.url || '';
	const created = a.created_at ? relTime(a.created_at) : '—';
	const onchain = a.onchain_id || a.erc8004_id || a.chain_id;
	const pumpMint = a.meta?.pumpfun?.mint || a.meta?.token?.mint || a.meta?.token?.ca;
	const brain = brainLabel(a);

	return `
		<div class="dn-panel dn-agent-card" data-agent-id="${esc(a.id)}">
			<div style="
				width:56px;height:56px;border-radius:12px;overflow:hidden;
				background:linear-gradient(135deg,rgba(140,143,150,0.3),rgba(100,103,110,0.2));
				display:grid;place-items:center;flex-shrink:0;border:1px solid var(--nxt-stroke);
			">
				${avatarThumb
					? `<img src="${esc(avatarThumb)}" alt="${name}" style="width:100%;height:100%;object-fit:cover" loading="lazy" />`
					: `<svg width="28" height="28" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="color:var(--nxt-ink-dim)"><rect x="5" y="2" width="10" height="10" rx="2"/><circle cx="8" cy="6.5" r="1"/><circle cx="12" cy="6.5" r="1"/><path d="M8 9h4M3 14l2-2h10l2 2v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3z"/></svg>`
				}
			</div>

			<div style="min-width:0">
				<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
					<span style="font-size:15px;font-weight:600;color:var(--nxt-ink)">${name}</span>
					${onchain ? `<span class="dn-tag success" style="font-size:11px">on-chain</span>` : `<span class="dn-tag" style="font-size:11px">off-chain</span>`}
					${pumpMint ? `<span class="dn-tag" style="font-size:11px;background:rgba(168,173,181,0.12);border-color:rgba(168,173,181,0.28);color:#a8adb5">pump.fun</span>` : ''}
				</div>
				${wallet ? `<div style="font-family:${MONO};font-size:12px;color:var(--nxt-ink-fade);margin-bottom:6px">${esc(truncMid(wallet, 8, 6))}</div>` : ''}
				<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;color:var(--nxt-ink-dim)">
					<span>Created ${esc(created)}</span>
					<span style="display:inline-flex;align-items:center;gap:4px">
						<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.55"><circle cx="8" cy="8" r="5.5"/><path d="M5 8h6M8 5v6"/></svg>
						<a href="/dashboard/library#tab=brain" style="color:inherit;text-decoration:none" title="Configure brain">${esc(brain)}</a>
					</span>
				</div>
				${a.persona?.tagline || a.tagline ? `<div style="font-size:13px;color:var(--nxt-ink-dim);margin-top:6px;font-style:italic">${esc((a.persona?.tagline || a.tagline).slice(0, 120))}</div>` : ''}
			</div>

			<div class="dn-agent-actions">
				<div class="dn-agent-actions-primary">
					${a.avatar_id ? `<a class="dn-btn" href="/agent-next?id=${encodeURIComponent(a.avatar_id)}" target="_blank" rel="noopener" style="padding:5px 10px;font-size:12px">Live page ↗</a>` : ''}
					<a class="dn-btn" href="/app?agent=${encodeURIComponent(a.id)}" target="_blank" rel="noopener" style="padding:5px 10px;font-size:12px">3D Studio ↗</a>
				</div>
				<div class="dn-agent-actions-secondary">
					<button class="dn-btn ghost" data-action="edit-agent" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Edit</button>
					<button class="dn-btn ghost" data-action="persona-agent" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Persona</button>
					<a class="dn-btn ghost" href="/dashboard/library#tab=brain" style="padding:5px 10px;font-size:12px;text-decoration:none">Brain</a>
					<button class="dn-btn ghost" data-action="view-reputation" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Reputation</button>
					<button class="dn-btn ghost danger" data-action="delete-agent" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Delete</button>
				</div>
			</div>

			${onchain || pumpMint ? `
				<div class="dn-agent-links">
					${onchain ? `<a href="/onchain?agent=${encodeURIComponent(a.id)}" style="font-size:11.5px;color:var(--nxt-ink-dim)">ERC-8004 registry ↗</a>` : ''}
					${pumpMint ? `<a href="https://pump.fun/coin/${encodeURIComponent(pumpMint)}" target="_blank" rel="noopener" style="font-size:11.5px;color:#a8adb5">View on Pump.fun ↗</a>` : ''}
				</div>
			` : ''}
		</div>
	`;
}

async function loadInlineReviewStats(host, agents) {
	const published = agents.filter((a) => a.is_published);
	if (!published.length) return;
	const results = await Promise.allSettled(
		published.map((a) =>
			fetch(`/api/marketplace/agents/${encodeURIComponent(a.id)}/reviews`, { credentials: 'include' })
				.then((r) => r.ok ? r.json() : null)
				.then((j) => ({ id: a.id, summary: j?.data?.summary }))
		)
	);
	for (const r of results) {
		if (r.status !== 'fulfilled' || !r.value?.summary) continue;
		const { id, summary } = r.value;
		const card = host.querySelector(`[data-agent-id="${id}"]`);
		if (!card) continue;
		const avg = Number(summary.rating_avg || 0);
		const count = summary.rating_count || 0;
		if (count === 0) continue;
		const badge = document.createElement('span');
		badge.className = 'dn-tag';
		badge.style.cssText = 'font-size:11px;background:rgba(251,191,36,0.12);border-color:rgba(251,191,36,0.3);color:#fbbf24';
		badge.textContent = `★ ${avg.toFixed(1)} (${count})`;
		badge.title = `${avg.toFixed(2)} avg from ${count} review${count === 1 ? '' : 's'}`;
		const nameRow = card.querySelector('div > div:nth-child(2) > div:first-child');
		if (nameRow) nameRow.appendChild(badge);
	}
}

function showReputationPanel(card, rep) {
	const existing = card.querySelector('[data-reputation-panel]');
	if (existing) { existing.remove(); return; }
	const score = rep?.score ?? rep?.rating ?? null;
	const count = rep?.reviews_count ?? rep?.count ?? 0;
	const panel = document.createElement('div');
	panel.setAttribute('data-reputation-panel', 'true');
	panel.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid var(--nxt-stroke)';
	panel.innerHTML = `
		<div style="font-size:12.5px;font-weight:600;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Reputation</div>
		${score !== null
			? `<div style="display:flex;align-items:baseline;gap:8px">
				<span style="font-size:32px;font-weight:700;color:var(--nxt-ink)">${Number(score).toFixed(1)}</span>
				<span style="font-size:13px;color:var(--nxt-ink-dim)">/ 5.0 · ${count} review${count === 1 ? '' : 's'}</span>
			</div>`
			: `<div style="color:var(--nxt-ink-dim);font-size:13px">No reviews yet.</div>`
		}
		${rep?.tags?.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${rep.tags.map((t) => `<span class="dn-tag">${esc(t)}</span>`).join('')}</div>` : ''}
	`;
	card.appendChild(panel);
}

// ── Create agent modal ─────────────────────────────────────────────────────

function openCreateModal(host, agents, avatars) {
	const overlay = makeOverlay();
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Create agent" style="
			width:min(480px,100%);
			background:linear-gradient(180deg,rgba(22,24,32,0.97),rgba(16,17,24,0.97));
			border:1px solid var(--nxt-stroke-strong);border-radius:14px;padding:24px;
			box-shadow:0 20px 60px rgba(0,0,0,0.6);
		">
			<div style="font-size:17px;font-weight:600;margin-bottom:18px">Create agent</div>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Agent name</span>
				<input data-slot="name" type="text" maxlength="60" placeholder="e.g. Aria, Zeno, Agent-7…"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13.5px" />
			</label>

			<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Avatar (optional)</span>
				<input type="hidden" data-slot="avatar" value="" />
				<button type="button" data-action="pick-avatar" class="dn-btn" style="
					display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;
					border:1px solid var(--nxt-stroke);background:rgba(255,255,255,0.04);
					color:var(--nxt-ink);font:inherit;font-size:13px;text-align:left;cursor:pointer;
					width:100%;transition:border-color 120ms ease,background 120ms ease;
				">
					<span data-slot="avatar-thumb" style="
						width:36px;height:36px;border-radius:8px;overflow:hidden;flex-shrink:0;
						background:linear-gradient(135deg,rgba(140,143,150,0.2),rgba(100,103,110,0.1));
						display:grid;place-items:center;border:1px solid var(--nxt-stroke);
					">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="color:var(--nxt-ink-dim)"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4.5 4.5-7 8-7s6.5 2.5 8 7"/></svg>
					</span>
					<span data-slot="avatar-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Choose an avatar...</span>
					<span style="font-size:11px;color:var(--nxt-ink-fade);flex-shrink:0">Browse</span>
				</button>
			</div>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Tagline (optional)</span>
				<input data-slot="tagline" type="text" maxlength="160" placeholder="One line about your agent…"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
			</label>

			<div data-slot="error" style="font-size:12.5px;color:var(--nxt-danger);min-height:18px;margin-bottom:12px"></div>

			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button class="dn-btn ghost" data-action="cancel">Cancel</button>
				<button class="dn-btn primary" data-action="submit">Create agent</button>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);
	const nameEl = overlay.querySelector('[data-slot="name"]');
	const avatarEl = overlay.querySelector('[data-slot="avatar"]');
	const taglineEl = overlay.querySelector('[data-slot="tagline"]');
	const errorEl = overlay.querySelector('[data-slot="error"]');
	const submitBtn = overlay.querySelector('[data-action="submit"]');
	nameEl.focus();

	overlay.querySelector('[data-action="pick-avatar"]').addEventListener('click', async () => {
		const picked = await openAvatarPicker({
			source: 'both',
			title: 'Choose an avatar for this agent',
			selectedId: avatarEl.value,
			showModes: false,
			ctaLabel: 'Use this avatar',
		});
		if (picked) {
			avatarEl.value = picked.id;
			const thumbEl = overlay.querySelector('[data-slot="avatar-thumb"]');
			const labelEl = overlay.querySelector('[data-slot="avatar-label"]');
			if (picked.thumbnail_url) {
				thumbEl.innerHTML = `<img src="${esc(picked.thumbnail_url)}" style="width:100%;height:100%;object-fit:cover" />`;
			}
			labelEl.textContent = picked.name || picked.id;
		}
	});

	const close = () => overlay.remove();
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	document.addEventListener('keydown', function onKey(e) {
		if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
	});

	submitBtn.addEventListener('click', async () => {
		const name = nameEl.value.trim();
		if (!name) { errorEl.textContent = 'Agent name is required.'; return; }
		errorEl.textContent = '';
		submitBtn.disabled = true;
		submitBtn.textContent = 'Creating…';
		try {
			const body = { name };
			if (avatarEl.value) body.avatar_id = avatarEl.value;
			if (taglineEl.value.trim()) body.tagline = taglineEl.value.trim();
			const r = await post('/api/agents', body);
			const newAgent = r?.agent || r;
			toast('Agent created');
			close();
			agents.unshift(newAgent);
			const freshAvatars = (await safeGet('/api/avatars?limit=50'))?.avatars || avatars;
			renderAgents(host, agents, freshAvatars, null);
		} catch (err) {
			errorEl.textContent = err?.body?.error || err?.message || 'Create failed';
			submitBtn.disabled = false;
			submitBtn.textContent = 'Create agent';
		}
	});
}

// ── Edit agent modal ───────────────────────────────────────────────────────

function openEditModal(host, agent, avatars, allAgents) {
	const overlay = makeOverlay();
	const currentName = agent.name || agent.display_name || '';
	const currentTagline = agent.persona?.tagline || agent.tagline || '';
	const currentAvatarId = agent.avatar_id || '';

	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Edit agent" style="
			width:min(480px,100%);
			background:linear-gradient(180deg,rgba(22,24,32,0.97),rgba(16,17,24,0.97));
			border:1px solid var(--nxt-stroke-strong);border-radius:14px;padding:24px;
			box-shadow:0 20px 60px rgba(0,0,0,0.6);
		">
			<div style="font-size:17px;font-weight:600;margin-bottom:18px">Edit agent</div>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Agent name</span>
				<input data-slot="name" type="text" maxlength="60" value="${esc(currentName)}"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13.5px" />
			</label>

			<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Avatar</span>
				<input type="hidden" data-slot="avatar" value="${esc(currentAvatarId)}" />
				<button type="button" data-action="pick-avatar" class="dn-btn" style="
					display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;
					border:1px solid var(--nxt-stroke);background:rgba(255,255,255,0.04);
					color:var(--nxt-ink);font:inherit;font-size:13px;text-align:left;cursor:pointer;
					width:100%;transition:border-color 120ms ease,background 120ms ease;
				">
					<span data-slot="avatar-thumb" style="
						width:36px;height:36px;border-radius:8px;overflow:hidden;flex-shrink:0;
						background:linear-gradient(135deg,rgba(140,143,150,0.2),rgba(100,103,110,0.1));
						display:grid;place-items:center;border:1px solid var(--nxt-stroke);
					">
						${(() => {
							const av = avatars.find((x) => x.id === currentAvatarId);
							return av?.thumbnail_url
								? `<img src="${esc(av.thumbnail_url)}" style="width:100%;height:100%;object-fit:cover" />`
								: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="color:var(--nxt-ink-dim)"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4.5 4.5-7 8-7s6.5 2.5 8 7"/></svg>`;
						})()}
					</span>
					<span data-slot="avatar-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${currentAvatarId ? esc(avatars.find((x) => x.id === currentAvatarId)?.name || currentAvatarId) : 'Choose an avatar...'}</span>
					<span style="font-size:11px;color:var(--nxt-ink-fade);flex-shrink:0">Browse</span>
				</button>
			</div>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Tagline</span>
				<input data-slot="tagline" type="text" maxlength="160" value="${esc(currentTagline)}"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
			</label>

			<div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;margin-bottom:16px">
				<div style="font-size:12px;color:var(--nxt-ink-fade);margin-bottom:6px">Agent ID</div>
				<div style="font-family:${MONO};font-size:12px;color:var(--nxt-ink-dim)">${esc(agent.id)}</div>
				${agent.wallet_address ? `<div style="font-family:${MONO};font-size:12px;color:var(--nxt-ink-fade);margin-top:4px">${esc(agent.wallet_address)}</div>` : ''}
			</div>

			<div data-slot="error" style="font-size:12.5px;color:var(--nxt-danger);min-height:18px;margin-bottom:12px"></div>

			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button class="dn-btn ghost" data-action="cancel">Cancel</button>
				<button class="dn-btn primary" data-action="submit">Save changes</button>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);
	const nameEl = overlay.querySelector('[data-slot="name"]');
	const avatarEl = overlay.querySelector('[data-slot="avatar"]');
	const taglineEl = overlay.querySelector('[data-slot="tagline"]');
	const errorEl = overlay.querySelector('[data-slot="error"]');
	const submitBtn = overlay.querySelector('[data-action="submit"]');
	nameEl.focus();

	overlay.querySelector('[data-action="pick-avatar"]').addEventListener('click', async () => {
		const picked = await openAvatarPicker({
			source: 'both',
			title: 'Choose an avatar for this agent',
			selectedId: avatarEl.value,
			showModes: false,
			ctaLabel: 'Use this avatar',
		});
		if (picked) {
			avatarEl.value = picked.id;
			const thumbEl = overlay.querySelector('[data-slot="avatar-thumb"]');
			const labelEl = overlay.querySelector('[data-slot="avatar-label"]');
			if (picked.thumbnail_url) {
				thumbEl.innerHTML = `<img src="${esc(picked.thumbnail_url)}" style="width:100%;height:100%;object-fit:cover" />`;
			}
			labelEl.textContent = picked.name || picked.id;
		}
	});

	const close = () => overlay.remove();
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	document.addEventListener('keydown', function onKey(e) {
		if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
	});

	submitBtn.addEventListener('click', async () => {
		const name = nameEl.value.trim();
		if (!name) { errorEl.textContent = 'Agent name is required.'; return; }
		errorEl.textContent = '';
		submitBtn.disabled = true;
		submitBtn.textContent = 'Saving…';
		try {
			const body = { name };
			if (avatarEl.value) body.avatar_id = avatarEl.value;
			if (taglineEl.value.trim()) body.tagline = taglineEl.value.trim();
			const r = await put(`/api/agents/${encodeURIComponent(agent.id)}`, body);
			const updated = r?.agent || { ...agent, ...body };
			toast('Agent updated');
			close();
			const idx = allAgents.findIndex((a) => a.id === agent.id);
			if (idx >= 0) allAgents[idx] = { ...allAgents[idx], ...updated };
			renderAgents(host, allAgents, avatars, null);
		} catch (err) {
			errorEl.textContent = err?.body?.error || err?.message || 'Save failed';
			submitBtn.disabled = false;
			submitBtn.textContent = 'Save changes';
		}
	});
}

// ── Persona editor + memory seeding modal ─────────────────────────────────

function openPersonaModal(host, agent, allAgents, avatars) {
	const overlay = makeOverlay();
	const persona = agent.persona || {};
	const systemPrompt = persona.system_prompt || agent.system_prompt || '';
	const tone = persona.tone || agent.tone || '';
	const traits = Array.isArray(persona.traits) ? persona.traits.join(', ') : (persona.traits || '');

	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Agent persona" style="
			width:min(600px,100%);
			background:linear-gradient(180deg,rgba(22,24,32,0.97),rgba(16,17,24,0.97));
			border:1px solid var(--nxt-stroke-strong);border-radius:14px;padding:24px;
			box-shadow:0 20px 60px rgba(0,0,0,0.6);
			max-height:calc(100vh - 48px);overflow-y:auto;
		">
			<div style="font-size:17px;font-weight:600;margin-bottom:4px">Persona — ${esc(agent.name || agent.display_name || 'Agent')}</div>
			<div style="font-size:12.5px;color:var(--nxt-ink-dim);margin-bottom:20px">System context, tone, traits, and memory seeding.</div>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">System prompt</span>
				<textarea data-slot="system-prompt" rows="5" maxlength="4000"
					placeholder="You are an AI assistant named… Your purpose is…"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px;
					resize:vertical;line-height:1.5">${esc(systemPrompt)}</textarea>
			</label>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Tone</span>
				<input data-slot="tone" type="text" maxlength="120"
					value="${esc(tone)}"
					placeholder="e.g. professional, friendly, witty, concise…"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
			</label>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Traits (comma-separated)</span>
				<input data-slot="traits" type="text" maxlength="300"
					value="${esc(traits)}"
					placeholder="e.g. curious, empathetic, direct…"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
			</label>

			<div data-slot="error" style="font-size:12.5px;color:var(--nxt-danger);min-height:18px;margin-bottom:12px"></div>

			<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:24px;flex-wrap:wrap">
				<a href="/brain" target="_blank" class="dn-btn" style="text-decoration:none;font-size:12.5px;margin-right:auto">Build in Brain Studio</a>
				<button class="dn-btn ghost" data-action="cancel">Cancel</button>
				<button class="dn-btn primary" data-action="save-persona">Save persona</button>
			</div>

			<div style="border-top:1px solid var(--nxt-stroke);padding-top:18px;margin-top:4px">
				<div style="font-size:13px;font-weight:600;color:var(--nxt-ink);margin-bottom:4px">Memory seeding</div>
				<div style="font-size:12.5px;color:var(--nxt-ink-dim);margin-bottom:14px">
					Seed this agent's long-term memory from your activity. Each source is fetched, distilled into facts, and written to the agent's memory store.
				</div>
				<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
					<div style="flex:1;min-width:0;font-size:12.5px;color:var(--nxt-ink-dim)">Distil your recent posts. Uses your connected <strong style="color:var(--nxt-ink)">X</strong> account.</div>
					<button class="dn-btn" data-action="seed-twitter" type="button" style="flex-shrink:0">Seed from X</button>
				</div>
				<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
					<div style="flex:1;min-width:0;font-size:12.5px;color:var(--nxt-ink-dim)">Distil your repos and commits. Uses your connected <strong style="color:var(--nxt-ink)">GitHub</strong> account.</div>
					<button class="dn-btn" data-action="seed-github" type="button" style="flex-shrink:0">Seed from GitHub</button>
				</div>
				<div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:0">
					<input data-slot="seed-farcaster" type="text" maxlength="50" placeholder="Farcaster username or FID"
						style="padding:8px 11px;border-radius:8px;border:1px solid var(--nxt-stroke);
						background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
					<button class="dn-btn" data-action="seed-farcaster" type="button" style="flex-shrink:0">Seed from Farcaster</button>
				</div>
				<div data-slot="seed-status" style="font-size:12.5px;color:var(--nxt-ink-dim);margin-top:10px;min-height:18px"></div>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);

	const errorEl = overlay.querySelector('[data-slot="error"]');
	const seedStatus = overlay.querySelector('[data-slot="seed-status"]');

	const close = () => overlay.remove();
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	document.addEventListener('keydown', function onKey(e) {
		if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
	});

	overlay.querySelector('[data-action="save-persona"]').addEventListener('click', async () => {
		errorEl.textContent = '';
		const systemPromptVal = overlay.querySelector('[data-slot="system-prompt"]').value.trim();
		const toneVal = overlay.querySelector('[data-slot="tone"]').value.trim();
		const traitsVal = overlay.querySelector('[data-slot="traits"]').value
			.split(',').map((t) => t.trim()).filter(Boolean);

		const saveBtn = overlay.querySelector('[data-action="save-persona"]');
		saveBtn.disabled = true;
		saveBtn.textContent = 'Saving…';
		try {
			const body = {
				persona: {
					system_prompt: systemPromptVal || undefined,
					tone: toneVal || undefined,
					traits: traitsVal.length ? traitsVal : undefined,
				},
			};
			const r = await put(`/api/agents/${encodeURIComponent(agent.id)}`, body);
			const updated = r?.agent || { ...agent, ...body };
			toast('Persona saved');
			close();
			const idx = allAgents.findIndex((a) => a.id === agent.id);
			if (idx >= 0) allAgents[idx] = { ...allAgents[idx], ...updated };
			renderAgents(host, allAgents, avatars, null);
		} catch (err) {
			errorEl.textContent = err?.body?.error || err?.message || 'Save failed';
			saveBtn.disabled = false;
			saveBtn.textContent = 'Save persona';
		}
	});

	const aid = encodeURIComponent(agent.id);
	const SEED_LABELS = { 'seed-twitter': 'Seed from X', 'seed-github': 'Seed from GitHub', 'seed-farcaster': 'Seed from Farcaster' };
	const SOURCE_NAMES = { 'seed-twitter': 'X', 'seed-github': 'GitHub', 'seed-farcaster': 'Farcaster' };

	const seedAction = async (action) => {
		seedStatus.innerHTML = '';

		// X and GitHub seed from the user's connected OAuth account (no handle).
		// Farcaster is public, so it takes a username or FID.
		let endpoint;
		let body;
		if (action === 'seed-twitter') {
			endpoint = `/api/agents/${aid}/memory-seed-x`;
		} else if (action === 'seed-github') {
			endpoint = `/api/agents/${aid}/memory-seed`;
		} else {
			const handle = overlay.querySelector('[data-slot="seed-farcaster"]').value.trim().replace(/^@/, '');
			if (!handle) { seedStatus.style.color = 'var(--nxt-danger)'; seedStatus.textContent = 'Enter a Farcaster username or FID first.'; return; }
			endpoint = `/api/agents/${aid}/memory/seed/farcaster`;
			body = /^\d+$/.test(handle) ? { fid: Number(handle) } : { fname: handle };
		}

		const btn = overlay.querySelector(`[data-action="${action}"]`);
		btn.disabled = true;
		btn.textContent = 'Seeding…';
		seedStatus.style.color = 'var(--nxt-ink-dim)';
		seedStatus.textContent = 'Fetching and distilling memory…';

		try {
			const r = await post(endpoint, body);
			const count = r?.seeded ?? 0;
			seedStatus.style.color = 'var(--nxt-ink)';
			seedStatus.textContent = count > 0
				? `Seeded ${count} ${count === 1 ? 'fact' : 'facts'} from ${SOURCE_NAMES[action]}.`
				: `No new facts found from ${SOURCE_NAMES[action]}.`;
		} catch (err) {
			seedStatus.style.color = 'var(--nxt-danger)';
			// The X/GitHub endpoints require a connected account; guide the user there.
			if (err?.code === 'not_connected' || err?.status === 412) {
				seedStatus.innerHTML = `Connect ${esc(SOURCE_NAMES[action])} to seed from it. `;
				const link = document.createElement('a');
				link.href = '/settings#connected-accounts';
				link.textContent = 'Connect now';
				link.style.color = 'var(--nxt-accent, #6ea8fe)';
				seedStatus.appendChild(link);
			} else if (err?.status === 429) {
				seedStatus.textContent = err?.message || 'Seeding is rate-limited. Try again later.';
			} else {
				seedStatus.textContent = err?.message || err?.body?.error || 'Seeding failed.';
			}
		} finally {
			btn.disabled = false;
			btn.textContent = SEED_LABELS[action];
		}
	};

	overlay.querySelector('[data-action="seed-twitter"]').addEventListener('click', () => seedAction('seed-twitter'));
	overlay.querySelector('[data-action="seed-github"]').addEventListener('click', () => seedAction('seed-github'));
	overlay.querySelector('[data-action="seed-farcaster"]').addEventListener('click', () => seedAction('seed-farcaster'));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeOverlay() {
	const el = document.createElement('div');
	el.style.cssText = `
		position:fixed;inset:0;z-index:1000;
		background:rgba(8,9,14,0.72);backdrop-filter:blur(6px);
		display:grid;place-items:center;padding:20px;
	`;
	return el;
}

function injectStyles() {
	if (document.getElementById('dn-agents-css')) return;
	const css = document.createElement('style');
	css.id = 'dn-agents-css';
	css.textContent = `
		.dn-agents-filter-bar {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 14px;
			flex-wrap: wrap;
		}
		.dn-agents-search-wrap {
			position: relative;
			flex: 1;
			min-width: 180px;
		}
		.dn-agents-search-icon {
			position: absolute;
			left: 12px;
			top: 50%;
			transform: translateY(-50%);
			color: var(--nxt-ink-fade);
			pointer-events: none;
		}
		.dn-agents-search {
			width: 100%;
			padding: 9px 12px 9px 34px;
			background: rgba(255,255,255,0.04);
			border: 1px solid var(--nxt-stroke);
			border-radius: 8px;
			color: var(--nxt-ink);
			font-size: 13px;
			font-family: inherit;
			outline: none;
			transition: border-color 0.14s ease, background 0.14s ease;
		}
		.dn-agents-search::placeholder { color: var(--nxt-ink-fade); }
		.dn-agents-search:focus {
			border-color: var(--nxt-stroke-strong);
			background: rgba(255,255,255,0.06);
		}
		.dn-agents-sort-wrap {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.dn-agents-sort {
			background: rgba(255,255,255,0.04);
			border: 1px solid var(--nxt-stroke);
			border-radius: 8px;
			color: var(--nxt-ink);
			font-size: 12.5px;
			font-family: inherit;
			padding: 8px 10px;
			cursor: pointer;
			outline: none;
			transition: border-color 0.14s ease;
		}
		.dn-agents-sort:focus { border-color: var(--nxt-stroke-strong); }
		.dn-agents-sort option { background: #14151c; color: var(--nxt-ink); }
		.dn-agents-count {
			font-size: 12px;
			color: var(--nxt-ink-fade);
			white-space: nowrap;
			font-variant-numeric: tabular-nums;
		}
		@media (max-width: 600px) {
			.dn-agents-filter-bar { flex-direction: column; align-items: stretch; }
			.dn-agents-sort-wrap { justify-content: space-between; }
		}
		.dn-agent-card {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 16px;
			align-items: start;
		}
		.dn-agent-actions {
			grid-column: 1 / -1;
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
			padding-top: 10px;
			border-top: 1px solid var(--nxt-stroke);
		}
		.dn-agent-actions-primary {
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
		}
		.dn-agent-actions-secondary {
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
			margin-left: auto;
		}
		.dn-agent-links {
			grid-column: 1 / -1;
			display: flex;
			gap: 12px;
			flex-wrap: wrap;
			padding-top: 4px;
		}
		@media (max-width: 600px) {
			.dn-agent-actions {
				flex-direction: column;
				align-items: stretch;
			}
			.dn-agent-actions-primary,
			.dn-agent-actions-secondary {
				justify-content: stretch;
			}
			.dn-agent-actions-primary { order: 0; }
			.dn-agent-actions-secondary { margin-left: 0; order: 1; }
			.dn-agent-actions-primary .dn-btn,
			.dn-agent-actions-secondary .dn-btn {
				flex: 1 1 auto;
				text-align: center;
			}
		}
	`;
	document.head.appendChild(css);
}
