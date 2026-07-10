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
import { openLaunchTokenModal } from '../../pump/launch-token-modal.js';
import { onchainBadgeHTML } from '../../shared/onchain-badge.js';
import { coinChipHTML } from '../../shared/agent-coin.js';
import { walletChipHTML, wireWalletChips } from '../../shared/agent-wallet-chip.js';
import { skeletonHTML, emptyStateHTML, errorStateHTML, attachRetry, ensureStateKitStyles } from '../../shared/state-kit.js';
import { rigBadgeHTML, matchesRigFilter, RIG_FILTERS } from '../../shared/rig-status.js';
ensureStateKitStyles();

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
				<div class="dn-agents-rig-chips" role="tablist" aria-label="Rig filter">
					${RIG_FILTERS.map((f) => `<button type="button" class="dn-agents-rig-chip${f.key === 'all' ? ' active' : ''}" data-action="rig-chip" data-rig="${f.key}" role="tab" aria-selected="${f.key === 'all'}">${f.label}</button>`).join('')}
				</div>
				<span class="dn-agents-count" data-slot="agents-count"></span>
			</div>

			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px"></div>
		`;

		const host = main.querySelector('[data-slot="content"]');
		host.setAttribute('aria-busy', 'true');
		host.innerHTML = skeletonHTML(6, 'row');

		const [agentsResp, avatarsResp] = await Promise.all([
			safeGet('/api/agents'),
			safeGet('/api/avatars?limit=50'),
		]);

		// safeGet returns null only when the request itself failed — a genuinely
		// empty account resolves to { agents: [] }. Distinguish the two so a
		// network failure shows a recoverable error, not a misleading empty state.
		if (agentsResp === null) {
			host.removeAttribute('aria-busy');
			host.innerHTML = errorStateHTML({
				title: "Couldn't load your agents",
				body: 'We could not reach the agents service. Check your connection and try again.',
				scope: 'agents',
			});
			attachRetry(host, () => location.reload());
			return;
		}

		const agents = agentsResp?.agents || [];
		const avatars = avatarsResp?.avatars || [];

		let currentFilter = '';
		let currentSort = 'created-desc';
		let currentRig = 'all';
		const avatarById = new Map(avatars.map((av) => [av.id, av]));

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
			if (currentRig !== 'all') {
				filtered = filtered.filter((a) => matchesRigFilter(avatarById.get(a.avatar_id), currentRig));
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

		function clearAgentFilters() {
			currentFilter = '';
			currentRig = 'all';
			const si = main.querySelector('[data-action="filter-search"]');
			if (si) si.value = '';
			main.querySelectorAll('[data-action="rig-chip"]').forEach((x) => {
				const on = x.getAttribute('data-rig') === 'all';
				x.classList.toggle('active', on);
				x.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			rerender();
		}

		function rerender() {
			const filtered = getFilteredAgents();
			const hasFilter = Boolean(currentFilter) || currentRig !== 'all';
			const countEl = main.querySelector('[data-slot="agents-count"]');
			if (countEl) {
				countEl.textContent = hasFilter
					? `${filtered.length} of ${agents.length} agent${agents.length !== 1 ? 's' : ''}`
					: `${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
			}
			// Filtered down to nothing while agents exist → a distinct "no match"
			// state with a working reset, not the first-run onboarding empty state.
			if (!filtered.length && agents.length) {
				host.removeAttribute('aria-busy');
				host.innerHTML = emptyStateHTML({
					icon: '🔍',
					title: 'No agents match',
					body: 'No agents match your current search or rig filter. Clear them to see all your agents.',
					actions: [{ label: 'Clear filters', id: 'clear-agent-filters', primary: true }],
				});
				host.querySelector('[data-sk-action="clear-agent-filters"]')?.addEventListener('click', clearAgentFilters);
				return;
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

		main.querySelectorAll('[data-action="rig-chip"]').forEach((chip) => {
			chip.addEventListener('click', () => {
				const v = chip.getAttribute('data-rig');
				if (currentRig === v) return;
				currentRig = v;
				main.querySelectorAll('[data-action="rig-chip"]').forEach((x) => {
					const on = x === chip;
					x.classList.toggle('active', on);
					x.setAttribute('aria-selected', on ? 'true' : 'false');
				});
				rerender();
			});
		});

		// Arrow-key roving across the rig-filter tablist (ARIA automatic activation).
		main.querySelectorAll('[role="tablist"]').forEach(wireTablistKeys);

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

// Arrow-key roving across a role="tablist" chip group: move focus and activate
// (ARIA automatic-activation pattern), matching the existing click path.
function wireTablistKeys(container) {
	if (!container) return;
	container.addEventListener('keydown', (e) => {
		if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
		const tabs = [...container.querySelectorAll('[role="tab"]')];
		if (!tabs.length) return;
		const cur = tabs.indexOf(document.activeElement);
		let next;
		if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = tabs.length - 1;
		else if (e.key === 'ArrowRight') next = (cur + 1) % tabs.length;
		else next = (cur - 1 + tabs.length) % tabs.length;
		e.preventDefault();
		tabs[next].focus();
		tabs[next].click();
	});
}

async function safeGet(url) {
	try {
		return await get(url);
	} catch {
		return null;
	}
}

// ── Render agent list ──────────────────────────────────────────────────────

function renderAgents(host, agents, avatars, root) {
	host.removeAttribute('aria-busy');
	if (!agents.length) {
		host.innerHTML = emptyStateHTML({
			icon: '🤖',
			title: 'No agents yet',
			body: 'Agents are AI characters you can embed and chat with — each gets an on-chain identity, its own wallet, and attachable skills.',
			actions: [
				{ label: '+ Create your first agent', id: 'create-first', primary: true },
				{ label: 'Generate its 3D body from text', href: '/create/prompt', id: 'forge-body' },
				{ label: "What's an agent?", href: '/docs/agents-vs-avatars', id: 'learn-agents' },
			],
		});
		host.querySelector('[data-sk-action="create-first"]')?.addEventListener('click', () => {
			openCreateModal(host, agents, avatars);
		});
		return;
	}

	host.innerHTML = agents.map((a) => agentCard(a, avatars)).join('');
	wireWalletChips(host);

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
					const repOpen = !!btn.closest('.dn-panel')?.querySelector('[data-reputation-panel]');
					btn.setAttribute('aria-expanded', repOpen ? 'true' : 'false');
			} catch {
				toast('Reputation data unavailable');
			} finally {
				btn.disabled = false;
				btn.textContent = 'Reputation';
			}
		});
	});

	host.querySelectorAll('[data-action="deploy-onchain"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.id;
			const agent = agents.find((a) => a.id === id);
			if (agent) openDeployOnchainModal(host, agent, avatars, agents);
		});
	});

	host.querySelectorAll('[data-action="deploy-pump"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.id;
			const agent = agents.find((a) => a.id === id);
			if (agent) openDeployPumpModal(agent, avatars);
		});
	});

	host.querySelectorAll('[data-action="screen-caster"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.id;
			const agent = agents.find((a) => a.id === id);
			if (agent) openCasterModal(agent);
		});
	});

	loadInlineReviewStats(host, agents);
	enrichAgentTradingStatus(host, agents);
}

// ── Deploy on-chain (Metaplex Core / ERC-8004) ─────────────────────────────
// Reuses OnchainDeployButton, which drives the full prep → sign → confirm
// pipeline from src/onchain/deploy.js and persists the result server-side via
// /api/agents/onchain/confirm. The button mutates the agent object it's given
// (sets agent.onchain) and renders its own success chip. We watch for that
// mutation, then re-fetch the agents list so every card reflects persisted
// state, matching how Delete refreshes the list after a server mutation.

async function openDeployOnchainModal(host, agent, avatars, allAgents) {
	const [{ OnchainDeployButton }] = await Promise.all([
		import('../../onchain/deploy-button.js'),
		import('../../erc8004/deploy-button.css'),
	]);

	const overlay = makeOverlay();
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Deploy agent on-chain" style="
			width:min(460px,100%);
			background:linear-gradient(180deg,rgba(22,24,32,0.97),rgba(16,17,24,0.97));
			border:1px solid var(--nxt-stroke-strong);border-radius:14px;padding:24px;
			box-shadow:0 20px 60px rgba(0,0,0,0.6);
		">
			<div style="font-size:17px;font-weight:600;margin-bottom:6px">Deploy on-chain</div>
			<div style="font-size:12.5px;color:var(--nxt-ink-dim);margin-bottom:18px">
				Register <strong style="color:var(--nxt-ink)">${esc(agent.name || agent.display_name || 'this agent')}</strong> on-chain. Pick a chain, then sign one transaction in your wallet. The asset becomes the agent's permanent on-chain identity.
			</div>
			<div data-slot="deploy-host" style="display:flex;justify-content:center;margin-bottom:18px"></div>
			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button class="dn-btn ghost" data-action="cancel">Close</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	const deployHost = overlay.querySelector('[data-slot="deploy-host"]');
	// Pass a thin agent shape the deploy pipeline understands. The button writes
	// `deployAgentObj.onchain` on success — that's our completion signal.
	const deployAgentObj = {
		id: agent.id,
		name: agent.name || agent.display_name || 'Agent',
		description: agent.description || agent.persona?.tagline || agent.tagline || '',
		avatar_id: agent.avatar_id || null,
		skills: Array.isArray(agent.skills) && agent.skills.length ? agent.skills : undefined,
		onchain: agent.onchain || null,
	};
	const deployBtn = new OnchainDeployButton({ agent: deployAgentObj, container: deployHost });
	deployBtn.mount();

	let deployed = false;
	const finish = async () => {
		if (!deployed) return;
		toast('Agent deployed on-chain');
		// Re-fetch so the card reflects the record persisted by the confirm endpoint.
		const fresh = (await safeGet('/api/agents'))?.agents;
		const next =
			Array.isArray(fresh) && fresh.length
				? fresh
				: allAgents.map((a) =>
						a.id === agent.id ? { ...a, onchain: deployAgentObj.onchain } : a,
					);
		renderAgents(host, next, avatars, null);
	};

	const close = async () => {
		deployBtn.unmount();
		overlay.remove();
		document.removeEventListener('keydown', onKey);
		await finish();
	};
	function onKey(e) {
		if (e.key === 'Escape') close();
	}

	// The button has no success event, so observe its internal success chip:
	// it sets `deployAgentObj.onchain` and swaps in `.deploy-chip--success`.
	const observer = new MutationObserver(() => {
		if (deployAgentObj.onchain && deployHost.querySelector('.deploy-chip--success')) {
			deployed = true;
		}
	});
	observer.observe(deployHost, { childList: true, subtree: true });

	overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {
		observer.disconnect();
		close();
	});
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) {
			observer.disconnect();
			close();
		}
	});
	document.addEventListener('keydown', onKey);
}

// ── Deploy Pump.fun token ──────────────────────────────────────────────────
// Reuses the existing launch-token-modal. If the agent isn't on Solana yet the
// modal runs its deploy step first (needsDeploy), then launches the token. The
// modal persists via /api/agents/tokens/launch-confirm and reloads on success.

function openDeployPumpModal(agent, avatars) {
	const avatar = avatars.find((av) => av.id === agent.avatar_id);
	const imageUrl = avatar?.thumbnail_url || avatar?.url || agent.meta?.thumbnail_url || '';
	const onchain = agent.onchain || agent.meta?.onchain || null;
	const needsDeploy = !onchain || onchain.family !== 'solana';
	openLaunchTokenModal({
		agentId: agent.id,
		agentName: agent.name || agent.display_name || 'Agent',
		imageUrl,
		needsDeploy,
		agentForDeploy: needsDeploy
			? {
					id: agent.id,
					name: agent.name || agent.display_name || 'Agent',
					description: agent.description || agent.persona?.tagline || agent.tagline || '',
					avatar_id: agent.avatar_id || null,
					skills:
						Array.isArray(agent.skills) && agent.skills.length
							? agent.skills
							: undefined,
				}
			: null,
	});
}

const BRAIN_LABELS = {
	'claude-sonnet-4-6': 'Claude Sonnet 4.6',
	'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
	'claude-opus-4-6': 'Claude Opus 4.6',
	'claude-opus-4-7': 'Claude Opus 4.7',
	'llama-3.3-70b-versatile': 'Llama 3.3 70B · Groq',
	'llama-3.1-8b-instant': 'Llama 3.1 8B · Groq',
	'meta-llama/llama-3.3-70b-instruct:free': 'Llama 3.3 70B · OpenRouter',
	'meta-llama/llama-3.1-8b-instruct:free': 'Llama 3.1 8B · OpenRouter',
	'openai/gpt-oss-120b:free': 'GPT-OSS 120B · OpenRouter',
	'nousresearch/hermes-3-llama-3.1-405b:free': 'Hermes 3 405B · OpenRouter',
};

function brainLabel(agent) {
	const model = agent.meta?.brain?.model;
	if (!model) return 'Llama 3.3 70B · OpenRouter'; // runtime default
	return BRAIN_LABELS[model] || model.split('/').pop() || model;
}

function agentCard(a, avatars) {
	const name = esc(a.name || a.display_name || 'Unnamed agent');
	const avatar = avatars.find((av) => av.id === a.avatar_id);
	const avatarThumb = avatar?.thumbnail_url || avatar?.url || '';
	const created = a.created_at ? relTime(a.created_at) : '—';
	const onchainBadge = onchainBadgeHTML(a);
	const onchain = a.onchain || a.meta?.onchain || null;
	const pumpMint = a.meta?.pumpfun?.mint || a.meta?.token?.mint || a.meta?.token?.ca;
	const brain = brainLabel(a);

	return `
		<div class="dn-panel dn-agent-card" data-agent-id="${esc(a.id)}">
			<div style="
				width:56px;height:56px;border-radius:12px;overflow:hidden;
				background:linear-gradient(135deg,rgba(140,143,150,0.3),rgba(100,103,110,0.2));
				display:grid;place-items:center;flex-shrink:0;border:1px solid var(--nxt-stroke);
			">
				${
					avatarThumb
						? `<img src="${esc(avatarThumb)}" alt="${name}" style="width:100%;height:100%;object-fit:cover" loading="lazy" />`
						: `<svg width="28" height="28" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="color:var(--nxt-ink-dim)"><rect x="5" y="2" width="10" height="10" rx="2"/><circle cx="8" cy="6.5" r="1"/><circle cx="12" cy="6.5" r="1"/><path d="M8 9h4M3 14l2-2h10l2 2v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3z"/></svg>`
				}
			</div>

			<div style="min-width:0">
				<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
					<span style="font-size:15px;font-weight:600;color:var(--nxt-ink)">${name}</span>
					${onchainBadge || `<span class="dn-tag" style="font-size:11px">off-chain</span>`}
					${a.avatar_id ? rigBadgeHTML(avatar, { size: 'sm' }) : ''}
					${coinChipHTML(a, { launchable: false })}
				</div>
				<div style="margin-bottom:6px">${walletChipHTML(a, { isOwner: true, showPending: false, dense: true })}</div>
				<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;color:var(--nxt-ink-dim)">
					<span>Created ${esc(created)}</span>
					<span style="display:inline-flex;align-items:center;gap:4px">
						<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.55"><circle cx="8" cy="8" r="5.5"/><path d="M5 8h6M8 5v6"/></svg>
						<a href="/dashboard/library#tab=brain" style="color:inherit;text-decoration:none" title="Configure brain">${esc(brain)}</a>
					</span>
				</div>
				${a.persona?.tagline || a.tagline ? `<div style="font-size:13px;color:var(--nxt-ink-dim);margin-top:6px;font-style:italic">${esc((a.persona?.tagline || a.tagline).slice(0, 120))}</div>` : ''}
				<div data-trading-slot style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"></div>
			</div>

			<div class="dn-agent-actions">
				<div class="dn-agent-actions-primary">
					${a.avatar_id ? `<a class="dn-btn" href="/avatars/${encodeURIComponent(a.avatar_id)}" target="_blank" rel="noopener" style="padding:5px 10px;font-size:12px">Live page ↗</a>` : ''}
					<a class="dn-btn" href="/app?agent=${encodeURIComponent(a.id)}" target="_blank" rel="noopener" style="padding:5px 10px;font-size:12px">3D Studio ↗</a>
					<a class="dn-btn" href="/embed?avatar=${encodeURIComponent(a.id)}&mode=chat" target="_blank" rel="noopener" style="padding:5px 10px;font-size:12px">Embed wizard ↗</a>
				</div>
				<div class="dn-agent-actions-secondary">
					<button class="dn-btn ghost" data-action="edit-agent" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Edit</button>
					<button class="dn-btn ghost" data-action="persona-agent" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Persona</button>
					<a class="dn-btn ghost" href="/dashboard/library#tab=brain" style="padding:5px 10px;font-size:12px;text-decoration:none">Brain</a>
					<button class="dn-btn ghost" data-action="view-reputation" data-id="${esc(a.id)}" aria-expanded="false" style="padding:5px 10px;font-size:12px">Reputation</button>
					${onchain ? '' : `<button class="dn-btn ghost" data-action="deploy-onchain" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Deploy onchain</button>`}
					${pumpMint ? '' : `<button class="dn-btn ghost" data-action="deploy-pump" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Deploy Pump.fun</button>`}
					<button class="dn-btn ghost" data-action="screen-caster" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px" title="Get screen caster credentials">
						<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;vertical-align:-1px"><rect x="1" y="2.5" width="14" height="9" rx="1.5"/><path d="M5.5 13.5h5M8 11.5v2"/></svg>Screen
					</button>
					<button class="dn-btn ghost danger" data-action="delete-agent" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Delete</button>
				</div>
			</div>

			${
				onchain || pumpMint
					? `
				<div class="dn-agent-links">
					${onchain ? `<a href="/discover" style="font-size:11.5px;color:var(--nxt-ink-dim)">ERC-8004 registry ↗</a>` : ''}
					${pumpMint ? `<a href="https://pump.fun/coin/${encodeURIComponent(pumpMint)}" target="_blank" rel="noopener" style="font-size:11.5px;color:#a8adb5">View on Pump.fun ↗</a>` : ''}
				</div>
			`
					: ''
			}
		</div>
	`;
}

async function loadInlineReviewStats(host, agents) {
	const published = agents.filter((a) => a.is_published);
	if (!published.length) return;
	const results = await Promise.allSettled(
		published.map((a) =>
			fetch(`/api/marketplace/agents/${encodeURIComponent(a.id)}/reviews`, {
				credentials: 'include',
			})
				.then((r) => (r.ok ? r.json() : null))
				.then((j) => ({ id: a.id, summary: j?.data?.summary })),
		),
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
		badge.style.cssText =
			'font-size:11px;background:rgba(251,191,36,0.12);border-color:rgba(251,191,36,0.3);color:#fbbf24';
		badge.textContent = `★ ${avg.toFixed(1)} (${count})`;
		badge.title = `${avg.toFixed(2)} avg from ${count} review${count === 1 ? '' : 's'}`;
		const nameRow = card.querySelector('div > div:nth-child(2) > div:first-child');
		if (nameRow) nameRow.appendChild(badge);
	}
}

async function enrichAgentTradingStatus(host, agents) {
	if (!agents.length) return;
	const [oracleRes, sniperRes] = await Promise.allSettled([
		fetch('/api/oracle/leaderboard?network=mainnet&limit=50&min_actions=1', { credentials: 'include' })
			.then((r) => r.ok ? r.json() : null).catch(() => null),
		fetch('/api/sniper/strategy', { credentials: 'include' })
			.then((r) => r.ok ? r.json() : null).catch(() => null),
	]);

	const oracleMap = new Map();
	const oracleAgents = oracleRes.status === 'fulfilled' && oracleRes.value?.agents ? oracleRes.value.agents : [];
	for (const a of oracleAgents) oracleMap.set(a.agent_id, a);

	const sniperMap = new Map();
	const sniperStrats = sniperRes.status === 'fulfilled' && sniperRes.value?.strategies ? sniperRes.value.strategies : [];
	for (const s of sniperStrats) sniperMap.set(s.agent_id, s);

	for (const agent of agents) {
		const card = host.querySelector(`[data-agent-id="${agent.id}"]`);
		const slot = card?.querySelector('[data-trading-slot]');
		if (!slot) continue;

		const oracle = oracleMap.get(agent.id);
		const sniper = sniperMap.get(agent.id);

		if (!oracle && !sniper) continue;

		const badges = [];

		if (oracle) {
			const wrStr = oracle.win_rate != null ? `${oracle.win_rate}%` : '—';
			const pnl = Number(oracle.realized_pnl_sol || 0);
			const pnlStr = pnl !== 0 ? ` · ${pnl >= 0 ? '+' : ''}${Math.abs(pnl) < 0.01 ? pnl.toFixed(4) : pnl.toFixed(3)} ◎` : '';
			const winColor = (oracle.win_rate || 0) >= 50 ? '#a78bfa' : '#f87171';
			badges.push(`<a href="/oracle#agent" style="
				display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
				padding:3px 9px;border-radius:999px;text-decoration:none;
				border:1px solid rgba(167,139,250,0.35);
				background:rgba(167,139,250,0.08);color:#a78bfa;" title="Oracle conviction track record">
				<span style="color:${winColor}">${wrStr}</span>
				<span style="opacity:0.7;font-size:10px">oracle${pnlStr}</span>
			</a>`);
		}

		if (sniper && sniper.enabled && !sniper.kill_switch) {
			const pnlLam = BigInt(sniper.summary?.realized_pnl_lamports || '0');
			const pnl = Number(pnlLam) / 1e9;
			const pnlStr = pnl !== 0 ? `${pnl >= 0 ? '+' : ''}${Math.abs(pnl) < 0.01 ? pnl.toFixed(4) : pnl.toFixed(3)} ◎` : '0 ◎';
			const pnlColor = pnl >= 0 ? '#34d399' : '#f87171';
			badges.push(`<a href="/dashboard/sniper" style="
				display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
				padding:3px 9px;border-radius:999px;text-decoration:none;
				border:1px solid rgba(52,211,153,0.35);
				background:rgba(52,211,153,0.07);color:#34d399;" title="Sniper strategy active">
				<span style="color:${pnlColor}">${pnlStr}</span>
				<span style="opacity:0.7;font-size:10px">sniper</span>
			</a>`);
		}

		if (badges.length) slot.innerHTML = badges.join('');
	}
}

function showReputationPanel(card, rep) {
	const existing = card.querySelector('[data-reputation-panel]');
	if (existing) {
		existing.remove();
		return;
	}
	// Unified wallet-trust score (0–100) from /api/agents/:id/reputation.
	const isNew = rep?.isNew === true;
	const score = typeof rep?.score === 'number' ? rep.score : null;
	const tier = rep?.tierLabel || rep?.tier || null;
	const accent = rep?.accent || 'var(--nxt-accent, #c4b5fd)';
	const totals = rep?.totals || {};
	const panel = document.createElement('div');
	panel.setAttribute('data-reputation-panel', 'true');
	panel.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid var(--nxt-stroke)';
	const pillars = Array.isArray(rep?.pillars) ? rep.pillars : [];
	panel.innerHTML = `
		<div style="font-size:12.5px;font-weight:600;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Wallet trust</div>
		${
			isNew
				? `<div style="color:var(--nxt-ink-dim);font-size:13px">New agent — no track record yet. Trust is earned through real activity.</div>`
				: score !== null
					? `<div style="display:flex;align-items:baseline;gap:8px">
					<span style="font-size:32px;font-weight:700;color:var(--nxt-ink)">${Math.round(score)}</span>
					<span style="font-size:13px;color:var(--nxt-ink-dim)">/ 100 · <span style="color:${esc(accent)};font-weight:600">${esc(tier || '')}</span></span>
				</div>
				<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
					${[`$${fmtNum(totals.settled_usd)} volume`, `${totals.distinct_tippers || 0} tippers`, `${totals.confirmed_payments || 0} payments`, `${totals.fork_count || 0} forks`, totals.verified ? '✓ verified' : '']
						.filter(Boolean)
						.map((t) => `<span class="dn-tag">${esc(t)}</span>`)
						.join('')}
				</div>
				${
					pillars.length
						? `<div style="margin-top:12px;display:flex;flex-direction:column;gap:7px">${pillars
								.map(
									(p) =>
										`<div><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--nxt-ink-dim);margin-bottom:3px"><span>${esc(p.label)}</span><span>${p.points}/${p.max}</span></div><div style="height:4px;border-radius:2px;background:var(--nxt-stroke);overflow:hidden"><div style="height:100%;width:${Math.round((p.points / (p.max || 25)) * 100)}%;background:${esc(accent)}"></div></div></div>`,
								)
								.join('')}</div>`
						: ''
				}
				<a href="/agent/${encodeURIComponent(rep.agent_id || '')}/wallet#reputation" style="display:inline-block;margin-top:12px;font-size:12.5px;color:${esc(accent)};text-decoration:none">View full breakdown →</a>`
					: `<div style="color:var(--nxt-ink-dim);font-size:13px">Trust score unavailable right now.</div>`
		}
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
				thumbEl.innerHTML = `<img loading="lazy" decoding="async" src="${esc(picked.thumbnail_url)}" alt="${esc(picked.name || picked.id || 'Avatar')}" style="width:100%;height:100%;object-fit:cover" />`;
			}
			labelEl.textContent = picked.name || picked.id;
		}
	});

	const close = () => overlay.remove();
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});
	document.addEventListener('keydown', function onKey(e) {
		if (e.key === 'Escape') {
			close();
			document.removeEventListener('keydown', onKey);
		}
	});

	submitBtn.addEventListener('click', async () => {
		const name = nameEl.value.trim();
		if (!name) {
			errorEl.textContent = 'Agent name is required.';
			return;
		}
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
								? `<img loading="lazy" decoding="async" src="${esc(av.thumbnail_url)}" alt="${esc(av.name || av.id || 'Avatar')}" style="width:100%;height:100%;object-fit:cover" />`
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
				thumbEl.innerHTML = `<img loading="lazy" decoding="async" src="${esc(picked.thumbnail_url)}" alt="${esc(picked.name || picked.id || 'Avatar')}" style="width:100%;height:100%;object-fit:cover" />`;
			}
			labelEl.textContent = picked.name || picked.id;
		}
	});

	const close = () => overlay.remove();
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});
	document.addEventListener('keydown', function onKey(e) {
		if (e.key === 'Escape') {
			close();
			document.removeEventListener('keydown', onKey);
		}
	});

	submitBtn.addEventListener('click', async () => {
		const name = nameEl.value.trim();
		if (!name) {
			errorEl.textContent = 'Agent name is required.';
			return;
		}
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
	const traits = Array.isArray(persona.traits) ? persona.traits.join(', ') : persona.traits || '';

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
					<input data-slot="seed-farcaster" type="text" maxlength="50" placeholder="Farcaster username or FID" aria-label="Farcaster username or FID"
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
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});
	document.addEventListener('keydown', function onKey(e) {
		if (e.key === 'Escape') {
			close();
			document.removeEventListener('keydown', onKey);
		}
	});

	overlay.querySelector('[data-action="save-persona"]').addEventListener('click', async () => {
		errorEl.textContent = '';
		const systemPromptVal = overlay.querySelector('[data-slot="system-prompt"]').value.trim();
		const toneVal = overlay.querySelector('[data-slot="tone"]').value.trim();
		const traitsVal = overlay
			.querySelector('[data-slot="traits"]')
			.value.split(',')
			.map((t) => t.trim())
			.filter(Boolean);

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
	const SEED_LABELS = {
		'seed-twitter': 'Seed from X',
		'seed-github': 'Seed from GitHub',
		'seed-farcaster': 'Seed from Farcaster',
	};
	const SOURCE_NAMES = {
		'seed-twitter': 'X',
		'seed-github': 'GitHub',
		'seed-farcaster': 'Farcaster',
	};

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
			const handle = overlay
				.querySelector('[data-slot="seed-farcaster"]')
				.value.trim()
				.replace(/^@/, '');
			if (!handle) {
				seedStatus.style.color = 'var(--nxt-danger)';
				seedStatus.textContent = 'Enter a Farcaster username or FID first.';
				return;
			}
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
			seedStatus.textContent =
				count > 0
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
				seedStatus.textContent =
					err?.message || 'Seeding is rate-limited. Try again later.';
			} else {
				seedStatus.textContent = err?.message || err?.body?.error || 'Seeding failed.';
			}
		} finally {
			btn.disabled = false;
			btn.textContent = SEED_LABELS[action];
		}
	};

	overlay
		.querySelector('[data-action="seed-twitter"]')
		.addEventListener('click', () => seedAction('seed-twitter'));
	overlay
		.querySelector('[data-action="seed-github"]')
		.addEventListener('click', () => seedAction('seed-github'));
	overlay
		.querySelector('[data-action="seed-farcaster"]')
		.addEventListener('click', () => seedAction('seed-farcaster'));
}

// ── Screen Caster setup modal ──────────────────────────────────────────────

async function openCasterModal(agent) {
	const overlay = makeOverlay();
	const name = esc(agent.name || agent.display_name || 'Agent');

	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Screen Caster setup" style="
			width:min(580px,100%);
			background:linear-gradient(180deg,rgba(22,24,32,0.98),rgba(14,15,22,0.98));
			border:1px solid var(--nxt-stroke-strong);border-radius:16px;padding:28px;
			box-shadow:0 24px 80px rgba(0,0,0,0.7);
		">
			<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px">
				<div>
					<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
						<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="color:var(--nxt-accent,#c4b5fd);flex-shrink:0"><rect x="1" y="3" width="18" height="12" rx="2"/><path d="M7 17h6M10 15v2"/><circle cx="7" cy="9" r="1.2" fill="currentColor" stroke="none"/><path d="M9.2 9h5.8M9.2 11.5h4"/></svg>
						<span style="font-size:17px;font-weight:600">Screen Caster</span>
					</div>
					<p style="font-size:13px;color:var(--nxt-ink-dim);margin:0">
						Run a Playwright browser that streams live screenshots for <strong style="color:var(--nxt-ink)">${name}</strong>.
						Generate credentials once, deploy anywhere Docker runs.
					</p>
				</div>
				<button data-action="close" aria-label="Close" style="
					flex-shrink:0;background:none;border:none;cursor:pointer;
					color:var(--nxt-ink-fade);padding:4px;border-radius:6px;
					transition:color 120ms ease;
				" onmouseenter="this.style.color='var(--nxt-ink)'" onmouseleave="this.style.color='var(--nxt-ink-fade)'">
					<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
				</button>
			</div>

			<div data-slot="body">
				<div style="
					display:flex;align-items:center;justify-content:center;gap:10px;
					padding:32px;color:var(--nxt-ink-dim);font-size:13px;
				">
					<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="animation:dn-spin 1s linear infinite;flex-shrink:0"><path d="M21 12a9 9 0 11-9-9c2.01 0 3.86.67 5.36 1.8"/></svg>
					Generating credentials…
				</div>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);

	const close = () => overlay.remove();
	overlay.querySelector('[data-action="close"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	document.addEventListener('keydown', function onKey(e) {
		if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
	});

	const bodySlot = overlay.querySelector('[data-slot="body"]');

	try {
		const resp = await post('/api/agent/caster-config', { agentId: agent.id });
		const { envBlock, dockerCmd, prefix } = resp;

		bodySlot.innerHTML = `
			<div style="
				display:flex;align-items:center;gap:8px;padding:10px 14px;
				border-radius:8px;background:rgba(52,211,153,0.08);
				border:1px solid rgba(52,211,153,0.2);margin-bottom:18px;
			">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#34d399" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="2.5 8.5 6 12 13.5 4.5"/></svg>
				<span style="font-size:12.5px;color:#34d399">API key created</span>
				<code style="
					margin-left:auto;font-size:11px;padding:2px 8px;
					background:rgba(52,211,153,0.1);border-radius:4px;
					color:#34d399;letter-spacing:0.03em;
				">${esc(prefix)}…</code>
			</div>

			<div style="margin-bottom:16px">
				<div style="
					display:flex;align-items:center;justify-content:space-between;
					margin-bottom:6px;
				">
					<span style="font-size:12px;font-weight:600;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.06em">.env</span>
					<button data-copy="env" style="
						background:none;border:1px solid var(--nxt-stroke);border-radius:6px;
						color:var(--nxt-ink-dim);font:inherit;font-size:11.5px;cursor:pointer;
						padding:3px 10px;transition:color 120ms,border-color 120ms;
					">Copy</button>
				</div>
				<pre data-block="env" style="
					margin:0;padding:14px 16px;border-radius:10px;overflow-x:auto;
					background:rgba(0,0,0,0.35);border:1px solid var(--nxt-stroke);
					font-size:12px;line-height:1.7;color:#e2e8f0;
					font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
					white-space:pre;
				">${esc(envBlock)}</pre>
			</div>

			<div style="margin-bottom:20px">
				<div style="
					display:flex;align-items:center;justify-content:space-between;
					margin-bottom:6px;
				">
					<span style="font-size:12px;font-weight:600;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.06em">Docker run</span>
					<button data-copy="docker" style="
						background:none;border:1px solid var(--nxt-stroke);border-radius:6px;
						color:var(--nxt-ink-dim);font:inherit;font-size:11.5px;cursor:pointer;
						padding:3px 10px;transition:color 120ms,border-color 120ms;
					">Copy</button>
				</div>
				<pre data-block="docker" style="
					margin:0;padding:14px 16px;border-radius:10px;overflow-x:auto;
					background:rgba(0,0,0,0.35);border:1px solid var(--nxt-stroke);
					font-size:12px;line-height:1.7;color:#e2e8f0;
					font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
					white-space:pre;
				">${esc(dockerCmd)}</pre>
			</div>

			<div style="
				display:flex;flex-direction:column;gap:6px;padding:12px 14px;
				border-radius:8px;background:rgba(255,255,255,0.02);
				border:1px solid var(--nxt-stroke);font-size:12.5px;color:var(--nxt-ink-dim);
			">
				<div style="font-weight:600;color:var(--nxt-ink-fade);margin-bottom:2px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.06em">Deploy anywhere Docker runs</div>
				<div style="display:flex;align-items:baseline;gap:6px"><span style="color:var(--nxt-ink);font-weight:500;min-width:80px">Railway</span><span><a href="https://railway.app" target="_blank" rel="noopener" style="color:var(--nxt-accent,#c4b5fd)">railway.app</a> → New Project → Deploy Docker Image</span></div>
				<div style="display:flex;align-items:baseline;gap:6px"><span style="color:var(--nxt-ink);font-weight:500;min-width:80px">Fly.io</span><span><code style="font-size:11px">fly launch --image three-ws/agent-screen-caster</code></span></div>
				<div style="display:flex;align-items:baseline;gap:6px"><span style="color:var(--nxt-ink);font-weight:500;min-width:80px">Cloud Run</span><span>Container → set env vars → deploy</span></div>
				<div style="display:flex;align-items:baseline;gap:6px"><span style="color:var(--nxt-ink);font-weight:500;min-width:80px">Local</span><span><code style="font-size:11px">npm install && npm start</code> inside <code style="font-size:11px">services/agent-screen-caster/</code></span></div>
			</div>

			<div style="display:flex;justify-content:space-between;align-items:center;margin-top:18px;gap:12px;flex-wrap:wrap">
				<a href="/dashboard-next/watch?agentId=${encodeURIComponent(agent.id)}" target="_blank" rel="noopener" style="
					font-size:12.5px;color:var(--nxt-accent,#c4b5fd);text-decoration:none;
					display:inline-flex;align-items:center;gap:5px;
				">
					<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3C4.5 3 1.5 6 1.5 8s3 5 6.5 5 6.5-3 6.5-5-3-5-6.5-5z"/><circle cx="8" cy="8" r="2"/></svg>
					Preview watch panel ↗
				</a>
				<button data-action="close-done" class="dn-btn primary" style="font-size:13px;padding:7px 18px">Done</button>
			</div>
		`;

		bodySlot.querySelector('[data-action="close-done"]').addEventListener('click', close);

		bodySlot.querySelectorAll('[data-copy]').forEach((btn) => {
			const key = btn.dataset.copy;
			const pre = bodySlot.querySelector(`[data-block="${key}"]`);
			btn.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(pre.textContent);
					btn.textContent = 'Copied!';
					btn.style.color = '#34d399';
					btn.style.borderColor = 'rgba(52,211,153,0.4)';
					setTimeout(() => {
						btn.textContent = 'Copy';
						btn.style.color = '';
						btn.style.borderColor = '';
					}, 1800);
				} catch {
					toast('Copy failed — select and copy manually');
				}
			});
		});

	} catch (err) {
		bodySlot.innerHTML = `
			<div style="
				padding:16px;border-radius:8px;background:rgba(248,113,113,0.08);
				border:1px solid rgba(248,113,113,0.2);color:#f87171;font-size:13px;
			">${esc(err?.body?.error || err?.message || 'Failed to generate credentials. Try again.')}</div>
			<div style="display:flex;justify-content:flex-end;margin-top:14px">
				<button data-action="close" class="dn-btn ghost" style="font-size:13px">Close</button>
			</div>
		`;
		bodySlot.querySelector('[data-action="close"]').addEventListener('click', close);
	}
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
		.dn-agents-rig-chips { display: flex; gap: 4px; flex-wrap: wrap; }
		.dn-agents-rig-chip {
			padding: 7px 11px;
			background: rgba(255,255,255,0.04);
			border: 1px solid var(--nxt-stroke);
			border-radius: 8px;
			color: var(--nxt-ink-dim);
			font-size: 12.5px;
			font-family: inherit;
			cursor: pointer;
			transition: color 0.14s ease, background 0.14s ease, border-color 0.14s ease;
		}
		.dn-agents-rig-chip:hover { color: var(--nxt-ink); background: rgba(255,255,255,0.06); }
		.dn-agents-rig-chip.active { color: var(--nxt-ink); border-color: var(--nxt-stroke-strong); background: rgba(255,255,255,0.08); }
		.dn-agents-count {
			font-size: 12px;
			color: var(--nxt-ink-fade);
			white-space: nowrap;
			font-variant-numeric: tabular-nums;
		}
		@keyframes dn-spin { to { transform: rotate(360deg); } }
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

		/* Keyboard focus rings — tokens only */
		.dn-agents-rig-chip:focus-visible,
		.dn-agents-search:focus-visible,
		.dn-agents-sort:focus-visible {
			outline: 2px solid var(--nxt-accent);
			outline-offset: 2px;
		}

		/* Card enter — subtle. No fill-mode so any panel hover state still wins. */
		@keyframes dn-agent-card-in {
			from { opacity: 0; transform: translateY(6px); }
			to   { opacity: 1; transform: translateY(0); }
		}
		.dn-agent-card { animation: dn-agent-card-in 240ms ease; }

		@media (prefers-reduced-motion: reduce) {
			.dn-agent-card { animation: none; }
			svg[style*="dn-spin"] { animation: none !important; }
		}
	`;
	document.head.appendChild(css);
}
