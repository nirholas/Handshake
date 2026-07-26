/**
 * Homepage "Autonomous trading" section — live agent-sniper console.
 *
 * Renders the real on-chain sniper engine on the home page: a worker-liveness
 * pill, an interactive five-stage decision-loop diagram, a live trade tape, and
 * the platform's real trading KPIs. Every value is real:
 *
 *   · /api/sniper/status      → worker liveness (alive / feed-live / degraded),
 *                               strategies armed, open positions.
 *   · /api/oracle/stats       → launches scored in the last 24h.
 *   · /api/sniper/leaderboard → real_stats (on-chain-only wins, best multiple,
 *                               best realized ROI, open count — SIMULATED fills
 *                               excluded so the "no simulation" panel stays true),
 *                               plus the initial tape backlog (recent closed trades
 *                               + currently-open positions).
 *   · /api/sniper/stream      → SSE of fresh buy / sell / re-quote events; each
 *                               drives a packet through the pipeline and a row
 *                               into the tape.
 *
 * No simulation: the pipeline's ambient idle pulse illustrates the loop's shape
 * (it carries no ticker and writes nothing to the tape); only real SSE events
 * carry a $SYMBOL packet and append a tape row. Loading, empty, and error states
 * are all designed — when the feed is quiet the tape says so and points the user
 * at the arena rather than showing a void.
 *
 * In dev, /api/* is proxied to production (see vite.config.js), so the feed is
 * real even on localhost.
 */

import { reducedMotion, countUp } from './ui-juice.js';

const NETWORK = 'mainnet';
const STATUS_URL = '/api/sniper/status';
const STATS_URL = '/api/oracle/stats';
const BOARD_URL = `/api/sniper/leaderboard?network=${NETWORK}&window=30d`;
const STREAM_URL = `/api/sniper/stream?network=${NETWORK}`;
const MAX_ROWS = 7;
const STATUS_POLL_MS = 30_000;
const IDLE_PULSE_MS = 6500;

const STAGES = ['watch', 'score', 'guard', 'buy', 'exit'];

const EXPLAIN = {
	watch: '<strong>Watch.</strong> A PumpPortal feed streams every new pump.fun mint the instant it’s created — the agent sees launches the moment they exist.',
	score: '<strong>Score.</strong> Each candidate is graded against the agent’s strategy — market cap, creator track record, liquidity, momentum — into a single conviction score. Below threshold, it’s skipped.',
	guard: '<strong>Guard.</strong> Pre-trade checks gate the buy: open-position concurrency, daily budget, SOL headroom, and price-impact ceilings. Any failure aborts before a lamport moves.',
	buy: '<strong>Buy.</strong> The engine quotes the pump.fun curve, builds the buy, signs with the agent’s wallet, and broadcasts — returning real landing telemetry and a Solscan signature.',
	exit: '<strong>Exit.</strong> Open positions are swept every tick and closed autonomously on take-profit, stop-loss, trailing-stop, timeout, or a sentiment flip. The loop never sleeps.',
};

function esc(s) {
	return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function fmtCompact(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
	if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
	return String(Math.round(v));
}

function fmtPct(pct) {
	if (pct == null || !Number.isFinite(Number(pct))) return null;
	const v = Number(pct);
	const sign = v > 0 ? '+' : '';
	return `${sign}${v.toFixed(v >= 100 || v <= -100 ? 0 : 1)}%`;
}

function pnlClass(pct) {
	if (pct == null || !Number.isFinite(Number(pct))) return 'flat';
	if (Number(pct) > 0.05) return 'up';
	if (Number(pct) < -0.05) return 'down';
	return 'flat';
}

// ── pipeline animation ────────────────────────────────────────────────────────

function makePipeline(root) {
	const stagesEl = root.querySelector('#snipe-stages');
	const packet = root.querySelector('#snipe-packet');
	const explain = root.querySelector('#snipe-explain');
	const buttons = Array.from(root.querySelectorAll('.snipe-stage'));
	const rail = root.querySelector('.snipe-rail');
	if (!stagesEl || !buttons.length) return { run() {}, idle() {} };

	let selected = 'watch';
	function select(stage) {
		selected = stage;
		buttons.forEach((b) => {
			const on = b.dataset.stage === stage;
			b.classList.toggle('active', on);
			b.setAttribute('aria-pressed', on ? 'true' : 'false');
		});
		if (explain && EXPLAIN[stage]) explain.innerHTML = EXPLAIN[stage];
	}

	buttons.forEach((b) => {
		b.addEventListener('click', () => select(b.dataset.stage));
		// Hover previews the stage without committing the selection on pointer devices.
		b.addEventListener('mouseenter', () => {
			if (explain && EXPLAIN[b.dataset.stage]) explain.innerHTML = EXPLAIN[b.dataset.stage];
		});
		b.addEventListener('mouseleave', () => {
			if (explain && EXPLAIN[selected]) explain.innerHTML = EXPLAIN[selected];
		});
	});

	let running = false;
	function lightSequence(bright) {
		// Sweep each node on as the packet passes its column, off shortly after.
		buttons.forEach((b, i) => {
			const at = (i / (buttons.length - 1)) * 1100;
			setTimeout(() => {
				b.classList.add('flow');
				setTimeout(() => b.classList.remove('flow'), 380);
			}, at);
		});
		if (packet) {
			packet.style.opacity = bright ? '1' : '0.32';
			packet.style.transition = 'none';
			packet.style.transform = 'translateX(0)';
			// next frame: animate across the rail
			requestAnimationFrame(() => requestAnimationFrame(() => {
				const w = rail ? rail.getBoundingClientRect().width : 0;
				packet.style.transition = 'transform 1.2s cubic-bezier(.4,.1,.3,1)';
				packet.style.transform = `translateX(${w}px)`;
			}));
		}
	}

	function run(bright = true) {
		if (running || reducedMotion()) return;
		running = true;
		lightSequence(bright);
		setTimeout(() => {
			running = false;
			if (packet) { packet.style.transition = 'opacity .3s'; packet.style.opacity = '0'; }
		}, 1300);
	}

	return { run, idle: () => run(false) };
}

// ── trade tape ──────────────────────────────────────────────────────────────

function makeTape(root) {
	const list = root.querySelector('#snipe-tape');
	const seen = new Set();

	function rowEl(item, animate) {
		const kind = item.kind; // 'buy' | 'sell' | 'open'
		const tag = kind === 'sell' ? 'sell' : kind === 'open' ? 'open' : 'buy';
		const tagLabel = kind === 'sell' ? 'Sold' : kind === 'open' ? 'Holding' : 'Sniped';
		const sym = (item.symbol || item.name || '???').toString().slice(0, 12);
		const agent = item.agent_name || 'agent';
		const pctLabel = fmtPct(item.pnl_pct);
		const url = item.url;
		const tagEl = kind === 'sell' && item.exit_reason ? ` · ${esc(String(item.exit_reason).replace(/_/g, ' '))}` : '';
		const inner =
			`<span class="snipe-tag ${tag}">${tagLabel}</span>` +
			`<span class="snipe-rmeta"><span class="snipe-rsym">$${esc(sym.toUpperCase())}</span> ` +
			`<span class="snipe-ragent">${esc(agent)}${tagEl}</span></span>` +
			(pctLabel ? `<span class="snipe-rpnl ${pnlClass(item.pnl_pct)}">${esc(pctLabel)}</span>` : `<span class="snipe-rpnl flat">·</span>`);
		// Rows live in a <ul>, so the direct child must be an <li> (axe "list"
		// rule); the link, when there is one, goes inside it.
		const li = document.createElement('li');
		const el = document.createElement(url ? 'a' : 'div');
		el.className = 'snipe-row' + (animate && !reducedMotion() ? ' enter' : '');
		if (url) { el.href = url; el.target = '_blank'; el.rel = 'noopener'; }
		el.innerHTML = inner;
		li.appendChild(el);
		return li;
	}

	function reset() { if (list) list.innerHTML = ''; }

	function empty(msg) {
		if (!list) return;
		// <li>, not <div>: the tape is a <ul>, and a non-li child is an axe
		// "list" violation (ul must directly contain li/script/template only).
		list.innerHTML = `<li class="snipe-tape-msg">${esc(msg)}</li>`;
	}

	function add(item, animate) {
		if (!list) return false;
		const key = item.id != null ? `${item.kind}:${item.id}` : `${item.kind}:${item.symbol}:${item.at || ''}`;
		if (seen.has(key)) return false;
		seen.add(key);
		// Clear any placeholder/skeleton/message on first real row.
		const msg = list.querySelector('.snipe-tape-msg');
		const skel = list.querySelector('.snipe-skel');
		if (msg || skel) list.innerHTML = '';
		list.insertBefore(rowEl(item, animate), list.firstChild);
		while (list.children.length > MAX_ROWS) list.removeChild(list.lastChild);
		return true;
	}

	return { add, reset, empty };
}

// ── status pill ──────────────────────────────────────────────────────────────

function applyStatus(root, s) {
	const dot = root.querySelector('#snipe-state-dot');
	const text = root.querySelector('#snipe-state-text');
	const sub = root.querySelector('#snipe-substate');
	const armed = root.querySelector('#snipe-kpi-armed');
	if (!s) return;

	let cls = 'live', label = 'Engine live';
	if (s.state === 'down') { cls = 'down'; label = 'Engine offline'; }
	else if (s.state === 'degraded') { cls = 'degraded'; label = 'Feed degraded'; }
	else if (s.state === 'unknown') { cls = 'degraded'; label = 'Engine idle'; }
	else if (s.alive === false) { cls = 'down'; label = 'Engine offline'; }
	else if (s.feedLive === false) { cls = 'degraded'; label = 'Feed reconnecting'; }

	if (dot) dot.className = 'snipe-dot ' + cls;
	if (text) text.textContent = label;
	if (sub) {
		const parts = [];
		if (Number.isFinite(s.strategies)) parts.push(`${s.strategies} ${s.strategies === 1 ? 'strategy' : 'strategies'} armed`);
		if (Number.isFinite(s.openPositions)) parts.push(`${s.openPositions} open`);
		sub.textContent = parts.join(' · ');
	}
	if (armed && Number.isFinite(s.strategies)) {
		armed.textContent = fmtCompact(s.strategies);
		armed.classList.remove('loading');
	}
}

// ── aggregate proof band (oracle stats, count-up on reveal) ────────────────────

function makeStatBand(root) {
	const band = root.querySelector('#snipe-stats');
	// The three headline numbers draw from two real sources, merged:
	//   scored_24h    — oracle/stats: every pump.fun mint graded in 24h.
	//   real_wins     — sniper/leaderboard real_stats: profitable trades closed
	//                   on-chain (SIMULATED fills excluded), matching this panel's
	//                   "real positions · no simulation" promise.
	//   best_multiple — top multiple a real position reached from entry (peak/entry).
	const fields = [
		{ el: root.querySelector('#snipe-stat-scored'), key: 'scored_24h', fmt: fmtCompact },
		{ el: root.querySelector('#snipe-stat-wins'), key: 'real_wins', fmt: fmtCompact },
		{ el: root.querySelector('#snipe-stat-ath'), key: 'best_multiple', fmt: (n) => `${Number(n).toFixed(1)}×` },
	];
	let values = null;
	let shown = false;

	function inView() {
		if (!band) return true;
		const r = band.getBoundingClientRect();
		const vh = window.innerHeight || document.documentElement.clientHeight || 0;
		// Count once ~15% of the way up the viewport so the numbers animate as the
		// band arrives, not only when fully centered.
		return r.top < vh * 0.85 && r.bottom > 0;
	}

	function render() {
		if (!values || shown || !inView()) return;
		shown = true;
		teardown();
		fields.forEach(({ el, key, fmt }) => {
			if (!el) return;
			const v = Number(values[key]);
			el.classList.remove('loading');
			if (!Number.isFinite(v)) { el.textContent = '—'; return; }
			if (reducedMotion()) el.textContent = fmt(v);
			else countUp(el, 0, v, { format: fmt, duration: 1100 });
		});
	}

	// Re-check on scroll/resize (rAF-coalesced) until the count-up fires once. A
	// plain scroll listener is more robust than IntersectionObserver across
	// programmatic scrolls; it self-removes the moment the numbers render.
	let ticking = false;
	function onScroll() {
		if (ticking) return;
		ticking = true;
		requestAnimationFrame(() => { ticking = false; render(); });
	}
	function teardown() {
		window.removeEventListener('scroll', onScroll);
		window.removeEventListener('resize', onScroll);
	}
	window.addEventListener('scroll', onScroll, { passive: true });
	window.addEventListener('resize', onScroll, { passive: true });

	return {
		// Merge partial data from either source (oracle stats / real leaderboard).
		// Whichever arrives first seeds the band; the second fills the rest. The
		// count-up still fires exactly once, on reveal, with whatever has landed.
		merge(partial) {
			values = { ...(values || {}), ...partial };
			render(); // fires now if already in view; otherwise the scroll handler will
		},
	};
}

function setKpi(root, id, val, accent) {
	const el = root.querySelector(id);
	if (!el) return;
	el.textContent = val;
	el.classList.remove('loading');
	if (accent) el.classList.add('accent');
}

// ── boot ──────────────────────────────────────────────────────────────────────

export function initHomeSniper() {
	const root = document.getElementById('home-sniper');
	if (!root) return;

	const pipeline = makePipeline(root);
	const tape = makeTape(root);
	const statBand = makeStatBand(root);

	// Ambient idle pulse — illustrates the loop while the feed is quiet. Carries
	// no ticker and never writes to the tape, so it can't be mistaken for a trade.
	let lastEventAt = 0;
	let idleTimer = null;
	function scheduleIdle() {
		if (reducedMotion()) return;
		clearTimeout(idleTimer);
		idleTimer = setTimeout(function tick() {
			if (Date.now() - lastEventAt >= IDLE_PULSE_MS) pipeline.idle();
			idleTimer = setTimeout(tick, IDLE_PULSE_MS);
		}, IDLE_PULSE_MS);
	}

	// 0) Aggregate platform stats — feeds the proof band (count-up on reveal).
	async function loadStats() {
		try {
			const r = await fetch(STATS_URL, { headers: { accept: 'application/json' } });
			if (r.ok) {
				const d = await r.json();
				statBand.merge({ scored_24h: d.scored_24h });
			}
		} catch { /* non-fatal — placeholders stay */ }
	}

	// 1) Worker liveness — poll on an interval (cheap, public, no secrets).
	async function pollStatus() {
		try {
			const r = await fetch(STATUS_URL, { headers: { accept: 'application/json' } });
			if (r.ok) applyStatus(root, await r.json());
		} catch { /* non-fatal — keep last good state */ }
	}

	// 2) Leaderboard — KPIs + initial tape backlog.
	async function loadBoard() {
		try {
			const r = await fetch(BOARD_URL, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error(String(r.status));
			const d = await r.json();

			// Real, on-chain-only scoreboard — this panel promises "no simulation",
			// so every KPI here draws from real_stats (SIMULATED fills excluded),
			// never the trader-stats board (which counts paper fills for continuity).
			const rs = d.real_stats || {};
			const bestMultiple = rs.best_peak_multiple ?? rs.best_realized_multiple ?? 0;
			statBand.merge({ real_wins: Number(rs.wins) || 0, best_multiple: Number(bestMultiple) || 0 });

			const bestRoi = rs.best_realized_pct != null ? Number(rs.best_realized_pct) : null;
			const realOpen = Number(rs.open) || 0;
			setKpi(root, '#snipe-kpi-roi', bestRoi != null ? (fmtPct(bestRoi) || '—') : '—', true);
			setKpi(root, '#snipe-kpi-open', fmtCompact(realOpen));

			// Seed the tape from real history: most recent closed trades, then open holds.
			const seedTrades = (d.trades || []).slice(0, MAX_ROWS).map((t) => ({
				kind: 'sell', id: t.id, symbol: t.symbol, name: t.name, agent_name: t.agent_name,
				pnl_pct: t.pnl_pct, exit_reason: t.exit_reason, url: t.sell_url || t.buy_url, at: t.at,
			}));
			const seedOpen = (d.positions || []).slice(0, MAX_ROWS).map((p) => ({
				kind: 'open', id: p.id, symbol: p.symbol, name: p.name, agent_name: p.agent_name,
				pnl_pct: p.unrealized_pct, url: p.buy_url, at: p.at,
			}));
			const seed = [...seedTrades, ...seedOpen].slice(0, MAX_ROWS);
			if (seed.length) {
				tape.reset();
				// Oldest first so newest ends up on top after the prepend loop.
				seed.reverse().forEach((it) => tape.add(it, false));
			} else {
				tape.empty('No live trades right now — the engine is watching for the next launch. Open the arena to follow it live.');
			}
		} catch {
			tape.empty('Live feed is catching its breath. Open the arena to watch agents trade in real time →');
		}
	}

	// 3) Live SSE stream — fresh buy / sell / re-quote events.
	let es = null;
	function connectStream() {
		if (typeof EventSource !== 'function') return;
		try { es = new EventSource(STREAM_URL); } catch { return; }

		const onTrade = (kind) => (ev) => {
			let data;
			try { data = JSON.parse(ev.data); } catch { return; }
			lastEventAt = Date.now();
			const added = tape.add({
				kind,
				id: kind === 'update' ? `u${data.id}` : data.id,
				symbol: data.symbol, name: data.name, agent_name: data.agent_name,
				pnl_pct: data.pnl_pct,
				exit_reason: data.exit_reason,
				url: kind === 'sell' ? (data.sell_url || data.buy_url) : data.buy_url,
				at: data.at,
			}, true);
			if (added || kind !== 'update') pipeline.run(true);
		};

		es.addEventListener('buy', onTrade('buy'));
		es.addEventListener('sell', onTrade('sell'));
		es.addEventListener('update', onTrade('update'));
		// The server caps each SSE at ~90s, then sends `close` and ends — reconnect.
		es.addEventListener('close', () => { try { es.close(); } catch {} ; setTimeout(connectStream, 1200); });
		es.onerror = () => {
			// EventSource auto-reconnects on transient errors; only hard-reset on a
			// fully closed stream so we don't thrash the endpoint.
			if (es && es.readyState === EventSource.CLOSED) { try { es.close(); } catch {} ; setTimeout(connectStream, 3000); }
		};
	}

	// Tear down the stream when the tab is hidden; reconnect when it returns.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) { if (es) { try { es.close(); } catch {} es = null; } }
		else if (!es) connectStream();
	});

	loadStats();
	pollStatus();
	loadBoard();
	connectStream();
	scheduleIdle();
	setInterval(pollStatus, STATUS_POLL_MS);
}

if (typeof window !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initHomeSniper, { once: true });
	} else {
		initHomeSniper();
	}
}
