// arena.js — orchestrates the live 3D Sniper Arena.
//
// Pulls the real leaderboard + SSE trade stream, places each agent as an
// animated avatar in the 3D world (src/play/arena-world.js), turns every live
// buy/sell into an emote + particle burst + a tape entry, lets the spectator
// pick their own avatar and walk the floor, and keeps floating DOM labels
// pinned over each agent's head. All data is real — no placeholders.

import { ArenaWorld } from './arena-world.js';
import { tourCommentary } from '../tour-commentary.js';
import { createAgentScreenClient } from '../shared/agent-screen-client.js';
import { sanitizeMmEvent } from '../shared/mm-render.js';
import { createLogger } from '../shared/log.js';
import { fetchReputationBatch } from '../shared/agent-reputation.js';
import { fetchUnlocks } from '../shared/wallet-access.js';
import { evaluateAccessKey, buildAccessContext } from '../shared/wallet-access-rules.js';

const log = createLogger('arena');

// The reputation-gated world area in the arena. An agent stands on the Elite Floor
// only when the SERVER's computed reputation unlocks it — the client never decides.
const ELITE_FLOOR_KEY = 'arena-elite-floor';

const NETWORK = new URLSearchParams(location.search).get('network') || 'mainnet';

// Humanoid GLBs the canonical clip library animates cleanly. Agents are assigned
// one deterministically by id (template-cached, so repeats are free). The
// spectator picks their own (local roster + public gallery).
const ROSTER = [
	{ url: '/avatars/default.glb',      name: 'Default' },
	{ url: '/avatars/michelle.glb',     name: 'Michelle' },
	{ url: '/avatars/xbot.glb',         name: 'X-Bot' },
	{ url: '/avatars/studio.glb', name: 'Studio' },
	{ url: '/avatars/cz.glb',           name: 'CZ' },
];
const MAX_AGENTS = 9;
const PLAYER_KEY = 'arena:avatar:v1';

const $ = (id) => document.getElementById(id);
const fmtSol = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(3)}◎`);
const fmtPct = (n) => (n == null ? '' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`);
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const hash = (s) => { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
const isBig = (p) => (p?.pnl_sol ?? 0) >= 0.4 || (p?.pnl_pct ?? 0) >= 100;
const shortWallet = (a) => { const s = String(a || ''); return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; };

let world = null;
let labelLayer = null;
// Resolves once the scene + spectator avatar are live, so the tour caster knows
// the world is walkable before it issues the first goTo().
let _tourReadyResolve;
const tourReady = new Promise((res) => { _tourReadyResolve = res; });
const labelEls = new Map(); // agentId -> { el, pos }
const rowsById = new Map(); // world id -> normalized row (for click routing)

// Board context captured on every fetch so the HUD reads consistently.
let _source = 'empty';   // 'agents' | 'live' | 'empty'
let _solUsd = null;      // SOL→USD spot, for USD-denominated stats
let _liveWindow = null;  // kolscan window label when source === 'live'
let _positions = [];     // currently-open agent positions
let _sort = 'score';     // active leaderboard sort (agents only)

// Unify the two board shapes — provable three.ws agents and the live kolscan
// top-trader fallback — into one row model so the HUD + 3D floor render either
// without branching everywhere. `kind` carries the difference where it matters
// (click target, badges, labels).
function normalizeRow(r, kind) {
	if (kind === 'live') {
		return {
			kind: 'live',
			id: r.wallet,
			name: r.wallet_short || shortWallet(r.wallet),
			rank: r.rank,
			pnl_sol: r.realized_pnl_sol,
			pnl_usd: r.realized_pnl_usd,
			win_pct: r.win_rate != null ? Number(r.win_rate) * 100 : null, // API sends a 0–1 fraction
			trades: r.trades ?? null,
			open: 0,
			image: '',
			url: r.account_url,
			wallet: r.wallet,
		};
	}
	const winPct = r.closed
		? (r.win_rate != null ? r.win_rate * 100 : (r.wins / r.closed) * 100)
		: null;
	return {
		kind: 'agent',
		id: r.agent_id,
		agent_id: r.agent_id,
		name: r.agent_name || 'Agent',
		rank: r.rank,
		pnl_sol: r.realized_pnl_sol,
		pnl_usd: r.realized_pnl_usd,
		win_pct: winPct,
		closed: r.closed ?? 0,
		wins: r.wins ?? 0,
		open: r.open_positions ?? 0,
		roi_pct: r.roi_pct,
		score: r.score,
		verified: r.verified,
		copiers: r.copiers ?? 0,
		image: r.image || '',
	};
}

// Agent records are primary; the live kolscan ranking fills the floor until an
// agent posts a provable record (mirrors the leaderboard endpoint's hybrid).
function rowsFrom(data) {
	if ((data.leaderboard || []).length) return data.leaderboard.map((r) => normalizeRow(r, 'agent'));
	return (data.live_traders || []).map((r) => normalizeRow(r, 'live'));
}

// Capture the board context every fetch shares (source, price, open positions).
function ingest(data) {
	_solUsd = data.sol_usd ?? _solUsd;
	_liveWindow = data.live_window || null;
	_positions = data.positions || [];
	_source = data.source || ((data.leaderboard || []).length ? 'agents' : (data.live_traders || []).length ? 'live' : 'empty');
}

// ── boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
	const canvas = $('scene');
	labelLayer = $('labels');
	world = new ArenaWorld(canvas, { onAgentClick: focusAgent });
	window.__arenaWorld = world; // debug/support hook

	// Coin World Tour hook. The on-demand Playwright caster (workers/agent-screen-pool)
	// detects this API, waits for ready(), then walks the guide agent through the
	// waypoint loop — driving the REAL camera/avatar — while narrating what's
	// climbing three.ws's OWN launch feed (/api/pump/launches). tour-commentary.js
	// owns the pure feed→line mapping; the caster passes the feed in and renders the
	// result. No faked motion, no mocks. $THREE is the only coin the tour promotes.
	window.__tour = {
		ready: () => tourReady,
		waypoints: () => world?.tourStops?.() || [],
		location: () => world?.tourLocation?.() || null,
		goTo: (name) => world?.tourGoTo?.(name) ?? Promise.resolve(false),
		// Commentary for the stop the guide most recently reached, given the
		// three.ws launch feed (/api/pump/launches) the caster fetched. Returns
		// { line, badge, items, … }.
		commentary: (launches) => tourCommentary(
			world?.tourLocation?.() || 'lobby',
			Array.isArray(launches) ? launches : [],
		),
	};

	// Spin up the render loop immediately so the floor + lights are alive while
	// avatars stream in (perceived performance).
	setLoading('Building the arena…');
	world.start();

	try {
		await world.loadAnimations();
	} catch (e) {
		log.warn('animations failed', e);
	}

	// Spectator avatar: restore saved pick, else a sensible default.
	const saved = localStorage.getItem(PLAYER_KEY);
	try { await world.spawnPlayer(saved || '/avatars/default.glb'); } catch (e) { log.warn('player spawn', e); }

	world.setLabelUpdater(updateLabels);
	mountControls();
	mountJoystick();

	await loadAndPlace();
	connectStream();
	setLoading(null);

	// World is walkable — release the tour caster.
	_tourReadyResolve?.();

	// Periodic board refresh (realized P&L only changes on a close; SSE also nudges this).
	setInterval(loadBoardOnly, 30_000);
})();

// ── data: leaderboard → agents in the world ────────────────────────────────────

let _placed = false;
async function loadAndPlace() {
	let data;
	try {
		const r = await fetch(`/api/sniper/leaderboard?network=${NETWORK}&sort=${_sort}`);
		if (!r.ok) throw new Error('http ' + r.status);
		data = await r.json();
	} catch {
		renderBoard([]);
		setEmpty(true);
		return;
	}
	ingest(data);
	const rows = rowsFrom(data);
	const board = rows.slice(0, MAX_AGENTS);
	renderBoard(rows);
	renderTopCard(rows[0]);
	renderStats(rows);
	setEmpty(rows.length === 0);

	if (!_placed && board.length) {
		_placed = true;
		spawnAgentsProgressively(board);
	}

	// Light up the Elite Floor — a server-decided trust treatment on the agents the
	// network already trusts (agents only; live wallets have no reputation record).
	markEliteFloor(board.filter((r) => r.kind === 'agent').map((r) => r.id));

	// Seed the tape with recent closed trades (oldest first so prepend keeps order).
	(data.trades || []).slice(0, 12).reverse().forEach((t) => pushTape('sell', t, { quiet: true }));
}

async function loadBoardOnly() {
	try {
		const r = await fetch(`/api/sniper/leaderboard?network=${NETWORK}&sort=${_sort}`);
		if (!r.ok) return;
		const d = await r.json();
		ingest(d);
		const rows = rowsFrom(d);
		renderBoard(rows);
		renderTopCard(rows[0]);
		renderStats(rows);
		// Update floating labels' live P&L.
		rows.forEach((row) => {
			const L = labelEls.get(row.id);
			if (L) {
				const up = (row.pnl_sol ?? 0) >= 0;
				const pnlEl = L.el.querySelector('.lbl-pnl');
				pnlEl.textContent = fmtSol(row.pnl_sol);
				pnlEl.className = 'lbl-pnl ' + (up ? 'up' : 'down');
			}
		});
	} catch { /* keep last good */ }
}

// Spawn agents with bounded concurrency. Avatar GLBs are 1–3 MB and share a
// Draco/KTX2 worker pool — firing all of them at once thrashes the pool and
// stalls loads. Two workers pull from a queue so avatars pop in steadily and
// every one resolves. Repeats are instant (the world template-caches by URL).
const SPAWN_CONCURRENCY = 2;
async function spawnAgentsProgressively(board) {
	const positions = arenaPositions(board.length);
	const queue = board.map((row, i) => ({ row, i, pos: positions[i] }));
	const worker = async () => {
		let job;
		while ((job = queue.shift())) {
			const { row, i, pos } = job;
			const av = ROSTER[hash(row.id) % ROSTER.length];
			try {
				const agent = await world.spawnAgent({
					id: row.id,
					name: row.name,
					glbUrl: av.url,
					position: [pos.x, pos.z],
					facingY: pos.facing,
					leader: i === 0,
					pnlText: fmtSol(row.pnl_sol),
					pnlUp: (row.pnl_sol ?? 0) >= 0,
					thumbnail: row.image || '',
					rank: row.rank,
				});
				rowsById.set(row.id, row);
				createLabel(agent);
				if (row.kind === 'agent') connectMmFloor(row.id);
			} catch (err) {
				log.warn('spawn agent', err);
			}
		}
	};
	await Promise.all(Array.from({ length: SPAWN_CONCURRENCY }, worker));
}

// Arrange agents on a forward-facing arc; #1 elevated at the back-centre.
function arenaPositions(n) {
	const out = [];
	// Leader, elevated at the back-centre.
	out.push({ x: 0, z: -5.4, facing: 0 });
	const rest = n - 1;
	for (let i = 0; i < rest; i++) {
		const t = rest === 1 ? 0.5 : i / (rest - 1);   // 0..1
		const ang = (t - 0.5) * (Math.PI * 0.92);        // spread ~ -83°..83°
		const rad = 5.6;
		const x = Math.sin(ang) * rad;
		const z = -1.4 - Math.cos(ang) * 3.0;            // gentle bow toward the back
		out.push({ x, z, facing: Math.atan2(x - 0, 9 - z) }); // face the entrance
	}
	return out;
}

// ── market-maker floor defense ───────────────────────────────────────────────
// Each spawned agent subscribes to its own screen stream and watches for the
// `mm` ride-along the agent-mm worker publishes. A live frame drives the full
// reaction (floor update + emote + FX); the on-connect log backfill only draws
// the line at the last known price (no replayed emotes). A stream error ambers
// the line — it holds the last price until the next good quote.
const _mmClients = new Map(); // agentId -> screen client
function connectMmFloor(agentId) {
	if (!agentId || _mmClients.has(agentId)) return;
	const client = createAgentScreenClient(agentId, {
		onFrame: (frame) => {
			const ev = sanitizeMmEvent(frame?.mm);
			if (ev) safe(() => world.onMmEvent(agentId, ev));
		},
		onLog: (entries) => {
			// Apply only the most recent MM entry as a static floor (no emote).
			for (let i = (entries || []).length - 1; i >= 0; i--) {
				const ev = sanitizeMmEvent(entries[i]?.mm);
				if (ev) { safe(() => world.setFloor(agentId, ev)); break; }
			}
		},
		onError: () => safe(() => world.markFloorReQuoting(agentId)),
	});
	_mmClients.set(agentId, client);
	client.connect();
}

// ── live stream ────────────────────────────────────────────────────────────────

let es = null;
function connectStream() {
	es = new EventSource(`/api/sniper/stream?network=${NETWORK}`);
	es.addEventListener('open', () => { setLive(true); refreshTapeEmpty(); });
	es.addEventListener('buy', (m) => safe(() => onBuy(JSON.parse(m.data))));
	es.addEventListener('sell', (m) => safe(() => onSell(JSON.parse(m.data))));
	// A bare 'update' nudge means standings shifted (open P&L, rank, new agent)
	// without a discrete buy/sell — refresh the board, debounced so a burst of
	// nudges collapses into one fetch.
	es.addEventListener('update', () => { clearTimeout(_boardDebounce); _boardDebounce = setTimeout(loadBoardOnly, 1200); });
	es.onerror = () => { setLive(false); refreshTapeEmpty(); try { es.close(); } catch { /* already closed */ } setTimeout(connectStream, 2500); };
}
let _boardDebounce = null;
const safe = (fn) => { try { fn(); } catch { /* one bad frame never breaks the stream */ } };

function onBuy(p) {
	world.reactBuy(p.agent_id, { amountText: fmtSol(p.entry_sol) });
	pushTape('buy', p);
	bumpAgentBusy(p.agent_id);
}

function onSell(p) {
	const win = (p.pnl_sol ?? 0) >= 0;
	const big = isBig(p);
	world.reactSell(p.agent_id, { win, big, pnlText: `${fmtSol(p.pnl_sol)}` });
	pushTape('sell', p);
	if (win && big) bigWinBanner(p);
	bumpAgentBusy(p.agent_id);
	// A close changes realized P&L — refresh the board shortly.
	clearTimeout(connectStream._t);
	connectStream._t = setTimeout(loadBoardOnly, 1600);
}

function bumpAgentBusy(id) {
	const L = labelEls.get(id);
	if (!L) return;
	L.el.classList.add('active');
	clearTimeout(L._t);
	L._t = setTimeout(() => L.el.classList.remove('active'), 2600);
}

// ── floating labels over agents ────────────────────────────────────────────────

function createLabel(agent) {
	if (!agent || labelEls.has(agent.id)) return;
	const el = document.createElement('button');
	el.className = 'agent-label no-orbit' + (agent.leader ? ' leader' : '');
	el.type = 'button';
	el.innerHTML = `
		<span class="lbl-rank">#${agent.label.rank ?? '?'}</span>
		${agent.label.thumbnail ? `<img loading="lazy" decoding="async" class="lbl-av" src="${esc(agent.label.thumbnail)}" alt="" data-fallback="remove"/>` : ''}
		<span class="lbl-meta">
			<span class="lbl-name">${esc(agent.label.name)}</span>
			<span class="lbl-pnl ${agent.label.pnlUp ? 'up' : 'down'}">${esc(agent.label.pnlText)}</span>
		</span>`;
	el.addEventListener('click', () => focusAgent(agent.id));
	labelLayer.appendChild(el);
	labelEls.set(agent.id, { el, pos: { x: 0, y: 0 } });
}

// ── Elite Floor — the reputation-gated world area ───────────────────────────────
// Membership is the SERVER's call: each agent's tier + $THREE conviction come from
// the reputation service, so a client can never fake its way onto the floor. We
// reflect that verdict by crowning the trusted/elite agents' labels.
const _eliteFloor = new Set(); // agentIds the server places on the elite floor

async function markEliteFloor(ids) {
	const want = [...new Set((ids || []).filter(Boolean))];
	if (!want.length) return;
	ensureEliteStyles();
	let reps;
	try {
		reps = await fetchReputationBatch(want);
	} catch {
		return; // never break the arena over a reputation hiccup
	}
	for (const id of want) {
		const rep = reps?.[id];
		if (!rep) continue;
		// Evaluate the same world-area rule the server enforces, from server-computed
		// inputs (tier + $THREE held/duration in totals). This is a visual hint only;
		// the drawer confirms access against the authoritative /unlocks read.
		const verdict = evaluateAccessKey(ELITE_FLOOR_KEY, buildAccessContext(rep));
		const L = labelEls.get(id);
		if (verdict?.unlocked) {
			_eliteFloor.add(id);
			if (L?.el && !L.el.querySelector('.lbl-elite')) {
				L.el.classList.add('elite-floor');
				const crown = document.createElement('span');
				crown.className = 'lbl-elite';
				crown.title = `Elite Floor · ${rep.tierLabel || 'Trusted'} wallet`;
				crown.textContent = '👑';
				L.el.prepend(crown);
			}
		}
	}
	updateEliteLegend();
}

function updateEliteLegend() {
	let legend = document.getElementById('eliteLegend');
	const n = _eliteFloor.size;
	if (!n) {
		legend?.remove();
		return;
	}
	if (!legend) {
		legend = document.createElement('div');
		legend.id = 'eliteLegend';
		legend.className = 'arena-elite-legend';
		(document.getElementById('labels') || document.body).appendChild(legend);
	}
	legend.innerHTML = `<span aria-hidden="true">👑</span> Elite Floor · ${n} trusted ${n === 1 ? 'wallet' : 'wallets'}`;
}

let _eliteStyled = false;
function ensureEliteStyles() {
	if (_eliteStyled) return;
	_eliteStyled = true;
	const css = `
.agent-label .lbl-elite{font-size:13px;line-height:1;margin-right:2px;filter:drop-shadow(0 0 4px rgba(251,191,36,.8))}
.agent-label.elite-floor{border-color:rgba(251,191,36,.55)!important;box-shadow:0 0 0 1px rgba(251,191,36,.35),0 6px 20px rgba(251,191,36,.18)}
.arena-elite-legend{position:absolute;left:12px;bottom:12px;z-index:6;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font:600 11px/1 var(--font-mono,ui-monospace,monospace);color:#fbbf24;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.34);backdrop-filter:blur(6px);pointer-events:none}
.arena-elite-legend span{font-size:12px}
@media (max-width:560px){.arena-elite-legend{bottom:auto;top:64px}}
`;
	const style = document.createElement('style');
	style.id = 'arena-elite-styles';
	style.textContent = css;
	document.head.appendChild(style);
}

const _proj = { x: 0, y: 0, behind: false };
function updateLabels() {
	if (!labelEls.size) return;
	for (const [id, L] of labelEls) {
		const agent = world.agents.get(id);
		if (!agent) { L.el.style.display = 'none'; continue; }
		const p = world.projectHead(agent, _proj);
		// Hide when behind the camera, off-screen, or riding up under the top bar
		// (where it would cover — and steal clicks from — the chrome).
		const w = labelLayer.clientWidth, h = labelLayer.clientHeight;
		if (!p || p.y < 66 || p.y > h - 8 || p.x < -40 || p.x > w + 40) {
			L.el.style.opacity = '0'; L.el.style.pointerEvents = 'none'; continue;
		}
		L.el.style.opacity = '1';
		L.el.style.pointerEvents = 'auto';
		L.el.style.transform = `translate(-50%, -100%) translate(${p.x.toFixed(1)}px, ${(p.y - 6).toFixed(1)}px)`;
	}
}

function focusAgent(id) {
	const row = world.agents.get(id);
	if (row) {
		world._ringPulse?.(row.root.position, row.color);
		row.emote('buy');
		world.focusOnAgent(id);
	}
	const L = labelEls.get(id);
	if (L) { L.el.classList.add('active'); setTimeout(() => L.el.classList.remove('active'), 2200); }
	const meta = rowsById.get(id);
	if (meta?.kind === 'live') openLiveTraderDrawer(meta);
	else openAgentDrawer(id);
}

// Live kolscan traders have no three.ws profile, so the drawer shows their public
// market standing (rank, realized profit, win rate) and deep-links the wallet to
// Solscan rather than calling the agent-only /trader endpoint.
function openLiveTraderDrawer(row) {
	const el = $('agentDrawer');
	el.classList.add('open');
	if (drawerAbort) { drawerAbort.abort(); drawerAbort = null; }
	world.focusOnAgent?.(row.id);
	const up = (row.pnl_sol ?? 0) >= 0;
	const usd = row.pnl_usd != null ? fmtUsd(row.pnl_usd) : (row.pnl_sol != null && _solUsd ? fmtUsd(row.pnl_sol * _solUsd) : '');
	$('drawerBody').innerHTML = `
		<div class="dw-head">
			<span class="dw-av-fallback"></span>
			<div>
				<div class="dw-name">${esc(row.name)}</div>
				<div class="dw-sub"><span class="dw-badge">🔥 Live market${_liveWindow ? ' · ' + esc(_liveWindow) : ''}</span></div>
			</div>
			<div class="dw-score ${up ? 'up' : 'down'}"><b>#${row.rank}</b><span>rank</span></div>
		</div>
		<div class="dw-grid">
			<div class="dw-stat"><span>Realized P&amp;L</span><b class="${up ? 'up' : 'down'}">${fmtSol(row.pnl_sol)}${usd ? `<small> ${usd}</small>` : ''}</b></div>
			<div class="dw-stat"><span>Win rate</span><b>${row.win_pct != null ? Math.round(row.win_pct) + '%' : '—'}</b></div>
			<div class="dw-stat"><span>Trades</span><b>${row.trades != null ? Number(row.trades).toLocaleString('en-US') : '—'}</b></div>
			<div class="dw-stat"><span>Window</span><b>${esc(_liveWindow || 'live')}</b></div>
		</div>
		<p class="dw-live-note">Live public ranking of top Solana traders by realized profit. three.ws agents take these spots the moment they post a provable on-chain track record.</p>
		<div class="dw-cta">
			${row.url ? `<a class="btn primary" href="${esc(row.url)}" target="_blank" rel="noopener">View wallet on Solscan ↗</a>` : ''}
			<a class="btn" href="/agents">Browse three.ws agents ↗</a>
		</div>`;
}

// ── agent detail drawer (real on-chain track record) ────────────────────────────

let drawerAbort = null;
async function openAgentDrawer(id) {
	const el = $('agentDrawer');
	el.classList.add('open');
	const body = $('drawerBody');
	body.innerHTML = `<div class="dw-skel"></div><div class="dw-skel"></div><div class="dw-skel" style="height:120px"></div>`;
	// Cancel any in-flight previous fetch.
	if (drawerAbort) drawerAbort.abort();
	drawerAbort = new AbortController();
	try {
		const r = await fetch(`/api/sniper/trader?agent_id=${encodeURIComponent(id)}&network=${NETWORK}&window=all`, { signal: drawerAbort.signal });
		if (!r.ok) throw new Error(r.status === 404 ? "This trader isn't public yet." : `HTTP ${r.status}`);
		renderAgentDrawer(await r.json(), id);
		enrichDrawerWithOracle(id);
		enrichDrawerWithAccess(id);
	} catch (e) {
		if (e.name === 'AbortError') return;
		body.innerHTML = `<div class="dw-empty"><b>Couldn't load this trader</b>${esc(e.message)}<br/><a href="/trader/${encodeURIComponent(id)}" target="_blank" rel="noopener">Open full profile ↗</a></div>`;
	}
}

// Surface the agent's reputation tier + the server's Elite Floor verdict in the
// drawer. The access state is read from /api/agents/:id/unlocks — the same route a
// protected capability would gate on — so what's shown is the authoritative,
// server-computed answer, not a client guess.
async function enrichDrawerWithAccess(id) {
	try {
		const data = await fetchUnlocks(id);
		if (!data?.unlocks) return;
		const body = $('drawerBody');
		const cta = body?.querySelector('.dw-cta');
		if (!cta) return;
		const floor = data.unlocks.find((u) => u.key === ELITE_FLOOR_KEY);
		const tier = data.isNew ? 'New' : data.tierLabel || 'Emerging';
		const accent = esc(data.accent || '#a78bfa');
		const floorLine = floor?.unlocked
			? `<span class="dw-acc-on">👑 Elite Floor access</span>`
			: floor
			  ? `<span class="dw-acc-off">🔒 Elite Floor · ${esc(floor.nextHint || 'locked')}</span>`
			  : '';
		const block = document.createElement('div');
		block.className = 'dw-access';
		block.innerHTML =
			`<div class="dw-oracle-h">Reputation &amp; access</div>` +
			`<div class="dw-acc-row">` +
			`<a class="dw-acc-tier" href="/agent/${encodeURIComponent(id)}/wallet#reputation" style="--acc:${accent}" title="See the full trust breakdown">` +
			`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>` +
			`<b>${esc(tier)}</b><span>trust ${Math.round(data.score || 0)}/100</span></a>` +
			(floorLine ? `<div class="dw-acc-floor">${floorLine}</div>` : '') +
			`</div>`;
		body.insertBefore(block, cta);
		ensureDrawerAccessStyles();
	} catch {
		/* non-fatal — the drawer's track record is unaffected */
	}
}

let _dwAccStyled = false;
function ensureDrawerAccessStyles() {
	if (_dwAccStyled) return;
	_dwAccStyled = true;
	const css = `
.dw-access{margin-top:10px}
.dw-acc-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:6px}
.dw-acc-tier{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--acc,#a78bfa);background:color-mix(in srgb,var(--acc,#a78bfa) 12%,transparent);border:1px solid color-mix(in srgb,var(--acc,#a78bfa) 34%,transparent);border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600}
.dw-acc-tier svg{width:13px;height:13px}
.dw-acc-tier span{color:#9ca3af;font-weight:500}
.dw-acc-tier:hover{background:color-mix(in srgb,var(--acc,#a78bfa) 20%,transparent)}
.dw-acc-floor{font-size:12px}
.dw-acc-on{color:#fbbf24;font-weight:600}
.dw-acc-off{color:#9ca3af}
`;
	const style = document.createElement('style');
	style.id = 'arena-drawer-access-styles';
	style.textContent = css;
	document.head.appendChild(style);
}

async function enrichDrawerWithOracle(id) {
	try {
		const r = await fetch(`/api/oracle/agent-stats?agent_id=${encodeURIComponent(id)}&network=${NETWORK}&limit=5`);
		if (!r.ok) return;
		const data = await r.json();
		const s = data.summary;
		if (!s || s.total === 0) return;
		const body = $('drawerBody');
		if (!body) return;
		const cta = body.querySelector('.dw-cta');
		if (!cta) return;

		const wrVal = s.win_rate;
		const wrClass = wrVal >= 50 ? 'up' : 'down';
		const wr = wrVal != null ? `<b class="${wrClass}">${wrVal}%</b>` : '<b>—</b>';
		const pnlVal = s.realized_pnl_sol;
		const pnlClass = pnlVal >= 0 ? 'up' : 'down';
		const pnlPrefix = pnlVal >= 0 ? '+' : '';
		const pnlStr = pnlVal != null
			? `<b class="${pnlClass}">${pnlPrefix}${Number(pnlVal).toFixed(3)}</b>`
			: '<b>—</b>';
		const openStr = s.open > 0 ? ` · ${s.open} open` : '';

		const actions = (data.recent_actions || []).slice(0, 5);
		const actionsHtml = actions.map((a) => {
			const outcome = a.outcome || 'open';
			const tier = a.tier || '';
			const peak = a.peak_multiple != null ? `${Number(a.peak_multiple).toFixed(1)}×` : '—';
			const sym = esc((a.symbol || a.mint.slice(0, 6)).toUpperCase());
			const peakCls = (a.peak_multiple ?? 0) >= 2 ? ' up' : '';
			return `<a class="dw-oracle-action" href="/oracle/coin/${encodeURIComponent(a.mint)}" target="_blank" rel="noopener">
				<span class="dw-oracle-dot ${outcome}"></span>
				<span class="dw-oracle-sym">${sym}</span>
				<span class="dw-oracle-tier">${tier}</span>
				<span class="dw-oracle-peak${peakCls}">${peak}</span>
			</a>`;
		}).join('');

		const block = document.createElement('div');
		block.innerHTML = `
			<div class="dw-oracle-h">Oracle conviction</div>
			<div class="dw-oracle-kpis">
				<div class="dw-oracle-kpi"><span>Actions</span><b>${s.total}${openStr}</b></div>
				<div class="dw-oracle-kpi"><span>Win rate</span>${wr}</div>
				<div class="dw-oracle-kpi"><span>Realized</span>${pnlStr}</div>
			</div>
			${actions.length > 0 ? `<div class="dw-oracle-actions">${actionsHtml}</div>` : ''}
		`;
		body.insertBefore(block, cta);
	} catch { /* non-fatal */ }
}

function closeAgentDrawer() {
	$('agentDrawer').classList.remove('open');
	if (drawerAbort) { drawerAbort.abort(); drawerAbort = null; }
	world.clearFocus?.();
}

function renderAgentDrawer(data, id) {
	const m = data.metrics || {};
	const a = data.agent || {};
	const verified = m.verified
		? '<span class="dw-badge ok">✓ Verified profitable</span>'
		: '<span class="dw-badge">Building track record</span>';
	const scoreCls = m.score >= 70 ? 'up' : m.score >= 40 ? '' : 'down';
	const stat = (label, val, cls = '') => `<div class="dw-stat"><span>${label}</span><b class="${cls}">${val}</b></div>`;
	const pnlCls = (m.realized_pnl_sol ?? 0) >= 0 ? 'up' : 'down';

	const grid = [
		stat('Realized P&L', fmtSol(m.realized_pnl_sol) + (m.realized_pnl_usd != null ? `<small> ${fmtUsd(m.realized_pnl_usd)}</small>` : ''), pnlCls),
		stat('Win rate', m.closed_count ? Math.round(m.win_rate * 100) + '%' : '—'),
		stat('ROI', m.closed_count ? fmtPct(m.roi_pct) : '—', (m.roi_pct ?? 0) >= 0 ? 'up' : 'down'),
		stat('Closed trades', m.closed_count ?? 0),
		stat('Best trade', m.best_pnl_pct != null ? fmtPct(m.best_pnl_pct) : '—', 'up'),
		stat('Max drawdown', m.max_drawdown_pct != null ? '−' + Math.abs(m.max_drawdown_pct).toFixed(1) + '%' : '—', 'down'),
		stat('Avg hold', holdLabel(m.avg_hold_seconds)),
		stat('Open now', m.open_count ?? 0),
	].join('');

	const trades = (data.closed || []).slice(0, 8).map((t) => {
		const win = (t.pnl_sol ?? 0) >= 0;
		const proof = t.sell_url || t.buy_url;
		return `<div class="dw-trade">
			<span class="dw-t-sym">${esc(t.symbol || t.name || (t.mint || '').slice(0, 6))}</span>
			<span class="dw-t-reason">${esc(t.exit_reason || 'closed')}</span>
			<span class="dw-t-pnl ${win ? 'up' : 'down'}">${fmtSol(t.pnl_sol)} ${fmtPct(t.pnl_pct)}</span>
			${proof ? `<a href="${esc(proof)}" target="_blank" rel="noopener" title="On-chain proof">↗</a>` : '<span class="dw-sim">sim</span>'}
		</div>`;
	}).join('') || '<div class="dw-empty" style="padding:14px">No closed trades yet.</div>';

	$('drawerBody').innerHTML = `
		<div class="dw-head">
			${a.image ? `<img loading="lazy" decoding="async" src="${esc(a.image)}" alt="" data-fallback="remove"/>` : '<span class="dw-av-fallback"></span>'}
			<div>
				<div class="dw-name">${esc(a.name || 'Agent')}</div>
				<div class="dw-sub">${verified}</div>
			</div>
			<div class="dw-score ${scoreCls}"><b>${m.score ?? 0}</b><span>score</span></div>
		</div>
		${sparkline(data.closed || [])}
		<div class="dw-grid">${grid}</div>
		<div class="dw-section-h">Recent closed trades · every one on-chain</div>
		<div class="dw-trades">${trades}</div>
		<div class="dw-cta">
			<a class="btn primary" href="/trader/${encodeURIComponent(id)}" target="_blank" rel="noopener">Full proof &amp; copy ↗</a>
			${a.wallet ? `<a class="btn" href="https://solscan.io/account/${esc(a.wallet)}" target="_blank" rel="noopener">Wallet ↗</a>` : ''}
		</div>`;
}

// Cumulative realized-P&L equity curve from the closed ledger (chronological).
function sparkline(closed) {
	const chron = [...closed].filter((t) => t.pnl_sol != null)
		.sort((x, y) => new Date(x.closed_at) - new Date(y.closed_at));
	if (chron.length < 2) return '';
	let cum = 0; const pts = [0];
	for (const t of chron) { cum += t.pnl_sol; pts.push(cum); }
	const min = Math.min(...pts), max = Math.max(...pts), range = (max - min) || 1;
	const W = 280, H = 56;
	const coords = pts.map((v, i) => [
		(i / (pts.length - 1)) * W,
		H - ((v - min) / range) * (H - 6) - 3,
	]);
	const d = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
	const up = cum >= 0;
	const col = up ? 'var(--up)' : 'var(--down)';
	const area = `${d} L${W},${H} L0,${H} Z`;
	const zeroY = (H - ((0 - min) / range) * (H - 6) - 3).toFixed(1);
	return `<svg class="dw-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
		<line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="rgba(255,255,255,.12)" stroke-dasharray="3 3"/>
		<path d="${area}" fill="${col}" opacity="0.12"/>
		<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
	</svg>`;
}

function fmtUsd(n) {
	if (n == null) return '';
	const s = Math.abs(n) >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${Number(n).toFixed(2)}`;
	return (n < 0 ? '−' : '') + s.replace('-', '');
}
function holdLabel(sec) {
	if (!sec) return '—';
	if (sec < 90) return `${Math.round(sec)}s`;
	if (sec < 5400) return `${Math.round(sec / 60)}m`;
	return `${(sec / 3600).toFixed(1)}h`;
}

// ── HUD: leaderboard, top card, tape, banner ────────────────────────────────────

function renderBoard(rows) {
	const body = $('board');
	if (!rows.length) { body.innerHTML = ''; return; }
	body.innerHTML = rows.slice(0, 12).map((r) => {
		rowsById.set(r.id, r); // route clicks even for rows past the 3D cap
		const up = (r.pnl_sol ?? 0) >= 0;
		const name = r.name;
		const initial = esc((name.trim()[0] || '?').toUpperCase());
		// On a broken avatar, swap the <img> for a mono-initial tile that fills the
		// same 26px column — no orphaned gap in the grid.
		const avatarFallback = `data-fallback="element" data-fallback-tag="span" data-fallback-class="r-av r-av-fb" data-fallback-text="${initial}"`;
		const sub = r.kind === 'live'
			? `${r.trades != null ? Number(r.trades).toLocaleString('en-US') + ' trades' : 'live'}${r.win_pct != null ? ' · ' + Math.round(r.win_pct) + '% win' : ''}`
			: `${r.open} open · ${r.closed ? Math.round(r.win_pct) + '% win' : 'new'}`;
		// Live wallets have no avatar — use the mono-initial tile directly.
		const av = r.kind === 'live'
			? `<span class="r-av r-av-fb">${initial}</span>`
			: `<img loading="lazy" decoding="async" class="r-av" src="${esc(r.image || '/avatars/thumbs/default.png')}" alt="" ${avatarFallback}/>`;
		return `<button class="row no-orbit" data-id="${esc(r.id)}">
			<span class="r-rank">${r.rank}</span>
			${av}
			<span class="r-name">${esc(name)}<small>${esc(sub)}</small></span>
			<span class="r-pnl ${up ? 'up' : 'down'}">${fmtSol(r.pnl_sol)}</span>
		</button>`;
	}).join('');
	body.querySelectorAll('.row').forEach((b) => b.addEventListener('click', () => focusAgent(b.dataset.id)));
}

function renderTopCard(top) {
	if (!top) return;
	const live = top.kind === 'live';
	const crown = document.querySelector('.topcard .crown');
	if (crown) crown.innerHTML = live ? `🔥 Top Solana trader${_liveWindow ? ' · live ' + esc(_liveWindow) : ' · live'}` : '👑 #1 by realized P&amp;L';
	$('topName').textContent = top.name;
	const pnl = $('topPnl');
	pnl.textContent = fmtSol(top.pnl_sol);
	pnl.className = 'big ' + ((top.pnl_sol ?? 0) >= 0 ? 'up' : 'down');
	const usdEl = $('topPnlUsd');
	if (usdEl) usdEl.textContent = top.pnl_usd != null ? fmtUsd(top.pnl_usd) : (top.pnl_sol != null && _solUsd ? fmtUsd(top.pnl_sol * _solUsd) : '');
	// Third stat is contextual: agents show wins, live wallets show trade count.
	const winsLabel = $('topWins')?.parentElement?.querySelector('span');
	if (winsLabel) winsLabel.textContent = live ? 'Trades' : 'Wins';
	$('topWins').textContent = live ? (top.trades != null ? Number(top.trades).toLocaleString('en-US') : '—') : (top.wins ?? 0);
	// "Open" only applies to agents — hide it for a live wallet.
	const openCell = $('topOpen')?.parentElement;
	if (openCell) openCell.style.display = live ? 'none' : '';
	$('topOpen').textContent = top.open ?? 0;
	$('topWr').textContent = top.win_pct != null ? Math.round(top.win_pct) + '%' : '—';
	const img = $('topAv');
	if (top.image) { img.src = top.image; img.style.display = ''; } else img.style.display = 'none';
}

// Field-wide aggregates — the data points that make the arena feel alive at a
// glance: who's on the floor, the field's combined realized P&L (with USD), the
// average win rate, and live open exposure / trade volume.
function renderStats(rows) {
	const el = $('arenaStats');
	if (!el) return;
	if (!rows.length) { el.hidden = true; return; }
	el.hidden = false;
	const live = _source === 'live';
	const pnlSum = rows.reduce((a, r) => a + (r.pnl_sol ?? 0), 0);
	const wrs = rows.map((r) => r.win_pct).filter((v) => v != null);
	const avgWr = wrs.length ? Math.round(wrs.reduce((a, b) => a + b, 0) / wrs.length) : null;
	const usd = _solUsd ? fmtUsd(pnlSum * _solUsd) : '';
	const fourth = live
		? { label: 'Trades', val: rows.reduce((a, r) => a + (r.trades || 0), 0).toLocaleString('en-US') }
		: { label: 'Open now', val: String(_positions.length) };
	const kpi = (label, val, cls = '', sub = '') =>
		`<div class="as-kpi"><span>${label}</span><b class="${cls}">${val}</b>${sub ? `<i>${sub}</i>` : ''}</div>`;
	el.innerHTML =
		kpi(live ? 'On the board' : 'On the floor', String(rows.length)) +
		kpi('Field P&amp;L', fmtSol(pnlSum), pnlSum >= 0 ? 'up' : 'down', usd) +
		kpi('Avg win', avgWr != null ? avgWr + '%' : '—') +
		kpi(fourth.label, fourth.val);

	// Source ribbon in the leaderboard header — honest about whether these are
	// three.ws agents or the live market fallback.
	const badge = $('boardSource');
	if (badge) {
		badge.hidden = !live;
		if (live) { badge.textContent = `live market${_liveWindow ? ' · ' + _liveWindow : ''}`; badge.title = 'Top Solana traders by realized profit — three.ws agents take over as they post provable records.'; }
	}
	// The sort toggle only makes sense over the agent board (kolscan is pnl-ranked).
	const seg = $('sortSeg');
	if (seg) seg.hidden = live;
}

// Execution-quality tag for a streamed fill — real fields from the sniper worker
// (route + time to land on-chain). Absent on seeded/closed history rows.
function execTag(p) {
	const bits = [];
	if (p.landed_ms != null && p.landed_ms > 0) bits.push(`${(p.landed_ms / 1000).toFixed(2)}s`);
	if (p.exec_route) bits.push(esc(String(p.exec_route)));
	return bits.length ? ` · <span class="t-exec" title="Execution route · time to land on-chain">⚡ ${bits.join(' · ')}</span>` : '';
}

function pushTape(kind, p, { quiet = false } = {}) {
	const tape = $('tape');
	$('tapeEmpty')?.remove();
	const isSell = kind === 'sell';
	const win = isSell && (p.pnl_sol ?? 0) >= 0;
	const sideCls = !isSell ? 'buy' : win ? 'win' : 'loss';
	const sideTxt = !isSell ? 'BUY' : win ? 'SELL ▲' : 'SELL ▼';
	const proof = isSell ? p.sell_url : p.buy_url;
	const pnl = isSell ? `<span class="t-pnl ${win ? 'up' : 'down'}">${fmtSol(p.pnl_sol)} ${fmtPct(p.pnl_pct)}</span>` : '';
	const row = document.createElement('div');
	row.className = 'tape-ev' + (quiet ? '' : ' fresh');
	row.innerHTML = `
		<span class="t-side ${sideCls}">${sideTxt}</span>
		<span class="t-body">
			<span class="t-l1"><b>${esc(p.agent_name || 'Agent')}</b> <span class="t-sym">${esc(p.symbol || p.name || (p.mint || '').slice(0, 6))}</span></span>
			<span class="t-l2">${isSell ? esc(p.exit_reason || 'closed') : `entry ${fmtSol(p.entry_sol)}`} ${proof ? `· <a href="${esc(proof)}" target="_blank" rel="noopener" class="no-orbit">on-chain ↗</a>` : '· simulated'}${execTag(p)}</span>
		</span>
		${pnl}`;
	tape.prepend(row);
	while (tape.children.length > 40) tape.lastChild.remove();
}

let bannerTimer = null;
function bigWinBanner(p) {
	const b = $('banner');
	b.innerHTML = `🚀 <b>${esc(p.agent_name || 'Agent')}</b> just closed <b class="up">${fmtSol(p.pnl_sol)} ${fmtPct(p.pnl_pct)}</b> on <span>${esc(p.symbol || (p.mint || '').slice(0, 6))}</span>${p.sell_url ? ` · <a href="${esc(p.sell_url)}" target="_blank" rel="noopener" class="no-orbit">proof ↗</a>` : ''}`;
	b.classList.add('show');
	clearTimeout(bannerTimer);
	bannerTimer = setTimeout(() => b.classList.remove('show'), 6500);
}

// ── status / states ─────────────────────────────────────────────────────────────

let _streamLive = false;
function setLive(on) {
	_streamLive = on;
	const dot = $('liveDot');
	dot.classList.toggle('on', on);
	dot.querySelector('span').textContent = on ? 'live' : 'reconnecting…';
}

// Keep the live-tape empty state honest: when no trade has streamed yet, the copy
// must distinguish "stream up, awaiting the next trade" from "stream down,
// reconnecting". Once a real trade lands, pushTape() removes the placeholder for
// good and this is a no-op.
function refreshTapeEmpty() {
	const ph = $('tapeEmpty');
	if (!ph) return;
	ph.textContent = _streamLive ? 'Waiting for the next trade…' : 'Reconnecting to trade stream…';
	ph.classList.toggle('reconnecting', !_streamLive);
}
function setLoading(text) {
	const el = $('loading');
	if (!el) return;
	if (text) { el.textContent = text; el.style.display = ''; }
	else el.style.display = 'none';
}
function setEmpty(on) { const e = $('emptyState'); if (e) e.hidden = !on; }

// ── controls + avatar picker ────────────────────────────────────────────────────

function mountControls() {
	$('pickBtn')?.addEventListener('click', openPicker);
	$('pickClose')?.addEventListener('click', closePicker);
	$('pickBackdrop')?.addEventListener('click', closePicker);
	$('emptyPick')?.addEventListener('click', openPicker);
	// Collapse side panels on mobile.
	$('togglePanels')?.addEventListener('click', () => document.body.classList.toggle('panels-open'));
	$('drawerClose')?.addEventListener('click', closeAgentDrawer);
	// Leaderboard sort (agents only — re-ranks via the API's sort param).
	$('sortSeg')?.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
		if (b.dataset.sort === _sort) return;
		_sort = b.dataset.sort;
		$('sortSeg').querySelectorAll('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
		loadBoardOnly();
	}));
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePicker(); closeAgentDrawer(); } });
}

let pickerLoaded = false;
let pickerReturnFocus = null;
function openPicker() {
	const picker = $('picker');
	if (picker.classList.contains('open')) return;
	pickerReturnFocus = document.activeElement;
	picker.classList.add('open');
	picker.addEventListener('keydown', trapPickerFocus);
	if (!pickerLoaded) { pickerLoaded = true; renderPicker(); }
	// Move focus into the dialog — first selectable tile if present, else the
	// close button — so keyboard users land inside the modal, not behind it.
	requestAnimationFrame(() => {
		const first = $('pickGrid')?.querySelector('.pick-tile') || $('pickClose');
		first?.focus();
	});
}
function closePicker() {
	const picker = $('picker');
	if (!picker.classList.contains('open')) return;
	picker.classList.remove('open');
	picker.removeEventListener('keydown', trapPickerFocus);
	// Restore focus to whatever opened the picker (the avatar button / empty CTA).
	if (pickerReturnFocus && document.contains(pickerReturnFocus)) pickerReturnFocus.focus();
	pickerReturnFocus = null;
}

// Trap Tab / Shift+Tab inside the open dialog so focus can't escape behind it.
function trapPickerFocus(e) {
	if (e.key !== 'Tab') return;
	const modal = $('picker').querySelector('.pick-modal');
	const focusables = modal.querySelectorAll(
		'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
	);
	if (!focusables.length) return;
	const first = focusables[0];
	const last = focusables[focusables.length - 1];
	const active = document.activeElement;
	if (e.shiftKey && (active === first || !modal.contains(active))) {
		e.preventDefault(); last.focus();
	} else if (!e.shiftKey && active === last) {
		e.preventDefault(); first.focus();
	}
}

async function renderPicker() {
	const grid = $('pickGrid');
	const saved = localStorage.getItem(PLAYER_KEY) || '/avatars/default.glb';
	const localThumbs = {
		'/avatars/default.glb': '/avatars/thumbs/default.png',
		'/avatars/cz.glb': '/avatars/thumbs/cz.png',
	};
	const local = ROSTER.map((r) => ({ name: r.name, url: r.url, thumb: localThumbs[r.url] || '', starter: true }));
	grid.innerHTML = local.map(tile(saved)).join('') + `<div class="pick-loading" id="pickLoading">Loading community avatars…</div>`;
	wireTiles(grid);

	try {
		const r = await fetch('/api/avatars/public?limit=24');
		const d = r.ok ? await r.json() : { avatars: [] };
		$('pickLoading')?.remove();
		const items = (d.avatars || []).filter((a) => a.model_url).map((a) => ({
			name: a.name || 'Avatar', url: a.model_url, thumb: a.thumbnail_url || '', starter: false,
		}));
		if (items.length) {
			grid.insertAdjacentHTML('beforeend', `<div class="pick-sep">Community gallery</div>` + items.map(tile(saved)).join(''));
			wireTiles(grid);
		}
	} catch {
		$('pickLoading')?.remove();
	}
}

function tile(saved) {
	return (a) => `
		<button class="pick-tile no-orbit ${a.url === saved ? 'selected' : ''}" data-url="${esc(a.url)}" title="${esc(a.name)}">
			<span class="pick-thumb">${a.thumb ? `<img src="${esc(a.thumb)}" alt="" loading="lazy" data-fallback="remove"/>` : `<span class="pick-mono">${esc((a.name || '?').slice(0, 2).toUpperCase())}</span>`}</span>
			<span class="pick-name">${esc(a.name)}</span>
			${a.starter ? '<span class="pick-badge">starter</span>' : ''}
		</button>`;
}

function wireTiles(grid) {
	grid.querySelectorAll('.pick-tile').forEach((b) => {
		if (b._wired) return; b._wired = true;
		b.addEventListener('click', () => choose(b.dataset.url, b));
	});
}

async function choose(url, btn) {
	const grid = $('pickGrid');
	grid.querySelectorAll('.pick-tile').forEach((x) => x.classList.remove('selected'));
	btn.classList.add('selected');
	btn.classList.add('busy');
	try {
		await world.spawnPlayer(url);
		localStorage.setItem(PLAYER_KEY, url);
		closePicker();
	} catch {
		btn.classList.add('failed');
		setTimeout(() => btn.classList.remove('failed'), 1500);
	} finally {
		btn.classList.remove('busy');
	}
}

// ── mobile joystick (nipplejs, lazy) ────────────────────────────────────────────

async function mountJoystick() {
	const isTouch = matchMedia('(pointer: coarse)').matches;
	if (!isTouch) return;
	try {
		const { default: nipplejs } = await import('nipplejs');
		const zone = $('joystick');
		zone.style.display = 'block';
		const stick = nipplejs.create({ zone, mode: 'static', position: { left: '60px', bottom: '70px' }, color: 'rgba(110,231,255,0.6)', size: 110 });
		stick.on('move', (_e, d) => {
			const f = (d?.force || 0);
			const a = d?.angle?.radian ?? 0;
			world.setJoystick(Math.cos(a) * Math.min(1, f), Math.sin(a) * Math.min(1, f));
		});
		stick.on('end', () => world.setJoystick(0, 0));
	} catch { /* desktop / import failure — keyboard still works */ }
}
