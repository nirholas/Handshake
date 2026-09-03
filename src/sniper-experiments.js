// /sniper/experiments, the strategy A/B scoreboard.
//
// One row per armed sniper strategy: its human label, the entry conditions it
// trades (rule shields or an LLM judge), and its REAL on-chain record over the
// selected window via /api/sniper/experiments. No simulation rows, no mock
// data; when an arm hasn't traded yet it honestly shows zero.

import { escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30_000;
const WINDOWS = [
	{ key: '24h', label: '24h' },
	{ key: '7d', label: '7 days' },
	{ key: '30d', label: '30 days' },
	{ key: 'all', label: 'All time' },
];

let windowKey = '7d';
let timer = null;
// Monotonic request id. Switching windows fires a new fetch while the previous
// one is still in flight, and the two can land out of order: without this the
// slower 7d response overwrites the 24h board the user just asked for.
let reqSeq = 0;
// Whether a real board has ever rendered. A first-load failure gets the full
// error card (there is nothing to keep); a failed refresh on top of good data
// keeps the board and says the numbers are stale, because blanking a working
// dashboard over one dropped poll is worse than showing it a minute old.
let hasData = false;
let lastGoodAt = null;

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// What actually went wrong, in a sentence the reader can act on. `fetch` throws a
// bare "Failed to fetch" for every transport failure, which tells nobody
// anything; an HTTP status tells us whether waiting will help.
function describeFailure(err) {
	const status = err && err.status;
	if (status === 429) {
		return {
			headline: 'Rate limited',
			detail: 'This scoreboard is public and rate limited per IP. It refreshes itself in a few seconds.',
		};
	}
	if (status === 404) {
		return {
			headline: 'Scoreboard endpoint not found',
			detail: 'The strategy feed moved or is not deployed on this host.',
		};
	}
	if (typeof status === 'number' && status >= 500) {
		return {
			headline: 'The scoreboard service is down',
			detail: `The fleet feed answered ${status}. The trading agents keep running; only this view is affected.`,
		};
	}
	if (typeof status === 'number') {
		return {
			headline: "Couldn't load the scoreboard",
			detail: `The fleet feed answered ${status}.`,
		};
	}
	return {
		headline: "Couldn't reach the fleet feed",
		detail: 'Nothing answered at /api/sniper/experiments. Check your connection.',
	};
}

function sol(n) {
	if (n == null || !Number.isFinite(Number(n))) return '·';
	const v = Number(n);
	const s = v.toFixed(Math.abs(v) < 0.01 && v !== 0 ? 4 : 3);
	return `${v > 0 ? '+' : ''}${s} SOL`;
}

function pct(n, signed = true) {
	if (n == null || !Number.isFinite(Number(n))) return '·';
	const v = Number(n);
	return `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function holdFmt(s) {
	if (s == null || !Number.isFinite(Number(s))) return '·';
	const v = Number(s);
	if (v < 90) return `${Math.round(v)}s`;
	return `${Math.round(v / 60)}m`;
}

function ago(iso) {
	if (!iso) return 'never';
	const ms = Date.now() - new Date(iso).getTime();
	if (ms < 60_000) return 'just now';
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
	return `${Math.round(ms / 86_400_000)}d ago`;
}

function pnlClass(v) {
	if (v == null || Number(v) === 0) return '';
	return Number(v) > 0 ? 'xp-pos' : 'xp-neg';
}

function shortAddr(a) {
	if (!a) return null;
	return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function walletLine(x) {
	if (!x.wallet_address) return '<div class="xp-wallet xp-wallet-none">no wallet</div>';
	const bal = x.balance_sol != null ? `${Number(x.balance_sol).toFixed(3)} SOL` : '· SOL';
	const low = x.balance_sol != null && x.balance_sol < 0.02;
	return `
		<div class="xp-wallet">
			<a href="${esc(x.wallet_explorer_url)}" target="_blank" rel="noopener noreferrer" title="View wallet on Solscan">${esc(shortAddr(x.wallet_address))} ↗</a>
			<span class="${low ? 'xp-neg' : ''}">${esc(bal)}</span>
		</div>`;
}

function modeBadge(x) {
	if (x.decision_mode === 'llm') {
		return `<span class="xp-badge xp-badge-llm" title="No rule shields: an LLM judges each launch">LLM · ${esc((x.llm_model || 'auto').split('/').pop())}</span>`;
	}
	return `<span class="xp-badge xp-badge-rules">rules</span>`;
}

// Why an arm shows no fills. A strategy can be armed, funded and evaluating every
// launch while one of its own knobs makes an entry impossible — and a skipped
// evaluation leaves no trace, so the board used to render that as a bare "0". A
// blocking condition is loud; a merely quiet arm ("nothing has qualified yet") is
// only shown when it has no record at all, so a working arm stays uncluttered.
function stallLine(x) {
	const s = x.stall;
	if (!s) return '';
	if (!s.blocking && x.closed > 0) return '';
	const cls = s.blocking ? 'xp-stall xp-stall-blocking' : 'xp-stall';
	const label = s.blocking ? 'not trading' : 'idle';
	// An arm is often broken in more than one way. The rest are listed under the
	// headline so fixing the first does not just reveal the second a day later.
	const also = Array.isArray(s.also) && s.also.length
		? `<ul class="xp-stall-also">${s.also.map((x) => `<li>${esc(x.message)}</li>`).join('')}</ul>`
		: '';
	const tip = [s.message, ...(s.also || []).map((x) => x.message)].join('\n\n');
	return `<div class="${cls}" title="${esc(tip)}"><b>${esc(label)}:</b> ${esc(s.message)}${also}</div>`;
}

// Earned autonomy: how much rope this arm's own record has bought it. Only shown
// once an arm has moved off the default, so the board stays quiet by default and
// a tier badge always means something happened.
function tierBadge(x) {
	const tier = x.autonomy_tier;
	if (!tier || tier === 'standard') return '';
	const title = `${x.autonomy_reason || ''} ${x.autonomy_grants || ''}`.trim();
	return ` <span class="xp-badge xp-badge-tier xp-tier-${esc(tier)}" title="${esc(title)}">${esc(tier)}</span>`;
}

// The exit shape in one glance. A null ladder is the classic single-shot full
// exit; a set one recovers the stake at Nx and keeps a moon bag riding.
function exitLine(x) {
	const bits = [`SL ${pct(-Math.abs(x.stop_loss_pct ?? 0), false)}`];
	if (x.trailing_stop_pct != null) bits.push(`trail ${pct(x.trailing_stop_pct, false)}`);
	if (x.max_hold_seconds != null) bits.push(`max ${holdFmt(x.max_hold_seconds)}`);
	bits.push(x.initials_out_multiple != null
		? `ladder ${x.initials_out_multiple}x, ${x.moonbag_min_pct ?? 15}% moon bag`
		: 'no ladder');
	return bits.join(' · ');
}

// First paint. The board's own fetch reads live SOL balances off an RPC, so the
// gap between DOMContentLoaded and data is seconds, not milliseconds: without
// this the page sits as a headline over a blank void long enough to read as
// broken. Shape-matched to the real layout so nothing jumps when data lands.
function renderSkeleton() {
	const tile = `
		<div class="cv-card xp-tile xp-skel-tile">
			<span class="cv-skel xp-skel-line" style="width:64%"></span>
			<b class="cv-skel xp-skel-line xp-skel-lg" style="width:46%"></b>
			<i class="cv-skel xp-skel-line" style="width:78%"></i>
		</div>`;
	$('xp-summary').innerHTML = `<div class="xp-tiles">${tile.repeat(6)}</div>`;
	const cell = (w) => `<td><span class="cv-skel xp-skel-line" style="width:${w}"></span></td>`;
	const row = `<tr>${cell('82%')}${cell('90%')}${cell('60%')}${cell('50%')}${cell('62%')}${cell('50%')}${cell('55%')}${cell('45%')}${cell('58%')}</tr>`;
	$('xp-board').innerHTML = `
		<div class="cv-card" style="overflow-x:auto">
			<table class="cv-table xp-table">
				<thead>
					<tr>
						<th>Strategy</th><th>Entry conditions</th><th>Record</th><th>Win rate</th>
						<th>Realized</th><th>ROI</th><th>Avg trade</th><th>Avg hold</th><th>Last trade</th>
					</tr>
				</thead>
				<tbody>${row.repeat(5)}</tbody>
			</table>
		</div>`;
	$('xp-board').setAttribute('aria-busy', 'true');
	$('xp-updated').textContent = 'Loading the fleet record\u2026';
}

// A refresh that fails on top of a good board. The numbers stay (a minute-old
// scoreboard beats a blank one) but they stop claiming to be current, and the
// reader gets the same manual retry the error card offers.
function renderStaleNotice(err) {
	const el = $('xp-alert');
	if (!el) return;
	const { headline } = describeFailure(err);
	const since = lastGoodAt ? ago(new Date(lastGoodAt).toISOString()) : 'a moment ago';
	el.innerHTML = `
		<span class="dot" aria-hidden="true"></span>
		<span>${esc(headline)}. Showing the last good read from ${esc(since)}.</span>
		<button type="button" class="cv-linkbtn" data-retry>Retry now</button>`;
	el.hidden = false;
	el.querySelector('[data-retry]').addEventListener('click', refresh);
}

function clearStaleNotice() {
	const el = $('xp-alert');
	if (!el) return;
	el.hidden = true;
	el.innerHTML = '';
}

function renderControls() {
	$('xp-controls').innerHTML = `
		<div class="xp-seg" role="group" aria-label="Time window">
			${WINDOWS.map(
				(w) => `
				<button class="xp-seg-btn${w.key === windowKey ? ' on' : ''}" data-window="${w.key}" aria-pressed="${w.key === windowKey}">
					${esc(w.label)}
				</button>`,
			).join('')}
		</div>`;
	$('xp-controls').querySelectorAll('[data-window]').forEach((btn) => {
		btn.addEventListener('click', () => {
			windowKey = btn.dataset.window;
			renderControls();
			refresh();
		});
	});
}

// How much of the fleet has traded its way into extra freedom. An arm at trusted
// or above gets wider tuning bounds, more of the fleet budget, and a richer
// evidence pack in front of its judge; one on probation gets held tighter.
// Moon bags the fleet is still holding. Deliberately NOT added to realized P&L:
// nothing here is realized until a bag is sold, and the whole point of the rule is
// that these ride indefinitely. Shown because upside you cannot see is upside you
// will not believe in.
function moonbagTile(experiments) {
	const bags = experiments.reduce((a, x) => a + (Number(x.moonbags) || 0), 0);
	const value = experiments.reduce((a, x) => a + (Number(x.moonbag_value_sol) || 0), 0);
	return `
		<div class="cv-card xp-tile" title="Winners the fleet banked but never fully sold. Their cost basis came back on the sold leg, so every one of these is free: worth zero at worst, uncapped at best. Not counted as profit until sold.">
			<span>Moon bags riding</span>
			<b>${bags}</b>
			<i>${bags ? `${value.toFixed(4)} SOL at last quote, cost basis zero` : 'no bags held yet'}</i>
		</div>`;
}

function earnedTile(experiments) {
	const count = (tier) => experiments.filter((x) => x.autonomy_tier === tier).length;
	const earned = count('trusted') + count('autonomous');
	const probation = count('probation');
	return `
		<div class="cv-card xp-tile" title="Tiers are recomputed from each arm's own realized record every optimizer run. Freedom is continuously earned, never granted once.">
			<span>Earned autonomy</span>
			<b class="${earned > 0 ? 'xp-pos' : ''}">${earned} earned</b>
			<i>${probation} on probation · ${experiments.length - earned - probation} standard</i>
		</div>`;
}

function renderSummary(experiments, masterWallet) {
	const active = experiments.filter((x) => x.enabled);
	const traded = experiments.filter((x) => x.closed > 0);
	const totalPnl = experiments.reduce((a, x) => a + (Number(x.realized_pnl_sol) || 0), 0);
	const totalTrades = experiments.reduce((a, x) => a + x.closed, 0);
	const fleetSol = experiments.reduce((a, x) => a + (Number(x.balance_sol) || 0), 0);
	const best = traded.slice().sort((a, b) => (b.realized_pnl_sol || 0) - (a.realized_pnl_sol || 0))[0];
	const masterTile = masterWallet
		? `<div class="cv-card xp-tile">
				<span>Master funding wallet</span>
				<b><a href="${esc(masterWallet.explorer_url)}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(masterWallet.address))} ↗</a></b>
				<i>${masterWallet.balance_sol != null ? `${masterWallet.balance_sol.toFixed(3)} SOL, auto-tops-up dry arms` : 'balance unavailable'}</i>
			</div>`
		: '';
	$('xp-summary').innerHTML = `
		<div class="xp-tiles">
			<div class="cv-card xp-tile"><span>Armed strategies</span><b>${active.length}</b><i>${experiments.length - active.length} paused</i></div>
			<div class="cv-card xp-tile"><span>Closed trades</span><b>${totalTrades}</b><i>${experiments.reduce((a, x) => a + x.open, 0)} open now</i></div>
			<div class="cv-card xp-tile"><span>Fleet realized P&amp;L</span><b class="${pnlClass(totalPnl)}">${esc(sol(totalPnl))}</b><i>window: ${esc(windowKey)}</i></div>
			<div class="cv-card xp-tile"><span>Fleet SOL on hand</span><b>${fleetSol.toFixed(3)} SOL</b><i>across ${experiments.filter((x) => x.wallet_address).length} wallets</i></div>
			<div class="cv-card xp-tile"><span>Best arm</span><b>${best ? esc(best.label) : 'no trades yet'}</b><i>${best ? esc(sol(best.realized_pnl_sol)) : 'waiting on fills'}</i></div>
			${moonbagTile(experiments)}
			${earnedTile(experiments)}
			${masterTile}
		</div>`;
}

function renderBoard(experiments) {
	if (!experiments.length) {
		$('xp-board').innerHTML = `
			<div class="cv-empty">
				<p style="margin:0 0 6px;font-weight:600">No strategies armed on this network yet</p>
				<p style="margin:0">
					Every arm on this board is a real agent trading its own wallet.
					<a href="/arm">Arm an agent</a> and its record appears here on its first fill,
					or read how the fleet is scored in the <a href="/trading">trading hub</a>.
				</p>
			</div>`;
		return;
	}
	const rows = experiments
		.map((x) => {
			const record = x.closed > 0 ? `${x.wins}W · ${x.losses}L` : 'no fills';
			const bags = Number(x.moonbags) > 0
				? `<div class="xp-moonbag" title="Free moon bags still riding from this arm's winners. The cost basis already came back, so each one is worth zero at worst and uncapped at best. Not counted as profit until sold.">🌙 ${x.moonbags} bag${x.moonbags === 1 ? '' : 's'} · ${Number(x.moonbag_value_sol || 0).toFixed(4)} SOL</div>`
				: '';
			const paper = x.paper_closed > 0 || x.paper_open > 0
				? `<div class="xp-paper" title="Simulate-mode record: real quotes, no broadcast">paper: ${x.paper_wins}W · ${x.paper_closed - x.paper_wins}L${x.paper_open ? ` · ${x.paper_open} open` : ''} · ${esc(sol(x.paper_pnl_sol))}</div>`
				: '';
			return `
			<tr class="${x.enabled ? '' : 'xp-off'}">
				<td>
					<div class="xp-label">${esc(x.label)}${x.enabled ? '' : ' <span class="xp-paused">paused</span>'}${tierBadge(x)}</div>
					<div class="xp-agent"><a href="/a/${esc(x.agent_id)}">${esc(x.agent_name || 'agent')}</a> ${modeBadge(x)} · <a href="${esc(x.ledger_url)}" title="Full decision-by-decision reasoning ledger, tamper-evident and on-chain anchored">ledger →</a></div>
					${walletLine(x)}
				</td>
				<td class="xp-cond">${esc(x.conditions)}<div class="xp-cond-sub">${esc(String(x.per_trade_sol ?? '·'))} SOL/trade · ${esc(exitLine(x))}</div>${stallLine(x)}</td>
				<td>${esc(record)}${x.open > 0 ? ` <span class="xp-open">+${x.open} open</span>` : ''}${bags}${paper}</td>
				<td>${x.win_rate != null ? esc(String(x.win_rate)) + '%' : '·'}</td>
				<td class="${pnlClass(x.realized_pnl_sol)}">${esc(sol(x.realized_pnl_sol))}</td>
				<td class="${pnlClass(x.roi_pct)}">${esc(pct(x.roi_pct))}</td>
				<td class="${pnlClass(x.avg_pnl_pct)}">${esc(pct(x.avg_pnl_pct))}</td>
				<td>${esc(holdFmt(x.avg_hold_seconds))}</td>
				<td>${esc(ago(x.last_closed_at))}</td>
			</tr>`;
		})
		.join('');
	$('xp-board').innerHTML = `
		<div class="cv-card" style="overflow-x:auto">
			<table class="cv-table xp-table">
				<thead>
					<tr>
						<th>Strategy</th><th>Entry conditions</th><th>Record</th><th>Win rate</th>
						<th>Realized</th><th>ROI</th><th>Avg trade</th><th>Avg hold</th><th>Last trade</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

function renderJudgment(judgment) {
	const el = $('xp-judgment');
	if (!el) return;
	if (!judgment || !judgment.length) {
		// The LLM arms are half of what this page is about, so "no verdicts in this
		// window" is a fact worth stating rather than a section that quietly vanishes.
		el.innerHTML = `
			<h2 class="cv-h2">Judgment ledger</h2>
			<div class="cv-empty">
				<p style="margin:0 0 6px;font-weight:600">No LLM verdicts in this window</p>
				<p style="margin:0">
					The judge-driven arms record a verdict per launch they evaluate, buys and
					skips alike. Widen the window above, or read how the arms are scored in the
					<a href="/trading">trading hub</a>.
				</p>
			</div>`;
		return;
	}
	const rows = judgment
		.map((j) => `
		<tr>
			<td class="xp-label">${esc(j.model.split('/').pop())}<div class="xp-cond-sub">${esc(j.model)}</div></td>
			<td>${j.verdicts}</td>
			<td>${j.verdicts > 0 ? Math.round((j.buy_calls / j.verdicts) * 100) + '%' : '·'} <span class="xp-cond-sub" style="display:inline">(${j.buy_calls})</span></td>
			<td>${j.avg_confidence != null ? Math.round(j.avg_confidence * 100) + '%' : '·'}</td>
			<td class="${j.buy_precision_pct != null ? (j.buy_precision_pct >= 50 ? 'xp-pos' : 'xp-neg') : ''}">${j.buy_precision_pct != null ? j.buy_precision_pct + '%' : 'awaiting outcomes'} <span class="xp-cond-sub" style="display:inline">${j.buys_scored ? `(${j.buy_hits}/${j.buys_scored})` : ''}</span></td>
			<td>${j.missed_winner_pct != null ? j.missed_winner_pct + '%' : '·'} <span class="xp-cond-sub" style="display:inline">${j.skips_scored ? `(${j.missed_winners}/${j.skips_scored})` : ''}</span></td>
			<td>${j.avg_latency_ms != null ? (j.avg_latency_ms / 1000).toFixed(1) + 's' : '·'}</td>
		</tr>`)
		.join('');
	el.innerHTML = `
		<h2 class="cv-h2">Judgment ledger</h2>
		<p style="margin:4px 0 12px;color:var(--cv-text-3);font-size:13px">
			Every verdict the LLM judges render is recorded, buys and skips alike, then scored
			against what the coin actually did an hour later. This measures each model's calls
			independent of position size: a "hit" is a coin that pumped 3x or graduated.
		</p>
		<div class="cv-card" style="overflow-x:auto">
			<table class="cv-table xp-table" style="min-width:720px">
				<thead>
					<tr>
						<th>Model</th><th>Verdicts</th><th>Buy rate</th><th>Avg conf</th>
						<th>Buy precision</th><th>Missed winners</th><th>Latency</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

function renderError(err) {
	const { headline, detail } = describeFailure(err);
	$('xp-summary').innerHTML = '';
	$('xp-judgment').innerHTML = '';
	$('xp-board').innerHTML = `
		<div class="cv-empty">
			<p style="margin:0 0 6px;font-weight:600">${esc(headline)}</p>
			<p style="margin:0 0 14px">${esc(detail)} It retries on its own every ${REFRESH_MS / 1000}s.</p>
			<button type="button" class="cv-linkbtn" data-retry>Try again now</button>
		</div>`;
	$('xp-board').querySelector('[data-retry]').addEventListener('click', refresh);
	$('xp-updated').textContent = 'Not updated: the fleet feed is unreachable.';
}

async function refresh() {
	const seq = ++reqSeq;
	if (!hasData) $('xp-board').setAttribute('aria-busy', 'true');
	try {
		const data = await getJson(`/api/sniper/experiments?network=mainnet&window=${encodeURIComponent(windowKey)}`);
		// A window switch fired while this was in flight: that newer answer owns the
		// board now, and painting this one would silently show the wrong window.
		if (seq !== reqSeq) return;
		clearStaleNotice();
		renderSummary(data.experiments, data.master_wallet);
		renderBoard(data.experiments);
		renderJudgment(data.judgment);
		hasData = true;
		lastGoodAt = Date.now();
		$('xp-updated').textContent = `Updated ${new Date(data.t).toLocaleTimeString()} · real on-chain fills only`;
	} catch (err) {
		if (seq !== reqSeq) return;
		if (hasData) renderStaleNotice(err);
		else renderError(err);
	} finally {
		if (seq === reqSeq) $('xp-board').setAttribute('aria-busy', 'false');
	}
}

renderControls();
renderSkeleton();
refresh();
timer = setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
	if (document.hidden) {
		clearInterval(timer);
		timer = null;
	} else if (!timer) {
		refresh();
		timer = setInterval(refresh, REFRESH_MS);
	}
});
