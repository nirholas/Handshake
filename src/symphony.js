/**
 * /symphony: the agent economy, played live as generative music.
 *
 * Every note is a real platform event from the site-wide activity bus
 * (GET /api/feed for first paint, then the /api/feed-stream SSE tail, with a
 * polling fallback). No synthetic events, no audio files: every sound is
 * synthesized in WebAudio from the note specs in src/symphony-score.js.
 *
 * Surfaces:
 *  - a full-bleed canvas visualization (one orb per note, positioned by the
 *    actor's stereo pan, colored by voice)
 *  - a live ledger listing the actual events behind the notes, with real
 *    click-throughs (agent profiles, explorers)
 *  - a recorder that captures the master bus to a downloadable audio clip
 *
 * Audio only ever starts from a user gesture; the page is fully readable
 * (ledger, stats, states) with sound off.
 */

import { esc, timeAgo } from './shared/pulse-format.js';
import { createLogger } from './shared/log.js';
import {
	CATEGORIES,
	eventToNote,
	describeEvent,
	createBurstGate,
	matchesFilter,
	parseFilter,
	filterLabel,
	ROOT_HZ,
} from './symphony-score.js';

const log = createLogger('symphony');

const FEED_URL = '/api/feed?limit=40';
const STREAM_URL = '/api/feed-stream';
const POLL_MS = 20_000; // fallback cadence when SSE is unavailable
const LEDGER_MAX = 60;
const RECORD_MAX_MS = 60_000;
const SEEN_MAX = 500;

const $ = (id) => document.getElementById(id);

const state = {
	playing: false,
	muted: new Set(loadJson('twx_symphony_muted', [])),
	volume: clamp01(Number(localStorage.getItem('twx_symphony_volume') ?? 0.7)),
	seen: new Set(),
	events: [], // newest first, capped to LEDGER_MAX
	notesPlayed: 0,
	lastEventTs: 0,
	source: null, // EventSource
	pollTimer: null,
	status: 'connecting',
	loading: true, // a read is in flight and there is nothing on screen yet
	feedOk: false, // the LAST feed read succeeded; gates "live" from ever being a lie
	filter: {}, // solo mode: {} = the whole platform, else { agentId } | { actor }
};

function clamp01(n) { return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7; }

const burstGate = createBurstGate(1500);

function loadJson(key, fallback) {
	try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

/* ── i18n ownership ────────────────────────────────────────────────────── */

/*
 * The page ships its copy as static HTML annotated with data-i18n, and the
 * catalog pass lands AFTER an async /api/locale fetch. Anything this script
 * writes into an annotated node before then is silently reverted: the status
 * pill snaps back to "connecting" while the stream is live, and a pressed play
 * button snaps back to "Play the economy" while audio is running.
 * `data-i18n-owned="1"` is this codebase's documented opt-out (src/i18n.js):
 * claim a node while the script owns its text, hand it back when it returns to
 * its declared copy so a later locale switch still translates it.
 */
function i18nText(key, fallback) {
	const v = window.threewsI18n?.t?.(key);
	return typeof v === 'string' && v && v !== key ? v : fallback;
}

function claimI18n(el, text) {
	if (!el) return;
	el.setAttribute('data-i18n-owned', '1');
	el.textContent = text;
}

function releaseI18n(el, text) {
	if (!el) return;
	el.textContent = text;
	el.removeAttribute('data-i18n-owned');
	window.threewsI18n?.apply?.(el); // the catalog may have landed while owned
}

/* ── Audio engine ──────────────────────────────────────────────────────── */

const audio = {
	ctx: null,
	master: null,
	wet: null,
	recordDest: null,
	recorder: null,
	recordChunks: [],
	recordTimer: null,
	drone: null,
};

function ensureAudio() {
	if (audio.ctx) return audio.ctx;
	const Ctx = window.AudioContext || window.webkitAudioContext;
	if (!Ctx) return null;
	const ctx = new Ctx();
	const master = ctx.createGain();
	master.gain.value = state.volume;
	const comp = ctx.createDynamicsCompressor();
	comp.threshold.value = -18;
	comp.ratio.value = 6;
	master.connect(comp);
	comp.connect(ctx.destination);

	// Generated impulse-response reverb: 2s of exponentially decaying noise.
	// No audio assets shipped; the room is synthesized too.
	const wet = ctx.createGain();
	wet.gain.value = 0.35;
	const convolver = ctx.createConvolver();
	const len = Math.floor(ctx.sampleRate * 2);
	const ir = ctx.createBuffer(2, len, ctx.sampleRate);
	for (let ch = 0; ch < 2; ch++) {
		const buf = ir.getChannelData(ch);
		let seed = 0x2f6e2b1 + ch;
		for (let i = 0; i < len; i++) {
			// xorshift PRNG: deterministic, dependency-free noise
			seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
			buf[i] = ((seed >>> 0) / 0xffffffff * 2 - 1) * Math.pow(1 - i / len, 2.4);
		}
	}
	convolver.buffer = ir;
	wet.connect(convolver);
	convolver.connect(master);

	// Record tap: everything reaching the master also reaches the recorder.
	if (window.MediaRecorder && ctx.createMediaStreamDestination) {
		audio.recordDest = ctx.createMediaStreamDestination();
		comp.connect(audio.recordDest);
	}

	audio.ctx = ctx;
	audio.master = master;
	audio.wet = wet;
	return ctx;
}

// Connect a note's output to the master (dry) and the reverb send (wet).
function toBus(node, pan) {
	const ctx = audio.ctx;
	let out = node;
	if (ctx.createStereoPanner) {
		const p = ctx.createStereoPanner();
		p.pan.value = Math.min(0.9, Math.max(-0.9, pan || 0));
		node.connect(p);
		out = p;
	}
	out.connect(audio.master);
	out.connect(audio.wet);
}

function startDrone() {
	if (audio.drone || !audio.ctx) return;
	const ctx = audio.ctx;
	const gain = ctx.createGain();
	gain.gain.value = 0.035;
	const filter = ctx.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.value = 320;
	filter.connect(gain);

	const oscA = ctx.createOscillator();
	oscA.type = 'sine';
	oscA.frequency.value = ROOT_HZ / 2;
	const oscB = ctx.createOscillator();
	oscB.type = 'sine';
	oscB.frequency.value = ROOT_HZ / 2;
	oscB.detune.value = 4;
	oscA.connect(filter);
	oscB.connect(filter);

	// A slow breath on the filter keeps the idle state alive without motion sickness.
	const lfo = ctx.createOscillator();
	lfo.frequency.value = 0.08;
	const lfoGain = ctx.createGain();
	lfoGain.gain.value = 140;
	lfo.connect(lfoGain);
	lfoGain.connect(filter.frequency);

	toBus(gain, 0);
	oscA.start(); oscB.start(); lfo.start();
	audio.drone = { oscA, oscB, lfo, gain };
}

function stopDrone() {
	if (!audio.drone) return;
	const { oscA, oscB, lfo, gain } = audio.drone;
	const t = audio.ctx.currentTime;
	gain.gain.setTargetAtTime(0, t, 0.15);
	for (const o of [oscA, oscB, lfo]) { try { o.stop(t + 0.8); } catch { /* already stopped */ } }
	audio.drone = null;
}

function envGain(t0, peak, decay) {
	const g = audio.ctx.createGain();
	g.gain.setValueAtTime(0.0001, t0);
	g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.008);
	g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
	return g;
}

function pluck(hz, gain, pan, t0, decay = 0.7, type = 'triangle') {
	const ctx = audio.ctx;
	const g = envGain(t0, gain, decay);
	const osc = ctx.createOscillator();
	osc.type = type;
	osc.frequency.value = hz;
	osc.connect(g);
	const shimmer = ctx.createOscillator();
	shimmer.type = 'sine';
	shimmer.frequency.value = hz * 2;
	const sg = envGain(t0, gain * 0.25, decay * 0.6);
	shimmer.connect(sg);
	sg.connect(g);
	toBus(g, pan);
	osc.start(t0); osc.stop(t0 + decay + 0.1);
	shimmer.start(t0); shimmer.stop(t0 + decay + 0.1);
}

function bell(hz, gain, pan, t0) {
	const ctx = audio.ctx;
	const g = envGain(t0, gain * 0.8, 1.4);
	const carrier = ctx.createOscillator();
	carrier.type = 'sine';
	carrier.frequency.value = hz;
	// Inharmonic FM partial: the classic bell ratio 2.76
	const mod = ctx.createOscillator();
	mod.frequency.value = hz * 2.76;
	const modGain = ctx.createGain();
	modGain.gain.setValueAtTime(hz * 1.4, t0);
	modGain.gain.exponentialRampToValueAtTime(1, t0 + 1.1);
	mod.connect(modGain);
	modGain.connect(carrier.frequency);
	carrier.connect(g);
	toBus(g, pan);
	carrier.start(t0); carrier.stop(t0 + 1.6);
	mod.start(t0); mod.stop(t0 + 1.6);
}

function bass(hz, gain, pan, t0) {
	const ctx = audio.ctx;
	const g = envGain(t0, gain, 0.9);
	const osc = ctx.createOscillator();
	osc.type = 'sine';
	osc.frequency.setValueAtTime(hz, t0);
	osc.frequency.exponentialRampToValueAtTime(Math.max(hz * 0.5, 28), t0 + 0.5);
	osc.connect(g);
	toBus(g, pan);
	osc.start(t0); osc.stop(t0 + 1.1);
}

function alarm(hz, gain, pan, t0) {
	const ctx = audio.ctx;
	const g = envGain(t0, gain * 0.5, 0.35);
	const osc = ctx.createOscillator();
	osc.type = 'square';
	osc.frequency.value = hz;
	const flat = ctx.createOscillator(); // a minor second above: deliberate dissonance
	flat.type = 'square';
	flat.frequency.value = hz * Math.pow(2, 1 / 12);
	const fg = envGain(t0, gain * 0.3, 0.3);
	osc.connect(g);
	flat.connect(fg);
	fg.connect(g);
	toBus(g, pan);
	osc.start(t0); osc.stop(t0 + 0.45);
	flat.start(t0); flat.stop(t0 + 0.4);
}

function jackpotGliss(note, t0) {
	const ctx = audio.ctx;
	const g = envGain(t0, note.gain * 0.6, 1.2);
	const filter = ctx.createBiquadFilter();
	filter.type = 'bandpass';
	filter.Q.value = 6;
	filter.frequency.setValueAtTime(note.hz, t0);
	filter.frequency.exponentialRampToValueAtTime(note.hz * 4, t0 + 0.8);
	const osc = ctx.createOscillator();
	osc.type = 'sawtooth';
	osc.frequency.setValueAtTime(note.hz, t0);
	osc.frequency.exponentialRampToValueAtTime(note.hz * 4, t0 + 0.8);
	osc.connect(filter);
	filter.connect(g);
	toBus(g, note.pan);
	osc.start(t0); osc.stop(t0 + 1.3);
	// Sparkle on top of the rise
	note.motifHz.forEach((hz, i) => pluck(hz * 2, note.gain * 0.3, note.pan, t0 + 0.25 + i * 0.12, 0.4, 'sine'));
}

function playNote(note, when = 0) {
	if (!audio.ctx || state.muted.has(note.category)) return false;
	const t0 = audio.ctx.currentTime + when;
	switch (note.category) {
		case 'money': pluck(note.hz, note.gain * 0.55, note.pan, t0, 0.8); break;
		case 'bass': bass(note.hz * 0.5, note.gain * 0.7, note.pan, t0); break;
		case 'bell': bell(note.hz, note.gain * 0.5, note.pan, t0); break;
		case 'arp': note.motifHz.forEach((hz, i) => pluck(hz, note.gain * 0.4, note.pan, t0 + i * 0.09, 0.5)); break;
		case 'alarm': alarm(note.hz * 0.5, note.gain, note.pan, t0); break;
		case 'jackpot': jackpotGliss(note, t0); break;
		default: pluck(note.hz, note.gain * 0.4, note.pan, t0, 0.6);
	}
	return true;
}

/* ── Visualization ─────────────────────────────────────────────────────── */

const viz = { canvas: null, ctx2d: null, orbs: [], colors: {}, raf: 0, reduced: false };

function vizColors() {
	const cs = getComputedStyle(document.documentElement);
	const read = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
	return {
		money: read('--sym-money', '#43d9a3'),
		bass: read('--sym-bass', '#5b8cff'),
		bell: read('--sym-bell', '#e8c15a'),
		arp: read('--sym-arp', '#b07ce8'),
		alarm: read('--sym-alarm', '#f0654f'),
		jackpot: read('--sym-jackpot', '#ff9d2e'),
		ink: read('--ink', '#e8e8e8'),
	};
}

function vizInit() {
	viz.canvas = $('sym-canvas');
	if (!viz.canvas) return;
	viz.ctx2d = viz.canvas.getContext('2d');
	viz.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	viz.colors = vizColors();
	new MutationObserver(() => { viz.colors = vizColors(); })
		.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	const resize = () => {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		viz.canvas.width = viz.canvas.clientWidth * dpr;
		viz.canvas.height = viz.canvas.clientHeight * dpr;
		viz.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
	};
	resize();
	window.addEventListener('resize', resize);
	viz.raf = requestAnimationFrame(vizFrame);
}

function vizSpawn(note) {
	if (!viz.canvas) return;
	const w = viz.canvas.clientWidth, h = viz.canvas.clientHeight;
	viz.orbs.push({
		x: w / 2 + (note.pan / 0.9) * w * 0.42,
		y: h * (0.82 - 0.6 * (note.degree / 20)),
		r: 4 + note.intensity * 26,
		color: viz.colors[note.category] || viz.colors.bell,
		born: performance.now(),
		life: viz.reduced ? 1200 : 3200,
	});
	if (viz.orbs.length > 80) viz.orbs.splice(0, viz.orbs.length - 80);
}

function vizFrame(now) {
	const c = viz.ctx2d;
	const w = viz.canvas.clientWidth, h = viz.canvas.clientHeight;
	// Paint the stage backdrop into the canvas rather than leaving it
	// transparent over the CSS gradient: visually identical, and it means a
	// captured recording carries the picture instead of an alpha hole.
	c.clearRect(0, 0, w, h);
	c.fillStyle = '#000';
	c.fillRect(0, 0, w, h);
	const glow = c.createRadialGradient(w / 2, h * 0.9, 0, w / 2, h * 0.9, Math.max(w, h) * 0.75);
	glow.addColorStop(0, 'rgba(67, 217, 163, 0.07)');
	glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
	c.fillStyle = glow;
	c.fillRect(0, 0, w, h);

	// Baseline: a faint horizon the notes float away from.
	c.strokeStyle = viz.colors.ink;
	c.globalAlpha = 0.08;
	c.beginPath();
	c.moveTo(0, h * 0.82);
	c.lineTo(w, h * 0.82);
	c.stroke();

	// Idle heartbeat ring while playing, synced to a slow phase.
	if (state.playing) {
		const phase = (now % 4000) / 4000;
		c.globalAlpha = 0.10 * (1 - phase);
		c.strokeStyle = viz.colors.ink;
		c.beginPath();
		c.arc(w / 2, h * 0.82, 12 + phase * Math.min(w, h) * 0.28, 0, Math.PI * 2);
		c.stroke();
	}

	for (const orb of viz.orbs) {
		const age = (now - orb.born) / orb.life;
		if (age >= 1) continue;
		const rise = viz.reduced ? 0 : age * 60;
		c.globalAlpha = 0.85 * (1 - age);
		c.fillStyle = orb.color;
		c.beginPath();
		c.arc(orb.x, orb.y - rise, orb.r * (1 + age * 0.4), 0, Math.PI * 2);
		c.fill();
		c.globalAlpha = 0.25 * (1 - age);
		c.strokeStyle = orb.color;
		c.beginPath();
		c.arc(orb.x, orb.y - rise, orb.r * (1.8 + age * 2.2), 0, Math.PI * 2);
		c.stroke();
	}
	c.globalAlpha = 1;
	viz.orbs = viz.orbs.filter((o) => (now - o.born) < o.life);
	viz.raf = requestAnimationFrame(vizFrame);
}

// Browsers throttle rAF in background tabs but do not always stop it; drop the
// loop outright when hidden and restart on return so a parked tab costs nothing.
function vizSetRunning(run) {
	if (run && !viz.raf) viz.raf = requestAnimationFrame(vizFrame);
	else if (!run && viz.raf) { cancelAnimationFrame(viz.raf); viz.raf = 0; }
}

/* ── Ledger + stats ────────────────────────────────────────────────────── */

function ledgerRowHTML(evt) {
	const d = describeEvent(evt);
	const note = eventToNote(evt);
	const body = `
		<span class="sy-row-title">${esc(d.title)}</span>
		${d.detail ? `<span class="sy-row-detail">${esc(String(d.detail))}</span>` : ''}`;
	// The main content is one link; "solo" is a sibling button, never nested
	// inside it (interactive-in-interactive is invalid and untabbable).
	const main = d.href
		? `<a class="sy-row-link" href="${esc(d.href)}" ${d.href.startsWith('http') ? 'target="_blank" rel="noopener"' : ''}>${body}</a>`
		: `<span class="sy-row-link">${body}</span>`;
	const actor = evt.actor ? esc(String(evt.actor)) : '';
	const solo = actor
		? `<button type="button" class="sy-solo" data-actor="${actor}"${evt.agentId ? ` data-agent-id="${esc(String(evt.agentId))}"` : ''} title="Listen to ${actor} alone" aria-label="Listen to ${actor} alone">solo</button>`
		: '';
	return `<div class="sy-row">
		<span class="sy-dot" style="--c:var(--sym-${note.category})" aria-hidden="true">${esc(d.icon)}</span>
		${main}
		${solo}
		<time class="sy-row-time" datetime="${new Date(evt.ts || Date.now()).toISOString()}">${esc(timeAgo(evt.ts))}</time>
	</div>`;
}

// First paint is in flight. A blank strip where the score belongs reads as
// "nothing ever happens here"; six inert bars read as "the score is loading".
function loadingLedgerHTML() {
	return `<div class="sy-skeleton" aria-hidden="true">${'<div class="sy-skel-row"></div>'.repeat(6)}</div>`;
}

// The feed is unreachable. This must never borrow the quiet-economy copy
// below: "the economy is quiet" is a claim about the platform, and claiming it
// while we cannot see the platform at all is simply false.
function offlineLedgerHTML() {
	return `
		<div class="sy-empty sy-empty-error" role="alert">
			<p><strong>The live event feed is unreachable.</strong></p>
			<p>Nothing can be scored without it, so the stage is silent. The page
			keeps retrying by itself every ${Math.round(POLL_MS / 1000)} seconds.</p>
			<p><button type="button" class="sy-retry" id="sy-retry">Try again now</button></p>
			<p><a href="/pulse">Watch the Money Pulse</a> or <a href="/economy">see the economy dashboard</a>.</p>
		</div>`;
}

function emptyLedgerHTML() {
	const label = filterLabel(state.filter, state.events);
	if (label) {
		return `
			<div class="sy-empty">
				<p><strong>${esc(label)} has not done anything yet.</strong></p>
				<p>You are listening to one participant. The next time this agent pays,
				trades, launches or gets refused by a safety rule, it plays here and
				nothing else does.</p>
				<p><a href="/symphony">Hear the whole economy</a> instead.</p>
			</div>`;
	}
	return `
		<div class="sy-empty">
			<p><strong>The economy is quiet right now.</strong></p>
			<p>The moment an agent pays, trades, launches or levels up anywhere on
			three.ws, you will hear it here. Meanwhile the drone you hear is the
			platform's idle heartbeat.</p>
			<p><a href="/pulse">Watch the Money Pulse</a> or <a href="/economy">see the economy dashboard</a>.</p>
		</div>`;
}

// Full rebuild. Only for first paint and for the empty state: a live feed that
// re-rendered every row per event would restart all 60 enter animations and,
// worse, make an aria-live container re-announce the entire list. Steady-state
// arrivals go through prependLedgerRow() instead.
function renderLedger() {
	const el = $('sy-ledger');
	if (!el) return;
	if (state.events.length) {
		el.removeAttribute('aria-busy');
		el.innerHTML = state.events.map(ledgerRowHTML).join('');
		return;
	}
	if (state.loading) {
		el.setAttribute('aria-busy', 'true');
		el.innerHTML = loadingLedgerHTML();
		return;
	}
	el.removeAttribute('aria-busy');
	el.innerHTML = state.status === 'offline' ? offlineLedgerHTML() : emptyLedgerHTML();
}

// One newly-arrived event: insert a single node at the head and evict the tail.
function prependLedgerRow(evt) {
	const el = $('sy-ledger');
	if (!el) return;
	if (!el.querySelector('.sy-row')) { renderLedger(); return; } // was the empty state
	const tpl = document.createElement('template');
	tpl.innerHTML = ledgerRowHTML(evt).trim();
	const row = tpl.content.firstElementChild;
	if (!row) return;
	el.prepend(row);
	while (el.children.length > LEDGER_MAX) el.lastElementChild.remove();
}

// Screen readers get ONE short sentence per arrival, throttled, from a
// dedicated live region. The ledger itself is not a live region: announcing a
// 60-row list on every beat of a live feed is unusable.
let lastAnnounceMs = 0;
function announceEvent(evt) {
	const el = $('sy-announce');
	if (!el) return;
	const now = Date.now();
	if (now - lastAnnounceMs < 4000) return;
	lastAnnounceMs = now;
	const d = describeEvent(evt);
	el.textContent = d.detail ? `${d.title}, ${d.detail}` : d.title;
}

/*
 * The status pill is derived, never assigned ad hoc. It used to be written from
 * four call sites and they disagreed: a page that had never once reached the
 * API showed "live (polling)", because the EventSource error handler set
 * "polling" before the offline guard downstream could read it. Two facts decide
 * it: whether the last feed read worked, and whether the SSE tail is open.
 */
function syncStatus() {
	if (!state.feedOk) {
		state.status = state.loading ? 'connecting' : 'offline';
		return;
	}
	if (state.source && state.source.readyState === 1) {
		state.status = 'live';
		return;
	}
	// The data on screen is real, but the tail is not open. Only claim the
	// polling fallback once it is genuinely running; otherwise we are still
	// connecting it.
	state.status = state.pollTimer ? 'polling' : 'connecting';
}

function renderStats() {
	const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
	set('sy-notes', String(state.notesPlayed));
	set('sy-events', String(state.events.length));
	set('sy-last', state.lastEventTs ? timeAgo(state.lastEventTs) : 'never');
	const pill = $('sy-status');
	if (pill) {
		pill.dataset.status = state.status;
		// "connecting" is the only one of the four that ships as declared copy,
		// so it is the only one the catalog can translate; the pill is claimed
		// either way so the catalog pass cannot revert a live status to it.
		claimI18n(pill, state.status === 'live' ? 'live'
			: state.status === 'polling' ? 'live (polling)'
			: state.status === 'offline' ? 'offline'
			: i18nText('symphony.connecting', 'connecting'));
	}
}

/* ── Solo mode ─────────────────────────────────────────────────────────── */

function renderSoloChip() {
	const bar = $('sy-solo-bar');
	const label = $('sy-solo-label');
	if (!bar || !label) return;
	const name = filterLabel(state.filter, state.events);
	bar.hidden = !name;
	if (name) label.textContent = name;
	document.body.classList.toggle('sy-soloing', Boolean(name));
}

/*
 * The soloing sentence is translated as MARKUP, and every locale's value
 * carries its own EMPTY <strong id="sy-solo-label">. So the catalog pass does
 * not merely overwrite the participant's name, it replaces the element holding
 * it, and a deep link like /symphony?actor=Luna rendered "Soloing . Everything
 * else is muted."
 *
 * The i18n:change event alone cannot fix it: the catalog lands on its own
 * schedule and in testing it beat this module's own boot (event at 999ms,
 * listener registered at 1089ms), so half the time there is nothing listening
 * yet. Watching the bar covers both orders, and marking the sentence
 * script-owned is not an option because that would freeze it in English.
 */
function wireI18nRepaint() {
	window.addEventListener('i18n:change', () => {
		renderSoloChip();
		renderStats();
	});
	const bar = $('sy-solo-bar');
	if (!bar || typeof MutationObserver === 'undefined') return;
	// Writing the name back mutates the bar again; the equality guard makes that
	// second pass a no-op, so the observer settles instead of looping.
	new MutationObserver(() => {
		const name = filterLabel(state.filter, state.events);
		const label = $('sy-solo-label');
		if (name && label && label.textContent !== name) label.textContent = name;
	}).observe(bar, { childList: true, subtree: true });
}

/**
 * Switch the whole page to one participant (or back to everything) without a
 * reload: reset the accumulated stream, re-fetch under the new filter, and
 * keep the URL shareable so the state survives a copy-paste.
 */
async function setFilter(filter, { push = true } = {}) {
	state.filter = filter || {};
	state.seen = new Set();
	state.events = [];
	state.lastEventTs = 0;
	state.loading = true; // re-reading under the new filter, not an empty result
	if (push && typeof history !== 'undefined' && history.replaceState) {
		const qs = state.filter.agentId ? `?agent=${encodeURIComponent(state.filter.agentId)}`
			: state.filter.actor ? `?actor=${encodeURIComponent(state.filter.actor)}`
			: '';
		history.replaceState(null, '', `${location.pathname}${qs}`);
	}
	renderSoloChip();
	renderLedger();
	renderStats();
	await fetchFirstPaint();
	renderSoloChip(); // an agentId filter resolves its display name from the events
}

function wireSolo() {
	$('sy-ledger')?.addEventListener('click', (e) => {
		const retry = e.target.closest('.sy-retry');
		if (retry) {
			e.preventDefault();
			retryFeed(retry);
			return;
		}
		const btn = e.target.closest('.sy-solo');
		if (!btn) return;
		e.preventDefault();
		const agentId = btn.dataset.agentId;
		setFilter(agentId ? { agentId } : { actor: btn.dataset.actor });
	});
	$('sy-solo-clear')?.addEventListener('click', () => setFilter({}));
}

/** Retry the feed by hand from the offline state, and re-open the SSE tail. */
async function retryFeed(btn) {
	btn.disabled = true;
	btn.setAttribute('aria-busy', 'true');
	btn.textContent = 'Reconnecting…';
	state.loading = true;
	syncStatus();
	renderStats();
	// A CLOSED EventSource never reconnects on its own; drop it so the reopen
	// below is a real reconnection rather than a no-op.
	if (state.source && state.source.readyState === 2) {
		state.source.close();
		state.source = null;
	}
	const ok = await fetchFirstPaint();
	if (ok && !state.source) connectStream();
	syncStatus();
	renderStats();
	// A failed retry repaints the offline block, which replaces this button
	// outright; only a surviving node still needs its idle label back.
	if (btn.isConnected) {
		btn.disabled = false;
		btn.removeAttribute('aria-busy');
		btn.textContent = 'Try again now';
	}
}

/* ── Event plumbing ────────────────────────────────────────────────────── */

function acceptEvent(evt, { silent = false } = {}) {
	if (!evt || !evt.id || state.seen.has(evt.id)) return;
	// Solo mode drops other participants before anything else: they must not
	// consume the seen-set, the ledger, or a note.
	if (!matchesFilter(evt, state.filter)) return;
	state.seen.add(evt.id);
	if (state.seen.size > SEEN_MAX) {
		state.seen = new Set(state.events.map((e) => e.id));
	}
	state.events.unshift(evt);
	if (state.events.length > LEDGER_MAX) state.events.length = LEDGER_MAX;
	state.lastEventTs = Math.max(state.lastEventTs, Number(evt.ts) || 0);

	const note = eventToNote(evt);
	if (!silent && state.playing) {
		// Floods (e.g. a sniper sweep emitting dozens of identical guard events)
		// collapse into one accented note per actor instead of a machine-gun.
		const { play, accent } = burstGate.admit(evt, Date.now());
		if (play) {
			note.gain = Math.min(1, note.gain + accent);
			if (playNote(note)) state.notesPlayed++;
			vizSpawn(note);
		}
	}
	// Silent arrivals are the first-paint backlog: the caller renders once after
	// the batch instead of paying a full rebuild per row.
	if (silent) return;
	prependLedgerRow(evt);
	announceEvent(evt);
	renderStats();
}

async function fetchFirstPaint() {
	try {
		const res = await fetch(FEED_URL);
		if (!res.ok) throw new Error(`feed ${res.status}`);
		const data = await res.json();
		const events = Array.isArray(data.events) ? data.events : [];
		for (const evt of events.slice().reverse()) acceptEvent(evt, { silent: true });
		state.feedOk = true;
		state.loading = false;
		syncStatus();
		renderLedger();
		renderStats();
		return true;
	} catch (err) {
		log.warn('first paint failed', err);
		state.loading = false;
		state.feedOk = false;
		syncStatus();
		renderStats();
		renderLedger();
		return false;
	}
}

function connectStream() {
	if (state.source || typeof EventSource === 'undefined') { if (!state.source) startPolling(); return; }
	try {
		const source = new EventSource(STREAM_URL);
		state.source = source;
		source.addEventListener('hello', () => { state.feedOk = true; syncStatus(); stopPolling(); renderStats(); });
		source.addEventListener('event', (msg) => {
			try { acceptEvent(JSON.parse(msg.data)); } catch { /* malformed frame */ }
		});
		source.onerror = () => {
			// EventSource auto-reconnects; run the poll fallback while it is down.
			startPolling();
			syncStatus();
			renderStats();
		};
	} catch (err) {
		log.warn('SSE unavailable, polling instead', err);
		startPolling();
	}
}

function startPolling() {
	if (state.pollTimer) return;
	state.pollTimer = setInterval(async () => {
		state.feedOk = await fetchFirstPaintDiff();
		syncStatus();
		renderStats();
		// The offline and quiet-economy blocks are different sentences; a poll
		// that flips the verdict has to repaint the one on screen.
		if (!state.events.length) renderLedger();
	}, POLL_MS);
	syncStatus(); // the timer exists now, so "polling" is finally true
}

function stopPolling() {
	if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function fetchFirstPaintDiff() {
	try {
		const res = await fetch(FEED_URL);
		if (!res.ok) return false;
		const data = await res.json();
		for (const evt of (data.events || []).slice().reverse()) acceptEvent(evt);
		return true;
	} catch { return false; }
}

/* ── Recorder ──────────────────────────────────────────────────────────── */

// The clip people actually share is the one with picture: capture the canvas
// alongside the master bus so a recording is a postable video, not a bare .webm
// of audio. Falls back to audio-only wherever captureStream or the muxer is
// unavailable, so the button never breaks.
function buildRecordStream() {
	const audioTracks = audio.recordDest.stream.getAudioTracks();
	const canvas = viz.canvas;
	if (!canvas || typeof canvas.captureStream !== 'function') return { stream: audio.recordDest.stream, video: false };
	try {
		const videoStream = canvas.captureStream(30);
		const tracks = [...videoStream.getVideoTracks(), ...audioTracks];
		if (!tracks.length) return { stream: audio.recordDest.stream, video: false };
		return { stream: new MediaStream(tracks), video: videoStream.getVideoTracks().length > 0 };
	} catch {
		return { stream: audio.recordDest.stream, video: false };
	}
}

function pickMimeType(wantsVideo) {
	const candidates = wantsVideo
		? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
		: ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
	for (const type of candidates) {
		if (typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(type)) return type;
	}
	return '';
}

function toggleRecord() {
	const btn = $('sy-record');
	if (!btn || !audio.recordDest) return;
	if (audio.recorder) { stopRecord(); return; }
	try {
		const { stream, video } = buildRecordStream();
		const mimeType = pickMimeType(video);
		const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
		audio.recordChunks = [];
		rec.ondataavailable = (e) => { if (e.data && e.data.size) audio.recordChunks.push(e.data); };
		rec.onstop = () => {
			const blob = new Blob(audio.recordChunks, { type: rec.mimeType || (video ? 'video/webm' : 'audio/webm') });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			const ext = /ogg/.test(blob.type) ? 'ogg' : 'webm';
			a.href = url;
			a.download = `three-ws-symphony-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		};
		rec.start();
		audio.recorder = rec;
		btn.setAttribute('aria-pressed', 'true');
		claimI18n(btn, 'Stop + save clip');
		audio.recordTimer = setTimeout(stopRecord, RECORD_MAX_MS);
	} catch (err) {
		log.warn('recorder failed', err);
		btn.hidden = true;
	}
}

function stopRecord() {
	const btn = $('sy-record');
	if (audio.recordTimer) { clearTimeout(audio.recordTimer); audio.recordTimer = null; }
	if (audio.recorder) {
		try { audio.recorder.stop(); } catch { /* already stopped */ }
		audio.recorder = null;
	}
	if (btn) {
		btn.setAttribute('aria-pressed', 'false');
		releaseI18n(btn, 'Record a video clip');
	}
}

/* ── Controls ──────────────────────────────────────────────────────────── */

/*
 * The play button's declared copy is translated MARKUP (`<span>Play the
 * economy</span>`), so its two states are handled as a claim/release pair: the
 * script owns the node while it reads "Pause", and hands it back on stop so the
 * catalog restores the visitor's own language rather than English.
 */
function setPlayLabel(btn, playing) {
	if (!btn) return;
	btn.setAttribute('aria-pressed', String(playing));
	const span = btn.querySelector('span') || btn.appendChild(document.createElement('span'));
	if (playing) {
		btn.setAttribute('data-i18n-owned', '1');
		span.textContent = 'Pause';
		return;
	}
	span.textContent = 'Play the economy';
	btn.removeAttribute('data-i18n-owned');
	window.threewsI18n?.apply?.(btn);
}

let recapDone = false;

async function togglePlay() {
	const btn = $('sy-play');
	if (state.playing) {
		state.playing = false;
		stopDrone();
		stopRecord();
		if (audio.ctx) await audio.ctx.suspend().catch(() => {});
		setPlayLabel(btn, false);
		// A clip cut while the context is suspended is a file full of silence.
		// Take the affordance away with the sound rather than ship that.
		const stoppedRec = $('sy-record');
		if (stoppedRec) stoppedRec.hidden = true;
		return;
	}
	const ctx = ensureAudio();
	if (!ctx) {
		const el = $('sy-ledger');
		if (el) el.insertAdjacentHTML('afterbegin',
			'<div class="sy-empty"><p><strong>This browser does not support WebAudio.</strong> The ledger below still streams the real events.</p></div>');
		return;
	}
	await ctx.resume().catch(() => {});
	state.playing = true;
	startDrone();
	setPlayLabel(btn, true);
	const recBtn = $('sy-record');
	if (recBtn && audio.recordDest) recBtn.hidden = false;

	// One-time recap: replay the most recent real events as a fast overture so
	// a first visit demonstrates the mapping even during a quiet minute.
	if (!recapDone && state.events.length) {
		recapDone = true;
		state.events.slice(0, 10).reverse().forEach((evt, i) => {
			const note = eventToNote(evt);
			note.gain *= 0.5;
			setTimeout(() => {
				if (!state.playing) return;
				if (playNote(note)) state.notesPlayed++;
				vizSpawn(note);
				renderStats();
			}, 250 + i * 170);
		});
	}
}

function wireLegend() {
	for (const cat of CATEGORIES) {
		const btn = document.querySelector(`[data-voice="${cat}"]`);
		if (!btn) continue;
		const sync = () => btn.setAttribute('aria-pressed', String(!state.muted.has(cat)));
		sync();
		btn.addEventListener('click', () => {
			if (state.muted.has(cat)) state.muted.delete(cat); else state.muted.add(cat);
			localStorage.setItem('twx_symphony_muted', JSON.stringify([...state.muted]));
			sync();
		});
	}
}

function wireControls() {
	$('sy-play')?.addEventListener('click', togglePlay);
	$('sy-record')?.addEventListener('click', toggleRecord);
	const vol = $('sy-volume');
	if (vol) {
		vol.value = String(state.volume);
		vol.addEventListener('input', () => {
			state.volume = clamp01(Number(vol.value));
			localStorage.setItem('twx_symphony_volume', String(state.volume));
			if (audio.master) audio.master.gain.setTargetAtTime(state.volume, audio.ctx.currentTime, 0.05);
		});
	}
	document.addEventListener('keydown', (e) => {
		if (e.code === 'Space' && !/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(document.activeElement?.tagName || '')) {
			e.preventDefault();
			togglePlay();
		}
	});
	document.addEventListener('visibilitychange', () => {
		vizSetRunning(!document.hidden);
		if (!audio.ctx) return;
		if (document.hidden && state.playing) audio.ctx.suspend().catch(() => {});
		else if (!document.hidden && state.playing) audio.ctx.resume().catch(() => {});
	});
	if (!window.MediaRecorder) { const b = $('sy-record'); if (b) b.hidden = true; }
	setInterval(renderStats, 15_000); // keep "last event" ages honest
}

/* ── Boot ──────────────────────────────────────────────────────────────── */

async function main() {
	state.filter = parseFilter(location.search);
	vizInit();
	wireControls();
	wireLegend();
	wireSolo();
	wireI18nRepaint();
	renderSoloChip();
	renderStats();
	renderLedger(); // skeleton while the first read is in flight
	await fetchFirstPaint();
	renderSoloChip(); // resolve an ?agent=<id> deep link to its display name
	connectStream();
}

main();
