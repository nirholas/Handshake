// /exit-lab — counterfactual replay of the fleet's real closed positions.
//
// The corpus comes from /api/sniper/exit-lab (real on-chain closed positions,
// nothing simulated). The replay runs HERE, in the browser, against the same
// pure kernel the server imports, so a slider move is instant and the server is
// never asked to re-derive an answer it has no better claim to than we do.
//
// Everything on this page is computed from that corpus. When the corpus is
// empty the page says so and explains why; it never invents a row to fill a
// layout.

import { escapeHtml as esc } from './shared/coin-format.js';
import {
	PARAM_SPECS,
	DEFAULT_PARAMS,
	normalizeParams,
	sameParams,
	replayFleet,
	sweepParams,
	exitReasons,
	toSol,
} from '../api/_lib/exit-replay.js';

const $ = (id) => document.getElementById(id);
const CORPUS_URL = '/api/sniper/exit-lab?network=mainnet&window=all&limit=500';

/** Named starting points. Each is a real posture, not a decoration. */
const PRESETS = [
	{
		key: 'live',
		label: 'Live fleet policy',
		hint: 'The rules the worker is running right now.',
		params: DEFAULT_PARAMS,
	},
	{
		key: 'tight',
		label: 'Cut losers fast',
		hint: 'A short leash on the downside: exit early and often, keep the drawdown small.',
		params: { stopLossPct: 15, trailingStopPct: 10, takeProfitPct: null, initialsOutMultiple: 2, moonbagMinPct: 15 },
	},
	{
		key: 'ride',
		label: 'Let winners run',
		hint: 'Wide stops and a big moon bag: accept deeper dips to keep the tail.',
		params: { stopLossPct: 50, trailingStopPct: 45, takeProfitPct: null, initialsOutMultiple: 3, moonbagMinPct: 40 },
	},
	{
		key: 'classic',
		label: 'No ladder',
		hint: 'The all-or-nothing exit, with no take-initials and no moon bag.',
		params: { stopLossPct: 35, trailingStopPct: 25, takeProfitPct: 100, initialsOutMultiple: null, moonbagMinPct: 0 },
	},
];

// The grid the search sweeps. Deliberately coarse on the axes that barely move
// the answer and fine on the two that dominate it, so the search stays exact and
// still finishes in well under a second on a phone.
const SWEEP_AXES = {
	stopLossPct: [10, 15, 20, 25, 35, 50, 70, null],
	trailingStopPct: [10, 15, 20, 25, 35, 50, null],
	initialsOutMultiple: [1.5, 2, 3, 5, null],
	moonbagMinPct: [0, 15, 30, 50],
};

const REASON_LABELS = {
	take_initials: 'Take initials',
	take_profit: 'Take-profit ceiling',
	trailing_stop: 'Trailing stop',
	stop_loss: 'Hard stop-loss',
	timeout: 'Held to the end',
};

const state = {
	corpus: null,
	error: null,
	params: normalizeParams(DEFAULT_PARAMS),
	live: null, // replayFleet under the live policy, the comparison baseline
	current: null,
	sweep: null,
	tradeSort: 'divergence',
};

// ── formatting ───────────────────────────────────────────────────────────────

function sol(lamports, { signed = true, places = 4 } = {}) {
	const v = toSol(lamports);
	const sign = signed && v > 0 ? '+' : '';
	return `${sign}${v.toFixed(places)}`;
}

function pctText(n, { signed = true } = {}) {
	if (n == null || !Number.isFinite(Number(n))) return '·';
	const v = Number(n);
	return `${signed && v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function toneFor(n) {
	if (!Number.isFinite(Number(n)) || Number(n) === 0) return 'flat';
	return Number(n) > 0 ? 'up' : 'down';
}

function paramText(spec, value) {
	if (value == null) return 'off';
	if (spec.unit === 'x') return `${value}x`;
	return `${value}${spec.unit}`;
}

function policySummary(params) {
	return PARAM_SPECS.map((s) => `${s.label} ${paramText(s, params[s.key])}`).join(' · ');
}

// ── controls ─────────────────────────────────────────────────────────────────

function renderPresets() {
	const el = $('xl-presets');
	if (!el) return;
	el.innerHTML = PRESETS.map(
		(p) => `<button type="button" class="xl-chip${sameParams(p.params, state.params) ? ' is-active' : ''}"
			data-preset="${esc(p.key)}" title="${esc(p.hint)}">${esc(p.label)}</button>`,
	).join('');
}

function renderControls() {
	const el = $('xl-params');
	if (!el) return;
	el.innerHTML = PARAM_SPECS.map((spec) => {
		const v = state.params[spec.key];
		const off = v == null;
		const slider = off ? spec.min : v;
		const helpId = `xl-help-${spec.key}`;
		return `<div class="xl-param${off ? ' is-off' : ''}" data-param="${esc(spec.key)}">
			<div class="xl-param-head">
				<label class="xl-param-label" for="xl-input-${esc(spec.key)}">${esc(spec.label)}</label>
				<button type="button" class="xl-help" aria-expanded="false" aria-controls="${helpId}"
					aria-label="What does ${esc(spec.label)} do?">?</button>
				<output class="xl-param-value" for="xl-input-${esc(spec.key)}">${esc(paramText(spec, v))}</output>
			</div>
			<div class="xl-param-row">
				<input type="range" id="xl-input-${esc(spec.key)}" class="xl-range"
					min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${slider}"
					aria-label="${esc(spec.label)}"${off ? ' disabled' : ''} />
				${
					spec.nullable
						? `<label class="xl-toggle"><input type="checkbox" data-off="${esc(spec.key)}"${off ? ' checked' : ''} /> <span>off</span></label>`
						: ''
				}
			</div>
			<p class="xl-param-help" id="${helpId}" hidden>${esc(spec.help)}</p>
		</div>`;
	}).join('');
}

function bindControls() {
	const el = $('xl-params');
	if (!el) return;
	el.addEventListener('input', (ev) => {
		const range = ev.target.closest('.xl-range');
		if (range) {
			const key = range.id.replace('xl-input-', '');
			state.params = normalizeParams({ ...state.params, [key]: Number(range.value) });
			syncUrl();
			recompute();
			return;
		}
		const off = ev.target.closest('input[data-off]');
		if (off) {
			const key = off.getAttribute('data-off');
			const spec = PARAM_SPECS.find((s) => s.key === key);
			const next = off.checked ? null : Number(document.getElementById(`xl-input-${key}`)?.value ?? spec.min);
			state.params = { ...state.params, [key]: off.checked ? null : normalizeParams({ [key]: next })[key] };
			renderControls();
			syncUrl();
			recompute();
		}
	});
	el.addEventListener('click', (ev) => {
		const help = ev.target.closest('.xl-help');
		if (!help) return;
		const panel = document.getElementById(help.getAttribute('aria-controls'));
		if (!panel) return;
		const open = panel.hidden;
		panel.hidden = !open;
		help.setAttribute('aria-expanded', String(open));
	});

	$('xl-presets')?.addEventListener('click', (ev) => {
		const btn = ev.target.closest('[data-preset]');
		if (!btn) return;
		const preset = PRESETS.find((p) => p.key === btn.getAttribute('data-preset'));
		if (!preset) return;
		applyParams(preset.params);
	});

	$('xl-reset')?.addEventListener('click', () => applyParams(DEFAULT_PARAMS));

	$('xl-share')?.addEventListener('click', async (ev) => {
		const btn = ev.currentTarget;
		syncUrl();
		const before = btn.textContent;
		try {
			await navigator.clipboard.writeText(window.location.href);
			btn.textContent = 'Link copied';
		} catch {
			// Clipboard access can be denied outright; the URL bar already holds the
			// shareable link, so say that rather than fail silently.
			btn.textContent = 'Copy it from the address bar';
		}
		window.setTimeout(() => {
			btn.textContent = before;
		}, 2400);
	});

	$('xl-sweep-run')?.addEventListener('click', runSweep);

	document.querySelector('.xl-trade-sort')?.addEventListener('click', (ev) => {
		const btn = ev.target.closest('[data-sort]');
		if (!btn) return;
		state.tradeSort = btn.getAttribute('data-sort');
		document
			.querySelectorAll('.xl-trade-sort [data-sort]')
			.forEach((b) => b.classList.toggle('is-active', b === btn));
		renderTrades();
	});

	$('xl-sweep')?.addEventListener('click', (ev) => {
		const btn = ev.target.closest('[data-apply]');
		if (!btn) return;
		const idx = Number(btn.getAttribute('data-apply'));
		const leader = state.sweep?.leaders?.[idx];
		if (leader) {
			applyParams(leader.params);
			$('xl-console-h')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	});
}

function applyParams(params) {
	state.params = normalizeParams(params);
	renderControls();
	renderPresets();
	syncUrl();
	recompute();
}

// ── URL sync, so a finding is linkable ───────────────────────────────────────

function syncUrl() {
	const url = new URL(window.location.href);
	for (const spec of PARAM_SPECS) {
		const v = state.params[spec.key];
		if (v == null) url.searchParams.set(spec.key, 'off');
		else url.searchParams.set(spec.key, String(v));
	}
	window.history.replaceState(null, '', `${url.pathname}${url.search}`);
}

function paramsFromUrl() {
	const url = new URL(window.location.href);
	const out = { ...DEFAULT_PARAMS };
	let touched = false;
	for (const spec of PARAM_SPECS) {
		const raw = url.searchParams.get(spec.key);
		if (raw == null) continue;
		touched = true;
		if (raw === 'off') out[spec.key] = spec.nullable ? null : DEFAULT_PARAMS[spec.key];
		else out[spec.key] = Number(raw);
	}
	return touched ? normalizeParams(out) : null;
}

// ── results ──────────────────────────────────────────────────────────────────

function metric({ label, value, sub, tone, title }) {
	return `<div class="xl-metric${tone ? ` xl-metric-${tone}` : ''}"${title ? ` title="${esc(title)}"` : ''}>
		<div class="xl-metric-label">${esc(label)}</div>
		<div class="xl-metric-value">${esc(value)}</div>
		<div class="xl-metric-sub">${esc(sub)}</div>
	</div>`;
}

/** Equity curve as an SVG path. Empty when there is nothing honest to draw. */
function curvePath(series, w, h) {
	const pts = (Array.isArray(series) ? series : []).filter((n) => Number.isFinite(Number(n))).map(Number);
	if (pts.length < 2) return '';
	const min = Math.min(0, ...pts);
	const max = Math.max(0, ...pts);
	const range = max - min || 1;
	const pad = 3;
	const usable = Math.max(1, h - pad * 2);
	const x = (i) => (i / (pts.length - 1)) * w;
	const y = (v) => pad + usable - ((v - min) / range) * usable;
	return {
		d: pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' '),
		zero: y(0).toFixed(2),
	};
}

function renderResults() {
	const el = $('xl-results');
	if (!el) return;
	el.removeAttribute('aria-busy');

	if (state.error) {
		el.innerHTML = `<div class="xl-state xl-state-error" role="alert">
			<h3>The trade corpus could not be loaded</h3>
			<p>${esc(state.error)}</p>
			<p class="xl-state-sub">The fleet may still be trading. This page reads closed positions from
			<code>/api/sniper/exit-lab</code>; nothing is cached locally, so there is nothing stale to show instead.</p>
			<button type="button" class="xl-btn xl-btn-primary" id="xl-retry">Try again</button>
		</div>`;
		$('xl-retry')?.addEventListener('click', load);
		return;
	}

	if (!state.corpus) {
		el.innerHTML = `<div class="xl-state xl-state-loading">
			<div class="xl-skeleton xl-skeleton-lg"></div>
			<div class="xl-skeleton"></div>
			<div class="xl-skeleton"></div>
			<div class="xl-skeleton xl-skeleton-sm"></div>
		</div>`;
		return;
	}

	if (!state.current || state.current.trades === 0) {
		el.innerHTML = `<div class="xl-state xl-state-empty">
			<h3>No replayable trades yet</h3>
			<p>The lab needs positions the fleet opened with real SOL and closed on-chain. Once the
			first one settles it appears here, and every slider on this page starts working.</p>
			<p class="xl-state-sub">Watch entries happen live in the
			<a href="/play/arena">agent arena</a>, or read how the fleet decides in the
			<a href="/docs/agent-sniper">sniper docs</a>.</p>
		</div>`;
		return;
	}

	const r = state.current;
	const base = state.live;
	const delta = base ? r.pnlLamports - base.pnlLamports : 0;
	const isLive = sameParams(state.params, DEFAULT_PARAMS);
	const curve = curvePath(r.curve, 320, 72);

	el.innerHTML = `
		<div class="xl-verdict xl-verdict-${toneFor(r.pnlLamports)}">
			<div class="xl-verdict-main">
				<span class="xl-verdict-label">Net result over ${esc(String(r.trades))} real trades</span>
				<span class="xl-verdict-value">${esc(sol(r.pnlLamports))} SOL</span>
				<span class="xl-verdict-roi">${esc(pctText(r.roiPct))} on ${esc(sol(r.stakedLamports, { signed: false, places: 3 }))} SOL staked</span>
			</div>
			<div class="xl-verdict-delta xl-delta-${toneFor(isLive ? 0 : delta)}">
				${
					isLive
						? '<span class="xl-delta-note">This is the live fleet policy. Move a slider to compare.</span>'
						: `<span class="xl-delta-value">${esc(sol(delta))} SOL</span>
						   <span class="xl-delta-note">versus the live policy over the same trades</span>`
				}
			</div>
		</div>

		${
			curve
				? `<figure class="xl-curve">
					<svg viewBox="0 0 320 72" preserveAspectRatio="none" role="img"
						aria-label="Cumulative profit and loss across ${esc(String(r.trades))} replayed trades, ending at ${esc(sol(r.pnlLamports))} SOL">
						<line x1="0" y1="${curve.zero}" x2="320" y2="${curve.zero}" class="xl-curve-zero" />
						<path d="${curve.d}" class="xl-curve-line xl-curve-${toneFor(r.pnlLamports)}" />
					</svg>
					<figcaption>Cumulative P&amp;L, newest trade at the right. The line is the flat zero mark.</figcaption>
				</figure>`
				: ''
		}

		<div class="xl-metrics">
			${metric({
				label: 'Win rate',
				value: `${r.winRate}%`,
				sub: `${r.wins} up · ${r.losses} down`,
				title: 'Share of replayed positions that finished above their cost basis, counting a moon bag still riding at its last observed price.',
			})}
			${metric({
				label: 'Max drawdown',
				value: `${sol(r.maxDrawdownLamports, { signed: false })} SOL`,
				sub: 'worst peak-to-trough',
				tone: r.maxDrawdownLamports > 0 ? 'down' : '',
				title: 'The deepest fall of the cumulative P&L curve from a high-water mark. This is the number that decides whether a policy is survivable, not the total.',
			})}
			${metric({
				label: 'Actually booked',
				value: `${sol(r.actual.pnlLamports)} SOL`,
				sub: `over the same ${r.actual.knownTrades} trades`,
				tone: toneFor(r.actual.pnlLamports),
				title: 'What the fleet really realized on these positions, straight from the ledger. Compare replays to replays: the replay does not model slippage or fees, so it will not reproduce this figure exactly.',
			})}
			${metric({
				label: 'Still riding',
				value: String(r.ridingTrades),
				sub: 'kept a moon bag',
				title: 'Positions this policy would not have fully sold. Their remaining bag is valued at the last price the fleet observed, never at a guess about what came after.',
			})}
		</div>

		<p class="xl-policy-line">${esc(policySummary(state.params))}</p>
	`;
}

function renderReasons() {
	const el = $('xl-reasons');
	if (!el) return;
	const r = state.current;
	if (!r || r.trades === 0) {
		el.innerHTML = '';
		return;
	}
	const rows = exitReasons()
		.map((key) => ({ key, ...r.byReason[key] }))
		.filter((row) => row.trades > 0);
	if (!rows.length) {
		el.innerHTML = `<p class="xl-note">No rule fired on any trade under this policy: every position ran to the end of its recorded path.</p>`;
		return;
	}
	const maxTrades = Math.max(...rows.map((row) => row.trades));
	el.innerHTML = rows
		.map(
			(row) => `<div class="xl-reason">
				<div class="xl-reason-head">
					<span class="xl-reason-name">${esc(REASON_LABELS[row.key] || row.key)}</span>
					<span class="xl-reason-count">${row.trades} ${row.trades === 1 ? 'trade' : 'trades'}</span>
				</div>
				<div class="xl-reason-bar"><span style="width:${((row.trades / maxTrades) * 100).toFixed(1)}%"></span></div>
				<div class="xl-reason-pnl xl-delta-${toneFor(row.pnlLamports)}">${esc(sol(row.pnlLamports))} SOL</div>
			</div>`,
		)
		.join('');
}

// ── the grid search ──────────────────────────────────────────────────────────

function renderSweepIdle() {
	const el = $('xl-sweep');
	if (!el) return;
	const combos = Object.values(SWEEP_AXES).reduce((acc, g) => acc * g.length, 1);
	const trades = state.current?.trades ?? 0;
	el.innerHTML = `<p class="xl-note">${combos.toLocaleString()} policies against ${trades.toLocaleString()} real
		trades, replayed exactly. Nothing is sampled and nothing is estimated.</p>`;
}

function renderSweepProgress(done, total) {
	const el = $('xl-sweep');
	if (!el) return;
	const pctDone = total ? Math.round((done / total) * 100) : 0;
	el.innerHTML = `<div class="xl-progress" role="progressbar" aria-valuenow="${pctDone}" aria-valuemin="0" aria-valuemax="100"
			aria-label="Policy search progress">
			<div class="xl-progress-bar"><span style="width:${pctDone}%"></span></div>
			<p class="xl-note">${done.toLocaleString()} of ${total.toLocaleString()} policies replayed</p>
		</div>`;
}

function renderSweepResults() {
	const el = $('xl-sweep');
	if (!el || !state.sweep) return;
	const s = state.sweep;
	const rows = s.leaders
		.map((l, i) => {
			const isCurrent = sameParams(l.params, state.params);
			return `<tr${isCurrent ? ' class="is-current"' : ''}>
				<td class="xl-rank">${i + 1}</td>
				<td class="xl-policy">${PARAM_SPECS.map(
					(spec) => `<span class="xl-tag"><b>${esc(spec.label)}</b> ${esc(paramText(spec, l.params[spec.key]))}</span>`,
				).join('')}</td>
				<td class="xl-num xl-delta-${toneFor(l.pnlLamports)}">${esc(sol(l.pnlLamports))}</td>
				<td class="xl-num">${esc(pctText(l.roiPct))}</td>
				<td class="xl-num">${l.winRate}%</td>
				<td class="xl-num">${esc(sol(l.maxDrawdownLamports, { signed: false }))}</td>
				<td><button type="button" class="xl-btn xl-btn-small" data-apply="${i}">${isCurrent ? 'Applied' : 'Apply'}</button></td>
			</tr>`;
		})
		.join('');

	el.innerHTML = `
		${
			s.overfitRisk
				? `<p class="xl-warn" role="note"><b>Too few trades to lean on.</b> With ${state.current?.trades ?? 0}
				closed positions in the corpus, a grid this size will always find a flattering corner of noise.
				Read the leaders as a hypothesis to test, not a setting to ship.</p>`
				: `<p class="xl-note">${s.combos.toLocaleString()} policies replayed exactly against
				${state.current?.trades ?? 0} real trades. This is an in-sample optimum over trades that already
				happened: it describes the fleet's past, and the past is not a forecast.</p>`
		}
		<div class="xl-table-scroll">
			<table class="xl-table">
				<caption class="xl-sr">Top exit policies by net profit over the replayed corpus</caption>
				<thead><tr>
					<th scope="col">#</th><th scope="col">Policy</th>
					<th scope="col" class="xl-num">Net SOL</th><th scope="col" class="xl-num">ROI</th>
					<th scope="col" class="xl-num">Win</th><th scope="col" class="xl-num">Drawdown</th>
					<th scope="col"><span class="xl-sr">Apply</span></th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

/**
 * Run the grid. The work is real, so the progress is real: the corpus is
 * replayed in slices across animation frames, which keeps the page responsive
 * and lets the bar report actual completed policies rather than a timer.
 */
async function runSweep() {
	if (!state.corpus?.trades?.length) return;
	const btn = $('xl-sweep-run');
	if (btn) {
		btn.disabled = true;
		btn.textContent = 'Searching';
	}

	const keys = Object.keys(SWEEP_AXES);
	const grids = keys.map((k) => SWEEP_AXES[k]);
	const total = grids.reduce((acc, g) => acc * g.length, 1);
	renderSweepProgress(0, total);

	// Slice the grid by its first axis so each frame does a bounded, honest
	// chunk of the same exact search a single sweepParams() call would do.
	const results = [];
	let done = 0;
	for (const first of grids[0]) {
		const slice = { ...SWEEP_AXES, [keys[0]]: [first] };
		const part = sweepParams(state.corpus.trades, slice, { limit: 40, baseline: DEFAULT_PARAMS });
		results.push(...part.leaders);
		done += total / grids[0].length;
		renderSweepProgress(Math.round(done), total);
		await new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}

	results.sort((a, b) => b.pnlLamports - a.pnlLamports || a.maxDrawdownLamports - b.maxDrawdownLamports);
	state.sweep = {
		combos: total,
		leaders: results.slice(0, 8),
		overfitRisk: (state.current?.trades ?? 0) < 30,
	};
	renderSweepResults();
	if (btn) {
		btn.disabled = false;
		btn.textContent = 'Run the search again';
	}
}

// ── trade by trade ───────────────────────────────────────────────────────────

const TRADE_LIMIT = 25;

function renderTrades() {
	const el = $('xl-trades');
	if (!el) return;
	el.removeAttribute('aria-busy');
	const r = state.current;
	if (!r || !r.rows.length) {
		el.innerHTML = '';
		return;
	}
	const meta = new Map((state.corpus?.trades || []).map((t) => [t.mint, t]));
	const rows = r.rows.slice();
	if (state.tradeSort === 'best') rows.sort((a, b) => b.pnlLamports - a.pnlLamports);
	else if (state.tradeSort === 'worst') rows.sort((a, b) => a.pnlLamports - b.pnlLamports);
	else {
		rows.sort(
			(a, b) =>
				Math.abs(b.pnlLamports - (b.actualPnlLamports ?? 0)) -
				Math.abs(a.pnlLamports - (a.actualPnlLamports ?? 0)),
		);
	}

	const body = rows
		.slice(0, TRADE_LIMIT)
		.map((row) => {
			const t = meta.get(row.mint) || {};
			const label = row.symbol || row.mint?.slice(0, 6) || 'coin';
			const diff = row.actualPnlLamports == null ? null : row.pnlLamports - Number(row.actualPnlLamports);
			return `<tr>
				<td class="xl-coin">
					<span class="xl-coin-sym">${esc(String(label).toUpperCase())}</span>
					${row.agentName ? `<a class="xl-coin-agent" href="/trader/${esc(row.agentId)}">${esc(row.agentName)}</a>` : ''}
				</td>
				<td class="xl-num" title="High-water mark reached, as a multiple of the entry price">${row.peakMultiple}x</td>
				<td class="xl-num xl-delta-${toneFor(row.actualPnlLamports)}">${
					row.actualPnlLamports == null ? '·' : esc(sol(row.actualPnlLamports))
				}</td>
				<td class="xl-num xl-delta-${toneFor(row.pnlLamports)}">${esc(sol(row.pnlLamports))}</td>
				<td class="xl-num xl-delta-${toneFor(diff)}">${diff == null ? '·' : esc(sol(diff))}</td>
				<td><span class="xl-reason-tag">${esc(REASON_LABELS[row.exitReason] || row.exitReason || '·')}</span>${
					row.keptMoonbag ? '<span class="xl-reason-tag xl-tag-bag" title="A moon bag was still riding at the end of the recorded path">bag riding</span>' : ''
				}</td>
				<td class="xl-proof">${
					t.buyUrl
						? `<a href="${esc(t.buyUrl)}" target="_blank" rel="noopener noreferrer" title="Buy transaction on Solscan">buy</a>`
						: ''
				}${
					t.sellUrl
						? `<a href="${esc(t.sellUrl)}" target="_blank" rel="noopener noreferrer" title="Sell transaction on Solscan">sell</a>`
						: ''
				}</td>
			</tr>`;
		})
		.join('');

	el.innerHTML = `<div class="xl-table-scroll">
		<table class="xl-table">
			<caption class="xl-sr">Per-trade comparison of the replayed policy against what the fleet actually booked</caption>
			<thead><tr>
				<th scope="col">Coin</th>
				<th scope="col" class="xl-num">Peak</th>
				<th scope="col" class="xl-num">Booked</th>
				<th scope="col" class="xl-num">Replay</th>
				<th scope="col" class="xl-num">Delta</th>
				<th scope="col">Exit</th>
				<th scope="col">On-chain</th>
			</tr></thead>
			<tbody>${body}</tbody>
		</table>
	</div>
	${
		rows.length > TRADE_LIMIT
			? `<p class="xl-note">Showing ${TRADE_LIMIT} of ${rows.length} replayed trades, ranked by the sort above.</p>`
			: ''
	}`;
}

// ── the caveats ──────────────────────────────────────────────────────────────

function renderHonesty() {
	const el = $('xl-honesty');
	if (!el) return;
	const c = state.corpus;
	const r = state.current;
	const items = [
		`<b>Every trade is real.</b> The corpus is closed positions with an on-chain buy signature that is not the
		simulate sentinel. Paper fills cannot enter it. ${
			c ? `${c.replayable} of ${c.scanned} closed positions in this window are replayable.` : ''
		}`,
		`<b>Compare replays to replays, not to the ledger.</b> The replay prices an exit at the quote the fleet
		recorded and does not model slippage, priority fees or the spread actually paid. Replaying the live
		policy will therefore not reproduce the booked number, and the gap between two replays is the signal.`,
		`<b>Exiting earlier is exact; holding longer is a floor.</b> The recorded path stops where the real
		policy sold. A counterfactual that would have kept holding is valued at that last observed price, so its
		result is a lower bound and never an upper one.${
			r && r.boundedTrades ? ` ${r.boundedTrades} of ${r.trades} trades are bounded this way under the current policy.` : ''
		}`,
	];
	for (const ex of c?.excluded || []) {
		items.push(`<b>${ex.count} position${ex.count === 1 ? '' : 's'} excluded.</b> ${esc(ex.reason)}`);
	}
	items.push(
		`<b>An in-sample optimum is not a forecast.</b> The search finds the policy that would have paid best on
		trades that already happened. Read <a href="/docs/exit-lab">the method</a> before changing anything the
		fleet runs on.`,
	);
	el.innerHTML = items.map((html) => `<li>${html}</li>`).join('');
}

// ── corpus pill + updated line ───────────────────────────────────────────────

function renderPill() {
	const el = $('xl-corpus-pill');
	if (!el) return;
	if (state.error) {
		el.className = 'xl-pill xl-pill-down';
		el.innerHTML = '<span class="xl-dot" aria-hidden="true"></span><span class="xl-pill-text">Corpus unavailable</span>';
		return;
	}
	if (!state.corpus) return;
	const n = state.corpus.replayable;
	el.className = n > 0 ? 'xl-pill xl-pill-live' : 'xl-pill xl-pill-muted';
	el.innerHTML = `<span class="xl-dot" aria-hidden="true"></span><span class="xl-pill-text">${
		n > 0 ? `${n} real closed trades loaded` : 'No closed trades yet'
	}</span>`;
}

function renderUpdated() {
	const el = $('xl-updated');
	if (!el || !state.corpus?.generatedAt) return;
	const d = new Date(state.corpus.generatedAt);
	el.textContent = Number.isFinite(d.getTime())
		? `Corpus read ${d.toLocaleString()} · mainnet · all closed positions`
		: '';
}

// ── wiring ───────────────────────────────────────────────────────────────────

function recompute() {
	if (!state.corpus) return;
	state.current = replayFleet(state.corpus.trades, state.params);
	renderResults();
	renderReasons();
	renderTrades();
	renderHonesty();
	renderPresets();
	if (state.sweep) renderSweepResults();
	else renderSweepIdle();
}

async function load() {
	state.error = null;
	state.corpus = null;
	renderResults();
	try {
		const res = await fetch(CORPUS_URL, { headers: { accept: 'application/json' } });
		const body = await res.json().catch(() => null);
		const data = body?.data ?? body;
		if (!res.ok || !data || data.ok === false) {
			throw new Error(data?.detail || data?.error || `the corpus endpoint returned ${res.status}`);
		}
		state.corpus = data;
		state.live = replayFleet(data.trades, DEFAULT_PARAMS);
		renderPill();
		renderUpdated();
		recompute();
	} catch (err) {
		state.error = err?.message || 'the request failed';
		renderPill();
		renderResults();
		renderHonesty();
	}
}

function init() {
	const fromUrl = paramsFromUrl();
	if (fromUrl) state.params = fromUrl;
	renderPresets();
	renderControls();
	bindControls();
	renderResults();
	load();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
