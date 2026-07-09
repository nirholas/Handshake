// /launcher — your personal Memetic Launcher (the per-user scope).
//
// Talks only to /api/launcher/me (session or bearer). Two modes:
//   Preview (dry_run=true, the default) — the cron picks coins from your agents
//   and records them; nothing moves on-chain.
//   Live (dry_run=false) — the same picks mint for real on pump.fun, SELF-FUNDED:
//   each launch is paid by the launching agent's own wallet (base cost + dev buy)
//   from SOL you deposited to it. The platform never fronts a user launch, so the
//   arm modal here guards your own money, and only yours.
// All API-sourced strings are escaped before they touch the DOM.

import { updateValue, enterRow } from './ui-juice.js';

const API = '/api/launcher/me';
const REFRESH_MS = 6000;
// Per-launch overhead (pump.fun base cost + fee buffer) besides the dev buy.
// The server sends the authoritative value (launch_overhead_sol); this seeds the
// cost hint before the first GET lands.
let launchOverheadSol = 0.027;

const MODES = [
	{ id: 'hybrid', name: 'Hybrid', desc: 'Trend first, meme + random filler to hold cadence.' },
	{ id: 'trend', name: 'Trend', desc: 'Only ride live cultural narratives.' },
	{ id: 'meme', name: 'Meme', desc: 'Coins original memes from culture.' },
	{ id: 'random', name: 'Random', desc: 'Wordlist salad. No LLM, pure volume.' },
	{ id: 'off', name: 'Off', desc: 'Selected but idle. Picks nothing.' },
];
const SOURCES = [
	{ id: 'coin_intel', label: 'Coin intel' },
	{ id: 'trending', label: 'Trending' },
	{ id: 'knowyourmeme', label: 'Know Your Meme' },
	{ id: 'x', label: 'X' },
	{ id: 'hackernews', label: 'Hacker News' },
	{ id: 'reddit', label: 'Reddit' },
	{ id: 'wikipedia', label: 'Wikipedia' },
];
const EDITABLE = ['enabled', 'dry_run', 'mode', 'sources', 'target_cadence_seconds', 'max_per_hour', 'dev_buy_sol', 'daily_sol_cap', 'network'];

// Page markup — injected into the dashboard-next shell's <main> slot by
// src/dashboard-next/pages/launcher.js. Kept here so the controller and the
// DOM it drives live together (every element id below is wired in this file).
export const LAUNCHER_MARKUP = `
	<div id="ul-root" aria-busy="true">
		<!-- Sign-in gate -->
		<section class="ml-gate" id="ul-gate" hidden>
			<div class="ml-gate-card">
				<div class="ml-gate-mark" aria-hidden="true">◎</div>
				<h1 class="ml-gate-title">Memetic Launcher</h1>
				<p class="ml-gate-sub">Sign in to design your own autonomous launcher.</p>
				<a class="ml-btn ml-btn-primary ml-gate-btn" id="ul-signin" href="/login?next=/launcher">Sign in</a>
			</div>
		</section>

		<div id="ul-panel" hidden>
			<!-- Hero -->
			<header class="ml-hero">
				<div class="ml-hero-l">
					<p class="ml-kicker"><span class="ml-dot" id="ul-status-dot"></span> Your autonomous launcher</p>
					<h1 class="ml-title">Memetic <em>Launcher</em></h1>
					<p class="ml-sub" id="ul-status-line">Loading…</p>
				</div>
				<div class="ml-hero-r">
					<span class="ul-badge" id="ul-badge">Preview</span>
					<button class="ml-btn ml-armswitch" id="ul-enable" aria-pressed="false">
						<span class="ml-armswitch-track"><span class="ml-armswitch-knob"></span></span>
						<span class="ml-armswitch-lbl" id="ul-enable-lbl">Off</span>
					</button>
				</div>
			</header>

			<!-- Honest explainer — copy tracks the selected launch mode (see renderNote) -->
			<div class="ul-note" id="ul-note">
				<span class="ul-note-ico" aria-hidden="true">◑</span>
				<p id="ul-note-txt"></p>
			</div>

			<!-- Breaker (rare, but designed) -->
			<div class="ml-breaker" id="ul-breaker" hidden role="alert">
				<span class="ml-breaker-ico" aria-hidden="true">⚠</span>
				<span class="ml-breaker-txt" id="ul-breaker-txt">Paused.</span>
				<button class="ml-btn ml-btn-ghost" id="ul-resume">Resume</button>
			</div>

			<!-- Stats -->
			<dl class="ml-stats ul-stats">
				<div class="ml-stat ml-stat--lead"><dt>Coins previewed today</dt><dd id="ul-s-dry">—</dd></div>
				<div class="ml-stat"><dt>Agents in rotation</dt><dd id="ul-s-queue">—</dd></div>
				<div class="ml-stat"><dt>Launch-ready agents</dt><dd id="ul-s-eligible">—</dd></div>
				<div class="ml-stat"><dt>Mode</dt><dd id="ul-s-mode" class="ul-s-mode">—</dd></div>
			</dl>

			<div class="ml-grid">
				<!-- Config -->
				<form class="ml-config" id="ul-config" aria-label="Launcher configuration">
					<section class="ml-card">
						<h2 class="ml-card-h">Mode</h2>
						<p class="ml-card-help">What your launcher coins each tick.</p>
						<div class="ml-modes" id="ul-modes" role="radiogroup" aria-label="Launch mode"></div>
					</section>

					<section class="ml-card" id="ul-sources-card">
						<h2 class="ml-card-h">Trend sources</h2>
						<p class="ml-card-help">Culture mined to ride live narratives. Themes only — never clones a ticker.</p>
						<div class="ml-chips" id="ul-sources"></div>
					</section>

					<section class="ml-card">
						<h2 class="ml-card-h">Cadence &amp; network</h2>
						<div class="ml-fields">
							<label class="ml-field">
								<span class="ml-field-lbl">Target cadence <em>seconds</em></span>
								<input type="number" min="60" max="86400" step="1" id="ul-cadence" class="ml-input" />
								<span class="ml-field-hint" id="ul-cadence-hint"></span>
							</label>
							<label class="ml-field">
								<span class="ml-field-lbl">Max / hour <em>ceiling</em></span>
								<input type="number" min="0" max="60" step="1" id="ul-maxhour" class="ml-input" />
							</label>
						</div>
						<div class="ml-net ul-net-row">
							<span class="ml-net-lbl">Network</span>
							<div class="ml-seg" id="ul-network" role="radiogroup" aria-label="Network">
								<button type="button" class="ml-seg-btn" data-net="mainnet" role="radio">Mainnet</button>
								<button type="button" class="ml-seg-btn" data-net="devnet" role="radio">Devnet</button>
							</div>
						</div>
					</section>

					<!-- Launch mode: preview vs live + self-funding -->
					<section class="ml-card ul-live-card">
						<h2 class="ml-card-h">Launch mode</h2>
						<p class="ml-card-help">
							Preview records what it would mint. Live mints for real on pump.fun — paid by your own agents'
							wallets, never the platform's.
						</p>
						<div class="ml-seg ul-liveseg" id="ul-liveseg" role="radiogroup" aria-label="Launch mode">
							<button type="button" class="ml-seg-btn" data-live="preview" role="radio">Preview</button>
							<button type="button" class="ml-seg-btn" data-live="live" role="radio">Live</button>
						</div>
						<div class="ml-fields ul-live-fields">
							<label class="ml-field">
								<span class="ml-field-lbl">Dev buy <em>SOL per launch</em></span>
								<input type="number" min="0" max="1" step="0.001" id="ul-devbuy" class="ml-input" />
								<span class="ml-field-hint" id="ul-cost-hint"></span>
							</label>
							<label class="ml-field">
								<span class="ml-field-lbl">Daily cap <em>SOL</em></span>
								<input type="number" min="0" max="10" step="0.1" id="ul-dailycap" class="ml-input" />
								<span class="ml-field-hint">Live spend ceiling per UTC day.</span>
							</label>
						</div>

						<div class="ul-funding">
							<div class="ml-console-h">
								<h3 class="ul-funding-h">Agent wallets</h3>
								<button type="button" class="ml-btn ml-btn-ghost ul-fund-refresh" id="ul-fund-refresh">Refresh</button>
							</div>
							<p class="ml-card-help">Live launches spend from these. Deposit SOL to any of them to power your rotation.</p>
							<ul class="ul-fund-list" id="ul-fund-list"></ul>
							<p class="ul-fund-note" id="ul-fund-note" hidden></p>
							<div class="ul-fund-empty" id="ul-fund-empty" hidden>
								<p>No launch-ready agents yet. <a href="/create-agent">Create an agent</a> with an avatar — it gets its own Solana wallet automatically.</p>
							</div>
						</div>
					</section>

					<!-- Preview a coin -->
					<section class="ml-card ul-preview-card">
						<div class="ml-console-h">
							<h2 class="ml-card-h">Preview a coin</h2>
							<button type="button" class="ml-btn ml-btn-ghost ul-preview-btn" id="ul-preview-btn">Synthesize</button>
						</div>
						<p class="ml-card-help">See exactly what your launcher would mint next, riding the currents on the right.</p>
						<div class="ul-sample" id="ul-sample" hidden>
							<div class="ul-sample-head">
								<span class="ul-sample-name" id="ul-sample-name"></span>
								<span class="ul-sample-sym" id="ul-sample-sym"></span>
							</div>
							<p class="ul-sample-desc" id="ul-sample-desc"></p>
							<div class="ul-sample-meta" id="ul-sample-meta"></div>
						</div>
						<div class="ul-sample-empty" id="ul-sample-empty">
							<p>No preview yet. Hit <strong>Synthesize</strong> to coin one from the live narratives.</p>
						</div>
					</section>
				</form>

				<!-- Right rail -->
				<div class="ml-rail">
					<section class="ml-narr" aria-label="Live narratives">
						<div class="ml-console-h">
							<h2 class="ml-card-h">Live narratives</h2>
							<span class="ml-console-meta" id="ul-narr-meta">—</span>
						</div>
						<p class="ml-narr-lead" id="ul-narr-lead" hidden></p>
						<ol class="ml-narr-list" id="ul-narr-list"></ol>
						<div class="ml-narr-empty" id="ul-narr-empty" hidden>
							<p>No live narrative yet. Enable trend sources (Know Your Meme, Coin intel…) to surface the currents your launcher would ride.</p>
						</div>
					</section>

					<section class="ml-console" aria-label="Preview console">
						<div class="ml-console-h">
							<h2 class="ml-card-h">Preview console</h2>
							<span class="ml-console-meta" id="ul-console-meta">—</span>
						</div>
						<ol class="ml-runs" id="ul-runs"></ol>
						<div class="ml-runs-empty" id="ul-runs-empty" hidden>
							<p>No previews yet. Turn your launcher <strong>On</strong> to watch it pick coins every cadence.</p>
						</div>
					</section>
				</div>
			</div>
		</div>
	</div>

	<!-- Sticky save bar -->
	<div class="ml-savebar" id="ul-savebar" hidden role="region" aria-label="Unsaved changes">
		<span class="ml-savebar-txt" id="ul-savebar-txt">Unsaved changes</span>
		<div class="ml-savebar-actions">
			<button class="ml-btn ml-btn-ghost" id="ul-discard">Discard</button>
			<button class="ml-btn ml-btn-primary" id="ul-save">Save changes</button>
		</div>
	</div>

	<!-- Go-live confirm -->
	<div class="ml-modal" id="ul-modal" hidden role="dialog" aria-modal="true" aria-labelledby="ul-modal-title">
		<div class="ml-modal-card">
			<h2 class="ml-modal-title" id="ul-modal-title">Go live?</h2>
			<p class="ml-modal-body" id="ul-modal-body"></p>
			<label class="ml-modal-confirm">
				<span>Type <strong>LIVE</strong> to confirm</span>
				<input type="text" id="ul-modal-input" class="ml-input" autocomplete="off" spellcheck="false" />
			</label>
			<div class="ml-modal-actions">
				<button class="ml-btn ml-btn-ghost" id="ul-modal-cancel">Cancel</button>
				<button class="ml-btn ml-btn-danger" id="ul-modal-go" disabled>Go live</button>
			</div>
		</div>
	</div>

	<div class="ml-toast" id="ul-toast" hidden aria-live="polite"></div>
`;

let loaded = null;
let draft = null;
let refreshTimer = null;
let built = false;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── API ──────────────────────────────────────────────────────────────────────
async function api(method, body) {
	const r = await fetch(API, {
		method,
		headers: { 'content-type': 'application/json' },
		credentials: 'same-origin',
		body: body ? JSON.stringify(body) : undefined,
	});
	if (r.status === 401) { showGate(); throw new Error('unauthorized'); }
	const j = await r.json().catch(() => null);
	if (!r.ok) throw new Error(j?.error_description || j?.error || `HTTP ${r.status}`);
	return j;
}

function safeJson(s, d) { try { return JSON.parse(s); } catch { return d; } }
function normalize(c) {
	c = c || {};
	const arr = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? safeJson(v, []) : []);
	return {
		enabled: !!c.enabled,
		dry_run: c.dry_run !== false,
		paused: !!c.paused,
		pause_reason: c.pause_reason || '',
		mode: c.mode || 'hybrid',
		sources: arr(c.sources),
		target_cadence_seconds: Number(c.target_cadence_seconds ?? 60),
		max_per_hour: Number(c.max_per_hour ?? 30),
		dev_buy_sol: Number(c.dev_buy_sol ?? 0.01),
		daily_sol_cap: Number(c.daily_sol_cap ?? 1),
		network: c.network || 'mainnet',
	};
}

// ── gate ──────────────────────────────────────────────────────────────────────
function showGate() {
	$('ul-panel').hidden = true;
	$('ul-gate').hidden = false;
	$('ul-root').setAttribute('aria-busy', 'false');
	stopRefresh();
}

// ── load + render ──────────────────────────────────────────────────────────────
async function load() {
	const state = await api('GET');
	if (Number(state.launch_overhead_sol) > 0) launchOverheadSol = Number(state.launch_overhead_sol);
	loaded = normalize(state.config);
	draft = { ...loaded };
	$('ul-gate').hidden = true;
	$('ul-panel').hidden = false;
	$('ul-root').setAttribute('aria-busy', 'false');
	buildStaticControls();
	renderForm();
	renderState(state);
	updateDirty();
	startRefresh();
	loadFunding(); // RPC-backed, so fetched once here + on explicit refresh, never per poll
}

async function refresh() {
	if (document.hidden) return;
	try {
		const state = await api('GET');
		const fresh = normalize(state.config);
		if (!isDirty()) { loaded = fresh; draft = { ...fresh }; renderForm(); updateDirty(); }
		else { loaded.paused = fresh.paused; loaded.pause_reason = fresh.pause_reason; }
		renderState(state);
	} catch { /* transient */ }
}
function startRefresh() { stopRefresh(); refreshTimer = setInterval(refresh, REFRESH_MS); }
function stopRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ── static controls (built once) ───────────────────────────────────────────────
function buildStaticControls() {
	if (built) return;
	built = true;

	$('ul-modes').innerHTML = MODES.map(
		(m) => `
		<label class="ml-mode">
			<input type="radio" name="ul-mode" value="${m.id}" />
			<span class="ml-mode-ui">
				<span class="ml-mode-name">${esc(m.name)}</span>
				<span class="ml-mode-desc">${esc(m.desc)}</span>
			</span>
		</label>`,
	).join('');
	$('ul-modes').addEventListener('change', (e) => { if (e.target.name === 'ul-mode') { draft.mode = e.target.value; onEdit(); } });

	$('ul-sources').innerHTML = SOURCES.map(
		(s) => `<button type="button" class="ml-chip" data-src="${s.id}" aria-pressed="false">${esc(s.label)}</button>`,
	).join('');
	$('ul-sources').addEventListener('click', (e) => {
		const btn = e.target.closest('.ml-chip');
		if (!btn) return;
		const set = new Set(draft.sources);
		set.has(btn.dataset.src) ? set.delete(btn.dataset.src) : set.add(btn.dataset.src);
		draft.sources = [...set];
		onEdit();
	});

	$('ul-network').addEventListener('click', (e) => {
		const btn = e.target.closest('.ml-seg-btn');
		if (!btn) return;
		draft.network = btn.dataset.net;
		onEdit();
	});

	$('ul-liveseg').addEventListener('click', (e) => {
		const btn = e.target.closest('.ml-seg-btn');
		if (!btn) return;
		draft.dry_run = btn.dataset.live !== 'live';
		onEdit();
	});

	bindNum('ul-cadence', 'target_cadence_seconds');
	bindNum('ul-maxhour', 'max_per_hour');
	bindNum('ul-devbuy', 'dev_buy_sol');
	bindNum('ul-dailycap', 'daily_sol_cap');

	$('ul-enable').addEventListener('click', () => { draft.enabled = !draft.enabled; onEdit(); });
	$('ul-config').addEventListener('submit', (e) => e.preventDefault());
	$('ul-save').addEventListener('click', save);
	$('ul-discard').addEventListener('click', () => { draft = { ...loaded }; renderForm(); updateDirty(); });
	$('ul-resume').addEventListener('click', resumeBreaker);
	$('ul-preview-btn').addEventListener('click', previewCoin);
	$('ul-fund-refresh').addEventListener('click', () => loadFunding(true));
	$('ul-fund-list').addEventListener('click', copyFundAddress);

	// Go-live modal: type LIVE to enable the confirm button.
	$('ul-modal-input').addEventListener('input', () => {
		$('ul-modal-go').disabled = $('ul-modal-input').value.trim().toUpperCase() !== 'LIVE';
	});
	$('ul-modal-cancel').addEventListener('click', closeLiveModal);
	$('ul-modal-go').addEventListener('click', async () => { closeLiveModal(); await commitSave(); });
	$('ul-modal').addEventListener('click', (e) => { if (e.target === $('ul-modal')) closeLiveModal(); });
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('ul-modal').hidden) closeLiveModal(); });

	// ⌘/Ctrl+S saves pending edits.
	document.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
			if (loaded && !$('ul-panel').hidden && isDirty()) { e.preventDefault(); save(); }
		}
	});
}

function bindNum(id, key) {
	$(id).addEventListener('input', () => {
		const n = Number($(id).value);
		if (Number.isFinite(n)) { draft[key] = n; onEdit(false); }
	});
}
function onEdit(rerender = true) { if (rerender) renderForm(); updateDirty(); renderStatusFromDraft(); }

// ── render form ────────────────────────────────────────────────────────────────
function renderForm() {
	for (const el of document.querySelectorAll('input[name="ul-mode"]')) el.checked = el.value === draft.mode;
	const set = new Set(draft.sources);
	for (const btn of document.querySelectorAll('#ul-sources .ml-chip')) {
		btn.setAttribute('aria-pressed', set.has(btn.dataset.src) ? 'true' : 'false');
	}
	$('ul-sources-card').style.opacity = draft.mode === 'trend' || draft.mode === 'hybrid' ? '1' : '0.5';
	for (const btn of document.querySelectorAll('#ul-network .ml-seg-btn')) btn.classList.toggle('active', btn.dataset.net === draft.network);
	for (const btn of document.querySelectorAll('#ul-liveseg .ml-seg-btn')) {
		const active = (btn.dataset.live === 'live') === !draft.dry_run;
		btn.classList.toggle('active', active);
		btn.setAttribute('aria-checked', active ? 'true' : 'false');
	}
	setVal('ul-cadence', draft.target_cadence_seconds);
	setVal('ul-maxhour', draft.max_per_hour);
	setVal('ul-devbuy', draft.dev_buy_sol);
	setVal('ul-dailycap', draft.daily_sol_cap);
	$('ul-cadence-hint').textContent = cadenceHint(draft.target_cadence_seconds);
	$('ul-cost-hint').textContent = `≈ ${perLaunchSol().toFixed(3)} SOL per launch, from the launching agent's wallet`;
	renderNote();
	renderFunding(); // funded pills track the current dev buy
	renderStatusFromDraft();
}

function perLaunchSol() { return launchOverheadSol + (Number(draft?.dev_buy_sol) || 0); }

// The explainer copy tracks the selected mode — static strings only, safe as HTML.
function renderNote() {
	$('ul-note-txt').innerHTML = draft.dry_run
		? '<strong>Preview mode.</strong> Your launcher rides live cultural narratives and picks coins from your own ' +
			'agents on a schedule — recording each pick — but it mints nothing and moves no SOL. Tune it, watch what ' +
			'it would launch, then flip <strong>Live</strong> when the rotation looks right.'
		: '<strong>Live mode.</strong> Your launcher mints real pump.fun coins on your cadence. Every launch is paid by ' +
			'the launching agent’s own wallet — deposit SOL below to keep it running; it skips (never fails) when a ' +
			'wallet runs dry. Your daily cap bounds total spend. Switch back to Preview anytime.';
}
function setVal(id, v) { const el = $(id); if (el && document.activeElement !== el) el.value = v; }
function cadenceHint(sec) { if (!sec) return ''; return `≈ ${Math.floor(3600 / sec).toLocaleString()} coins / hour at full tilt`; }

function renderStatusFromDraft() {
	$('ul-enable').setAttribute('aria-pressed', draft.enabled ? 'true' : 'false');
	$('ul-enable-lbl').textContent = draft.enabled ? 'On' : 'Off';

	const live = !draft.dry_run;
	const badge = $('ul-badge');
	badge.textContent = live ? 'Live' : 'Preview';
	badge.classList.toggle('is-live', live);
	badge.title = live
		? 'Live — launches spend real SOL from your agent wallets'
		: 'Preview — records picks, no SOL moves';

	const dot = $('ul-status-dot');
	dot.className = 'ml-dot';
	let line;
	if (loaded.paused) { dot.classList.add('is-paused'); line = `Paused — ${esc(loaded.pause_reason || 'too many misses')}.`; }
	else if (loaded.enabled && !loaded.dry_run) { dot.classList.add('is-armed'); line = `LIVE — minting on ${esc(loaded.mode)} mode every ${loaded.target_cadence_seconds}s, paid by your agent wallets.`; }
	else if (loaded.enabled) { dot.classList.add('is-dry'); line = `Previewing — coining on ${esc(loaded.mode)} mode every ${loaded.target_cadence_seconds}s. No SOL moves.`; }
	else { line = 'Off — idle. Turn on to watch it design your rotation.'; }
	if (isDirty()) line += '  •  Unsaved changes.';
	$('ul-status-line').textContent = line;
	$('ul-s-mode').textContent = draft.mode;
}

// ── server state ────────────────────────────────────────────────────────────────
function renderState(state) {
	const s = state.stats || {};
	// Count the live counters between real poll values; the dry-run tally tints up
	// each time the launcher records a fresh preview pick — a real cadence beat.
	updateValue($('ul-s-dry'), Number(s.dry_runs_today || 0), num);
	updateValue($('ul-s-queue'), Number(state.queue_enabled || 0), num, { flash: false });
	updateValue($('ul-s-eligible'), Number(state.eligible_agents || 0), num, { flash: false });

	const breaker = $('ul-breaker');
	if (loaded.paused) { breaker.hidden = false; $('ul-breaker-txt').textContent = `Paused: ${loaded.pause_reason || 'too many misses'}.`; }
	else breaker.hidden = true;

	renderConsole(state.console || [], state.config?.network || draft.network);
	$('ul-console-meta').textContent = `updated ${new Date().toLocaleTimeString()}`;
	renderNarratives(state.narratives);
}

// ── narratives ──────────────────────────────────────────────────────────────────
let lastNarrSig = null;
function renderNarratives(narr) {
	const terms = (narr && Array.isArray(narr.terms)) ? narr.terms : [];
	const sig = (narr?.top?.term || '') + '|' + terms.map((t) => `${t.term}:${Math.round(t.score)}`).join(',');
	if (sig === lastNarrSig) return;
	lastNarrSig = sig;

	const list = $('ul-narr-list');
	const empty = $('ul-narr-empty');
	const lead = $('ul-narr-lead');
	const meta = $('ul-narr-meta');

	if (!terms.length) {
		list.innerHTML = '';
		empty.hidden = false;
		lead.hidden = true;
		meta.textContent = (draft.mode === 'trend' || draft.mode === 'hybrid') ? 'no signal' : 'trend off';
		return;
	}
	empty.hidden = true;
	meta.textContent = `${terms.length} live · ${(narr.providers || []).length} sources`;
	if (narr.top) {
		lead.hidden = false;
		lead.innerHTML = `Riding <strong>${esc(narr.top.term)}</strong>${narr.top.kind ? ` <span class="ml-narr-kind">${esc(narr.top.kind)}</span>` : ''} next.`;
	} else lead.hidden = true;

	const max = terms[0]?.score || 1;
	list.innerHTML = terms.slice(0, 12).map((t) => {
		const pct = Math.max(6, Math.round((Number(t.score) / max) * 100));
		const srcs = Array.isArray(t.sources) ? t.sources.length : 0;
		return `
		<li class="ml-narr-row" title="${esc((t.sources || []).join(', '))}">
			<span class="ml-narr-bar" style="width:${pct}%"></span>
			<span class="ml-narr-term">${esc(t.term)}</span>
			<span class="ml-narr-tags">${t.kind ? `<span class="ml-narr-kind">${esc(t.kind)}</span>` : ''}${srcs > 1 ? `<span class="ml-narr-conf">×${srcs}</span>` : ''}</span>
		</li>`;
	}).join('');
}

// ── console (keyed/incremental — flicker-free, scroll-stable) ─────────────────────
function runRowHtml(r, network) {
	const status = String(r.status || 'pending');
	const name = r.mint
		? `<a href="${solscan(r.mint, network)}" target="_blank" rel="noopener">${esc(r.name || r.symbol || 'coin')}</a>`
		: esc(r.name || r.symbol || '—');
	const rode = topNarrative(r.trigger_detail);
	const meta = `<span class="ml-kind">${esc(r.kind || '')}</span>${rode ? ' · rode ' + esc(rode) : (r.trigger_source ? ' · ' + esc(r.trigger_source) : '')}`;
	// Skips/failures explain themselves on hover (e.g. which wallet needs a deposit).
	const why = (status === 'skipped' || status === 'failed') && r.error ? ` title="${esc(r.error)}"` : '';
	return (
		`<span class="ml-pill s-${esc(status)}"${why}>${esc(statusLabel(status))}</span>` +
		`<span class="ml-run-main">` +
			`<span class="ml-run-name">${name} <span class="ml-run-sym">${esc(r.symbol || '')}</span></span>` +
			`<span class="ml-run-meta">${meta}</span>` +
		`</span>` +
		`<span class="ml-run-r"><span class="ml-run-time">${esc(reltime(r.created_at))}</span></span>`
	);
}
function runSig(r) { return `${r.status}|${r.mint || ''}|${reltime(r.created_at)}`; }
const _rows = new Map();
function renderConsole(runs, network) {
	const list = $('ul-runs');
	const empty = $('ul-runs-empty');
	if (!runs.length) { list.replaceChildren(); _rows.clear(); empty.hidden = false; return; }
	empty.hidden = true;
	const seen = new Set();
	let prev = null;
	for (const r of runs.slice(0, 50)) {
		const id = String(r.id);
		seen.add(id);
		const sig = runSig(r);
		let entry = _rows.get(id);
		if (!entry) {
			const li = document.createElement('li');
			li.className = 'ml-run';
			li.innerHTML = runRowHtml(r, network);
			// Slide the freshly-recorded pick in via the shared primitive (replaces a
			// hand-rolled setTimeout class-toggle; animationend-driven, reduced-motion-safe).
			enterRow(li);
			entry = { el: li, sig };
			_rows.set(id, entry);
		} else if (entry.sig !== sig) {
			entry.el.innerHTML = runRowHtml(r, network);
			entry.sig = sig;
		}
		const ref = prev ? prev.nextSibling : list.firstChild;
		if (entry.el !== ref) list.insertBefore(entry.el, ref);
		prev = entry.el;
	}
	for (const [id, entry] of _rows) { if (!seen.has(id)) { entry.el.remove(); _rows.delete(id); } }
}

// ── preview a coin ──────────────────────────────────────────────────────────────
async function previewCoin() {
	const btn = $('ul-preview-btn');
	btn.disabled = true;
	btn.textContent = 'Synthesizing…';
	try {
		const r = await api('POST', { action: 'preview', mode: draft.mode });
		const s = r.sample;
		$('ul-sample-empty').hidden = true;
		$('ul-sample').hidden = false;
		$('ul-sample-name').textContent = s.name || 'Untitled';
		$('ul-sample-sym').textContent = s.symbol ? `$${s.symbol}` : '';
		$('ul-sample-desc').textContent = s.description || '';
		const bits = [];
		if (s.kind) bits.push(`<span class="ml-narr-kind">${esc(s.kind)}</span>`);
		if (s.top_narrative) bits.push(`rode <strong>${esc(s.top_narrative)}</strong>`);
		else if (s.trigger_source) bits.push(esc(s.trigger_source));
		$('ul-sample-meta').innerHTML = bits.join(' · ');
	} catch (err) {
		if (err.message !== 'unauthorized') toast(err.message, true);
	} finally {
		btn.disabled = false;
		btn.textContent = 'Synthesize';
	}
}

// ── agent-wallet funding (self-funded live launches) ───────────────────────────
let fundAgents = null; // last {id,name,address,sol}[] from {action:'funding'}
let fundLoading = false;

async function loadFunding(manual = false) {
	if (fundLoading) return;
	fundLoading = true;
	const btn = $('ul-fund-refresh');
	btn.disabled = true;
	btn.textContent = 'Refreshing…';
	try {
		const r = await api('POST', { action: 'funding' });
		fundAgents = Array.isArray(r.agents) ? r.agents : [];
		renderFunding();
	} catch (err) {
		if (err.message !== 'unauthorized' && manual) toast(err.message, true);
	} finally {
		fundLoading = false;
		btn.disabled = false;
		btn.textContent = 'Refresh';
	}
}

function renderFunding() {
	if (fundAgents == null) return; // not fetched yet — skeleton state stays
	const list = $('ul-fund-list');
	const empty = $('ul-fund-empty');
	const note = $('ul-fund-note');
	if (!fundAgents.length) {
		list.innerHTML = '';
		note.hidden = true;
		empty.hidden = false;
		return;
	}
	empty.hidden = true;
	const need = perLaunchSol();
	list.innerHTML = fundAgents.map((a) => {
		const funded = a.sol != null && a.sol >= need;
		const bal = a.sol == null ? '—' : `${Number(a.sol).toFixed(3)} SOL`;
		return `
		<li class="ul-fund-row${funded ? ' is-funded' : ''}">
			<span class="ul-fund-name">${esc(a.name || 'agent')}</span>
			<code class="ul-fund-addr" title="${esc(a.address)}">${esc(shortAddr(a.address))}</code>
			<button type="button" class="ml-btn ml-btn-ghost ul-fund-copy" data-addr="${esc(a.address)}" aria-label="Copy ${esc(a.name || 'agent')} wallet address">Copy</button>
			<span class="ul-fund-bal">${esc(bal)}</span>
			<span class="ml-pill ${funded ? 's-confirmed' : 's-skipped'}">${funded ? 'funded' : 'needs SOL'}</span>
		</li>`;
	}).join('');
	const fundedCount = fundAgents.filter((a) => a.sol != null && a.sol >= need).length;
	note.hidden = false;
	note.textContent = fundedCount
		? `${fundedCount} of ${fundAgents.length} wallet${fundAgents.length === 1 ? '' : 's'} can cover the next launch (≈ ${need.toFixed(3)} SOL).`
		: `No wallet covers a launch yet — deposit ≈ ${need.toFixed(3)} SOL to any address above.`;
}

async function copyFundAddress(e) {
	const btn = e.target.closest('.ul-fund-copy');
	if (!btn) return;
	try {
		await navigator.clipboard.writeText(btn.dataset.addr);
		toast('Address copied — send SOL to fund this agent');
	} catch {
		toast('Copy failed — long-press the address to copy it', true);
	}
}

function shortAddr(a) { a = String(a || ''); return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a; }

// ── dirty + save ───────────────────────────────────────────────────────────────
function pickEditable(o) { const r = {}; for (const k of EDITABLE) r[k] = o[k]; r.sources = [...(o.sources || [])].sort(); return r; }
function isDirty() { return JSON.stringify(pickEditable(draft)) !== JSON.stringify(pickEditable(loaded)); }
function updateDirty() { $('ul-savebar').hidden = !isDirty(); }

// Saving a preview→live transition detours through the typed confirm modal;
// everything else commits directly.
async function save() {
	if (!draft.dry_run && loaded.dry_run) return openLiveModal();
	return commitSave();
}

async function commitSave() {
	const payload = {};
	for (const k of EDITABLE) payload[k] = draft[k];
	$('ul-save').disabled = true;
	try {
		const resp = await api('POST', payload);
		loaded = normalize(resp.config);
		draft = { ...loaded };
		renderForm();
		updateDirty();
		toast(!loaded.enabled ? 'Saved' : loaded.dry_run ? 'Saved — launcher is previewing' : 'Saved — launcher is LIVE');
		refresh();
	} catch (err) {
		if (err.message !== 'unauthorized') toast(err.message, true);
	} finally {
		$('ul-save').disabled = false;
	}
}

function openLiveModal() {
	const perHour = Math.floor(3600 / Math.max(60, draft.target_cadence_seconds));
	const rate = Math.min(perHour, draft.max_per_hour || perHour);
	$('ul-modal-body').textContent =
		`Your launcher will mint real pump.fun coins on ${draft.network} — up to ${rate}/hour at your cadence, ` +
		`≈ ${perLaunchSol().toFixed(3)} SOL each from your own agent wallets, capped at ${draft.daily_sol_cap} SOL per day. ` +
		'It only spends SOL you deposit; an unfunded wallet pauses launches, it never fails them.';
	$('ul-modal-input').value = '';
	$('ul-modal-go').disabled = true;
	$('ul-modal').hidden = false;
	$('ul-modal-input').focus();
}
function closeLiveModal() { $('ul-modal').hidden = true; }
async function resumeBreaker() {
	try { await api('POST', { action: 'resume' }); toast('Resumed'); refresh(); }
	catch (err) { if (err.message !== 'unauthorized') toast(err.message, true); }
}

// ── toast ──────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, isErr) {
	const t = $('ul-toast');
	t.textContent = msg;
	t.classList.toggle('is-err', !!isErr);
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ── formatters ─────────────────────────────────────────────────────────────────
function num(n) { return Number(n || 0).toLocaleString(); }
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function statusLabel(s) { return { dry_run: 'preview', confirmed: 'live', launched: 'live' }[s] || s; }
function topNarrative(detail) {
	let d = detail;
	if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return ''; } }
	const t = d && typeof d === 'object' ? d.top_narrative : '';
	return t ? trunc(String(t), 28) : '';
}
function solscan(mint, network) { return `https://solscan.io/token/${encodeURIComponent(mint)}${network === 'devnet' ? '?cluster=devnet' : ''}`; }
function reltime(iso) {
	if (!iso) return '';
	const d = (Date.now() - new Date(iso).getTime()) / 1000;
	if (d < 60) return `${Math.max(0, Math.floor(d))}s`;
	if (d < 3600) return `${Math.floor(d / 60)}m`;
	if (d < 86400) return `${Math.floor(d / 3600)}h`;
	return `${Math.floor(d / 86400)}d`;
}

// ── boot ───────────────────────────────────────────────────────────────────────
// Called by the page module after LAUNCHER_MARKUP is in the DOM.
export async function initLauncher() {
	try { await load(); } catch (err) { if (err.message !== 'unauthorized') showGate(); }
}
