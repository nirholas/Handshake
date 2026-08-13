// The AGI: frontend surface.
//
// One real, autonomous agent, framed as what it is: a narrow AGI, genuinely
// superhuman at pump.fun memecoin trading and deliberately nothing else. This
// page gives that mind a body (the <agent-3d> element, mood-driven from the live
// cognition vector) and surrounds it with the proof: a live stream of its actual
// decisions, a chain-proven track record, and its stated doctrine: what it
// claims, and what it refuses.
//
// Every number comes from /api/agi/state (real DB / on-chain truth layers). No
// sample data: when the platform has no proven trader yet, the page renders a
// designed "awakening" state instead of inventing one.
//
// The shell is built ONCE and then patched in place on every poll. It used to be
// re-rendered wholesale, which silently destroyed the mounted <agent-3d> on the
// first 20s tick and left "embodying…" on screen forever: the page's centerpiece
// vanished 20 seconds after load. Only data-bearing regions are replaced now, and
// the stage the body lives in is never touched.

import { apiFetch } from './api.js';
import { countUp, enterStagger, liveDot, setLiveDot, reducedMotion } from './ui-juice.js';

const root = document.getElementById('agi-root');
const POLL_MS = 20000;

const state = {
	data: null,
	seen: new Set(), // decision ids already rendered, so only fresh ones animate-in
	timer: null,
	el3d: null, // the embodied <agent-3d>
	embodied: false,
	lastScore: null, // last reputation value drawn, so the ring only re-sweeps on a real change
	shell: false, // the stable layout has been built
	filter: 'trade', // decision stream lens: 'trade' | 'all'
};

// ── utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortRef(m) { return m ? `${m.slice(0, 4)}…${m.slice(-4)}` : ''; }
function fmtSol(n) { const v = Number(n) || 0; return `${v >= 0 ? '+' : ''}${v.toFixed(3)}`; }
function fmtPct(n) { if (n == null || !Number.isFinite(Number(n))) return 'n/a'; const v = Number(n); return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }
function pnlClass(n) { const v = Number(n) || 0; return v > 0 ? 'agi-pos' : v < 0 ? 'agi-neg' : ''; }
function timeAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 60) return `${Math.floor(s)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}
function solscanToken(mint, network) {
	if (!mint) return null;
	return network === 'devnet' ? `https://solscan.io/token/${mint}?cluster=devnet` : `https://solscan.io/token/${mint}`;
}
const $ = (sel) => root.querySelector(sel);

// ── data ────────────────────────────────────────────────────────────────────
async function fetchState() {
	const qs = new URLSearchParams(location.search);
	const params = new URLSearchParams();
	if (qs.get('agent')) params.set('agent', qs.get('agent'));
	if (qs.get('network')) params.set('network', qs.get('network'));
	const res = await apiFetch(`/api/agi/state${params.toString() ? `?${params}` : ''}`);
	if (!res.ok) throw new Error(`agi state ${res.status}`);
	return res.json();
}

// ── embodiment: cognition to 3D body + aura ───────────────────────────────────
// Valence ∈ [-1,1], arousal ∈ [0,1]. The aura is the one chromatic license on a
// monochrome surface: hue tracks valence (red/slate/green), strength tracks arousal.
function auraFor(valence, arousal) {
	const v = Math.max(-1, Math.min(1, Number(valence) || 0));
	const a = Math.max(0, Math.min(1, Number(arousal) || 0));
	const hue = v >= 0 ? 210 - v * 65 : 210 + v * 202; // 210 neutral, 145 green, 8 red
	const sat = Math.round(35 + Math.abs(v) * 45);
	return {
		aura: `hsla(${hue.toFixed(0)}, ${sat}%, 56%, 0.42)`,
		solid: `hsl(${hue.toFixed(0)}, ${sat}%, 60%)`,
		strength: (0.35 + a * 0.45).toFixed(2),
	};
}

function applyAura(cog) {
	const stage = document.getElementById('agi-stage');
	if (!stage || !cog) return;
	const { aura, solid, strength } = auraFor(cog.valence, cog.arousal);
	stage.style.setProperty('--agi-aura', aura);
	stage.style.setProperty('--agi-aura-solid', solid);
	stage.style.setProperty('--agi-aura-strength', strength);
}

function applyMood(cog) {
	const el = state.el3d;
	if (!el || !cog) return;
	try {
		if (typeof el.setMood === 'function') el.setMood(cog.valence, cog.arousal, { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
		if (cog.emotion && typeof el.expressEmotion === 'function') {
			el.expressEmotion(cog.emotion.trigger, cog.emotion.intensity);
		}
	} catch (_) { /* embodiment is enhancement, never a hard dependency */ }
}

function mountBody(agent) {
	const stage = document.getElementById('agi-stage');
	if (!stage || state.el3d) return;
	const el = document.createElement('agent-3d');
	el.setAttribute('mode', 'inline');
	el.setAttribute('background', 'transparent');
	el.setAttribute('name-plate', 'off');
	el.setAttribute('avatar-chat', 'off');
	// `chat="off"` keeps the element a bare body. Without it, binding an
	// agent-id builds the chat shell (focusable log, suggestion chips, send
	// button) inside a host we label role="img", and axe rightly flags that
	// as nested-interactive: role="img" makes every descendant presentational.
	el.setAttribute('chat', 'off');
	el.setAttribute('responsive', '');
	el.setAttribute('eager', '');
	// The body is a graphic: name it for screen readers, since the canvas inside
	// carries no text of its own.
	el.setAttribute('role', 'img');
	el.setAttribute('aria-label', agent?.name ? `Live 3D body of ${agent.name}, the trading agent` : 'Live 3D body of the trading agent');
	if (agent?.id) el.setAttribute('agent-id', agent.id);
	else el.setAttribute('body', '/avatars/default.glb');
	// Reveal only once the model is in; until then the boot line shows.
	const reveal = () => {
		el.classList.add('agi-loaded');
		const boot = stage.querySelector('.agi-stage-boot');
		if (boot) boot.remove();
		state.embodied = true;
		if (state.data?.cognition) { applyMood(state.data.cognition); }
	};
	el.addEventListener('agent:ready', reveal, { once: true });
	el.addEventListener('load', reveal, { once: true });
	// Failsafe: if neither event fires (older bundle), reveal after a beat.
	setTimeout(reveal, 4000);
	stage.insertBefore(el, stage.querySelector('.agi-stage-floor'));
	state.el3d = el;
}

// ── hero ──────────────────────────────────────────────────────────────────────
function heroActions(agent) {
	const ledgerHref = agent?.id ? `/ledger/${agent.id}` : '/ledger';
	// With no designated agent yet there is no per-trader page to send anyone to,
	// so the second action points at the platform-wide live trade feed instead of
	// a /trader/ URL with a missing id.
	const second = agent?.id
		? `<a class="agi-btn" href="/trader/${esc(agent.id)}">Live trades</a>`
		: `<a class="agi-btn" href="/activity">Watch live agent trades</a>`;
	return `<a class="agi-btn agi-btn-primary" href="${esc(ledgerHref)}">Audit its track record →</a>${second}`;
}

function updateHero(d) {
	const { doctrine, cognition: cog, agent } = d;
	const domain = $('[data-f="domain"]');
	if (domain) domain.textContent = doctrine.domain;
	const lede = $('[data-f="thesis"]');
	if (lede) lede.textContent = doctrine.thesis;
	const label = $('[data-f="cog-label"]');
	if (label) label.textContent = cog.label;
	const conv = $('[data-f="conviction"]');
	if (conv) conv.textContent = cog.conviction != null ? `conviction ${Math.round(cog.conviction * 100)}%` : 'scanning';
	const actions = $('#agi-actions');
	if (actions) {
		const next = heroActions(agent);
		if (actions.innerHTML !== next) actions.innerHTML = next;
	}
}

// ── the mind (decision stream) ────────────────────────────────────────────────
function renderThought(t, network, fresh) {
	const reconciled = t.outcome?.status === 'reconciled';
	const verdict = reconciled
		? (t.outcome.was_correct
			? `<span class="agi-verdict win">right ${t.outcome.pnl_sol != null ? fmtSol(t.outcome.pnl_sol) + ' SOL' : ''}</span>`
			: `<span class="agi-verdict loss">wrong ${t.outcome.pnl_sol != null ? fmtSol(t.outcome.pnl_sol) + ' SOL' : ''}</span>`)
		: `<span class="agi-verdict pending">open call</span>`;
	const conf = t.confidence != null ? Math.round(t.confidence * 100) : null;
	const tokenUrl = solscanToken(t.mint, network);
	// Only a real mint gets a Solscan link. An operational call's subject is an
	// internal id, so it renders as plain text rather than a link to nothing.
	const subject = t.mint
		? `<span class="agi-thought-mint">${tokenUrl ? `<a href="${esc(tokenUrl)}" target="_blank" rel="noopener">${esc(shortRef(t.mint))}</a>` : esc(shortRef(t.mint))}</span>`
		: t.subject_ref
			? `<span class="agi-thought-mint agi-thought-ref" title="${esc(t.subject_ref)}">${esc(shortRef(t.subject_ref))}</span>`
			: '';
	const proof = reconciled && t.outcome.proof_url ? ` · <a href="${esc(t.outcome.proof_url)}" target="_blank" rel="noopener">proof</a>` : '';
	return `
		<article class="agi-thought${fresh ? ' agi-fresh' : ''}">
			<div class="agi-thought-top">
				<span class="agi-thought-kind">▸ ${esc(t.kind || 'decision')}${subject}</span>
				<span class="agi-thought-time">${esc(timeAgo(t.decided_at))}</span>
			</div>
			${t.rationale ? `<p class="agi-thought-body">${esc(t.rationale)}</p>` : ''}
			<div class="agi-thought-meta">
				${conf != null ? `<span class="agi-muted">said ${conf}%</span><span class="agi-conf-bar"><span style="width:${conf}%"></span></span>` : ''}
				${verdict}${proof}
			</div>
		</article>`;
}

function visibleDecisions(d) {
	const all = d.decisions || [];
	return state.filter === 'trade' ? all.filter((t) => t.domain !== 'operations') : all;
}

function updateFilter(d) {
	const all = d.decisions || [];
	const trades = all.filter((t) => t.domain !== 'operations').length;
	const host = $('#agi-filter');
	if (!host) return;
	// The lens only earns its place once the agent logs both kinds of call.
	if (!trades || trades === all.length) { host.hidden = true; host.innerHTML = ''; return; }
	host.hidden = false;
	if (!host.children.length) {
		const chip = (key, label) =>
			`<button type="button" class="agi-chip" data-filter="${key}">${label} <span class="agi-chip-n"></span></button>`;
		host.innerHTML = chip('trade', 'Trading calls') + chip('all', 'Everything it decided');
	}
	// Patched in place, never rebuilt: replacing these buttons on every poll would
	// yank focus out from under anyone driving the page from the keyboard.
	const counts = { trade: trades, all: all.length };
	for (const btn of host.querySelectorAll('.agi-chip')) {
		btn.setAttribute('aria-pressed', String(state.filter === btn.dataset.filter));
		const n = btn.querySelector('.agi-chip-n');
		if (n) n.textContent = String(counts[btn.dataset.filter] ?? 0);
	}
}

function updateMind(d) {
	const host = $('#agi-stream-host');
	if (!host) return;
	const list = visibleDecisions(d);
	const total = (d.decisions || []).length;
	host.innerHTML = list.length
		? `<div class="agi-stream">${list.map((t) => renderThought(t, d.network, !state.seen.has(t.id))).join('')}</div>`
		: total
			? `<div class="agi-empty"><p>No trading calls in this window: everything it logged recently was operational self-tuning.</p><button type="button" class="agi-btn" data-filter="all">Show everything it decided</button></div>`
			: `<div class="agi-empty"><p>No decisions logged in this window yet. Every call it makes will appear here, with its reasoning, its stated confidence, and, once the trade resolves, whether it was right.</p></div>`;
	// Mark the whole payload seen, not just the visible slice, so flipping the lens
	// never re-animates a call the reader already watched arrive.
	(d.decisions || []).forEach((t) => state.seen.add(t.id));
	enterStagger(host.querySelectorAll('.agi-thought.agi-fresh'), { step: 60 });
}

// ── track record ──────────────────────────────────────────────────────────────
function ring(score) {
	const r = 40, c = 2 * Math.PI * r;
	const pct = Math.max(0, Math.min(100, Number(score) || 0));
	const off = c * (1 - pct / 100);
	const prev = state.lastScore;
	const fromOff = prev == null ? c : c * (1 - Math.max(0, Math.min(100, prev)) / 100);
	// Markup carries the FINAL state (correct without JS / under reduced motion);
	// playRecord sweeps from `data-from-off` to it and counts the number up.
	return `
		<div class="agi-ring">
			<svg viewBox="0 0 92 92" aria-hidden="true">
				<circle class="agi-ring-track" cx="46" cy="46" r="${r}" fill="none" stroke-width="6" />
				<circle class="agi-ring-val" cx="46" cy="46" r="${r}" fill="none" stroke-width="6"
					stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
					data-from-off="${fromOff.toFixed(1)}" />
			</svg>
			<div class="agi-ring-num"><b data-score="${Math.round(pct)}" data-from="${prev == null ? 0 : Math.round(prev)}">${Math.round(pct)}</b><small>reputation</small></div>
		</div>`;
}

// Sweep the reputation ring from its previous fill to the new one and count the
// number up in step. Only animates on a real change; reduced motion lands final.
function playRecord() {
	const num = $('.agi-ring-num b');
	const arc = $('.agi-ring-val');
	if (num) {
		const to = Number(num.dataset.score) || 0;
		const from = Number(num.dataset.from) || 0;
		countUp(num, from, to, { format: (n) => String(Math.round(n)) });
	}
	if (arc && !reducedMotion()) {
		const fromOff = arc.getAttribute('data-from-off');
		const finalOff = arc.getAttribute('stroke-dashoffset');
		if (fromOff != null && fromOff !== finalOff) {
			arc.style.strokeDashoffset = fromOff;
			void arc.getBoundingClientRect(); // commit the start frame
			requestAnimationFrame(() => { arc.style.strokeDashoffset = ''; });
		}
	}
}

function stat(k, v, cls = '') {
	return `<div class="agi-stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div></div>`;
}

function recordMarkup(d) {
	const p = d.performance;
	const rep = d.reputation;
	const agent = d.agent;
	if (!p) {
		return `
			<div class="agi-section-head"><h2>Track record</h2></div>
			<div class="agi-empty"><p>The track record fills in as soon as the agent closes its first proven trade. Nothing is shown until it's real and on-chain.</p></div>`;
	}
	const winRate = p.win_rate != null ? `${Math.round(p.win_rate * 100)}%` : 'n/a';
	const hit = p.snipe_hit_rate != null ? `${Math.round(p.snipe_hit_rate * 100)}%` : 'n/a';
	const positions = (d.positions || []).map((pos) => {
		const url = solscanToken(pos.mint, d.network);
		const label = pos.symbol || shortRef(pos.mint);
		return `<div class="agi-position"><span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label)}</span><span class="${pnlClass(pos.unrealized_pct)}">${fmtPct(pos.unrealized_pct)}</span></div>`;
	}).join('');
	const calNote = rep && rep.sample_size
		? `Computed from <b>${rep.sample_size}</b> reconciled call${rep.sample_size === 1 ? '' : 's'}, hit rate, calibration, and realized P&amp;L, regressed toward neutral until proven.`
		: `Regressed toward neutral, too few reconciled calls to trust yet.`;
	const ledgerHref = agent?.id ? `/ledger/${agent.id}` : '/ledger';
	return `
		<div class="agi-section-head">
			<h2>Track record</h2>
			<span class="agi-section-sub">${p.verified ? 'verified trader' : 'unverified'}</span>
		</div>
		<div class="agi-rep">
			${ring(rep ? rep.score : p.score)}
			<div class="agi-rep-side">${calNote}</div>
		</div>
		<div class="agi-stats">
			${stat('Win rate', winRate)}
			${stat('Realized P&L', `<span class="${pnlClass(p.realized_pnl_sol)}">${fmtSol(p.realized_pnl_sol)} SOL</span>`)}
			${stat('Snipe hit rate', hit)}
			${stat('ROI', `<span class="${pnlClass(p.roi_pct)}">${fmtPct(p.roi_pct)}</span>`)}
			${stat('Closed trades', String(p.closed_count ?? 0))}
			${stat('Coins traded', String(p.unique_coins ?? 0))}
		</div>
		${positions ? `<div class="agi-section-head agi-open-head"><h3>Open now</h3><span class="agi-section-sub"><span class="${pnlClass(p.unrealized_pnl_sol)}">${fmtSol(p.unrealized_pnl_sol)} SOL unrealized</span></span></div><div class="agi-positions">${positions}</div>` : ''}
		<p class="agi-honesty">Being wrong is visible, that's the point. Every loss above is counted, never hidden. <a href="${esc(ledgerHref)}">Interrogate the full ledger →</a></p>`;
}

function updateRecord(d) {
	const host = $('#agi-record');
	if (!host) return;
	host.innerHTML = recordMarkup(d);
	playRecord();
	const drawn = $('.agi-ring-num b');
	if (drawn) state.lastScore = Number(drawn.dataset.score);
}

// ── doctrine ──────────────────────────────────────────────────────────────────
function updateDoctrine(d) {
	const host = $('#agi-doctrine');
	if (!host) return;
	const { doctrine } = d;
	const next = `
		<div class="agi-doctrine-grid">
			<div class="agi-card agi-claim">
				<h3>What it is</h3>
				<ul class="agi-list">
					<li><span class="agi-mark" aria-hidden="true">✓</span><span>Superhuman at <b>${esc(doctrine.domain)}</b>, reading launches, the wallet graph, and order flow faster and more consistently than a human.</span></li>
					<li><span class="agi-mark" aria-hidden="true">✓</span><span>Fully autonomous: it sizes, enters, and exits on its own, inside hard spend caps and a kill switch.</span></li>
					<li><span class="agi-mark" aria-hidden="true">✓</span><span>Accountable: every decision is logged with its reasoning and reconciled against the real outcome.</span></li>
				</ul>
			</div>
			<div class="agi-card agi-refuse">
				<h3>What it refuses</h3>
				<ul class="agi-list">
					${doctrine.refusals.map((r) => `<li><span class="agi-mark" aria-hidden="true">✕</span><span>${esc(r)}</span></li>`).join('')}
				</ul>
			</div>
		</div>`;
	if (host.innerHTML !== next) host.innerHTML = next;
}

// ── shell ─────────────────────────────────────────────────────────────────────
// Built once, then patched. Nothing in here that the 3D body lives inside is ever
// replaced, so the mounted element survives every poll.
function buildShell() {
	root.innerHTML = `
		<section class="agi-hero">
			<div class="agi-hero-copy">
				<span class="agi-domain-tag"><i class="agi-dot" aria-hidden="true"></i> <span data-f="domain"></span></span>
				<h1 class="agi-title" id="agi-title">The first AGI.<br /><span class="agi-em">Narrow by design.</span></h1>
				<p class="agi-lede" data-f="thesis"></p>
				<p class="agi-thesis">It is not a chatbot pretending to be smart. It is a single autonomous agent that out-trades humans at one game, and tells you plainly it can do nothing else.</p>
				<div class="agi-hero-actions" id="agi-actions"></div>
			</div>
			<div class="agi-stage" id="agi-stage">
				<div class="agi-stage-boot">embodying…</div>
				<div class="agi-stage-floor">
					<span class="agi-state-pill"><i class="agi-spark" aria-hidden="true"></i> <span data-f="cog-label"></span></span>
					<span class="agi-conviction" data-f="conviction"></span>
				</div>
			</div>
		</section>
		<div class="agi-grid">
			<section class="agi-card agi-mind">
				<div class="agi-section-head">
					<h2>The mind, out loud</h2>
					<span class="agi-mind-meta">
						<span class="agi-section-sub">every call, tamper-evident</span>
						${liveDot('live', { label: 'live' })}
					</span>
				</div>
				<div class="agi-filter" id="agi-filter" role="group" aria-label="Filter the decision stream" hidden></div>
				<div id="agi-stream-host"></div>
			</section>
			<section class="agi-card" id="agi-record"></section>
		</div>
		<section class="agi-doctrine" id="agi-doctrine"></section>`;
	// One delegated handler covers the filter chips and the empty state's escape
	// hatch, so a re-rendered stream never loses its wiring.
	root.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-filter]');
		if (!btn || !root.contains(btn)) return;
		const next = btn.dataset.filter === 'all' ? 'all' : 'trade';
		if (next === state.filter) return;
		state.filter = next;
		if (state.data) { updateFilter(state.data); updateMind(state.data); }
	});
	state.shell = true;
}

function render(d) {
	if (!state.shell) buildShell();
	updateHero(d);
	updateFilter(d);
	updateMind(d);
	updateRecord(d);
	updateDoctrine(d);
	applyAura(d.cognition);
	mountBody(d.agent);
	if (state.embodied) applyMood(d.cognition);
}

function renderLoading() {
	root.innerHTML = `
		<section class="agi-hero">
			<div class="agi-hero-copy">
				<span class="agi-domain-tag"><i class="agi-dot" aria-hidden="true"></i> memecoin trading · pump.fun</span>
				<h1 class="agi-title">The first AGI.<br /><span class="agi-em">Narrow by design.</span></h1>
				<div class="agi-skel" style="height:80px;max-width:46ch"></div>
			</div>
			<div class="agi-stage"><div class="agi-stage-boot">waking the agent…</div></div>
		</section>
		<div class="agi-grid">
			<section class="agi-card"><div class="agi-skel" style="height:300px"></div></section>
			<section class="agi-card"><div class="agi-skel" style="height:300px"></div></section>
		</div>`;
	state.shell = false;
}

function renderError() {
	root.innerHTML = `
		<div class="agi-error">
			<h2>The agent is unreachable</h2>
			<p>Couldn't load the AGI's live state right now. This is a transient connection issue, the agent keeps trading regardless.</p>
			<div class="agi-error-actions">
				<button class="agi-btn agi-btn-primary" id="agi-retry" type="button">Retry</button>
				<a class="agi-btn" href="/ledger">Browse the proof ledger</a>
				<a class="agi-btn" href="/activity">Watch live agent trades</a>
			</div>
		</div>`;
	state.shell = false;
	state.el3d = null;
	state.embodied = false;
	document.getElementById('agi-retry')?.addEventListener('click', () => { renderLoading(); boot(); });
}

// ── boot + poll ───────────────────────────────────────────────────────────────
async function refresh() {
	try {
		const d = await fetchState();
		state.data = d;
		render(d);
		document.title = d.agent?.name ? `${d.agent.name} · The AGI · three.ws` : 'The AGI · three.ws';
	} catch (e) {
		if (!state.data) renderError();
		// Keep the last good render up, but mark the live feed as reconnecting so the
		// "live" dot tells the truth until the next tick recovers.
		else setLiveDot($('.agi-mind'), 'error', 'reconnecting');
	}
}

async function boot() {
	await refresh();
	if (state.timer) clearInterval(state.timer);
	state.timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && state.data) refresh(); });

renderLoading();
boot();
