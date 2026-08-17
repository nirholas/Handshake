// src/economy-lab.js: the Runway Lab (/economy-lab).
//
// A digital twin of the x402 settle path's admission control. The page imports
// api/_lib/x402/runway-sim.js, which in turn imports the very functions the
// live facilitator calls on every settle (wallet-fee-governor.js), so the
// projection cannot drift from production the way a parallel model would.
//
// Both modules are dependency-free and reach no node: built-in, which is what
// makes this cross-boundary import legal here; scripts/check-browser-graph.mjs
// fails the build the moment that stops being true.
//
// Live state comes from GET /api/x402/runway-lab. Everything else happens in
// the browser: no writes, no wallet connection, no config is changed from this
// page. Applying a configuration is a command the operator runs themselves.

import {
	simulateRunway,
	solveForThroughput,
	equilibriumSettlesPerDay,
	envDiff,
	LAMPORTS_PER_SOL,
} from '../api/_lib/x402/runway-sim.js';

const $ = (id) => document.getElementById(id);

const KNOBS = {
	balance: { el: null, out: null, live: 0, fmt: (v) => `${fmtSol(v)} SOL` },
	floor: { el: null, out: null, live: 0, fmt: (v) => `${fmtSol(v)} SOL` },
	runway: { el: null, out: null, live: 3, fmt: (v) => `${v} day${Number(v) === 1 ? '' : 's'}` },
	heartbeat: { el: null, out: null, live: 0, fmt: (v) => `${fmtSol(v)} SOL/day` },
	demand: { el: null, out: null, live: 0, fmt: (v) => `${fmtInt(v)}/hour` },
	horizon: { el: null, out: null, live: 72, fmt: (v) => (v >= 48 ? `${Math.round(v / 24)} days` : `${v} hours`) },
};

let seed = null;
let feeLamports = 5000;

// Demand the projection falls back to when the facilitator log recorded no
// settle attempts in the window. A projection needs traffic to say anything:
// seeded at zero the page opens with an empty chart and a verdict that has
// proved nothing, which is worse than useless on a rail whose wallet is sitting
// under its hard floor. The knob is a scenario input, not a measurement, so a
// labelled default is honest as long as the page says which one it is, and
// demandSource below is what makes it say so.
const SCENARIO_DEMAND_PER_HOUR = 60;
let demandSource = 'measured';

// ── Formatting ─────────────────────────────────────────────────────────────
function fmtSol(lamports, max = 4) {
	const n = Number(lamports) / LAMPORTS_PER_SOL;
	if (!Number.isFinite(n)) return '0';
	if (n === 0) return '0';
	if (n < 0.0001) return n.toExponential(2);
	return n.toLocaleString('en-US', { maximumFractionDigits: max });
}

function fmtInt(n) {
	return Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : '0';
}

// null and undefined are "the ledger had nothing to divide", not zero. Number()
// turns both into 0, which rendered an unread admission rate as a confident
// "0.0%", a starvation reading invented out of missing data.
function fmtPct(n, digits = 1) {
	if (n === null || n === undefined || n === '') return 'not read';
	return Number.isFinite(Number(n)) ? `${(Number(n) * 100).toFixed(digits)}%` : 'not read';
}

// A projection hour turned into a human clock reading, anchored on the UTC hour
// the seed was taken. "in 14h (03:00 UTC)" is actionable in a way that "hour
// 14" is not.
function fmtWhen(hour) {
	if (hour === null || hour === undefined) return 'not reached';
	const utc = ((seed?.meter?.utc_hour ?? 0) + hour) % 24;
	const clock = `${String(utc).padStart(2, '0')}:00 UTC`;
	if (hour === 0) return `immediately (${clock})`;
	if (hour < 48) return `in ${hour}h (${clock})`;
	return `in ${Math.floor(hour / 24)}d ${hour % 24}h (${clock})`;
}

function shortAddr(a) {
	return a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || 'not configured';
}

// ── Accessible tooltips ────────────────────────────────────────────────────
// Hover, focus, and touch all open; Escape and blur close. The tip is a single
// fixed node repositioned per trigger so it can never be clipped by a panel's
// overflow, and it is flipped above the trigger when it would leave the
// viewport.
function initTooltips() {
	const tip = $('el-tip');
	if (!tip) return;
	let current = null;

	const close = () => {
		if (!current) return;
		current.setAttribute('aria-expanded', 'false');
		current.removeAttribute('aria-describedby');
		current = null;
		tip.dataset.open = 'false';
		tip.hidden = true;
	};

	const open = (btn) => {
		const text = btn.dataset.tip;
		if (!text) return;
		current = btn;
		tip.textContent = text;
		tip.hidden = false;
		tip.dataset.open = 'true';
		tip.id = 'el-tip';
		btn.setAttribute('aria-expanded', 'true');
		btn.setAttribute('aria-describedby', 'el-tip');

		const r = btn.getBoundingClientRect();
		const t = tip.getBoundingClientRect();
		let left = r.left + r.width / 2 - t.width / 2;
		left = Math.max(12, Math.min(left, window.innerWidth - t.width - 12));
		let top = r.bottom + 9;
		if (top + t.height > window.innerHeight - 12) top = r.top - t.height - 9;
		tip.style.left = `${Math.round(left)}px`;
		tip.style.top = `${Math.round(Math.max(12, top))}px`;
	};

	for (const btn of document.querySelectorAll('.el-help')) {
		btn.setAttribute('aria-expanded', 'false');
		btn.addEventListener('mouseenter', () => open(btn));
		btn.addEventListener('mouseleave', close);
		btn.addEventListener('focus', () => open(btn));
		btn.addEventListener('blur', close);
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			if (current === btn) close();
			else open(btn);
		});
	}
	// Capture phase: site-wide scripts (nav, command palette) also listen for
	// Escape and some stop propagation, which would leave a tooltip stuck open
	// for keyboard users with no way to dismiss it.
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
	window.addEventListener('scroll', close, { passive: true });
	window.addEventListener('resize', close);
}

// ── Seed ───────────────────────────────────────────────────────────────────
async function loadSeed() {
	const res = await fetch('/api/x402/runway-lab', { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`seed request failed: ${res.status}`);
	const data = await res.json();
	if (!data?.ok) throw new Error('seed request returned an error payload');
	return data;
}

function applySeedToKnobs() {
	const cfg = seed.config;
	const bal = seed.fee_wallet.sol_lamports;
	feeLamports = seed.observed?.fee_lamports_observed || 5000;

	const measuredDemand = Number(seed.observed?.demand_per_hour) || 0;
	demandSource = measuredDemand > 0 ? 'measured' : 'scenario';

	KNOBS.balance.live = bal ?? cfg.floor_lamports;
	KNOBS.floor.live = cfg.floor_lamports;
	KNOBS.runway.live = cfg.runway_days;
	KNOBS.heartbeat.live = cfg.min_budget_lamports;
	KNOBS.demand.live = measuredDemand > 0 ? measuredDemand : SCENARIO_DEMAND_PER_HOUR;
	KNOBS.horizon.live = 72;

	// Ranges are derived from the live values so every knob has useful travel on
	// both sides of where production actually sits, rather than a fixed scale
	// that pins the handle at one end.
	//
	// The lamport knobs use step="1". A coarser step would silently round the
	// live balance to the nearest slider notch, and on a wallet holding 0.023 SOL
	// a 0.001 SOL notch is a 5% error in the seed. Keyboard usability is restored
	// by lamportKeySteps() below rather than by giving up precision.
	setRange(KNOBS.balance.el, 0, Math.max(2 * LAMPORTS_PER_SOL, KNOBS.balance.live * 4), 1);
	setRange(KNOBS.floor.el, 0, Math.max(200_000_000, KNOBS.floor.live * 4), 1);
	setRange(KNOBS.heartbeat.el, 0, Math.max(200_000_000, KNOBS.heartbeat.live * 8), 1);
	// Step 1, for the same reason the lamport knobs use it: a step of 5 snapped a
	// measured 37 settles/hour to 35, and snapped the seed of a barely-used rail
	// all the way down to 0.
	setRange(KNOBS.demand.el, 0, Math.max(3000, KNOBS.demand.live * 6), 1);

	$('el-governor').checked = cfg.governor_enabled;
	describeDemandSeed();
	for (const key of Object.keys(KNOBS)) KNOBS[key].el.value = String(KNOBS[key].live);
	// The input clamps and snaps on assignment, so the resolved value is the real
	// baseline. Comparing against the requested value instead would leave every
	// knob permanently "dirty" and the reset button permanently enabled.
	for (const key of Object.keys(KNOBS)) KNOBS[key].live = Number(KNOBS[key].el.value);
}

// Say where the demand number came from, in the hint and in the tooltip. A
// scenario default presented as a measurement would make the whole page a lie;
// presented as what it is, it is the only way to project a rail nobody used
// today.
function describeDemandSeed() {
	const hint = $('el-demand-hint');
	const help = document.querySelector('[data-knob="demand"] .el-help');
	const measured = demandSource === 'measured';

	hint.textContent = measured
		? 'What the rail is being asked to do, per hour. Seeded from the last 24 hours.'
		: `No settles were attempted in the last 24 hours, so there is no measured rate to seed from. This starts at ${fmtInt(SCENARIO_DEMAND_PER_HOUR)}/hour as a scenario: drag it to the load you care about.`;
	hint.dataset.source = demandSource;

	if (!help) return;
	help.dataset.tip = measured
		? 'Settle attempts arriving per hour. Seeded from the last 24 hours of the facilitator log, excluding duplicate-signature retries, so the projection starts from measured traffic rather than a guess.'
		: 'Settle attempts arriving per hour. The facilitator log recorded no attempts in the last 24 hours, so this knob is a scenario you choose rather than a measurement. Everything else on the page is still read live.';
}

function setRange(el, min, max, step) {
	el.min = String(min);
	el.max = String(Math.ceil(max));
	el.step = String(step);
}

// A step of 1 lamport makes arrow keys useless on a range spanning billions.
// Give the lamport sliders a keyboard grammar sized to the money: 0.001 SOL per
// arrow press, 0.05 SOL per page, and the ends for Home/End.
function lamportKeySteps(el) {
	el.addEventListener('keydown', (e) => {
		const jump = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -50, PageUp: 50 }[e.key];
		if (jump === undefined) return;
		e.preventDefault();
		const next = Number(el.value) + jump * 1_000_000;
		el.value = String(Math.min(Number(el.max), Math.max(Number(el.min), next)));
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
}

function readKnobs() {
	return {
		startLamports: Number(KNOBS.balance.el.value),
		floorLamports: Number(KNOBS.floor.el.value),
		runwayDays: Number(KNOBS.runway.el.value),
		minBudgetLamports: Number(KNOBS.heartbeat.el.value),
		demandPerHour: Number(KNOBS.demand.el.value),
		hours: Number(KNOBS.horizon.el.value),
		governorEnabled: $('el-governor').checked,
	};
}

function isDirty() {
	if ($('el-governor').checked !== seed.config.governor_enabled) return true;
	return Object.keys(KNOBS).some((k) => Number(KNOBS[k].el.value) !== Number(KNOBS[k].live));
}

// ── Live state panel ───────────────────────────────────────────────────────
function renderLiveState() {
	const w = seed.fee_wallet;
	const cfg = seed.config;
	const o = seed.observed;
	const spendable = w.spendable_lamports;
	const spent = seed.meter?.spent_today_lamports;

	const budgetNow = spendable === null
		? null
		: Math.max(cfg.governor_enabled ? cfg.min_budget_lamports : 0, Math.floor(spendable / cfg.runway_days));
	const headroom = budgetNow === null || spent === null ? null : budgetNow - spent;
	// Below the floor the settle path refuses before the meter is read, so the
	// governor's headroom is not the binding constraint and must not be rendered
	// as one. A wallet under its floor with a full daily budget was reporting
	// "headroom 0.01 SOL" in green while admitting nothing at all.
	const belowFloor = w.balance_read && w.sol_lamports < cfg.floor_lamports;

	const cards = [
		{
			label: 'Fee wallet',
			value: shortAddr(w.address),
			sub: w.role ? `${w.role} role` : 'unresolved',
		},
		{
			label: 'Balance',
			value: w.balance_read ? `${fmtSol(w.sol_lamports)} SOL` : 'not read',
			sub: w.balance_read ? `floor ${fmtSol(cfg.floor_lamports)} SOL` : 'RPC unavailable',
			tone: !w.balance_read ? '' : w.sol_lamports < cfg.floor_lamports ? 'bad' : 'good',
		},
		{
			label: 'Spendable',
			value: spendable === null ? 'not read' : `${fmtSol(spendable)} SOL`,
			sub: belowFloor
				? `${fmtSol(cfg.floor_lamports - w.sol_lamports)} SOL short of the hard floor`
				: 'balance above the hard floor',
			tone: spendable === null ? '' : spendable <= 0 ? 'bad' : spendable < cfg.min_budget_lamports ? 'warn' : 'good',
		},
		{
			label: 'Today’s headroom',
			value: belowFloor ? 'not reachable' : headroom === null ? 'not read' : `${fmtSol(headroom)} SOL`,
			sub: belowFloor
				? 'the hard floor refuses before the budget is consulted'
				: spent === null ? 'ledger unread' : `${fmtSol(spent)} spent of ${fmtSol(budgetNow)} budget`,
			tone: belowFloor ? 'bad' : headroom === null ? '' : headroom <= 0 ? 'bad' : headroom < budgetNow * 0.2 ? 'warn' : 'good',
		},
		{
			label: 'Settles / day',
			value: seed.projected_settles_per_day === null ? 'not read' : fmtInt(seed.projected_settles_per_day),
			sub: 'at this balance and config',
			tone: seed.projected_settles_per_day === null
				? ''
				: seed.projected_settles_per_day <= 0 ? 'bad' : seed.projected_settles_per_day < 1000 ? 'warn' : 'good',
		},
		{
			label: 'Admitted (24h)',
			value: !o ? 'not read' : o.attempts === 0 ? 'no traffic' : fmtPct(o.capacity_admission_rate),
			sub: !o
				? 'ledger unread'
				: o.attempts === 0
					? 'no settles were attempted in this window'
					: `${fmtInt(o.settled)} settled, ${fmtInt(o.capacity_refused)} could not be afforded`,
			tone: !o || o.capacity_admission_rate === null ? '' : o.capacity_admission_rate > 0.9 ? 'good' : o.capacity_admission_rate > 0.5 ? 'warn' : 'bad',
		},
	];

	$('el-stats').innerHTML = cards.map((c) => `
		<div class="el-stat"${c.tone ? ` data-tone="${c.tone}"` : ''}>
			<p class="el-stat-label">${esc(c.label)}</p>
			<p class="el-stat-value">${esc(c.value)}</p>
			<p class="el-stat-sub">${esc(c.sub)}</p>
		</div>`).join('');

	$('el-stamp').textContent = `Read ${new Date(seed.generated_at).toLocaleTimeString()}`;

	const notes = [];
	if (!w.balance_read) notes.push('The fee wallet balance could not be read from Solana RPC, so the projection is seeded from the configured floor. Nothing here should be read as a starvation signal.');
	if (seed.db_error) notes.push('The facilitator ledger could not be read, so observed demand, fee size, and refusal causes are unavailable. The knobs still work against the live balance and config.');
	if (!seed.self_facilitator_enabled) notes.push('The self-hosted facilitator is disabled on this deploy, so settlement routes externally and this governor is not in the path.');
	const note = $('el-live-note');
	note.hidden = notes.length === 0;
	note.textContent = notes.join(' ');
}

// ── Verdict ────────────────────────────────────────────────────────────────
function renderVerdict(summary) {
	const box = $('el-verdict');
	const icon = box.querySelector('.el-verdict-icon');
	const dirty = isDirty();
	const scope = dirty ? 'With your changes' : 'As configured right now';

	const limiterText = {
		floor: 'the hard SOL floor is refusing settles: the wallet has nothing spendable left, and no config change moves this. Only funding does.',
		governor: 'the wallet fee governor is pacing the rail: there is SOL above the floor, but the daily fee budget is spent.',
		demand: 'nothing in the rail is holding it back. Every attempt lands, so throughput is set by how much demand arrives.',
		none: 'no settles were attempted over this horizon, so there is nothing to admit or refuse.',
	}[summary.limiter];

	const state = summary.verdict;
	box.dataset.state = state;
	icon.textContent = { healthy: '✓', throttled: '!', idle: '·' }[state] || '×';

	const head = {
		healthy: `${scope}, settlement is healthy`,
		throttled: `${scope}, settlement is throttled`,
		starved: `${scope}, settlement is starved`,
		idle: `${scope}, nothing is being attempted`,
	}[state];

	$('el-verdict-head').textContent = head;
	// An idle projection has admitted nothing and refused nothing, which is not a
	// clean bill of health: it is an experiment that was never run. Say that
	// instead of reporting a 100% admission rate over an empty set.
	$('el-verdict-detail').textContent = state === 'idle'
		? `No settles are attempted over the next ${fmtWhenSpan(summary.hoursSimulated)}, so this projection cannot say whether the rail would admit them. Raise demand to find out what this balance and config would actually deliver.`
		: `${fmtInt(summary.admitted)} of ${fmtInt(summary.demanded)} settles land over the next ${fmtWhenSpan(summary.hoursSimulated)}: ${limiterText}` +
			(summary.firstRefusalHour !== null ? ` First refusal ${fmtWhen(summary.firstRefusalHour)}.` : '');
}

function fmtWhenSpan(hours) {
	return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
}

// ── KPIs ───────────────────────────────────────────────────────────────────
function renderKpis(summary, knobs) {
	const liveProjection = seed.projected_settles_per_day;
	const steady = summary.steadySettlesPerDay;
	const delta = liveProjection ? steady - liveProjection : null;
	// With no attempts in the projection, "never refused" and "never hit the
	// floor" are facts about an empty simulation, not about the rail. Reporting
	// them in green is the same error as a 100% admission rate over zero settles.
	const idle = summary.demanded === 0;

	const kpis = [
		{
			label: 'Settles / day',
			value: fmtInt(steady),
			tone: steady <= 0 ? 'bad' : steady < 1000 ? 'warn' : 'good',
			delta: delta === null ? 'steady state' : delta === 0 ? 'same as live' : `${delta > 0 ? '+' : ''}${fmtInt(delta)} vs live`,
		},
		{
			label: 'Admission rate',
			value: idle ? 'no demand' : fmtPct(summary.admissionRate, 0),
			tone: idle ? '' : summary.admissionRate > 0.9 ? 'good' : summary.admissionRate > 0.5 ? 'warn' : 'bad',
			delta: idle ? 'nothing was attempted' : `${fmtInt(summary.refused)} refused`,
		},
		{
			label: 'First refusal',
			value: idle ? 'untested' : summary.firstRefusalHour === null ? 'never' : fmtWhen(summary.firstRefusalHour).replace(/ \(.*\)/, ''),
			tone: idle ? '' : summary.firstRefusalHour === null ? 'good' : summary.firstRefusalHour < 6 ? 'bad' : 'warn',
			delta: idle ? 'raise demand to test it' : summary.firstRefusalHour === null ? 'holds the whole horizon' : 'throughput breaks here',
		},
		{
			label: 'Hits the floor',
			value: idle ? 'untested' : summary.floorBreachHour === null ? 'never' : fmtWhen(summary.floorBreachHour).replace(/ \(.*\)/, ''),
			tone: idle ? '' : summary.floorBreachHour === null ? 'good' : 'bad',
			delta: idle ? 'no fees are being burned' : summary.floorBreachHour === null ? 'stays above the floor' : 'funding required',
		},
		{
			label: 'SOL burned',
			value: `${fmtSol(summary.feesBurnedLamports)} SOL`,
			delta: `at ${fmtInt(feeLamports)} lamports/settle`,
		},
		{
			label: 'Ending balance',
			value: `${fmtSol(summary.endLamports)} SOL`,
			tone: summary.endLamports < knobs.floorLamports ? 'bad' : 'good',
			delta: `from ${fmtSol(summary.startLamports)} SOL`,
		},
	];

	$('el-kpis').innerHTML = kpis.map((k) => `
		<div class="el-kpi"${k.tone ? ` data-tone="${k.tone}"` : ''}>
			<p class="el-kpi-label">${esc(k.label)}</p>
			<p class="el-kpi-value">${esc(k.value)}</p>
			<p class="el-kpi-delta">${esc(k.delta)}</p>
		</div>`).join('');
}

// ── Chart ──────────────────────────────────────────────────────────────────
// Balance as a filled area against the left axis, hourly admitted and refused
// counts as stacked columns against the right, the hard floor as a dashed rule,
// and a tick per UTC midnight so the governor's daily reset is visible as the
// structural feature it is.
function drawChart(series, knobs) {
	const canvas = $('el-chart');
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	const cssW = canvas.clientWidth || 1000;
	const cssH = Math.round((cssW * 380) / 1000);
	canvas.width = Math.round(cssW * dpr);
	canvas.height = Math.round(cssH * dpr);
	const ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, cssW, cssH);

	const css = getComputedStyle(document.querySelector('.el-shell'));
	const col = (name, fallback) => (css.getPropertyValue(name) || fallback).trim();
	const line = col('--el-line', '#232735');
	const faint = col('--el-faint', '#6a7183');
	const accent = col('--el-accent', '#6ee7b7');
	const danger = col('--el-danger', '#fb7185');
	const info = col('--el-info', '#7dd3fc');

	const padL = 58;
	const padR = 52;
	const padT = 16;
	const padB = 28;
	const w = cssW - padL - padR;
	const h = cssH - padT - padB;
	if (w <= 0 || h <= 0 || !series.length) return;

	const maxBal = Math.max(knobs.floorLamports * 1.15, ...series.map((s) => s.lamports), 1);
	const maxCount = Math.max(1, ...series.map((s) => s.admitted + s.refusedFloor + s.refusedGovernor));
	const x = (i) => padL + (series.length === 1 ? w / 2 : (i / (series.length - 1)) * w);
	const yBal = (v) => padT + h - (v / maxBal) * h;
	const yCount = (v) => padT + h - (v / maxCount) * h;

	// Grid
	ctx.strokeStyle = line;
	ctx.lineWidth = 1;
	ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
	ctx.fillStyle = faint;
	for (let g = 0; g <= 4; g++) {
		const yy = padT + (h / 4) * g;
		ctx.beginPath();
		ctx.moveTo(padL, yy);
		ctx.lineTo(padL + w, yy);
		ctx.stroke();
		ctx.textAlign = 'right';
		ctx.fillText(`${fmtSol(maxBal * (1 - g / 4), 3)}`, padL - 8, yy + 4);
		ctx.textAlign = 'left';
		ctx.fillText(fmtInt(maxCount * (1 - g / 4)), padL + w + 8, yy + 4);
	}

	// UTC midnight markers
	const startHour = seed?.meter?.utc_hour ?? 0;
	ctx.save();
	ctx.setLineDash([2, 4]);
	ctx.strokeStyle = faint;
	for (let i = 0; i < series.length; i++) {
		if ((startHour + i) % 24 !== 0 || i === 0) continue;
		ctx.beginPath();
		ctx.moveTo(x(i), padT);
		ctx.lineTo(x(i), padT + h);
		ctx.stroke();
		ctx.fillStyle = faint;
		ctx.textAlign = 'center';
		ctx.fillText('00 UTC', x(i), padT + 10);
	}
	ctx.restore();

	// Hourly outcome columns
	const barW = Math.max(1, Math.min(14, w / series.length - 1));
	for (let i = 0; i < series.length; i++) {
		const s = series[i];
		const refused = s.refusedFloor + s.refusedGovernor;
		const bx = x(i) - barW / 2;
		if (s.admitted > 0) {
			ctx.fillStyle = accent;
			const bh = padT + h - yCount(s.admitted);
			ctx.fillRect(bx, yCount(s.admitted), barW, bh);
		}
		if (refused > 0) {
			ctx.fillStyle = danger;
			const top = yCount(s.admitted + refused);
			const bh = yCount(s.admitted) - top;
			ctx.fillRect(bx, top, barW, Math.max(1, bh));
		}
	}

	// Hard floor rule
	ctx.save();
	ctx.setLineDash([5, 4]);
	ctx.strokeStyle = danger;
	ctx.lineWidth = 1.25;
	ctx.beginPath();
	ctx.moveTo(padL, yBal(knobs.floorLamports));
	ctx.lineTo(padL + w, yBal(knobs.floorLamports));
	ctx.stroke();
	ctx.restore();
	ctx.fillStyle = danger;
	ctx.textAlign = 'left';
	ctx.fillText('hard floor', padL + 4, yBal(knobs.floorLamports) - 5);

	// Balance area + line
	ctx.beginPath();
	ctx.moveTo(x(0), padT + h);
	for (let i = 0; i < series.length; i++) ctx.lineTo(x(i), yBal(series[i].lamports));
	ctx.lineTo(x(series.length - 1), padT + h);
	ctx.closePath();
	const grad = ctx.createLinearGradient(0, padT, 0, padT + h);
	grad.addColorStop(0, hexWithAlpha(info, 0.28));
	grad.addColorStop(1, hexWithAlpha(info, 0));
	ctx.fillStyle = grad;
	ctx.fill();

	ctx.beginPath();
	for (let i = 0; i < series.length; i++) {
		const px = x(i);
		const py = yBal(series[i].lamports);
		if (i === 0) ctx.moveTo(px, py);
		else ctx.lineTo(px, py);
	}
	ctx.strokeStyle = info;
	ctx.lineWidth = 2;
	ctx.stroke();

	// Axis labels
	ctx.fillStyle = faint;
	ctx.textAlign = 'left';
	ctx.fillText('SOL', 6, padT + 10);
	ctx.textAlign = 'right';
	ctx.fillText('settles/h', cssW - 6, padT + 10);
}

function hexWithAlpha(color, alpha) {
	const c = color.trim();
	if (/^#([0-9a-f]{6})$/i.test(c)) {
		const n = parseInt(c.slice(1), 16);
		return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
	}
	return c;
}

// ── Solve panel ────────────────────────────────────────────────────────────
function renderLevers() {
	const knobs = readKnobs();
	const target = Math.max(0, Number($('el-target').value) || 0);
	const s = solveForThroughput({
		targetSettlesPerDay: target,
		startLamports: knobs.startLamports,
		floorLamports: knobs.floorLamports,
		runwayDays: knobs.runwayDays,
		minBudgetLamports: knobs.minBudgetLamports,
		feeLamports,
	});

	// A lever is only real if the wallet can actually fund the target down to its
	// floor. Widening the governor on a wallet with nothing spendable changes
	// nothing, and saying so is the point of this panel.
	const spendable = Math.max(0, knobs.startLamports - knobs.floorLamports);
	const fundable = spendable / feeLamports >= target;

	const levers = [
		{
			key: 'fund',
			name: 'Fund the wallet',
			value: s.alreadyMet ? 'not needed' : s.fund ? `+${fmtSol(s.fund.lamports)} SOL` : 'not needed',
			note: s.alreadyMet
				? 'The current configuration already reaches this target.'
				: `Deposit to reach ${fmtInt(target)} settles/day while keeping the ${knobs.runwayDays}-day runway.`,
			usable: !s.alreadyMet && !!s.fund,
			apply: s.fund ? () => setKnob('balance', knobs.startLamports + s.fund.lamports) : null,
		},
		{
			key: 'runway',
			name: 'Shorten the runway',
			value: s.alreadyMet ? 'not needed' : s.runwayDays ? `${s.runwayDays} days` : 'cannot work',
			note: s.alreadyMet
				? 'The current configuration already reaches this target.'
				: s.runwayDays
					? 'Spends the same SOL faster. Reaches the target today at the cost of tomorrow.'
					: 'There is not enough spendable SOL to reach this target at any runway setting.',
			usable: !s.alreadyMet && !!s.runwayDays,
			apply: s.runwayDays ? () => setKnob('runway', s.runwayDays) : null,
		},
		{
			key: 'heartbeat',
			name: 'Raise the heartbeat',
			value: s.alreadyMet ? 'not needed' : `${fmtSol(s.minBudget.lamports)} SOL/day`,
			note: s.alreadyMet
				? 'The current configuration already reaches this target.'
				: fundable
					? 'Independent of the balance, so it works even on a nearly empty wallet.'
					: 'Raising this alone will not help: the wallet does not hold enough spendable SOL, so the hard floor refuses first.',
			usable: !s.alreadyMet && fundable,
			apply: () => setKnob('heartbeat', s.minBudget.lamports),
		},
	];

	const host = $('el-levers');
	host.innerHTML = levers.map((l) => `
		<div class="el-lever" data-usable="${l.usable}">
			<p class="el-lever-name">${esc(l.name)}</p>
			<p class="el-lever-value">${esc(l.value)}</p>
			<p class="el-lever-note">${esc(l.note)}</p>
			${l.usable ? `<button type="button" class="el-lever-apply" data-lever="${l.key}">Try it</button>` : ''}
		</div>`).join('');

	for (const btn of host.querySelectorAll('.el-lever-apply')) {
		const lever = levers.find((l) => l.key === btn.dataset.lever);
		if (lever?.apply) btn.addEventListener('click', () => { lever.apply(); render(); });
	}
}

function setKnob(key, value) {
	const k = KNOBS[key];
	const max = Number(k.el.max);
	if (value > max) setRange(k.el, Number(k.el.min), value * 1.2, Number(k.el.step));
	k.el.value = String(value);
}

// ── Apply panel ────────────────────────────────────────────────────────────
function renderApply() {
	const knobs = readKnobs();
	const changes = envDiff(
		{
			runwayDays: seed.config.runway_days,
			minBudgetLamports: seed.config.min_budget_lamports,
			floorLamports: seed.config.floor_lamports,
			governorEnabled: seed.config.governor_enabled,
		},
		{
			runwayDays: knobs.runwayDays,
			minBudgetLamports: knobs.minBudgetLamports,
			floorLamports: knobs.floorLamports,
			governorEnabled: knobs.governorEnabled,
		},
	);

	const host = $('el-apply');
	const balanceChanged = knobs.startLamports !== KNOBS.balance.live;
	const fundingNote = balanceChanged
		? `<p class="el-warnbox">This projection also assumes a fee wallet balance of ${esc(fmtSol(knobs.startLamports))} SOL (live is ${esc(fmtSol(KNOBS.balance.live))} SOL). Moving funds is not something this page does or should do: it is a signed transfer an operator makes deliberately.</p>`
		: '';

	if (!changes.length) {
		// Deliberately scoped to the environment: the balance knob has no env var
		// behind it, so claiming "every knob matches" while the balance is dragged
		// somewhere else was simply false. The funding note below covers that case.
		host.innerHTML = `<p class="el-empty">No environment change. Every governor setting matches what this deploy is running.</p>${fundingNote}`;
		return;
	}

	const cmd = [
		'gcloud run services update three-ws-api \\',
		'  --region us-central1 --project aerial-vehicle-466722-p5 \\',
		`  --update-env-vars ${changes.map((c) => `${c.env}=${c.to}`).join(',')}`,
	].join('\n');

	host.innerHTML = `
		<ul class="el-diff">
			${changes.map((c) => `
				<li>
					<code>${esc(c.env)}</code>
					<span class="el-diff-from">${esc(c.from)}</span>
					<span aria-hidden="true">&rarr;</span>
					<span class="el-diff-to">${esc(c.to)}</span>
				</li>`).join('')}
		</ul>
		<div style="position:relative">
			<pre class="el-cmd"><code>${esc(cmd)}</code></pre>
			<button type="button" class="el-copy" id="el-copy">Copy</button>
		</div>
		<p class="el-warnbox">
			<code>--update-env-vars</code> merges into the existing environment.
			<code>--set-env-vars</code> would replace the whole set and drop every
			other variable on the service.
		</p>
		${fundingNote}`;

	$('el-copy').addEventListener('click', async (e) => {
		const btn = e.currentTarget;
		try {
			await navigator.clipboard.writeText(cmd);
			btn.dataset.copied = 'true';
			btn.textContent = 'Copied';
		} catch {
			// Clipboard blocked (insecure context or denied permission): select the
			// command so the keyboard shortcut still works.
			const range = document.createRange();
			range.selectNodeContents(host.querySelector('.el-cmd code'));
			const sel = window.getSelection();
			sel.removeAllRanges();
			sel.addRange(range);
			btn.textContent = 'Selected';
		}
		setTimeout(() => { btn.dataset.copied = 'false'; btn.textContent = 'Copy'; }, 2200);
	});
}

// ── Observed panel ─────────────────────────────────────────────────────────
function renderObserved(summary) {
	const o = seed.observed;
	const host = $('el-observed');
	if (!o) {
		host.innerHTML = '<div class="el-obs-card"><p class="el-empty">The facilitator ledger could not be read, so there are no observed outcomes to compare against.</p></div>';
		return;
	}

	const total = Math.max(1, ...o.refusals.map((r) => r.count));
	const causeLabel = {
		governor: 'Out of daily fee budget',
		floor: 'Fee wallet under its floor',
		duplicate: 'Already settled (retry)',
		dust_guard: 'Below the minimum settle',
		unspecified: 'No reason recorded',
		other: 'Other',
	};

	const liveEquilibrium = seed.projected_settles_per_day;

	host.innerHTML = `
		<div class="el-obs-card">
			<h3>Refusals, last ${o.window_hours}h</h3>
			${o.refusals.length === 0
				? '<p class="el-empty">Nothing was refused in this window.</p>'
				: `<ul class="el-bars">${o.refusals.map((r) => `
					<li class="el-bar-row" data-cause="${esc(r.cause)}">
						<div class="el-bar-head">
							<span class="el-bar-cause">${esc(causeLabel[r.cause] || r.cause)}</span>
							<span>${fmtInt(r.count)}</span>
						</div>
						<div class="el-bar-track"><div class="el-bar-fill" style="width:${((r.count / total) * 100).toFixed(1)}%"></div></div>
						${r.example ? `<p class="el-bar-example">${esc(r.example)}</p>` : ''}
					</li>`).join('')}</ul>`}
		</div>
		<div class="el-obs-card">
			<h3>Measured against modelled</h3>
			<ul class="el-compare">
				<li><span>Settles landed (24h)</span><strong>${fmtInt(o.settled)}</strong></li>
				<li><span>Model, live config</span><strong>${liveEquilibrium === null ? 'not read' : fmtInt(liveEquilibrium)}/day</strong></li>
				<li><span>Model, your config</span><strong>${fmtInt(summary.steadySettlesPerDay)}/day</strong></li>
				<li><span>Capacity admission rate</span><strong>${fmtPct(o.capacity_admission_rate)}</strong></li>
				<li><span>Demand arriving</span><strong>${fmtInt(o.demand_per_hour)}/hour</strong></li>
				<li><span>Fee per settle</span><strong>${fmtInt(o.fee_lamports_observed)} lamports</strong></li>
				<li><span>SOL burned (24h)</span><strong>${fmtSol(o.fee_total_lamports)} SOL</strong></li>
			</ul>
		</div>`;
}

// ── Render ─────────────────────────────────────────────────────────────────
let rafId = 0;
function render() {
	cancelAnimationFrame(rafId);
	rafId = requestAnimationFrame(() => {
		const knobs = readKnobs();
		const { series, summary } = simulateRunway({
			...knobs,
			feeLamports,
			spentTodayLamports: seed.meter?.spent_today_lamports ?? 0,
			startHourOfDay: seed.meter?.utc_hour ?? 0,
		});

		for (const key of Object.keys(KNOBS)) {
			const k = KNOBS[key];
			k.out.value = k.fmt(Number(k.el.value));
			k.el.closest('.el-field').dataset.dirty = String(Number(k.el.value) !== Number(k.live));
		}
		$('el-reset').disabled = !isDirty();

		renderVerdict(summary);
		renderKpis(summary, knobs);
		drawChart(series, knobs);
		renderLevers();
		renderApply();
		renderObserved(summary);

		const eq = equilibriumSettlesPerDay({
			spendableLamports: Math.max(0, knobs.startLamports - knobs.floorLamports),
			feeLamports,
			runwayDays: knobs.runwayDays,
			minBudgetLamports: knobs.governorEnabled ? knobs.minBudgetLamports : Number.MAX_SAFE_INTEGER,
		});
		$('el-chart-caption').textContent =
			`Balance (line, left axis) against hourly settles admitted and refused (columns, right axis) over ${fmtWhenSpan(summary.hoursSimulated)}. ` +
			`This configuration sustains ${fmtInt(eq)} settles per day.` +
			(summary.truncated ? ' The horizon was truncated to keep the projection responsive.' : '');
	});
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}

// ── Boot ───────────────────────────────────────────────────────────────────
function fail(message) {
	const box = $('el-verdict');
	box.dataset.state = 'error';
	box.querySelector('.el-verdict-icon').textContent = '×';
	$('el-verdict-head').textContent = 'Could not read the live rail';
	$('el-verdict-detail').textContent =
		`${message} The lab needs live state to be honest, so it will not fall back to invented numbers. Retry, or read the raw seed at /api/x402/runway-lab.`;
	$('el-stats').innerHTML = '';
}

async function boot() {
	for (const key of Object.keys(KNOBS)) {
		KNOBS[key].el = $(`el-${key}`);
		KNOBS[key].out = $(`el-${key}-out`);
	}
	initTooltips();

	try {
		seed = await loadSeed();
	} catch (err) {
		fail(err?.message ? `${err.message}.` : 'The seed request failed.');
		return;
	}

	applySeedToKnobs();
	renderLiveState();

	for (const key of Object.keys(KNOBS)) KNOBS[key].el.addEventListener('input', render);
	$('el-governor').addEventListener('change', render);
	$('el-target').addEventListener('input', () => { renderLevers(); });
	$('el-reset').addEventListener('click', () => {
		for (const key of Object.keys(KNOBS)) KNOBS[key].el.value = String(KNOBS[key].live);
		$('el-governor').checked = seed.config.governor_enabled;
		render();
	});
	window.addEventListener('resize', () => render(), { passive: true });

	render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
