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
import { requireUser, get, esc, ApiError } from '../api.js';
import { errorStateHTML, emptyStateHTML, ensureStateKitStyles, attachRetry } from '../../shared/state-kit.js';

// Page-scoped polish that the shared shell CSS doesn't cover: keyboard focus
// rings on this page's custom controls, stat-cell hover feedback, and a
// reduced-motion guard. Injected once, idempotent.
const TOKENS_STYLE_ID = 'dn-tokens-styles';
function ensureTokensStyles() {
	if (typeof document === 'undefined' || document.getElementById(TOKENS_STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = TOKENS_STYLE_ID;
	style.textContent = `
		.tk-stat { transition: border-color .14s ease, background .14s ease; }
		.tk-stat:hover { border-color: var(--nxt-stroke-strong); }
		.tk-card .dn-btn:focus-visible,
		.tk-card a:focus-visible,
		.tk-dialog button:focus-visible,
		.tk-copy:focus-visible {
			outline: 2px solid var(--nxt-accent); outline-offset: 2px; border-radius: var(--nxt-radius-sm);
		}
		.tk-copy.is-copied { color: var(--nxt-ink); border-color: var(--nxt-stroke-strong); }
		@media (prefers-reduced-motion: reduce) {
			.tk-stat, .tk-bond-fill { transition: none !important; }
		}
	`;
	(document.head || document.documentElement).appendChild(style);
}

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
		ensureTokensStyles();

		main.innerHTML = `
			<header style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:6px">
				<div>
					<h1 class="dn-h1">Tokens</h1>
					<p class="dn-h1-sub">Pump.fun tokens launched by your agents. Track performance, manage royalties, withdraw earnings.</p>
				</div>
				<a class="dn-btn primary" href="/pump-dashboard">Open Token Cockpit →</a>
			</header>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px">${skeletonMarkup()}</div>
		`;

		const host = main.querySelector('[data-slot="content"]');

		await loadTokens(host);
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else {
			throw err;
		}
	}
})();

// Structured skeleton mirroring the real layout (summary strip + token cards)
// so the loading frame reads as content, never a spinner.
function skeletonMarkup() {
	const stat = `<div class="dn-skeleton" style="height:78px;border-radius:var(--nxt-radius)"></div>`;
	const strip = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">${stat.repeat(4)}</div>`;
	const card = `<div class="dn-skeleton" style="height:220px;border-radius:var(--nxt-radius)"></div>`;
	return `<div style="display:flex;flex-direction:column;gap:16px" aria-hidden="true">${strip}${card}${card}</div>`;
}

async function loadTokens(host) {
	host.innerHTML = skeletonMarkup();

	const [agentsSettled, dashSettled] = await Promise.allSettled([
		get('/api/agents'),
		get('/api/pump/dashboard'),
	]);

	if (agentsSettled.status === 'rejected'
		&& agentsSettled.reason instanceof ApiError
		&& agentsSettled.reason.status === 401) {
		location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		return;
	}

	// Both primary surfaces failing means the network is down — render a retryable
	// error rather than renderEmpty(), which would wrongly read as "no tokens".
	if (agentsSettled.status === 'rejected' && dashSettled.status === 'rejected') {
		ensureStateKitStyles();
		host.innerHTML = errorStateHTML({
			title: "Couldn't load your tokens",
			body: 'We had trouble reaching the token service. Check your connection and try again.',
		});
		attachRetry(host, () => loadTokens(host));
		return;
	}

	const agents = (agentsSettled.status === 'fulfilled' ? agentsSettled.value?.agents : null) || [];
	const dashTokens = (dashSettled.status === 'fulfilled' ? dashSettled.value?.tokens : null) || [];

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
				mint: mint || byAgent?.data?.mint || null,
				token: byAgent?.token || fromDash || null,
				stats: byAgent?.stats || fromDash?.stats || null,
				coin: byAgent?.data || null, // { agent_authority, network, symbol, name, sharing_config }
			};
		}),
	);

	host.innerHTML = '';

	if (!pumpAgents.length) {
		host.appendChild(renderEmpty());
		return;
	}

	host.appendChild(renderSummaryStrip(tokenData));
	const cards = tokenData.map((td) => { const el = renderTokenCard(td); host.appendChild(el); return { el, mint: td.mint }; });
	enrichTokenCardsOracle(cards);
}

async function safeGet(url) {
	try { return await get(url); }
	catch { return null; }
}

// ── Empty state ────────────────────────────────────────────────────────────

function renderEmpty() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = emptyStateHTML({
		icon: '🚀',
		title: 'No tokens launched yet',
		body: 'Launch a Pump.fun token from any of your agents to give it a tradeable on-chain identity. You earn royalties on every trade.',
		actions: [
			{ label: 'Go to Agents →', href: '/dashboard/agents', primary: true },
			{ label: 'Open Token Cockpit →', href: '/pump-dashboard' },
		],
	});
	return panel;
}

// ── Summary strip ──────────────────────────────────────────────────────────

function renderSummaryStrip(tokenData) {
	const wrap = document.createElement('section');
	wrap.setAttribute('aria-label', 'Token portfolio summary');
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

function renderTokenCard({ agent, mint, token, stats, coin }) {
	const panel = document.createElement('article');
	panel.className = 'dn-panel tk-card';

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
				${mint ? `<a class="dn-btn ghost" href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener" aria-label="View $${ticker} on pump.fun (opens in a new tab)" style="padding:5px 10px;font-size:12px">pump.fun ↗</a>` : ''}
				<a class="dn-btn" href="/dashboard/agents" aria-label="Open the ${name} agent" style="padding:5px 10px;font-size:12px">Agent →</a>
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
				<div role="progressbar" aria-label="Bonding curve progress" aria-valuenow="${Math.round(Number(bondingPct))}" aria-valuemin="0" aria-valuemax="100" style="height:6px;border-radius:3px;background:var(--nxt-stroke);overflow:hidden">
					<div class="tk-bond-fill" style="height:100%;width:${Math.min(100, Number(bondingPct)).toFixed(1)}%;background:var(--nxt-accent);transition:width 400ms ease"></div>
				</div>
			</div>
		` : ''}

		${mint ? `
			<div class="tk-oracle-slot" data-oracle-mint="${esc(mint)}" style="margin-bottom:14px"></div>
			<div style="display:flex;gap:8px;flex-wrap:wrap">
				<button type="button" class="dn-btn primary" data-action="fees" style="font-size:12.5px">Fees &amp; rewards</button>
				<a class="dn-btn" href="/oracle/coin/${encodeURIComponent(mint)}" rel="noopener" style="font-size:12.5px">Oracle ↗</a>
				<a class="dn-btn" href="/coin3d?mint=${encodeURIComponent(mint)}" target="_blank" rel="noopener" aria-label="Open the 3D agent view for $${ticker} (opens in a new tab)" style="font-size:12.5px">3D Agent view ↗</a>
				<a class="dn-btn" href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener" aria-label="View $${ticker} on Solscan (opens in a new tab)" style="font-size:12.5px">Solscan ↗</a>
				<button type="button" class="dn-btn tk-copy" data-action="copy-mint" data-mint="${esc(mint)}" aria-label="Copy the $${ticker} contract address" style="font-size:12.5px">Copy CA</button>
			</div>
		` : ''}
	`;

	panel.querySelectorAll('[data-action="copy-mint"]').forEach((btn) => {
		const label = btn.textContent;
		btn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(btn.dataset.mint);
				toast('Contract address copied');
				btn.classList.add('is-copied');
				btn.textContent = 'Copied ✓';
				clearTimeout(btn._t);
				btn._t = setTimeout(() => { btn.classList.remove('is-copied'); btn.textContent = label; }, 1400);
			} catch {
				toast('Copy failed');
			}
		});
	});

	panel.querySelector('[data-action="fees"]')?.addEventListener('click', () => {
		openFeesModal({
			mint,
			network: coin?.network || 'mainnet',
			creator: coin?.agent_authority || null,
			agentId: agent.id,
			symbol: ticker,
			name: coin?.name || agent.name || '',
		});
	});

	return panel;
}

// ── Fees & rewards modal ────────────────────────────────────────────────────
// Mounts the shared studio fees panel against a token so creators get full
// claim / split / delegate / distribute control without leaving the dashboard.

let _meCache;
async function getMe() {
	if (_meCache !== undefined) return _meCache;
	try { _meCache = (await get('/api/auth/me'))?.user || null; }
	catch { _meCache = null; }
	return _meCache;
}

async function openFeesModal({ mint, network, creator, agentId, symbol, name }) {
	const opener = document.activeElement;
	const titleId = 'tk-fees-title';
	const backdrop = document.createElement('div');
	backdrop.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.62);backdrop-filter:blur(4px);display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px;overflow:auto';
	const panel = document.createElement('div');
	panel.className = 'tk-dialog';
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-modal', 'true');
	panel.setAttribute('aria-labelledby', titleId);
	panel.tabIndex = -1;
	panel.style.cssText = 'background:var(--nxt-bg,#0d0d12);border:1px solid var(--nxt-stroke,rgba(255,255,255,.1));border-radius:14px;max-width:560px;width:100%;box-shadow:0 24px 80px rgba(0,0,0,.5)';
	const head = document.createElement('div');
	head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--nxt-stroke,rgba(255,255,255,.08))';
	head.innerHTML = `<strong id="${titleId}" style="font-size:15px">Fees &amp; rewards · ${esc(symbol || 'Coin')}</strong><button type="button" aria-label="Close dialog" style="background:none;border:none;color:inherit;font-size:22px;line-height:1;cursor:pointer">×</button>`;
	const inner = document.createElement('div');
	inner.style.cssText = 'padding:8px';
	panel.append(head, inner);
	backdrop.appendChild(panel);
	document.body.appendChild(backdrop);
	const onEsc = (e) => {
		if (e.key === 'Escape') { close(); return; }
		// Keep tab focus inside the dialog while it's open.
		if (e.key !== 'Tab') return;
		const f = panel.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
		if (!f.length) return;
		const first = f[0], last = f[f.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	};
	const close = () => {
		backdrop.remove();
		document.removeEventListener('keydown', onEsc);
		if (opener && typeof opener.focus === 'function') opener.focus();
	};
	head.querySelector('button').addEventListener('click', close);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
	document.addEventListener('keydown', onEsc);
	head.querySelector('button').focus();
	try {
		const user = await getMe();
		const { mountFeesPanel } = await import(/* @vite-ignore */ '/studio/fees-panel.js');
		mountFeesPanel(inner, {
			mint, network: network || 'mainnet', creator: creator || null,
			agentId: agentId || null, symbol: symbol || '', name: name || '',
			getUser: () => user,
		});
	} catch (err) {
		inner.innerHTML = `<div style="padding:24px;color:var(--nxt-ink-fade,#999)">Couldn't load the fees panel: ${esc(err.message || 'error')}</div>`;
	}
}

// ── Oracle conviction enrichment ──────────────────────────────────────────────

const TK_TIER_COLOR = { prime: '#c084fc', strong: '#34d399', lean: '#fbbf24', watch: '#94a3b8', avoid: '#f87171' };

async function enrichTokenCardsOracle(cards) {
	const mints = cards.map((c) => c.mint).filter(Boolean);
	if (!mints.length) return;
	const chunks = [];
	for (let i = 0; i < mints.length; i += 20) chunks.push(mints.slice(i, i + 20));
	let results = {};
	try {
		const resps = await Promise.all(
			chunks.map((chunk) =>
				fetch(`/api/oracle/batch?mints=${chunk.map(encodeURIComponent).join(',')}&network=mainnet`)
					.then((r) => r.ok ? r.json() : null)
					.catch(() => null),
			),
		);
		for (const resp of resps) {
			if (resp?.results) Object.assign(results, resp.results);
		}
	} catch { return; }

	for (const { el, mint } of cards) {
		if (!mint) continue;
		const d = results[mint];
		const slot = el.querySelector('[data-oracle-mint]');
		if (!slot) continue;
		if (!d || d.score == null) {
			slot.remove();
			continue;
		}
		const color = TK_TIER_COLOR[d.tier] || '#94a3b8';
		const pillars = d.pillars || {};
		const pillarHtml = Object.entries(pillars)
			.filter(([, v]) => v != null)
			.map(([k, v]) => `
				<div style="display:grid;grid-template-columns:64px 1fr 26px;align-items:center;gap:6px;font-size:11px">
					<span style="color:var(--nxt-ink-fade);text-transform:capitalize">${esc(k)}</span>
					<div style="height:4px;border-radius:2px;background:rgba(255,255,255,0.06);overflow:hidden"><div style="height:100%;width:${Math.min(100, Number(v))}%;background:${color}"></div></div>
					<span style="color:var(--nxt-ink-dim);text-align:right">${Math.round(Number(v))}</span>
				</div>`).join('');
		slot.innerHTML = `
			<div style="border:1px solid var(--nxt-stroke);border-radius:10px;padding:13px;background:rgba(255,255,255,0.02)">
				<div style="display:flex;align-items:center;gap:10px;margin-bottom:${pillarHtml ? '12px' : '0'}">
					<div style="display:flex;align-items:baseline;gap:3px">
						<span style="font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;color:${color}">${Math.round(d.score)}</span>
						<span style="font-size:12px;color:var(--nxt-ink-fade)">/100</span>
					</div>
					<span style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${color}">${esc(d.tier || '')}</span>
					<span style="margin-left:auto;font-size:11.5px;color:var(--nxt-ink-dim)">Oracle conviction at launch</span>
				</div>
				${pillarHtml ? `<div style="display:flex;flex-direction:column;gap:5px">${pillarHtml}</div>` : ''}
			</div>`;
	}
}

function statCell(label, value) {
	return `
		<div class="tk-stat" style="padding:10px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid var(--nxt-stroke)">
			<div style="font-size:11.5px;color:var(--nxt-ink-dim);margin-bottom:4px">${esc(label)}</div>
			<div style="font-size:14px;font-weight:600">${esc(value)}</div>
		</div>
	`;
}
