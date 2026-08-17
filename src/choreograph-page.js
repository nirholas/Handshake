// /choreograph: compose agent gestures into a timed routine.
//
// The page owns editing and presentation only. Everything about what a routine
// *is* — validation, timing, the URL wire format, playback order — comes from
// src/runtime/choreography.js, the same module the agents API validates with
// and the avatar runtime performs with. That is what makes the preview here
// honest: the timeline is not an approximation of what the agent will do, it is
// driven by the identical player.
//
// The 3D stage reuses the gallery's shared engine (one renderer, one avatar,
// moved into the stage on demand) and nothing 3D loads until the first play.

import { SLOTS, DEFAULT_ANIMATION_MAP } from './runtime/animation-slots.js';
import {
	DEFAULT_HOLD,
	MAX_HOLD,
	MAX_STEPS,
	MIN_HOLD,
	PRESET_ROUTINES,
	RoutinePlayer,
	decodeRoutine,
	encodeRoutine,
	normalizeRoutine,
	resolveStepClip,
	routineDuration,
	slugify,
	stepOffsets,
} from './runtime/choreography.js';
import { curate, CATEGORIES } from './animation-presets.js';

const MANIFEST_URL = '/animations/manifest.json';
const THUMB_BASE = '/animations/thumbs';
/** Blend between steps. Long enough to read as a transition, short enough that
 *  a 1s beat is still mostly the gesture itself. */
const CROSSFADE = 0.28;

/** One line per slot: what this beat reads as inside a performance. */
const SLOT_ICONS = {
	idle: '🧍',
	wave: '👋',
	nod: '🙂',
	shake: '🙅',
	think: '🤔',
	celebrate: '🎉',
	concern: '😟',
	bow: '🙇',
	point: '👉',
	shrug: '🤷',
	fidget: '😌',
	dance: '💃',
	inspect: '🔍',
	present: '🖐️',
	sign: '✍️',
	curiosity: '👀',
	patience: '⏳',
	manipulate: '📦',
	conjure: '✨',
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (role, root = document) => root.querySelector(`[data-role="${role}"]`);

const state = {
	manifest: [],
	byName: new Map(),
	/** Working routine: always normalized, always the source of truth. */
	name: 'Welcome',
	steps: [],
	loop: false,
	player: null,
	preview: null,
	raf: 0,
	lastT: 0,
	stagedClip: null, // clip currently mounted on the stage
	/** True while a play is still binding its clips and nothing is on stage yet. */
	starting: false,
	/** Bumped by every start and every stop, so work that was already in flight
	 *  when the user changed their mind can tell that it no longer owns the
	 *  stage. Binding a cold routine takes seconds; a lot can happen in them. */
	startGen: 0,
	agents: null, // null = not fetched, [] = signed out or none
	dragIndex: -1,
	loadedFromLink: false,
	boundClips: [],
};

/* ── helpers ───────────────────────────────────────────────────────────── */

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The working routine as the rest of the platform sees it, or null if empty. */
function currentRoutine() {
	if (!state.steps.length) return null;
	try {
		return normalizeRoutine({ name: state.name, steps: state.steps, loop: state.loop });
	} catch {
		return null;
	}
}

function clipLabel(clipName) {
	return state.byName.get(clipName)?.label || clipName;
}

function stepClip(step) {
	return resolveStepClip(step, null);
}

/* ── data ──────────────────────────────────────────────────────────────── */

async function loadManifest() {
	try {
		const res = await fetch(MANIFEST_URL, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`${MANIFEST_URL} responded ${res.status}`);
		const manifest = await res.json();
		state.manifest = Array.isArray(manifest) ? manifest : [];
		state.byName = new Map(state.manifest.map((c) => [c.name, c]));
	} catch (err) {
		// The clip library only supplies labels, posters and the per-step clip
		// picker. Composing, previewing and saving all work without it, so this
		// degrades to slot names rather than taking the page down.
		setStatus(`Clip labels unavailable (${err.message}). Slot names still work.`);
	}
	renderPalette();
	renderSteps();
}

/**
 * The signed-in user's agents. Being signed out is the ordinary case here, not
 * an error: the whole page works without an account, and only the save panel
 * needs to know. `/api/auth/me` answers 200 either way, so asking it first keeps
 * an anonymous visitor's console clean instead of printing a red 401 from
 * `/api/agents` on every first paint.
 */
async function loadAgents() {
	try {
		const { apiFetch, noteSession } = await import('./api.js');
		const who = await apiFetch('/api/auth/me', {
			allowAnonymous: true,
			headers: { accept: 'application/json' },
		});
		const user = who.ok ? (await who.json()).user : null;
		noteSession(!!user);
		if (!user) {
			state.agents = [];
			renderSave();
			return;
		}
		// allowAnonymous keeps a session that expired mid-edit from bouncing the
		// composer to /login: the save panel simply falls back to its signed-out
		// state and the routine on screen survives.
		const res = await apiFetch('/api/agents', {
			allowAnonymous: true,
			headers: { accept: 'application/json' },
		});
		state.agents = res.ok ? ((await res.json()).agents ?? []) : [];
	} catch {
		state.agents = [];
	}
	renderSave();
}

/* ── render: presets ───────────────────────────────────────────────────── */

function renderPresets() {
	el('presets').innerHTML = PRESET_ROUTINES.map((preset) => {
		const seconds = routineDuration(normalizeRoutine(preset));
		const beats = preset.steps
			.map((s) => `<span class="ch-preset-beat">${SLOT_ICONS[s.slot] || '🎞️'} ${escapeHtml(s.slot)}</span>`)
			.join('<span class="ch-preset-arrow" aria-hidden="true">→</span>');
		return `
			<button type="button" class="ch-preset" role="listitem" data-preset="${escapeHtml(preset.id)}">
				<span class="ch-preset-head">
					<span class="ch-preset-name">${escapeHtml(preset.name)}</span>
					<span class="ch-preset-time">${seconds}s${preset.loop ? ' · loops' : ''}</span>
				</span>
				<span class="ch-preset-blurb">${escapeHtml(preset.blurb)}</span>
				<span class="ch-preset-beats">${beats}</span>
			</button>`;
	}).join('');
}

/* ── render: palette ───────────────────────────────────────────────────── */

function renderPalette() {
	el('palette').innerHTML = SLOTS.map((slot) => {
		const clip = DEFAULT_ANIMATION_MAP[slot];
		return `
			<button type="button" class="ch-chip" role="listitem" data-slot="${escapeHtml(slot)}"
				title="Add ${escapeHtml(slot)} (${escapeHtml(clipLabel(clip))})">
				<span class="ch-chip-thumb">
					<span class="ch-chip-icon" aria-hidden="true">${SLOT_ICONS[slot] || '🎞️'}</span>
					<img src="${THUMB_BASE}/${encodeURIComponent(clip)}.webp" alt="" loading="lazy"
						decoding="async" width="160" height="160" />
				</span>
				<span class="ch-chip-label">${escapeHtml(slot)}</span>
				<span class="ch-chip-add" aria-hidden="true">+</span>
			</button>`;
	}).join('');
	// The emoji stands in until the poster paints, then gets out of the way.
	for (const img of el('palette').querySelectorAll('img')) {
		const icon = img.previousElementSibling;
		if (img.complete && img.naturalWidth > 0) icon?.remove();
		else {
			img.addEventListener('load', () => icon?.remove(), { once: true });
			img.addEventListener('error', () => img.remove(), { once: true });
		}
	}
}

/* ── render: steps ─────────────────────────────────────────────────────── */

let clipOptionsHtml = '';
function buildClipOptions() {
	if (clipOptionsHtml) return clipOptionsHtml;
	const { groups } = curate(state.manifest);
	const order = new Map(CATEGORIES.map((c, i) => [c.key, i]));
	const sorted = [...groups].sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
	clipOptionsHtml = sorted
		.map(
			(g) =>
				`<optgroup label="${escapeHtml(`${g.icon} ${g.label}`)}">${g.items
					.map(
						(item) =>
							`<option value="${escapeHtml(item.name)}">${escapeHtml(item.label || item.name)}</option>`,
					)
					.join('')}</optgroup>`,
		)
		.join('');
	return clipOptionsHtml;
}

function stepRowHtml(step, i) {
	const clip = stepClip(step);
	const isDefault = !step.clip;
	return `
		<li class="ch-step" data-index="${i}" draggable="true">
			<span class="ch-step-grip" aria-hidden="true" title="Drag to reorder">⠿</span>
			<span class="ch-step-num">${i + 1}</span>
			<span class="ch-step-icon" aria-hidden="true">${SLOT_ICONS[step.slot] || '🎞️'}</span>
			<span class="ch-step-body">
				<span class="ch-step-slot">${escapeHtml(step.slot)}</span>
				<label class="ch-step-clip">
					<span class="ch-sr-only">Clip for step ${i + 1}</span>
					<select class="ch-select ch-select--sm" data-act="clip" data-index="${i}">
						${buildClipOptions()}
					</select>
				</label>
				${isDefault ? '' : '<span class="ch-step-pin" title="This step pins a clip instead of following the agent\'s own mapping">pinned</span>'}
			</span>
			<span class="ch-step-timing">
				<label class="ch-step-hold">
					<span class="ch-sr-only">Hold for step ${i + 1}, in seconds</span>
					<input type="range" class="ch-range" data-act="hold" data-index="${i}"
						min="${MIN_HOLD}" max="${MAX_HOLD}" step="0.1" value="${step.hold}" />
					<output class="ch-step-secs">${step.hold.toFixed(1)}s</output>
				</label>
				<label class="ch-step-speed">
					<span class="ch-sr-only">Speed for step ${i + 1}</span>
					<select class="ch-select ch-select--xs" data-act="speed" data-index="${i}">
						${[0.5, 0.75, 1, 1.25, 1.5, 2]
							.map(
								(s) =>
									`<option value="${s}"${s === step.speed ? ' selected' : ''}>${s}&times;</option>`,
							)
							.join('')}
					</select>
				</label>
			</span>
			<span class="ch-step-actions">
				<button type="button" class="ch-icon-btn ch-icon-btn--xs" data-act="up" data-index="${i}"
					title="Move up" aria-label="Move step ${i + 1} up"${i === 0 ? ' disabled' : ''}>↑</button>
				<button type="button" class="ch-icon-btn ch-icon-btn--xs" data-act="down" data-index="${i}"
					title="Move down" aria-label="Move step ${i + 1} down">↓</button>
				<button type="button" class="ch-icon-btn ch-icon-btn--xs ch-icon-btn--danger" data-act="remove"
					data-index="${i}" title="Remove" aria-label="Remove step ${i + 1}">✕</button>
			</span>
			<span class="ch-sr-only" data-role="step-clip-name">${escapeHtml(clipLabel(clip))}</span>
		</li>`;
}

function renderSteps() {
	const host = el('steps');
	const empty = el('steps-empty');
	host.innerHTML = state.steps.map(stepRowHtml).join('');
	host.hidden = !state.steps.length;
	empty.hidden = state.steps.length > 0;
	// Selects cannot carry their value through innerHTML, so set them after.
	for (const [i, step] of state.steps.entries()) {
		const select = host.querySelector(`select[data-act="clip"][data-index="${i}"]`);
		if (select) select.value = stepClip(step);
	}
	const last = host.querySelector('.ch-step:last-child [data-act="down"]');
	if (last) last.disabled = true;
	renderMeta();
	renderTimeline();
	renderExports();
}

function renderMeta() {
	const routine = currentRoutine();
	el('step-count').textContent = String(state.steps.length);
	const seconds = routine ? routineDuration(routine) : 0;
	el('meta-duration').textContent = seconds.toFixed(1);
	el('duration').textContent = seconds.toFixed(1);
	el('routine-id').textContent = slugify(state.name || 'routine');
	const hasSteps = state.steps.length > 0;
	for (const role of ['play', 'restart', 'loop']) el(role).disabled = !hasSteps;
	el('timeline-empty').hidden = hasSteps;
}

/* ── render: timeline ──────────────────────────────────────────────────── */

function renderTimeline() {
	const routine = currentRoutine();
	const track = el('timeline-track');
	const timeline = el('timeline');
	if (!routine) {
		track.innerHTML = '';
		el('playhead').hidden = true;
		timeline.setAttribute('aria-valuemax', '0');
		timeline.setAttribute('aria-valuenow', '0');
		timeline.setAttribute('aria-valuetext', 'Empty routine');
		return;
	}
	const total = routineDuration(routine) || 1;
	const active = state.player?.index ?? -1;
	track.innerHTML = routine.steps
		.map((step, i) => {
			const span = step.hold / (step.speed || 1);
			const pct = (span / total) * 100;
			return `
				<button type="button" class="ch-seg${i === active ? ' is-active' : ''}" style="width:${pct}%"
					data-seg="${i}" title="${escapeHtml(step.slot)} · ${span.toFixed(1)}s"
					aria-label="Jump to step ${i + 1}, ${escapeHtml(step.slot)}">
					<span class="ch-seg-icon" aria-hidden="true">${SLOT_ICONS[step.slot] || '🎞️'}</span>
					<span class="ch-seg-label">${escapeHtml(step.slot)}</span>
				</button>`;
		})
		.join('');
	timeline.setAttribute('aria-valuemax', String(total));
	renderPlayhead();
}

function renderPlayhead() {
	const head = el('playhead');
	const routine = currentRoutine();
	if (!routine || !state.player) {
		head.hidden = true;
		return;
	}
	const total = routineDuration(routine) || 1;
	const t = state.player.time;
	head.hidden = false;
	head.style.left = `${Math.min(100, (t / total) * 100)}%`;
	el('time').textContent = t.toFixed(1);
	const timeline = el('timeline');
	timeline.setAttribute('aria-valuenow', String(t));
	const step = routine.steps[state.player.index];
	timeline.setAttribute(
		'aria-valuetext',
		step ? `${t.toFixed(1)} seconds, ${step.slot}` : `${t.toFixed(1)} seconds`,
	);
}

function highlightActive() {
	const active = state.player?.index ?? -1;
	for (const seg of el('timeline-track').querySelectorAll('.ch-seg')) {
		seg.classList.toggle('is-active', Number(seg.dataset.seg) === active);
	}
	for (const row of el('steps').querySelectorAll('.ch-step')) {
		row.classList.toggle('is-active', Number(row.dataset.index) === active);
	}
}

/* ── render: exports ───────────────────────────────────────────────────── */

function renderExports() {
	const routine = currentRoutine();
	const json = routine
		? JSON.stringify({ choreographies: [routine] }, null, 2)
		: '// Add a step to see the payload.';
	$('code', el('json-code')).textContent = json;

	const id = routine?.id || 'routine';
	const snippet = routine
		? `<agent-3d agent="YOUR_AGENT_ID"></agent-3d>\n\n<script type="module">\n  const el = document.querySelector('agent-3d');\n  // Saved on the agent, so it plays by name:\n  el.playRoutine(${JSON.stringify(id)});\n<\/script>`
		: '// Add a step to see the snippet.';
	$('code', el('embed-code')).textContent = snippet;
	syncUrl();
}

function renderSave() {
	const panel = el('save-panel');
	const signedOut = el('save-signedout');
	const agents = state.agents;
	if (agents === null) {
		// Still loading: show neither rather than flashing "sign in" at someone
		// who is in fact signed in.
		panel.hidden = true;
		signedOut.hidden = true;
		return;
	}
	if (!agents.length) {
		panel.hidden = true;
		signedOut.hidden = false;
		return;
	}
	signedOut.hidden = true;
	panel.hidden = false;
	const select = el('agent-select');
	if (select.dataset.filled !== String(agents.length)) {
		select.dataset.filled = String(agents.length);
		select.innerHTML = agents
			.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}</option>`)
			.join('');
	}
	renderSavedRoutines();
}

/** Routines already stored on the selected agent, each loadable in one click. */
function renderSavedRoutines() {
	const box = el('saved');
	const agent = (state.agents || []).find((a) => a.id === el('agent-select')?.value);
	const list = Array.isArray(agent?.meta?.choreographies) ? agent.meta.choreographies : [];
	if (!list.length) {
		box.hidden = true;
		return;
	}
	box.hidden = false;
	el('saved-list').innerHTML = list
		.map((r, i) => {
			let seconds = 0;
			try {
				seconds = routineDuration(normalizeRoutine(r));
			} catch {
				return '';
			}
			return `
				<button type="button" class="ch-saved-chip" data-saved="${i}">
					<span class="ch-saved-name">${escapeHtml(r.name || r.id)}</span>
					<span class="ch-saved-meta">${r.steps?.length || 0} steps · ${seconds}s</span>
				</button>`;
		})
		.join('');
}

/* ── editing ───────────────────────────────────────────────────────────── */

/** Every mutation funnels through here so the URL, exports and stage agree. */
function commit({ restage = true } = {}) {
	// Any edit answers the "your link was broken" notice: the routine on screen
	// is now the user's own, so the warning about the one they arrived with is
	// stale.
	setNotice('');
	renderSteps();
	if (restage) restageIfPlaying();
	highlightActive();
}

function addStep(slot) {
	if (state.steps.length >= MAX_STEPS) {
		setStatus(`A routine holds at most ${MAX_STEPS} steps.`);
		return;
	}
	state.steps.push({ slot, clip: null, hold: DEFAULT_HOLD, speed: 1 });
	commit({ restage: false });
	// Adding a step should show you the step you just added, not restart the
	// routine from the top.
	playFrom(state.steps.length - 1);
	setStatus(`Added ${slot}. ${state.steps.length} steps.`);
}

function removeStep(i) {
	const [removed] = state.steps.splice(i, 1);
	if (!state.steps.length) stopPlayback();
	commit();
	setStatus(`Removed ${removed?.slot ?? 'step'}.`);
}

function moveStep(from, to) {
	if (to < 0 || to >= state.steps.length) return;
	const [step] = state.steps.splice(from, 1);
	state.steps.splice(to, 0, step);
	commit();
	setStatus(`Moved ${step.slot} to position ${to + 1}.`);
	// Keep the keyboard on the button the user just pressed.
	el('steps')
		.querySelector(`.ch-step[data-index="${to}"] [data-act="${to > from ? 'down' : 'up'}"]`)
		?.focus();
}

/* ── playback ──────────────────────────────────────────────────────────── */

function setStatus(text) {
	el('stage-status').textContent = text;
}

/**
 * The one message that gets its own visible slot. `setStatus` writes to a
 * screen-reader live region, which is right for play/pause chatter and wrong
 * for "your link was broken": a sighted user arriving on a bad share link would
 * otherwise see a routine they did not ask for and no explanation.
 * @param {string} text (empty to clear)
 */
function setNotice(text) {
	const box = el('notice');
	box.textContent = text;
	box.hidden = !text;
}

function setStageState(name, detail = '') {
	el('stage-empty').hidden = name !== 'empty';
	el('stage-loading').hidden = name !== 'loading';
	el('stage-error').hidden = name !== 'error';
	if (name === 'error' && detail) el('stage-error-title').textContent = detail;
}

async function getPreview() {
	if (!state.preview) {
		const mod = await import('./animations-live-preview.js');
		state.preview = mod.getLivePreview();
	}
	return state.preview;
}

/** Manifest def for a step's clip, or null when the clip is not in the library. */
function defFor(step) {
	const clip = stepClip(step);
	const def = state.byName.get(clip);
	return def ? { id: clip, source: 'curated', url: def.url, loop: def.loop !== false } : null;
}

/**
 * Mount a step on the stage. Steps after the first crossfade into place, and
 * the camera is framed once for the whole routine so it does not jog at cuts.
 */
async function stageStep(step, { crossfade = true } = {}) {
	const def = defFor(step);
	if (!def) {
		setStageState('error', `"${stepClip(step)}" is not in the clip manifest.`);
		return;
	}
	const gen = state.startGen;
	const preview = await getPreview();
	const bounds = state.boundClips || [];
	try {
		await preview.play(el('stage'), def, {
			speed: step.speed,
			crossfade: crossfade && state.stagedClip ? CROSSFADE : 0,
			frameWith: bounds.filter(Boolean),
		});
		// Stopped or restarted while this clip was binding: whatever is on the
		// stage now is the routine the user asked for, so leave it alone.
		if (gen !== state.startGen) return;
		state.stagedClip = def.id;
		setStageState('none');
		el('stage-badge').hidden = false;
		el('stage-badge').textContent = `${step.slot} · ${clipLabel(def.id)}`;
	} catch (err) {
		if (gen !== state.startGen) return;
		setStageState('error', err?.message ? `Preview failed: ${err.message}` : undefined);
	}
}

/** Bind every clip in the routine up front so no cut waits on a fetch. */
async function prepareClips(routine) {
	const preview = await getPreview();
	const defs = routine.steps.map(defFor).filter(Boolean);
	state.boundClips = await preview.prepare(defs);
}

/**
 * Cue the routine and start it.
 * @param {number} [fromIndex] step to open on
 * @returns {Promise<boolean>} false when a newer start or a stop took the stage
 *   before this one finished binding, so callers can skip their follow-up.
 */
async function startPlayback(fromIndex = 0) {
	const routine = currentRoutine();
	if (!routine) return false;

	stopRaf();
	el('stage-loading-text').textContent =
		state.stagedClip ? 'Cueing the routine…' : 'Retargeting the routine…';
	if (!state.stagedClip) setStageState('loading');
	// Flip the transport before the await. Binding every clip in the routine can
	// take seconds on a cold first play, and a play button that still reads "▶"
	// while the stage spins reads as a click that did not register.
	setPlayButton(true);
	state.starting = true;
	const gen = ++state.startGen;

	await prepareClips(routine);
	if (gen !== state.startGen) return false;
	state.starting = false;

	state.player = new RoutinePlayer(routine, {
		loop: state.loop,
		onStep: (step) => {
			stageStep(step);
			highlightActive();
			renderTimeline();
		},
		onTick: () => renderPlayhead(),
		onEnd: () => {
			setPlayButton(false);
			setStatus('Routine finished.');
			renderPlayhead();
		},
	});
	state.player.start();
	if (fromIndex > 0) state.player.seek(stepOffsets(routine)[fromIndex] ?? 0);
	setPlayButton(true);
	startRaf();
	setStatus(`Playing ${routine.name}, ${routine.steps.length} steps.`);
	return true;
}

function playFrom(index) {
	startPlayback(index);
}

function stopPlayback() {
	stopRaf();
	state.startGen++;
	state.starting = false;
	state.player = null;
	state.stagedClip = null;
	state.preview?.stop();
	setPlayButton(false);
	setStageState('empty');
	el('stage-badge').hidden = true;
	el('playhead').hidden = true;
	el('time').textContent = '0.0';
	highlightActive();
}

/** Re-cue the stage after an edit, but only if something was already playing. */
function restageIfPlaying() {
	if (!state.player) return;
	const wasPlaying = state.player.playing;
	const at = state.player.time;
	const routine = currentRoutine();
	if (!routine) {
		stopPlayback();
		return;
	}
	startPlayback(0).then((ok) => {
		if (!ok || !state.player) return;
		state.player.seek(Math.min(at, routineDuration(routine)));
		if (!wasPlaying) {
			state.player.pause();
			setPlayButton(false);
		}
		renderPlayhead();
	});
}

function setPlayButton(playing) {
	const btn = el('play');
	btn.textContent = playing ? '❙❙' : '▶';
	btn.setAttribute('aria-label', playing ? 'Pause routine' : 'Play routine');
	btn.title = playing ? 'Pause (Space)' : 'Play (Space)';
}

function startRaf() {
	stopRaf();
	state.lastT = performance.now();
	const tick = () => {
		state.raf = requestAnimationFrame(tick);
		const now = performance.now();
		const dt = Math.min(0.1, (now - state.lastT) / 1000);
		state.lastT = now;
		state.player?.update(dt);
	};
	state.raf = requestAnimationFrame(tick);
}

function stopRaf() {
	cancelAnimationFrame(state.raf);
	state.raf = 0;
}

function togglePlay() {
	if (!state.steps.length) return;
	if (state.starting) {
		// The transport already reads "pause" while the clips bind, so pressing it
		// has to call that load off. Without this it would queue a second copy of
		// the same load behind the first and leave the user watching the spinner
		// they were trying to dismiss.
		stopPlayback();
		setStatus('Stopped before the routine started.');
		return;
	}
	if (!state.player) {
		startPlayback(0);
		return;
	}
	if (state.player.playing) {
		state.player.pause();
		state.preview?.setPaused(true);
		setPlayButton(false);
		setStatus('Paused.');
	} else {
		// A player parked at the very end restarts rather than sitting still.
		if (state.player.time >= state.player.duration) state.player.start();
		else state.player.resume();
		state.preview?.setPaused(false);
		setPlayButton(true);
		setStatus('Playing.');
	}
}

function scrubTo(seconds) {
	const routine = currentRoutine();
	if (!routine) return;
	if (!state.player) {
		startPlayback(0).then((ok) => {
			if (!ok) return;
			state.player?.seek(seconds);
			state.player?.pause();
			setPlayButton(false);
			renderPlayhead();
		});
		return;
	}
	state.player.seek(seconds);
	renderPlayhead();
	highlightActive();
}

/* ── url state ─────────────────────────────────────────────────────────── */

/** The query key a routine travels in. */
const ROUTINE_PARAM = 'r';

/**
 * The raw `?r=` value, read without decoding it.
 *
 * `encodeRoutine` already escapes the routine name, and the `|` `,` `:` `*` `@`
 * it separates steps with are all legal in a query string, so the encoded
 * routine belongs in the URL verbatim. Handing it to `URLSearchParams` instead
 * would escape its percent signs a second time, so the share link for a routine
 * called "The pitch" read `?r=The%2520pitch|…`, and reading it back through
 * `URLSearchParams.get` would strip exactly one layer, turning a name that
 * legitimately contains an escaped `|` into a raw bar that splits the routine on
 * the wrong character.
 *
 * @returns {string|null}
 */
function readEncodedRoutine() {
	for (const pair of window.location.search.replace(/^\?/, '').split('&')) {
		if (pair.startsWith(`${ROUTINE_PARAM}=`)) return pair.slice(ROUTINE_PARAM.length + 1);
	}
	return null;
}

function syncUrl() {
	const routine = currentRoutine();
	const url = new URL(window.location.href);
	url.searchParams.delete(ROUTINE_PARAM);
	const others = url.searchParams.toString();
	const mine = routine ? `${ROUTINE_PARAM}=${encodeRoutine(routine)}` : '';
	url.search = [others, mine].filter(Boolean).join('&');
	window.history.replaceState(null, '', url);
}

function loadRoutine(routine, { announce = true } = {}) {
	const normalized = normalizeRoutine(routine);
	state.name = normalized.name;
	state.steps = normalized.steps.map((s) => ({ ...s }));
	state.loop = normalized.loop;
	el('name').value = state.name;
	el('loop').setAttribute('aria-pressed', String(state.loop));
	el('loop').classList.toggle('is-on', state.loop);
	commit({ restage: false });
	if (announce) setStatus(`Loaded ${normalized.name}: ${normalized.steps.length} steps.`);
}

/**
 * Load the routine in `?r=`, if there is one.
 * @returns {string|null} an error to show the user, or null when there was
 *   nothing to load or it loaded cleanly. Returning the message rather than
 *   announcing it lets the caller decide the final wording: a bad link falls
 *   back to a preset, and "could not read your link" plus "here is a starting
 *   point instead" belong in one sentence, not two that overwrite each other.
 */
function applyDeepLink() {
	const encoded = readEncodedRoutine();
	if (!encoded) return null;
	// Links shared before the studio wrote its own query carry one extra layer of
	// escaping. A value that does not parse as-is gets one decode and a second
	// chance, so every link that used to work still does.
	const candidates = [encoded];
	try {
		const once = decodeURIComponent(encoded);
		if (once !== encoded) candidates.push(once);
	} catch {
		// A lone percent sign means it was never double-escaped: nothing to retry.
	}
	let firstError = null;
	for (const candidate of candidates) {
		try {
			loadRoutine(decodeRoutine(candidate), { announce: false });
			setStatus(`Loaded a shared routine: ${state.name}.`);
			state.loadedFromLink = true;
			return null;
		} catch (err) {
			firstError ??= err.message;
		}
	}
	return firstError;
}

/* ── saving ────────────────────────────────────────────────────────────── */

async function copy(text, btn, label = 'Copy') {
	try {
		await navigator.clipboard.writeText(text);
		btn.textContent = 'Copied';
	} catch {
		btn.textContent = 'Copy blocked, select it by hand';
	}
	setTimeout(() => {
		btn.textContent = label;
	}, 1800);
}

async function saveToAgent() {
	const routine = currentRoutine();
	if (!routine) return;
	const btn = el('save');
	const status = el('save-status');
	const agentId = el('agent-select').value;
	const agent = (state.agents || []).find((a) => a.id === agentId);
	if (!agentId) return;

	// Merge by id: saving "welcome" twice replaces it rather than stacking a
	// second copy the owner would have to hunt down and delete.
	const existing = Array.isArray(agent?.meta?.choreographies) ? agent.meta.choreographies : [];
	const merged = existing.filter((r) => slugify(r?.id || r?.name || '') !== routine.id);
	merged.push(routine);

	btn.disabled = true;
	status.textContent = 'Saving…';
	status.className = 'ch-save-status';
	try {
		const { apiFetch } = await import('./api.js');
		const res = await apiFetch(`/api/agents/${agentId}/animations`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ choreographies: merged }),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body.error_description || body.error || `HTTP ${res.status}`);
		}
		const saved = await res.json();
		// Keep the local copy in step so a second save merges against the truth.
		if (agent) {
			agent.meta = { ...(agent.meta || {}), choreographies: saved.choreographies || [] };
		}
		const count = (saved.choreographies || []).length;
		status.innerHTML = `Saved as <code>${escapeHtml(routine.id)}</code>. <a href="/a/${escapeHtml(
			agentId,
		)}">Open ${escapeHtml(agent?.name || 'the agent')}</a> · ${count} routine${
			count === 1 ? '' : 's'
		} in total.`;
		status.className = 'ch-save-status is-ok';
		renderSavedRoutines();
	} catch (err) {
		status.textContent = `Could not save: ${err.message}`;
		status.className = 'ch-save-status is-err';
	} finally {
		btn.disabled = false;
	}
}

/* ── events ────────────────────────────────────────────────────────────── */

function wire() {
	el('presets').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-preset]');
		if (!btn) return;
		const preset = PRESET_ROUTINES.find((p) => p.id === btn.dataset.preset);
		if (!preset) return;
		loadRoutine(preset);
		startPlayback(0);
	});

	el('palette').addEventListener('click', (e) => {
		const chip = e.target.closest('[data-slot]');
		if (chip) addStep(chip.dataset.slot);
	});

	el('name').addEventListener('input', (e) => {
		state.name = e.target.value.slice(0, 40);
		renderMeta();
		renderExports();
	});

	// Step edits. One delegated listener for the whole list: rows are re-rendered
	// on every change, so per-row listeners would leak with each edit.
	const steps = el('steps');
	steps.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-act]');
		if (!btn) return;
		const i = Number(btn.dataset.index);
		if (btn.dataset.act === 'remove') removeStep(i);
		else if (btn.dataset.act === 'up') moveStep(i, i - 1);
		else if (btn.dataset.act === 'down') moveStep(i, i + 1);
	});

	steps.addEventListener('input', (e) => {
		const input = e.target.closest('[data-act="hold"]');
		if (!input) return;
		const i = Number(input.dataset.index);
		state.steps[i].hold = Number(input.value);
		// Live feedback while dragging, without re-rendering the row under the
		// pointer (which would drop the drag).
		input.parentElement.querySelector('.ch-step-secs').textContent =
			`${state.steps[i].hold.toFixed(1)}s`;
		renderMeta();
		renderTimeline();
		renderExports();
	});

	steps.addEventListener('change', (e) => {
		const control = e.target.closest('[data-act]');
		if (!control) return;
		const i = Number(control.dataset.index);
		if (control.dataset.act === 'clip') {
			const picked = control.value;
			state.steps[i].clip = picked === DEFAULT_ANIMATION_MAP[state.steps[i].slot] ? null : picked;
			commit();
			playFrom(i);
		} else if (control.dataset.act === 'speed') {
			state.steps[i].speed = Number(control.value);
			commit();
		} else if (control.dataset.act === 'hold') {
			commit();
		}
	});

	// Drag to reorder. The keyboard equivalent is the ↑/↓ buttons on every row,
	// so reordering never requires a pointer.
	steps.addEventListener('dragstart', (e) => {
		const row = e.target.closest('.ch-step');
		if (!row) return;
		state.dragIndex = Number(row.dataset.index);
		row.classList.add('is-dragging');
		e.dataTransfer.effectAllowed = 'move';
		// Firefox refuses to start a drag without payload.
		e.dataTransfer.setData('text/plain', String(state.dragIndex));
	});
	steps.addEventListener('dragover', (e) => {
		const row = e.target.closest('.ch-step');
		if (!row || state.dragIndex < 0) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		for (const r of steps.querySelectorAll('.ch-step')) r.classList.remove('is-drop-target');
		row.classList.add('is-drop-target');
	});
	steps.addEventListener('drop', (e) => {
		const row = e.target.closest('.ch-step');
		if (!row || state.dragIndex < 0) return;
		e.preventDefault();
		const to = Number(row.dataset.index);
		if (to !== state.dragIndex) moveStep(state.dragIndex, to);
		state.dragIndex = -1;
	});
	steps.addEventListener('dragend', () => {
		state.dragIndex = -1;
		for (const r of steps.querySelectorAll('.ch-step')) {
			r.classList.remove('is-dragging', 'is-drop-target');
		}
	});

	el('play').addEventListener('click', togglePlay);
	el('restart').addEventListener('click', () => startPlayback(0));
	el('loop').addEventListener('click', (e) => {
		state.loop = !state.loop;
		e.currentTarget.setAttribute('aria-pressed', String(state.loop));
		e.currentTarget.classList.toggle('is-on', state.loop);
		if (state.player) state.player.loop = state.loop;
		renderExports();
		setStatus(state.loop ? 'Looping.' : 'Playing once.');
	});
	el('stage-retry').addEventListener('click', () => startPlayback(0));

	// The timeline is both a scrubber and a step picker: clicking a segment jumps
	// to that beat, dragging anywhere scrubs.
	const timeline = el('timeline');
	const seek = (clientX) => {
		const routine = currentRoutine();
		if (!routine) return;
		const rect = timeline.getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		scrubTo(ratio * routineDuration(routine));
	};
	timeline.addEventListener('pointerdown', (e) => {
		timeline.setPointerCapture(e.pointerId);
		timeline.dataset.scrubbing = '1';
		seek(e.clientX);
	});
	timeline.addEventListener('pointermove', (e) => {
		if (timeline.dataset.scrubbing) seek(e.clientX);
	});
	const endScrub = (e) => {
		delete timeline.dataset.scrubbing;
		if (e.pointerId != null && timeline.hasPointerCapture?.(e.pointerId)) {
			timeline.releasePointerCapture(e.pointerId);
		}
	};
	timeline.addEventListener('pointerup', endScrub);
	timeline.addEventListener('pointercancel', endScrub);
	timeline.addEventListener('keydown', (e) => {
		const routine = currentRoutine();
		if (!routine) return;
		const total = routineDuration(routine);
		const at = state.player?.time ?? 0;
		const moves = { ArrowLeft: -0.25, ArrowRight: 0.25, Home: -total, End: total };
		if (!(e.key in moves)) return;
		e.preventDefault();
		scrubTo(Math.min(total, Math.max(0, e.key === 'Home' ? 0 : e.key === 'End' ? total : at + moves[e.key])));
	});

	el('save').addEventListener('click', saveToAgent);
	el('agent-select').addEventListener('change', renderSavedRoutines);
	el('saved-list').addEventListener('click', (e) => {
		const chip = e.target.closest('[data-saved]');
		if (!chip) return;
		const agent = (state.agents || []).find((a) => a.id === el('agent-select').value);
		const routine = agent?.meta?.choreographies?.[Number(chip.dataset.saved)];
		if (!routine) return;
		try {
			loadRoutine(routine);
			startPlayback(0);
		} catch (err) {
			setStatus(`That saved routine could not be loaded (${err.message}).`);
		}
	});

	const shareLink = (e) => {
		syncUrl();
		copy(window.location.href, e.currentTarget, 'Copy share link');
	};
	el('share').addEventListener('click', shareLink);
	el('share-2').addEventListener('click', shareLink);
	el('copy-json').addEventListener('click', (e) =>
		copy($('code', el('json-code')).textContent, e.currentTarget, 'Copy JSON'),
	);
	el('copy-embed').addEventListener('click', (e) =>
		copy($('code', el('embed-code')).textContent, e.currentTarget, 'Copy snippet'),
	);

	document.addEventListener('keydown', (e) => {
		// Never steal a key from a field the user is typing in.
		const tag = e.target.tagName;
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
		if (e.key === ' ' && state.steps.length) {
			e.preventDefault();
			togglePlay();
		} else if (e.key === 'r' || e.key === 'R') {
			if (state.steps.length) startPlayback(0);
		} else if (e.key === 'Escape' && state.player) {
			stopPlayback();
			setStatus('Stopped.');
		}
	});

	// Stop burning frames on a hidden tab without stomping a deliberate pause.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			stopRaf();
			state.preview?.setPaused(true);
		} else if (state.player?.playing) {
			state.preview?.setPaused(false);
			startRaf();
		}
	});
}

/* ── boot ──────────────────────────────────────────────────────────────── */

renderPresets();
wire();
loadManifest();
loadAgents();
const linkError = applyDeepLink();
if (!state.loadedFromLink) {
	// An empty timeline is the hardest screen to start on, so the page opens on a
	// real routine. Nothing 3D loads until the user presses play.
	loadRoutine(PRESET_ROUTINES[0], { announce: false });
	const opening = linkError
		? `That shared routine could not be read (${linkError}). Loaded the Welcome routine instead.`
		: 'Loaded the Welcome routine. Press play, or change any step.';
	setStatus(opening);
	if (linkError) setNotice(opening);
}
