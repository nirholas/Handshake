// Live Trading Theater — controller.
//
// Stages the platform's highest-reputation agents as real 3D avatars and makes
// trading a spectator sport: when a REAL on-chain event lands on the live feed,
// the matching avatar performs and a real receipt rises with an explorer link.
// Click any avatar for its read-only wallet/reputation HUD; watch, follow, or
// fork it from there. Three themed rooms re-cohort the stage around real filters.
//
// Every number here traces to a real endpoint:
//   roster   → GET /api/reputation/leaderboard  ·  GET /api/agents/public
//   bodies   → GET /api/agents/:id (avatar_model_url, mannequin fallback)
//   trust    → GET /api/agents/reputation-batch
//   balances → fetchWalletBalances() (live SOL/USDC/$THREE)
//   events   → GET /api/feed (snapshot) + GET /api/feed-stream (SSE)

import { createStage } from './theater-stage.js';
import { connectFeed, loadSnapshot } from './theater-feed.js';
import { fetchWalletBalances } from './shared/agent-wallet-identity.js';
import { log } from './shared/log.js';
import './ui-juice.css';
import { enterRow } from './ui-juice.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const ROSTER_TIMEOUT_MS = 8000;
// A slow-but-alive edge must still produce the stage. The first attempt fails
// fast so a genuinely dead endpoint reaches the error card quickly; the retry
// gives a congested one the room it needs before we call the stage broken.
const ROSTER_RETRY_TIMEOUT_MS = 20000;
const WATCH_KEY = 'theater:watch:v1';
const SOUND_KEY = 'theater:sound:v1';

// -- i18n ownership -----------------------------------------------------------
// The status pill, the quiet-market heartbeat and the sound button's aria-label
// all ship with a data-i18n key (so the pre-render copy is translated) but hold
// live state the moment this script runs. The catalog pass lands after the async
// /api/locale fetch, which is routinely AFTER the feed has already connected, so
// without an opt-out it reverted the pill to "Connecting" for the rest of the
// session and told a screen reader the sound was off while it was on.
// `data-i18n-owned="1"` is this codebase's documented opt-out; releasing an
// element hands it back so a locale switch still localizes the declared copy.
const i18nDefaults = new WeakMap();
function claimI18nText(el, text) {
	if (!el) return;
	if (!i18nDefaults.has(el)) i18nDefaults.set(el, el.textContent);
	el.setAttribute('data-i18n-owned', '1');
	el.textContent = text;
}
function releaseI18nText(el) {
	if (!el) return;
	el.removeAttribute('data-i18n-owned');
	const key = el.getAttribute('data-i18n');
	const translated = key ? window.threewsI18n?.t?.(key) : '';
	const restored = translated && translated !== key ? translated : i18nDefaults.get(el);
	if (restored != null) el.textContent = restored;
}
// Translated copy for a key that exists in the catalog, falling back to the
// English source when the catalog has not landed (or has no such key).
const tr = (key, fallback) => {
	const v = window.threewsI18n?.t?.(key);
	return v && v !== key ? v : fallback;
};

// Fill magnitude (0..1) from a real event's numeric size — drives centerpiece
// scale and stinger loudness so a whale buy lands harder than a dust trade.
function fillMagnitude(n) {
	if (Number.isFinite(n?.sol)) return Math.max(0.25, Math.min(1, n.sol / 3)); // ~3 SOL reads as full
	if (Number.isFinite(n?.usd)) return Math.max(0.25, Math.min(1, n.usd / 500)); // ~$500 reads as full
	return 0.4;
}

// A tasteful, opt-in WebAudio stinger for marquee fills. No asset — a short
// synthesized two-note arpeggio, envelope-shaped so it never grates. Off by
// default (a surprise sound is bad UX); the AudioContext is created lazily on a
// user gesture so it complies with autoplay policy.
function createStinger() {
	let ctx = null;
	let enabled = false;
	try { enabled = localStorage.getItem(SOUND_KEY) === 'on'; } catch {}
	const ensureCtx = () => {
		if (ctx) return ctx;
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		try { ctx = new AC(); } catch { ctx = null; }
		return ctx;
	};
	function ding(kind = 'buy', magnitude = 0.4) {
		if (!enabled) return;
		const ac = ensureCtx();
		if (!ac) return;
		if (ac.state === 'suspended') ac.resume().catch(() => {});
		const t0 = ac.currentTime;
		const notes = kind === 'loss' ? [329.63, 246.94] : [659.25, 987.77]; // fall on loss, rise otherwise
		const peak = 0.03 + Math.min(0.05, magnitude * 0.05);
		for (let i = 0; i < notes.length; i++) {
			const osc = ac.createOscillator();
			const g = ac.createGain();
			osc.type = 'triangle';
			osc.frequency.value = notes[i];
			const start = t0 + i * 0.07;
			g.gain.setValueAtTime(0.0001, start);
			g.gain.linearRampToValueAtTime(peak, start + 0.012);
			g.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
			osc.connect(g).connect(ac.destination);
			osc.start(start);
			osc.stop(start + 0.32);
		}
	}
	function toggle() {
		enabled = !enabled;
		try { localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); } catch {}
		if (enabled) { ensureCtx()?.resume?.().catch(() => {}); ding('buy', 0.5); } // confirmation blip
		return enabled;
	}
	return { ding, toggle, get enabled() { return enabled; } };
}

// Stage budget — keep the cast lively but 60fps. Tighter on small screens.
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
const rosterBudget = () => (isMobile() ? 6 : 14);

const ROOMS = [
	{ id: 'top', label: 'Top performers', hint: 'Ranked by the non-gameable wallet-trust score', centerpiece: false, featured: new Set(['buy', 'launch', 'verify', 'pay', 'win']) },
	{ id: 'launches', label: 'New launches', hint: 'Freshest agents going on-chain right now', centerpiece: true, featured: new Set(['launch', 'verify', 'buy']) },
	{ id: 'three', label: '$THREE stage', hint: 'The one coin — buys of $THREE take center stage', centerpiece: true, featured: new Set(['buy', 'pay']) },
];

// ── tiny DOM helper ──────────────────────────────────────────────────────────
function el(tag, attrs = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') n.className = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k === 'text') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
		else if (k === 'dataset') Object.assign(n.dataset, v);
		else n.setAttribute(k, v);
	}
	for (const c of [].concat(kids)) { if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); }
	return n;
}
const fmtScore = (s) => (Number.isFinite(s) ? Math.round(s) : '—');
const fmtUsd = (v) => (Number.isFinite(v) ? `$${v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2)}` : '—');
const timeAgo = (ts) => {
	const s = Math.max(0, (Date.now() - ts) / 1000);
	if (s < 60) return `${Math.floor(s)}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
};

// ── auth probe (real, cached) ─────────────────────────────────────────────────
let _me;
async function whoami() {
	if (_me !== undefined) return _me;
	try {
		const r = await fetch('/api/auth/me', { credentials: 'include' });
		_me = r.ok ? await r.json().catch(() => null) : null;
	} catch { _me = null; }
	return _me;
}

// ── copy-trade (mirror) plumbing ────────────────────────────────────────────────
// Wires the theater to the real custodial mirror system: one of the caller's own
// agents (the follower) copies the staged agent's (the leader's) confirmed trades,
// server-signed and sized/capped by the follower's own spend policy.
// POST /api/agents/:follower/mirror { leader_agent_id, sizing_mode:'fixed', fixed_sol }.

// A fresh single-use CSRF token for a state-changing POST.
async function csrfToken() {
	try {
		const r = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!r.ok) return null;
		const j = await r.json().catch(() => null);
		return j?.data?.token || j?.token || null;
	} catch { return null; }
}

// The caller's own agents that can act as a follower — they need a custodial
// Solana wallet to trade. Cached for the session.
let _myAgents;
async function mirrorableAgents() {
	if (_myAgents !== undefined) return _myAgents;
	try {
		const r = await fetch('/api/agents', { credentials: 'include', headers: { accept: 'application/json' } });
		const list = r.ok ? (await r.json().catch(() => null))?.agents || [] : [];
		_myAgents = list.filter((a) => a.solana_address).map((a) => ({ id: a.id, name: a.name || 'Agent' }));
	} catch { _myAgents = []; }
	return _myAgents;
}

async function createMirror({ follower, leader, sizeSol }) {
	const token = await csrfToken();
	const r = await fetch(`/api/agents/${encodeURIComponent(follower)}/mirror`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) },
		body: JSON.stringify({ leader_agent_id: leader, network: 'mainnet', enabled: true, sizing_mode: 'fixed', fixed_sol: sizeSol }),
	});
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(d.error_description || d.message || d.error || `mirror failed (${r.status})`);
	return d.data?.follow || d;
}

// Inline "copy this trader" affordance for the read-only HUD: a signed-in visitor
// picks one of their agents + a per-trade SOL size and starts a real mirror.
function buildMirror(leaderId, leaderName) {
	const wrap = el('div', { class: 'th-mirror' });

	function collapsed() {
		wrap.replaceChildren(
			el('button', { class: 'th-btn th-btn-primary th-mirror-start', onClick: openForm, text: '⧉ Copy this trader' }),
			el('p', { class: 'th-mirror-hint th-muted', text: 'Your agent buys what this one buys — sized and capped by your own limits.' }),
		);
	}

	async function openForm() {
		wrap.replaceChildren(el('p', { class: 'th-mirror-hint th-muted', text: 'Loading your agents…' }));
		const mine = await mirrorableAgents();
		if (!mine.length) {
			wrap.replaceChildren(el('p', { class: 'th-panel-foot th-muted' }, [
				'Copying a trader needs one of your own agents with a wallet. ',
				el('a', { href: '/agent/new', text: 'Create one →' }),
			]));
			return;
		}
		const select = el('select', { class: 'th-mirror-select', 'aria-label': 'Your agent to mirror with' },
			mine.map((a) => el('option', { value: a.id, text: a.name })));
		const size = el('input', { class: 'th-mirror-size', type: 'number', min: '0.001', step: '0.01', value: '0.05', 'aria-label': 'SOL per copied trade' });
		const submit = el('button', { class: 'th-btn th-btn-primary', text: 'Start mirroring' });
		const err = el('p', { class: 'th-mirror-msg th-mirror-err', role: 'status' });
		submit.addEventListener('click', async () => {
			const follower = select.value;
			const sizeSol = Math.max(0.001, Number(size.value) || 0.05);
			submit.disabled = true; submit.textContent = 'Starting…'; err.textContent = '';
			try {
				await createMirror({ follower, leader: leaderId, sizeSol });
				const name = mine.find((a) => a.id === follower)?.name || 'Your agent';
				wrap.replaceChildren(el('p', { class: 'th-mirror-ok' }, [
					`✓ ${name} now copies ${leaderName || 'this trader'}. `,
					el('a', { href: `/agents/${follower}`, text: 'Manage mirror →' }),
				]));
			} catch (e) {
				submit.disabled = false; submit.textContent = 'Start mirroring';
				err.textContent = e?.message || 'Could not start mirroring.';
			}
		});
		wrap.replaceChildren(el('div', { class: 'th-mirror-form' }, [
			el('label', { class: 'th-mirror-field' }, ['Mirror with', select]),
			el('label', { class: 'th-mirror-field' }, ['SOL per trade', size]),
			el('div', { class: 'th-mirror-actions' }, [submit, el('button', { class: 'th-btn', text: 'Cancel', onClick: collapsed })]),
			err,
		]));
	}

	collapsed();
	return wrap;
}

// ── data layer ────────────────────────────────────────────────────────────────
// Every roster/detail fetch is time-bounded so a slow or black-holed edge can
// never wedge the room behind an infinite "Assembling the cast…" spinner. On
// timeout the AbortController rejects, loadRoom catches it and shows the
// designed error state (with a Try-again button) instead of hanging forever.
async function fetchJson(url, { timeout = 8000, ...opts } = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeout);
	try {
		const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { accept: 'application/json', ...(opts.headers || {}) } });
		if (!r.ok) throw new Error(`${new URL(url, location.href).pathname} ${r.status}`);
		return await r.json();
	} finally {
		clearTimeout(timer);
	}
}

async function fetchLeaderboard(limit, timeout = ROSTER_TIMEOUT_MS) {
	const body = await fetchJson(`/api/reputation/leaderboard?limit=${limit}`, { timeout });
	return (body.agents || []).map((a) => ({
		id: a.id, name: a.name || 'Agent', solana_address: a.solana_address || null,
		score: a.score, tier: a.tier, tierLabel: a.tier_label, totals: a.totals || {},
		avatar_thumbnail: a.avatar_thumbnail_url || null,
	}));
}
async function fetchNewLaunches(limit, timeout = ROSTER_TIMEOUT_MS) {
	const body = await fetchJson(`/api/agents/public?sort=newest&limit=${limit}`, { timeout });
	return (body.agents || []).map((a) => ({
		id: a.id, name: a.name || 'Agent', solana_address: null,
		score: null, tier: null, tierLabel: null, totals: {},
		avatar_thumbnail: a.avatar_thumbnail || null,
	}));
}

// Resolve a staged agent's real 3D body + ownership from the public agent GET.
// Falls back cleanly (mannequin via agentAvatarGlb) if the detail is unavailable.
async function resolveBody(agent) {
	try {
		// Short timeout: one slow agent-detail GET must not stall the whole reveal,
		// since these run before the stage is shown. On abort we keep the mannequin.
		const d = await fetchJson(`/api/agents/${encodeURIComponent(agent.id)}`, { credentials: 'include', timeout: 5000 });
		const a = d?.agent || d || {};
		agent.avatar_model_url = a.avatar_model_url || a.avatar_glb_url || a.glb_url || null;
		agent.is_owner = !!a.is_owner;
		if (!agent.solana_address) agent.solana_address = a.solana_address || null;
	} catch { /* mannequin fallback handles it */ }
	return agent;
}

async function fetchReputationBatch(ids) {
	if (!ids.length) return {};
	try {
		const body = await fetchJson(`/api/agents/reputation-batch?ids=${ids.map(encodeURIComponent).join(',')}`, { timeout: 6000 });
		return body.data || {};
	} catch { return {}; }
}

// pooled map with bounded concurrency
async function pool(items, n, fn) {
	const out = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(n, items.length || 1) }, async () => {
		while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
	});
	await Promise.all(workers);
	return out;
}

// ── main ──────────────────────────────────────────────────────────────────────
export function initTheater(root) {
	const refs = {
		canvas: root.querySelector('#th-canvas'),
		overlay: root.querySelector('#th-overlay'),
		stageWrap: root.querySelector('#th-stage'),
		rooms: root.querySelector('#th-rooms'),
		status: root.querySelector('#th-status'),
		sound: root.querySelector('#th-sound'),
		ticker: root.querySelector('#th-ticker'),
		replay: root.querySelector('#th-replay'),
		panel: root.querySelector('#th-panel'),
		quiet: root.querySelector('#th-quiet'),
		loading: root.querySelector('#th-loading'),
		error: root.querySelector('#th-error'),
		empty: root.querySelector('#th-empty'),
		hint: root.querySelector('#th-room-hint'),
	};

	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	// Optional dealing-room backdrop GLB: `?env=<url>` or data-env on #th-root, so a
	// supplied environment (e.g. a Sketchfab office) drops in with no code change.
	// Same-origin or a full URL the CDN allows; the desks are always rendered by us.
	const envUrl = new URLSearchParams(location.search).get('env') || root.dataset.env || null;
	const stage = createStage({
		canvas: refs.canvas,
		overlay: refs.overlay,
		reducedMotion: reduced,
		environmentUrl: envUrl,
		onSelect: (id) => openPanel(id),
	});

	// Opt-in audio stinger on marquee fills, toggled from the top bar and
	// remembered per browser. Default off — a page that greets you with sound is
	// hostile; the toggle is a discoverable invitation, not a surprise.
	const stinger = createStinger();
	if (refs.sound) {
		const paintSound = () => {
			const on = stinger.enabled;
			refs.sound.setAttribute('aria-pressed', on ? 'true' : 'false');
			// "Sound off" is the button's declared copy; while sound is ON the label is
			// live state and the catalog pass must not revert it to the wrong one.
			if (on) {
				refs.sound.setAttribute('data-i18n-owned', '1');
				refs.sound.setAttribute('aria-label', 'Sound on');
				refs.sound.setAttribute('title', tr('theater.toggle_fill_sounds_title', 'Toggle fill sounds'));
			} else {
				refs.sound.removeAttribute('data-i18n-owned');
				refs.sound.setAttribute('aria-label', tr('theater.sound_off_arialabel', 'Sound off'));
			}
			refs.sound.classList.toggle('is-on', on);
			refs.sound.querySelector('.th-sound-icon').textContent = on ? '🔊' : '🔇';
		};
		refs.sound.addEventListener('click', () => { stinger.toggle(); paintSound(); });
		paintSound();
	}

	const ro = new ResizeObserver(() => stage.resize());
	ro.observe(refs.stageWrap);
	window.addEventListener('resize', () => stage.resize());

	const state = {
		room: ROOMS[0],
		roster: [],
		byId: new Map(),
		reputation: {},
		balances: {},
		watch: new Set(loadWatch()),
		sessionEvents: [], // featured events captured this session (for replay)
		liveCount: 0,
		lastMoveTs: null, // ts of the newest real event seen (drives the quiet heartbeat)
		selected: null,
		loadSeq: 0, // guards against a superseded roster load painting the wrong room
		seenIds: new Set(), // the tape is seeded from the snapshot, so dedupe by event id
	};

	// ── rooms ──────────────────────────────────────────────────────────────────
	renderRooms();
	function renderRooms() {
		refs.rooms.replaceChildren(
			...ROOMS.map((rm) =>
				el('button', {
					class: `th-room${rm.id === state.room.id ? ' is-active' : ''}`,
					role: 'tab',
					'aria-selected': rm.id === state.room.id ? 'true' : 'false',
					onClick: () => switchRoom(rm),
				}, rm.label),
			),
		);
		refs.hint.textContent = state.room.hint;
	}

	async function switchRoom(rm) {
		if (rm.id === state.room.id) return;
		state.room = rm;
		renderRooms();
		await loadRoom();
	}

	// ── status pill ─────────────────────────────────────────────────────────────
	// "Connecting" is the element's own declared copy, so the catalog owns it and a
	// non-English visitor gets it translated. Every other state is live data this
	// script owns, or the catalog pass would revert the pill to "Connecting" and
	// leave it claiming a connection that opened long ago.
	function setStatus(s) {
		const map = {
			connecting: [null, 'th-dot-amber'],
			live: ['Live', 'th-dot-green'],
			reconnecting: ['Reconnecting…', 'th-dot-amber'],
			offline: ['Offline', 'th-dot-red'],
		};
		const [label, dot] = map[s] || map.offline;
		refs.status.className = `th-status ${dot}`;
		const node = refs.status.querySelector('.th-status-label');
		if (label === null) releaseI18nText(node);
		else claimI18nText(node, label);
	}

	// ── roster load ──────────────────────────────────────────────────────────────
	const fetchRoster = (limit, timeout) =>
		(state.room.id === 'launches' ? fetchNewLaunches(limit, timeout) : fetchLeaderboard(limit, timeout));

	// A congested edge answering just past the first budget used to land the whole
	// room on the error card even though the endpoint was healthy. Try once more
	// with a longer budget, and say so, before declaring the stage broken.
	async function loadRosterRows(limit) {
		try {
			return await fetchRoster(limit, ROSTER_TIMEOUT_MS);
		} catch (e) {
			if (e?.name !== 'AbortError') throw e;
			claimI18nText(refs.loading.querySelector('p'), 'Still assembling the cast…');
			return await fetchRoster(limit, ROSTER_RETRY_TIMEOUT_MS);
		}
	}

	async function loadRoom() {
		// A room switch (or a Try-again) while a slow load is in flight must not let
		// the superseded response paint over the room the viewer actually chose.
		const seq = ++state.loadSeq;
		const stale = () => seq !== state.loadSeq;
		showState('loading');
		try {
			const limit = rosterBudget();
			const rows = await loadRosterRows(limit);
			if (stale()) return;

			// Empty roster is a designed state, not a bare stage: tell the viewer why
			// the room is empty and what to do, instead of showing an unlit void.
			if (!rows.length) {
				state.roster = [];
				state.byId = new Map();
				stage.setRoster([]).catch(() => {});
				showState('empty');
				return;
			}

			await pool(rows, 5, resolveBody);
			if (stale()) return;
			state.roster = rows;
			state.byId = new Map(rows.map((a) => [a.id, a]));

			// Reveal the stage as soon as we have the roster — the 3D bodies (heavy
			// rigged avatars) stream in desk by desk rather than blocking the room
			// behind a 30s "assembling" wait.
			showState('stage');
			maybeShowQuiet();
			stage.setRoster(rows).catch((e) => log.warn('[theater] setRoster', e?.message));

			// $THREE room: drop the coin centerpiece immediately as the room's anchor.
			if (state.room.id === 'three') stage.spawnCenterpiece({ tint: 0x8b5cf6 });

			// Enrich with batch reputation (fills New-launches scores; refreshes others).
			fetchReputationBatch(rows.map((a) => a.id)).then((rep) => { state.reputation = rep; if (state.selected) renderPanel(state.selected); });

			// Re-apply any watched highlight that belongs to this room.
			for (const id of state.watch) if (state.byId.has(id)) stage.highlight(id);
		} catch (err) {
			if (stale()) return;
			log.warn('[theater] room load failed', err?.message);
			showState('error');
		}
	}

	// loading & error are mutually-exclusive center cards over the live canvas.
	// The quiet-market card is independent: it rides at the foot of the stage and
	// only shows while no live event has arrived (the cast still stands on stage).
	function showState(which) {
		// The retry re-labels the loading card; hand it back to the catalog whenever
		// a fresh load starts so a second attempt does not inherit the first's copy.
		if (which === 'loading') releaseI18nText(refs.loading.querySelector('p'));
		refs.loading.hidden = which !== 'loading';
		refs.error.hidden = which !== 'error';
		if (refs.empty) refs.empty.hidden = which !== 'empty';
		if (which !== 'stage') refs.quiet.hidden = true;
	}
	function maybeShowQuiet() {
		refs.quiet.hidden = !(state.liveCount === 0 && refs.loading.hidden && refs.error.hidden);
	}

	for (const card of [refs.error, refs.empty]) card?.querySelector('[data-retry]')?.addEventListener('click', loadRoom);

	// ── live feed routing ────────────────────────────────────────────────────────
	const feed = connectFeed({
		onStatus: setStatus,
		onEvent: (n) => routeEvent(n),
	});

	function routeEvent(n) {
		// A stream reconnect can replay events the tape already carries. Those are
		// history, not a fresh fill, so they must not perform on stage again.
		if (!pushTicker(n)) return;

		// Safety refusals play as an at-desk "wave it off" on the actor's monitor
		// (amber flash) — the guardrail made visible — but never a celebration.
		if (n.kind === 'guard') {
			const gid = n.agentId && stage.hasPerformer(n.agentId) ? n.agentId : matchByActor(n.actor);
			if (gid) stage.perform(gid, { kind: 'guard' });
			return;
		}

		const featured = state.room.featured.has(n.kind);
		// $THREE room only celebrates $THREE buys; other rooms celebrate any buy.
		const threeOnly = state.room.id === 'three';
		const isThree = n.mint && n.mint === THREE_MINT;
		if (!featured) return;
		if (threeOnly && n.kind === 'buy' && !isThree) return;

		const mag = fillMagnitude(n);
		const marquee = (n.kind === 'buy' || n.kind === 'launch') && (state.room.centerpiece || isThree);
		if (marquee) {
			stage.spawnCenterpiece({ tint: isThree ? 0x8b5cf6 : 0x4ade80, magnitude: mag });
			stage.punchCamera();
		}
		// A stinger on the marquee fills and any win (opt-in; no-op when muted).
		if (marquee || n.kind === 'win') stinger.ding(n.kind, mag);

		// Attribute to a staged performer when the event names one; otherwise the
		// receipt rises center-stage (still a real event, just no avatar to own it).
		const performerId = n.agentId && stage.hasPerformer(n.agentId) ? n.agentId : matchByActor(n.actor);
		stage.perform(performerId, { kind: n.kind, receipt: buildReceipt(n) });

		// Capture featured events for replay.
		state.sessionEvents.unshift({ ...n, performerId });
		if (state.sessionEvents.length > 24) state.sessionEvents.pop();
		renderReplay();
	}

	function matchByActor(actor) {
		if (!actor) return null;
		const a = actor.toLowerCase();
		for (const ag of state.roster) if (ag.name && ag.name.toLowerCase() === a && stage.hasPerformer(ag.id)) return ag.id;
		return null;
	}

	function buildReceipt(n) {
		const tone = n.kind === 'loss' ? 'th-rec-loss' : n.kind === 'buy' || n.kind === 'win' ? 'th-rec-win' : 'th-rec-neutral';
		const node = el('div', { class: `th-receipt ${tone}` }, [
			el('span', { class: 'th-rec-title', text: n.title }),
			n.sub ? el('span', { class: 'th-rec-sub', text: n.sub }) : null,
			n.symbol ? el('span', { class: 'th-rec-coin', text: `$${n.symbol}` }) : null,
			n.href ? el('a', { class: 'th-rec-link', href: n.href, target: '_blank', rel: 'noopener', text: 'View ↗' }) : null,
		]);
		return node;
	}

	// ── ticker ───────────────────────────────────────────────────────────────────
	// The rail is seeded with the real recent snapshot so the Live tape is never a
	// blank column on a quiet market, then live events land on top. Seeded rows are
	// history: they neither animate in, dismiss the quiet card, nor count as the
	// stage lighting up. Dedupe by feed id so a snapshot event that also arrives on
	// the stream is not listed twice.
	// Returns false when the event was already on the tape, so a duplicate never
	// re-triggers the on-stage spectacle for a fill the viewer already watched.
	function pushTicker(n, { live = true } = {}) {
		if (n.id) {
			if (state.seenIds.has(n.id)) return false;
			state.seenIds.add(n.id);
			// bounded: the tape keeps 40 rows, the id set only has to outlive them
			if (state.seenIds.size > 500) state.seenIds.delete(state.seenIds.values().next().value);
		}
		if (live) {
			state.liveCount++;
			state.lastMoveTs = n.ts;
		}
		refs.ticker.querySelectorAll('.th-tick-empty, .th-tick-skel').forEach((r) => r.remove());
		const external = n.href ? /^https?:/i.test(n.href) : false;
		const row = el('li', { class: `th-tick th-tick-${n.kind}` }, [
			el('span', { class: 'th-tick-dot' }),
			el('div', { class: 'th-tick-body' }, [
				el('span', { class: 'th-tick-title', text: n.title }),
				n.sub ? el('span', { class: 'th-tick-sub', text: n.sub }) : null,
			]),
			n.href
				? el('a', {
					class: 'th-tick-link',
					href: n.href,
					target: external ? '_blank' : null,
					rel: external ? 'noopener' : null,
					'aria-label': external ? `Open ${n.title} in the explorer` : `Open ${n.title}`,
					text: '↗',
				})
				: null,
			el('time', { class: 'th-tick-time', text: timeAgo(n.ts), datetime: new Date(n.ts).toISOString() }),
		]);
		if (live) {
			refs.ticker.prepend(row);
			enterRow(row); // slide the freshly-landed live event in (reduced-motion safe)
		} else {
			refs.ticker.append(row); // snapshot arrives newest-first, so append keeps that order
		}
		while (refs.ticker.children.length > 40) refs.ticker.lastElementChild.remove();
		// a real event arrived → dismiss the quiet state
		if (live && !refs.quiet.hidden) refs.quiet.hidden = true;
		return true;
	}

	// The tape's loading state: three skeleton rows so the rail reads as "filling"
	// rather than "empty" while the snapshot is in flight. aria-hidden because the
	// rail is a live region and a skeleton has nothing to announce.
	function renderTickerLoading() {
		refs.ticker.replaceChildren(
			...Array.from({ length: 3 }, () =>
				el('li', { class: 'th-tick th-tick-skel', 'aria-hidden': 'true' }, [
					el('span', { class: 'th-tick-dot' }),
					el('div', { class: 'th-tick-body' }, [
						el('span', { class: 'th-skel-inline th-skel-title' }),
						el('span', { class: 'th-skel-inline th-skel-sub' }),
					]),
				]),
			),
		);
	}

	// The tape's designed empty state: a feed with nothing recent still has to say
	// what the viewer is waiting for, not render an empty column.
	function renderTickerEmpty() {
		refs.ticker.querySelectorAll('.th-tick-skel').forEach((r) => r.remove());
		if (refs.ticker.children.length) return;
		refs.ticker.replaceChildren(el('li', { class: 'th-tick-empty th-muted' }, [
			'Nothing on the tape yet. Every confirmed buy, launch and payment lands here the moment it clears.',
		]));
	}

	// ── replay ────────────────────────────────────────────────────────────────────
	function renderReplay() {
		const evts = state.sessionEvents;
		refs.replay.querySelector('[data-empty]')?.toggleAttribute('hidden', evts.length > 0);
		const rail = refs.replay.querySelector('[data-rail]');
		rail.replaceChildren(
			...evts.map((e) =>
				el('button', {
					class: `th-replay-mark th-tick-${e.kind}`,
					title: `${e.title}${e.sub ? ' · ' + e.sub : ''} · ${timeAgo(e.ts)} ago`,
					'aria-label': `Replay ${e.title}`,
					onClick: () => {
						stage.perform(e.performerId, { kind: e.kind, receipt: buildReceipt(e) });
						if (e.performerId) stage.highlight(e.performerId);
					},
				}),
			),
		);
	}
	refs.replay.querySelector('[data-play-all]')?.addEventListener('click', async () => {
		const evts = [...state.sessionEvents].reverse();
		for (const e of evts) {
			stage.perform(e.performerId, { kind: e.kind, receipt: buildReceipt(e) });
			await new Promise((r) => setTimeout(r, 700));
		}
	});

	// ── read-only HUD panel ────────────────────────────────────────────────────────
	async function openPanel(id) {
		const agent = state.byId.get(id);
		if (!agent) return;
		state.selected = id;
		renderPanel(id);
		refs.panel.classList.add('is-open');
		// live balance (real)
		if (!state.balances[id]) {
			fetchWalletBalances([id], { network: 'mainnet' }).then((b) => { state.balances = { ...state.balances, ...b }; if (state.selected === id) renderPanel(id); }).catch(() => {});
		}
	}
	function closePanel() { refs.panel.classList.remove('is-open'); state.selected = null; }

	async function renderPanel(id) {
		const agent = state.byId.get(id);
		if (!agent) return;
		const rep = state.reputation[id] || (agent.score != null ? { score: agent.score, tier: agent.tier, tierLabel: agent.tierLabel, totals: agent.totals } : null);
		const bal = state.balances[id];
		const me = await whoami();
		const isOwner = !!agent.is_owner;
		const signedIn = !!me;
		const watching = state.watch.has(id);
		const totals = rep?.totals || {};

		// value may be a string or a node (e.g. the loading skeleton)
		const stat = (label, value) => el('div', { class: 'th-stat' }, [
			el('span', { class: 'th-stat-v' }, [value]),
			el('span', { class: 'th-stat-l', text: label }),
		]);

		refs.panel.replaceChildren(
			el('button', { class: 'th-panel-close', 'aria-label': 'Close', onClick: closePanel, text: '✕' }),
			el('div', { class: 'th-panel-head' }, [
				agent.avatar_thumbnail
					? el('img', { class: 'th-panel-av', src: agent.avatar_thumbnail, alt: '', loading: 'lazy' })
					: el('div', { class: 'th-panel-av th-panel-av-fallback', text: (agent.name || '?').slice(0, 1).toUpperCase() }),
				el('div', {}, [
					el('h2', { class: 'th-panel-name', text: agent.name }),
					rep ? el('span', { class: 'th-panel-tier', text: `${rep.tierLabel || rep.tier || 'Agent'} · trust ${fmtScore(rep.score)}` }) : el('span', { class: 'th-panel-tier th-muted', text: 'New — no track record yet' }),
				]),
			]),
			el('div', { class: 'th-stats' }, [
				stat('Trust', rep ? fmtScore(rep.score) : '—'),
				stat('Wallet', bal ? fmtUsd(bal.usd) : el('span', { class: 'th-skel-inline' })),
				stat('Tips', totals.tip_count != null ? String(totals.tip_count) : '0'),
				stat('Launches', totals.deployed_mints != null ? String(totals.deployed_mints) : '0'),
			]),
			agent.solana_address
				? el('a', { class: 'th-addr', href: `https://solscan.io/account/${agent.solana_address}`, target: '_blank', rel: 'noopener', title: agent.solana_address }, [
					el('span', { text: `${agent.solana_address.slice(0, 4)}…${agent.solana_address.slice(-4)}` }),
					el('span', { class: 'th-addr-ext', text: '↗' }),
				])
				: null,
			el('div', { class: 'th-panel-actions' }, [
				el('button', {
					class: `th-btn ${watching ? 'th-btn-on' : ''}`,
					onClick: () => toggleWatch(id),
					text: watching ? '★ Watching' : '☆ Watch',
				}),
				el('a', { class: 'th-btn', href: `/agents/${id}/wallet#reputation`, text: 'Wallet & positions' }),
				el('a', { class: 'th-btn th-btn-primary', href: `/agents/${id}`, text: isOwner ? 'Manage agent' : 'Open profile' }),
			]),
			isOwner
				? el('p', { class: 'th-panel-foot th-muted', text: 'This agent is yours — act from its profile.' })
				: signedIn
					? el('div', {}, [
						buildMirror(id, agent.name),
						el('p', { class: 'th-panel-foot th-muted' }, [
							'Or ',
							el('a', { href: `/agents/${id}`, text: 'open its profile' }),
							' to fork it to your own wallet.',
						]),
					])
					: el('p', { class: 'th-panel-foot th-muted' }, [
						el('a', { href: `/login?next=${encodeURIComponent(`/agents/${id}`)}`, text: 'Sign in' }),
						' to copy this agent to your own wallet or follow its alpha. Watching is always free.',
					]),
			recentForAgent(id),
		);
	}

	function recentForAgent(id) {
		const mine = state.sessionEvents.filter((e) => e.performerId === id).slice(0, 5);
		if (!mine.length) return el('p', { class: 'th-panel-foot th-muted', text: 'No live moves captured yet this session.' });
		return el('div', { class: 'th-panel-recent' }, [
			el('h3', { class: 'th-panel-recent-h', text: 'Live moves this session' }),
			el('ul', {}, mine.map((e) => el('li', { class: `th-tick-${e.kind}` }, [
				el('span', { class: 'th-tick-dot' }),
				el('span', { text: `${e.title}${e.sub ? ' · ' + e.sub : ''}` }),
				el('time', { class: 'th-tick-time', text: timeAgo(e.ts) }),
			]))),
		]);
	}

	function toggleWatch(id) {
		if (state.watch.has(id)) {
			state.watch.delete(id);
			// re-focus another watched agent in this room, if any
			const next = [...state.watch].find((w) => state.byId.has(w));
			stage.highlight(next || null);
		} else {
			state.watch.add(id);
			stage.highlight(id);
		}
		saveWatch([...state.watch]);
		if (state.selected === id) renderPanel(id);
	}

	// ── quiet-market heartbeat + highlights (real recent activity) ───────────────
	// The heartbeat is honest: "last real move Xs ago" from the newest snapshot
	// event, ticking live — anticipation without a fabricated countdown (we can't
	// predict the next fill, so we never pretend to).
	function updateBeat() {
		const beat = refs.quiet.querySelector('[data-beat]');
		if (!beat) return;
		// The live variant is this script's data, so claim it against the catalog
		// pass; the fallback IS the element's declared copy, so hand it back.
		if (Number.isFinite(state.lastMoveTs)) {
			claimI18nText(beat, `Last on-chain move ${timeAgo(state.lastMoveTs)} ago. The stage lights up the instant the next buy fills.`);
		} else {
			releaseI18nText(beat);
		}
	}

	// A highlight with a real destination (an explorer receipt or an agent profile)
	// is a link; one without is plain text. A stub href="#" looks clickable and
	// goes nowhere, which is worse than not offering the affordance at all.
	function renderHighlight(e) {
		const kids = [
			el('span', { class: 'th-tick-dot' }),
			el('span', { class: 'th-hl-title', text: e.title }),
			e.sub ? el('span', { class: 'th-hl-sub', text: e.sub }) : null,
			el('time', { class: 'th-tick-time', text: timeAgo(e.ts), datetime: new Date(e.ts).toISOString() }),
		];
		const cls = `th-hl th-tick-${e.kind}`;
		if (!e.href) return el('div', { class: `${cls} th-hl-static` }, kids);
		const external = /^https?:/i.test(e.href);
		// Internal routes stay in this tab; only an explorer receipt leaves the page.
		return el('a', { class: cls, href: e.href, target: external ? '_blank' : null, rel: external ? 'noopener' : null }, kids);
	}

	loadSnapshot(40).then((events) => {
		if (events.length) state.lastMoveTs = Math.max(...events.map((e) => e.ts));
		updateBeat();
		// Seed the tape with real recent history before the first live event lands.
		// The rail is an aria-live region, so drop the live semantics for the seed:
		// this is existing history, not twenty events announcing themselves at once.
		refs.ticker.removeAttribute('aria-live');
		for (const e of events.slice(0, 20)) pushTicker(e, { live: false });
		renderTickerEmpty();
		requestAnimationFrame(() => refs.ticker.setAttribute('aria-live', 'polite'));
		const host = refs.quiet.querySelector('[data-highlights]');
		if (host) {
			const featured = events.filter((e) => ROOMS.some((r) => r.featured.has(e.kind)) && (e.href || e.sub));
			host.replaceChildren(
				...(featured.length
					? featured.slice(0, 8).map(renderHighlight)
					: [el('p', { class: 'th-muted', text: 'No recent activity to replay. The stage goes live the moment an agent moves.' })]),
			);
		}
		maybeShowQuiet();
	});

	// keep ticker timestamps fresh
	const tickTimer = setInterval(() => {
		refs.ticker.querySelectorAll('time.th-tick-time').forEach((t) => {
			const dt = Date.parse(t.getAttribute('datetime'));
			if (Number.isFinite(dt)) t.textContent = timeAgo(dt);
		});
		if (!refs.quiet.hidden) updateBeat();
	}, 15000);

	// reduced-motion live toggle (system pref change)
	window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (e) => stage.setReducedMotion(e.matches));

	// keyboard: Esc closes panel
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

	renderTickerLoading();
	renderReplay();
	loadRoom();

	// teardown for SPA navigations / HMR
	window.addEventListener('beforeunload', () => { feed.close(); stage.dispose(); clearInterval(tickTimer); ro.disconnect(); });
}

function loadWatch() { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); } catch { return []; } }
function saveWatch(arr) { try { localStorage.setItem(WATCH_KEY, JSON.stringify(arr.slice(0, 50))); } catch {} }

// auto-boot when the page mounts us directly
const _root = document.getElementById('th-root');
if (_root) initTheater(_root);
