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

		main.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:6px">
				<div>
					<h1 class="dn-h1">Agents</h1>
					<p class="dn-h1-sub">On-chain AI identities. Each agent has its own wallet, persona, skills, and payment address.</p>
				</div>
				<button class="dn-btn primary" data-action="create-agent">+ New agent</button>
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

		renderAgents(host, agents, avatars, main);
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
}

function agentCard(a, avatars) {
	const name = esc(a.name || a.display_name || 'Unnamed agent');
	const wallet = a.wallet_address || a.solana_address || '';
	const avatar = avatars.find((av) => av.id === a.avatar_id);
	const avatarThumb = avatar?.thumbnail_url || avatar?.url || '';
	const created = a.created_at ? relTime(a.created_at) : '—';
	const onchain = a.onchain_id || a.erc8004_id || a.chain_id;
	const pumpMint = a.meta?.pumpfun?.mint || a.meta?.token?.mint || a.meta?.token?.ca;

	return `
		<div class="dn-panel" style="display:grid;grid-template-columns:auto 1fr auto;gap:16px;align-items:start" data-agent-id="${esc(a.id)}">
			<div style="
				width:56px;height:56px;border-radius:12px;overflow:hidden;
				background:linear-gradient(135deg,rgba(154,124,255,0.3),rgba(109,193,255,0.2));
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
					${pumpMint ? `<span class="dn-tag" style="font-size:11px;background:rgba(255,180,84,0.12);border-color:rgba(255,180,84,0.28);color:#ffb454">pump.fun</span>` : ''}
				</div>
				${wallet ? `<div style="font-family:${MONO};font-size:12px;color:var(--nxt-ink-fade);margin-bottom:6px">${esc(truncMid(wallet, 8, 6))}</div>` : ''}
				<div style="font-size:12.5px;color:var(--nxt-ink-dim)">Created ${esc(created)}</div>
				${a.persona?.tagline || a.tagline ? `<div style="font-size:13px;color:var(--nxt-ink-dim);margin-top:6px;font-style:italic">${esc((a.persona?.tagline || a.tagline).slice(0, 120))}</div>` : ''}
			</div>

			<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;align-items:flex-end">
				<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
					<a class="dn-btn ghost" href="/app?agent=${encodeURIComponent(a.id)}" target="_blank" rel="noopener" style="padding:5px 10px;font-size:12px">View ↗</a>
					<button class="dn-btn" data-action="edit-agent" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Edit</button>
					<button class="dn-btn" data-action="view-reputation" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Reputation</button>
					<button class="dn-btn danger" data-action="delete-agent" data-id="${esc(a.id)}" style="padding:5px 10px;font-size:12px">Delete</button>
				</div>
				${onchain ? `<a href="/onchain?agent=${encodeURIComponent(a.id)}" style="font-size:11.5px;color:var(--nxt-accent)">ERC-8004 registry ↗</a>` : ''}
				${pumpMint ? `<a href="https://pump.fun/coin/${encodeURIComponent(pumpMint)}" target="_blank" rel="noopener" style="font-size:11.5px;color:#ffb454">View on Pump.fun ↗</a>` : ''}
			</div>
		</div>
	`;
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

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Avatar (optional)</span>
				<select data-slot="avatar"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px">
					<option value="">— No avatar yet —</option>
					${avatars.map((av) => `<option value="${esc(av.id)}">${esc(av.name || av.id)}</option>`).join('')}
				</select>
			</label>

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

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Avatar</span>
				<select data-slot="avatar"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px">
					<option value="">— No avatar —</option>
					${avatars.map((av) => `<option value="${esc(av.id)}"${av.id === currentAvatarId ? ' selected' : ''}>${esc(av.name || av.id)}</option>`).join('')}
				</select>
			</label>

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
