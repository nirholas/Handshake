/**
 * Mission Control — positions pane.
 *
 * The active agent's live book. Two real, fused sources:
 *   • SSE /api/sniper/stream — streaming unrealized PnL on the agent's sniper
 *     positions (open → live %, close → realized), filtered to this agent.
 *   • GET /api/agents/:id/solana/holdings — the wallet's real on-chain token
 *     balances, so discretionary buys made right here in the terminal show up as
 *     spot positions you can one-tap exit.
 * Backlog comes from /api/sniper/leaderboard (open) + /api/sniper/history (closed).
 *
 * Quick-exit sells the full balance through the same guarded trade path.
 */

import { createSseClient } from './realtime.js';
import { sell } from './trade.js';
import {
	escapeHtml,
	formatSol,
	formatSolDelta,
	formatPct,
	formatCompact,
	signClass,
	timeAgo,
} from './format.js';

const CLOSED_CAP = 12;
const HOLDINGS_REFRESH_MS = 30_000;

export function createPositionsPane({ store, bus, mount }) {
	mount.classList.add('mc-pane', 'mc-pane--positions');
	mount.setAttribute('role', 'region');
	mount.setAttribute('aria-label', 'Your positions');
	mount.innerHTML = `
		<div class="mc-pane-head">
			<span class="mc-pane-title">Positions</span>
			<span class="mc-pane-head-spacer"></span>
			<span class="mc-pane-count" data-host="count"></span>
		</div>
		<div class="mc-pos-summary" data-host="summary"></div>
		<div class="mc-pane-body" data-host="body" aria-live="polite"></div>
	`;
	const body = mount.querySelector('[data-host="body"]');
	const summary = mount.querySelector('[data-host="summary"]');
	const countEl = mount.querySelector('[data-host="count"]');

	const positions = new Map(); // key -> position
	const closed = []; // recently closed, newest first
	let sse = null;
	let holdingsTimer = null;
	let rafToken = 0;
	let agentId = store.getAgent()?.id || null;
	let connState = 'reconnecting';
	let summaryTween = { from: 0, to: 0, t0: 0, raf: 0 };

	const keyOf = (p) => (p.source === 'spot' ? `spot:${p.mint}` : `snipe:${p.id}`);

	function normSniper(d, status) {
		return {
			id: d.id,
			mint: d.mint,
			symbol: d.symbol || (d.mint ? d.mint.slice(0, 4) : '—'),
			name: d.name || '',
			source: 'sniper',
			status: status || (d.status === 'closed' ? 'closed' : 'open'),
			entry_sol: d.entry_sol ?? null,
			current_sol: d.current_sol ?? null,
			pnl_pct: d.pnl_pct ?? d.unrealized_pct ?? null,
			pnl_sol: d.pnl_sol ?? null,
			exit_reason: d.exit_reason || null,
			at: d.at || d.closed_at || d.opened_at || null,
		};
	}

	function upsert(p) {
		positions.set(keyOf(p), p);
	}

	function ingestSniper(d, status) {
		if (!d?.mint) return;
		const p = normSniper(d, status);
		if (p.status === 'closed') {
			positions.delete(keyOf({ source: 'sniper', id: p.id }));
			closed.unshift(p);
			closed.splice(CLOSED_CAP);
		} else {
			upsert(p);
		}
	}

	// ── backlog ────────────────────────────────────────────────────────────────
	async function loadBacklog() {
		if (!agentId) return;
		const net = store.getNetwork();
		try {
			const r = await fetch(`/api/sniper/leaderboard?network=${net}`, { headers: { accept: 'application/json' } });
			if (r.ok) {
				const data = await r.json();
				for (const p of data?.positions || []) {
					if (p.agent_id === agentId) ingestSniper(p, 'open');
				}
			}
		} catch { /* degrade — holdings + stream still populate the pane */ }
		try {
			const r = await fetch(`/api/sniper/history?network=${net}&agent_id=${encodeURIComponent(agentId)}&limit=${CLOSED_CAP}`, { headers: { accept: 'application/json' } });
			if (r.ok) {
				const data = await r.json();
				for (const t of data?.trades || []) {
					closed.push(normSniper({ ...t, current_sol: t.exit_sol }, 'closed'));
				}
				closed.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
				closed.splice(CLOSED_CAP);
			}
		} catch { /* closed history is best-effort */ }
		scheduleRender();
	}

	// ── holdings (spot) ──────────────────────────────────────────────────────────
	async function refreshHoldings() {
		const agent = store.getAgent();
		if (!agent?.id) return;
		try {
			const r = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/solana/holdings?network=${store.getNetwork()}`, { credentials: 'include' });
			if (!r.ok) return;
			const data = await r.json();
			const tokens = (data?.data?.tokens || []).filter((t) => !t.is_usdc);
			const seen = new Set();
			for (const t of tokens) {
				seen.add(`spot:${t.mint}`);
				// Skip if an open sniper position already represents this mint (the
				// sniper row carries live PnL the bare holding can't).
				const hasSniper = [...positions.values()].some((p) => p.source === 'sniper' && p.mint === t.mint && p.status === 'open');
				if (hasSniper) { positions.delete(`spot:${t.mint}`); continue; }
				const row = store.getRow(t.mint);
				upsert({
					mint: t.mint,
					symbol: row?.symbol || t.mint.slice(0, 4),
					name: row?.name || '',
					source: 'spot',
					status: 'open',
					ui_amount: t.ui_amount,
					amount_raw: t.amount_raw,
					decimals: t.decimals,
					market_cap_usd: row?.market_cap_usd ?? null,
				});
			}
			// Drop spot rows the wallet no longer holds.
			for (const k of [...positions.keys()]) {
				if (k.startsWith('spot:') && !seen.has(k)) positions.delete(k);
			}
			scheduleRender();
		} catch { /* transient RPC — keep last good book */ }
	}

	// ── stream ───────────────────────────────────────────────────────────────────
	function startStream() {
		if (!agentId) {
			// Nothing to follow without an agent: holding an SSE connection open
			// for an anonymous visitor would only burn a stream slot. The pill
			// reads "idle" rather than pretending to reconnect forever.
			connState = 'idle';
			bus.emit('conn:positions', 'idle');
			return;
		}
		sse = createSseClient({
			url: `/api/sniper/stream?network=${store.getNetwork()}`,
			onState: (s) => { connState = s; bus.emit('conn:positions', s); scheduleRender(); },
			events: {
				open: () => {},
				buy: (d) => { if (d?.agent_id === agentId) { ingestSniper(d, 'open'); flash(d.mint, d.pnl_pct); scheduleRender(); } },
				sell: (d) => { if (d?.agent_id === agentId) { ingestSniper(d, 'closed'); scheduleRender(); refreshHoldings(); } },
				update: (d) => { if (d?.agent_id === agentId) { ingestSniper(d, 'open'); flash(d.mint, d.pnl_pct); scheduleRender(); } },
				ping: () => {},
				close: () => {},
				error: () => {},
			},
		});
		sse.start();
	}

	let flashMint = null, flashDir = null;
	function flash(mint, pct) {
		flashMint = mint;
		flashDir = (pct ?? 0) >= 0 ? 'pos' : 'neg';
	}

	// ── render ─────────────────────────────────────────────────────────────────
	function scheduleRender() {
		if (rafToken) return;
		rafToken = requestAnimationFrame(() => { rafToken = 0; render(); });
	}

	function openList() {
		return [...positions.values()].filter((p) => p.status === 'open')
			.sort((a, b) => (b.current_sol ?? 0) - (a.current_sol ?? 0));
	}

	function tweenSummaryTo(value) {
		const el = summary.querySelector('[data-host="unreal"]');
		if (!el) return;
		summaryTween.from = summaryTween.to;
		summaryTween.to = value;
		summaryTween.t0 = performance.now();
		if (summaryTween.raf) cancelAnimationFrame(summaryTween.raf);
		const step = (now) => {
			const k = Math.min(1, (now - summaryTween.t0) / 300);
			const v = summaryTween.from + (summaryTween.to - summaryTween.from) * (k * (2 - k));
			el.textContent = formatSolDelta(v);
			el.className = `mc-num`;
			el.style.color = v > 0 ? 'var(--success,#4ade80)' : v < 0 ? 'var(--danger,#f87171)' : 'var(--ink-bright,#fff)';
			if (k < 1) summaryTween.raf = requestAnimationFrame(step);
		};
		summaryTween.raf = requestAnimationFrame(step);
	}

	function render() {
		const open = openList();
		const selected = store.getSelected();
		countEl.textContent = open.length ? `${open.length} open` : '';

		// summary
		const unreal = open.reduce((s, p) => s + (p.pnl_sol ?? 0), 0);
		const exposure = open.reduce((s, p) => s + (p.current_sol ?? 0), 0);
		const realized = closed.reduce((s, p) => s + (p.pnl_sol ?? 0), 0);
		summary.innerHTML = `
			<div><span>Open</span><b class="mc-num">${open.length}</b></div>
			<div><span>Exposure</span><b class="mc-num">${formatSol(exposure)} ◎</b></div>
			<div><span>Unrealized</span><b class="mc-num" data-host="unreal">${formatSolDelta(unreal)}</b></div>
			<div><span>Realized</span><b class="mc-num" style="color:${realized > 0 ? 'var(--success,#4ade80)' : realized < 0 ? 'var(--danger,#f87171)' : 'inherit'}">${formatSolDelta(realized)}</b></div>
		`;
		tweenSummaryTo(unreal);

		if (!store.getAgent()) {
			body.innerHTML = store.isSignedIn()
				? stateHtml('◎', 'No agent wallet yet', 'Create an agent wallet and its live positions and PnL stream here.', { href: '/create-agent', label: 'Create an agent wallet' })
				: stateHtml('◎', 'Sign in to see positions', 'Your agent wallet\'s open positions, live PnL, and recent exits stream here once you sign in.', { href: '/login?next=%2Fterminal', label: 'Sign in' });
			return;
		}
		if (!open.length && !closed.length) {
			if (connState === 'down') {
				body.innerHTML = stateHtml('⚠', 'Position stream unreachable', 'We can’t reach the live position stream right now and we’re retrying. Nothing stale is shown.');
				return;
			}
			body.innerHTML = stateHtml('▦', 'No open positions', 'Buy a coin from the feed to open your first position — its live PnL streams here.');
			return;
		}

		const openHtml = open.map((p) => positionRow(p, selected)).join('');
		const closedHtml = closed.length
			? `<div class="mc-section-h" style="padding:10px 12px 4px">Recently closed</div>${closed.map((p) => closedRow(p)).join('')}`
			: '';
		body.innerHTML = `<div class="mc-poss">${openHtml}${closedHtml}</div>`;

		// wire row interactions
		body.querySelectorAll('[data-pos-mint]').forEach((el) => {
			el.addEventListener('click', (e) => {
				if (e.target.closest('[data-exit]')) return;
				store.select(el.dataset.posMint);
			});
		});
		body.querySelectorAll('[data-exit]').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				e.stopPropagation();
				const mint = btn.dataset.exit;
				const raw = btn.dataset.raw || null;
				btn.disabled = true;
				btn.textContent = 'Selling…';
				await sell({ store, bus, mint, tokenAmountRaw: raw });
				// success/failure handled by toast + trade:done → holdings refresh
			});
		});

		// apply a one-shot flash to the just-updated row
		if (flashMint) {
			const el = body.querySelector(`[data-pos-mint="${cssEscape(flashMint)}"]`);
			if (el) { el.classList.remove('mc-flash-pos', 'mc-flash-neg'); void el.offsetWidth; el.classList.add(flashDir === 'pos' ? 'mc-flash-pos' : 'mc-flash-neg'); }
			flashMint = null;
		}
	}

	function positionRow(p, selected) {
		const cls = signClass(p.pnl_pct ?? 0);
		const isSel = p.mint === selected ? ' style="box-shadow:inset 2px 0 0 var(--accent,#7dd3fc)"' : '';
		const pnl = p.source === 'spot'
			? `<span class="mc-pos-pnl" style="color:var(--ink-dim,#888)">${formatCompact(p.ui_amount)}</span>`
			: `<span class="mc-pos-pnl mc-num">${formatPct(p.pnl_pct)}<br><small style="font-weight:400;opacity:.8">${formatSolDelta(p.pnl_sol)} ◎</small></span>`;
		const sub = p.source === 'spot'
			? `<span class="mc-pos-sub">Spot · ${formatCompact(p.ui_amount)} tokens</span>`
			: `<span class="mc-pos-sub">Entry ${formatSol(p.entry_sol)} → ${formatSol(p.current_sol)} ◎</span>`;
		return `
			<div class="mc-pos ${cls}" data-pos-mint="${escapeHtml(p.mint)}"${isSel} tabindex="0" role="button" aria-label="${escapeHtml(p.symbol)} position">
				<span class="mc-pos-sym">${escapeHtml(p.symbol)}<span class="mc-pos-name">${escapeHtml(p.name)}</span></span>
				${pnl}
				${sub}
				<span class="mc-pos-actions">
					<button class="mc-chipbtn" data-exit="${escapeHtml(p.mint)}"${p.amount_raw ? ` data-raw="${escapeHtml(p.amount_raw)}"` : ''} title="Sell full balance">Exit</button>
				</span>
			</div>`;
	}

	function closedRow(p) {
		const cls = signClass(p.pnl_pct ?? 0);
		return `
			<div class="mc-pos mc-pos--closed ${cls}" data-pos-mint="${escapeHtml(p.mint)}" tabindex="0" role="button" aria-label="${escapeHtml(p.symbol)} closed">
				<span class="mc-pos-sym">${escapeHtml(p.symbol)}<span class="mc-pos-name">${escapeHtml(p.exit_reason || 'closed')}</span></span>
				<span class="mc-pos-pnl mc-num">${formatPct(p.pnl_pct)}<br><small style="font-weight:400;opacity:.8">${formatSolDelta(p.pnl_sol)} ◎</small></span>
				<span class="mc-pos-sub">${p.at ? timeAgo(Math.floor(new Date(p.at).getTime() / 1000)) : ''}</span>
			</div>`;
	}

	function stateHtml(ico, title, msg, link = null) {
		const action = link ? `<a class="mc-chipbtn" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>` : '';
		return `<div class="mc-empty"><div class="mc-empty-ico" aria-hidden="true">${ico}</div><h3>${title}</h3><p>${msg}</p>${action}</div>`;
	}
	function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

	// ── lifecycle ────────────────────────────────────────────────────────────────
	function reset() {
		positions.clear();
		closed.length = 0;
		agentId = store.getAgent()?.id || null;
		if (sse) { sse.stop(); sse = null; }
		startStream();
		loadBacklog();
		refreshHoldings();
		scheduleRender();
	}

	const unsubs = [
		bus.on('agent', () => reset()),
		bus.on('network', () => reset()),
		bus.on('select', () => scheduleRender()),
		bus.on('trade:done', () => { refreshHoldings(); }),
	];

	startStream();
	loadBacklog();
	refreshHoldings();
	holdingsTimer = setInterval(refreshHoldings, HOLDINGS_REFRESH_MS);
	render();

	return {
		destroy() {
			if (sse) sse.stop();
			if (holdingsTimer) clearInterval(holdingsTimer);
			if (rafToken) cancelAnimationFrame(rafToken);
			if (summaryTween.raf) cancelAnimationFrame(summaryTween.raf);
			unsubs.forEach((u) => u());
		},
	};
}
