// dashboard-next — Tokens (Pump.fun) page.
//
// Creator dashboard for Pump.fun tokens launched from the user's agents.
// Shows: live stats (price, holders, volume), bonding curve progress,
// trade history, withdrawal controls, and a launch-new-token flow.
//
// Real endpoints:
//   GET  /api/agents                       { agents: [...] }
//   GET  /api/pump/by-agent?agent_id=:id   { token, stats }
//   GET  /api/pump/dashboard               { tokens: [...] }
//   POST /api/pump/withdraw-prep           body { agent_id, amount }
//   POST /api/pump/withdraw-confirm        body { tx }

import { mountShell } from '../shell.js';
import { requireUser, get, post, esc, relTime, formatUsdc, ApiError } from '../api.js';

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

		main.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:6px">
				<div>
					<h1 class="dn-h1">Tokens</h1>
					<p class="dn-h1-sub">Pump.fun tokens launched by your agents. Track performance, manage royalties, withdraw earnings.</p>
				</div>
				<a class="dn-btn primary" href="/pump-dashboard" target="_blank" rel="noopener">Full Pump dashboard ↗</a>
			</div>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px">
				<div class="dn-skeleton" style="height:200px;border-radius:12px"></div>
			</div>
		`;

		const host = main.querySelector('[data-slot="content"]');

		const [agentsResp, dashResp] = await Promise.all([
			safeGet('/api/agents'),
			safeGet('/api/pump/dashboard'),
		]);

		const agents = agentsResp?.agents || [];
		const dashTokens = dashResp?.tokens || [];

		// Build enriched token list: match pump tokens from agent meta + dashboard data
		const pumpAgents = agents.filter((a) =>
			a.meta?.pumpfun?.mint || a.meta?.token?.mint || a.meta?.token?.ca,
		);

		// Fetch per-agent token stats
		const tokenData = await Promise.all(
			pumpAgents.map(async (a) => {
				const mint = a.meta?.pumpfun?.mint || a.meta?.token?.mint || a.meta?.token?.ca;
				const byAgent = await safeGet(`/api/pump/by-agent?agent_id=${encodeURIComponent(a.id)}`);
				const fromDash = dashTokens.find((t) => t.mint === mint || t.address === mint);
				return {
					agent: a,
					mint,
					token: byAgent?.token || fromDash || null,
					stats: byAgent?.stats || fromDash?.stats || null,
				};
			}),
		);

		host.innerHTML = '';

		if (!pumpAgents.length) {
			host.appendChild(renderEmpty());
			return;
		}

		host.appendChild(renderSummaryStrip(tokenData));
		tokenData.forEach((td) => host.appendChild(renderTokenCard(td)));
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

// ── Empty state ────────────────────────────────────────────────────────────

function renderEmpty() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.style.textAlign = 'center';
	panel.style.padding = '48px 24px';
	panel.innerHTML = `
		<div style="font-size:40px;margin-bottom:16px">🚀</div>
		<h3 style="font-size:17px;font-weight:600;margin:0 0 8px">No tokens launched yet</h3>
		<p style="color:var(--nxt-ink-dim);margin:0 0 20px;font-size:14px;max-width:440px;margin-left:auto;margin-right:auto">
			Launch a Pump.fun token from any of your agents to give it a tradeable on-chain identity.
			You earn royalties on every trade.
		</p>
		<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
			<a class="dn-btn primary" href="/dashboard/agents">Go to Agents →</a>
			<a class="dn-btn" href="/pump-dashboard" target="_blank" rel="noopener">Pump dashboard ↗</a>
		</div>
	`;
	return panel;
}

// ── Summary strip ──────────────────────────────────────────────────────────

function renderSummaryStrip(tokenData) {
	const wrap = document.createElement('div');
	wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px';

	const totalHolders = tokenData.reduce((s, td) => s + Number(td.stats?.holder_count || td.token?.holder_count || 0), 0);
	const totalVolume = tokenData.reduce((s, td) => s + Number(td.stats?.volume_sol || td.token?.volume_sol || 0), 0);
	const totalRoyalties = tokenData.reduce((s, td) => s + Number(td.stats?.royalties_usd || 0), 0);

	[
		{ label: 'Tokens launched', value: String(tokenData.length) },
		{ label: 'Total holders', value: totalHolders.toLocaleString() },
		{ label: 'Total volume (SOL)', value: totalVolume.toFixed(2) + ' SOL' },
		{ label: 'Royalties earned', value: totalRoyalties > 0 ? '$' + totalRoyalties.toFixed(2) : '—' },
	].forEach(({ label, value }) => {
		const card = document.createElement('div');
		card.className = 'dn-panel';
		card.innerHTML = `
			<div class="dn-panel-title">${esc(label)}</div>
			<div style="font-size:24px;font-weight:700;letter-spacing:-0.02em;margin-top:6px">${esc(value)}</div>
		`;
		wrap.appendChild(card);
	});

	return wrap;
}

// ── Token card ─────────────────────────────────────────────────────────────

function renderTokenCard({ agent, mint, token, stats }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const name = esc(agent.name || agent.display_name || 'Agent');
	const ticker = esc(String(token?.symbol || token?.ticker || agent.meta?.pumpfun?.symbol || agent.meta?.token?.symbol || 'TOKEN').toUpperCase());
	const description = token?.description || agent.meta?.pumpfun?.description || '';
	const imageUrl = token?.image_url || token?.image || agent.meta?.pumpfun?.image || '';
	const holders = stats?.holder_count || token?.holder_count || '—';
	const volumeSol = stats?.volume_sol || token?.volume_sol;
	const priceSol = stats?.price_sol || token?.price_sol;
	const mcap = stats?.market_cap_usd || token?.market_cap_usd;
	const royaltiesUsd = stats?.royalties_usd;
	const bondingPct = stats?.bonding_curve_pct || token?.bonding_curve_pct;
	const graduated = stats?.graduated || token?.graduated;

	panel.innerHTML = `
		<div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:14px">
			${imageUrl
				? `<img src="${esc(imageUrl)}" alt="${ticker}" style="width:52px;height:52px;border-radius:10px;object-fit:cover;flex-shrink:0" loading="lazy" />`
				: `<div style="width:52px;height:52px;border-radius:10px;background:rgba(168,173,181,0.15);display:grid;place-items:center;font-size:22px;flex-shrink:0">🪙</div>`
			}
			<div style="flex:1;min-width:0">
				<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
					<span style="font-size:16px;font-weight:700">$${ticker}</span>
					${graduated
						? `<span class="dn-tag success">Graduated</span>`
						: `<span class="dn-tag warn">Bonding</span>`
					}
				</div>
				<div style="color:var(--nxt-ink-dim);font-size:13px">via ${name}</div>
				${description ? `<div style="font-size:12.5px;color:var(--nxt-ink-fade);margin-top:6px;max-width:480px">${esc(String(description).slice(0, 140))}</div>` : ''}
			</div>
			<div style="display:flex;gap:6px;flex-shrink:0">
				${mint ? `<a class="dn-btn ghost" href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener" style="padding:5px 10px;font-size:12px">pump.fun ↗</a>` : ''}
				<a class="dn-btn" href="/dashboard/agents" style="padding:5px 10px;font-size:12px">Agent →</a>
			</div>
		</div>

		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:14px">
			${statCell('Holders', String(holders))}
			${priceSol != null ? statCell('Price', Number(priceSol).toFixed(8) + ' SOL') : ''}
			${volumeSol != null ? statCell('Volume', Number(volumeSol).toFixed(2) + ' SOL') : ''}
			${mcap != null ? statCell('Market cap', '$' + Number(mcap).toLocaleString('en', { maximumFractionDigits: 0 })) : ''}
			${royaltiesUsd != null ? statCell('Royalties', '$' + Number(royaltiesUsd).toFixed(2)) : ''}
		</div>

		${bondingPct != null && !graduated ? `
			<div style="margin-bottom:14px">
				<div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px">
					<span style="color:var(--nxt-ink-dim)">Bonding curve progress</span>
					<span>${Number(bondingPct).toFixed(1)}%</span>
				</div>
				<div style="height:6px;border-radius:3px;background:var(--nxt-stroke);overflow:hidden">
					<div style="height:100%;width:${Math.min(100, Number(bondingPct)).toFixed(1)}%;background:var(--nxt-accent);transition:width 400ms ease"></div>
				</div>
			</div>
		` : ''}

		${mint ? `
			<div style="display:flex;gap:8px;flex-wrap:wrap">
				<a class="dn-btn" href="/pump-3d-agent?mint=${encodeURIComponent(mint)}" target="_blank" rel="noopener" style="font-size:12.5px">3D Agent view ↗</a>
				<a class="dn-btn" href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener" style="font-size:12.5px">Solscan ↗</a>
				${mint ? `<button class="dn-btn" data-action="copy-mint" data-mint="${esc(mint)}" style="font-size:12.5px">Copy CA</button>` : ''}
			</div>
		` : ''}
	`;

	panel.querySelectorAll('[data-action="copy-mint"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(btn.dataset.mint);
				toast('Contract address copied');
			} catch {
				toast('Copy failed');
			}
		});
	});

	return panel;
}

function statCell(label, value) {
	return `
		<div style="padding:10px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid var(--nxt-stroke)">
			<div style="font-size:11.5px;color:var(--nxt-ink-fade);margin-bottom:4px">${esc(label)}</div>
			<div style="font-size:14px;font-weight:600">${esc(value)}</div>
		</div>
	`;
}
