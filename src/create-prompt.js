/**
 * Prompt → 3D avatar controller for /create/prompt.
 *
 * Flow (reuses the same backend as the selfie pipeline):
 *   prompt text
 *     -> POST /api/avatars/reconstruct { name, prompt, visibility }
 *          (server turns the prompt into a frontal reference image via Flux,
 *           then runs the identical reconstruct -> auto-rig pipeline)
 *     -> poll /api/avatars/regenerate-status?jobId=...
 *     -> on { status:'done', resultAvatarId } -> fetch the avatar, preview it,
 *        and offer "Open in editor" / "Make another"
 *
 * Every state is designed: compose, building (with live status + elapsed),
 * done (with a real preview), and inline errors that tell the user what to do.
 */

import { log } from './shared/log.js';
import { injectFestivePresets } from './shared/festive-presets.js';
import { mountPromptDictation } from './voice/prompt-dictation.js';

const SUBMIT_ENDPOINT = '/api/avatars/reconstruct';
const STATUS_ENDPOINT = '/api/avatars/regenerate-status';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 8 * 60 * 1000;

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

const promptEl = /** @type {HTMLTextAreaElement} */ ($('#prompt'));
const counterEl = $('#counter');
const generateBtn = /** @type {HTMLButtonElement} */ ($('#generate-btn'));
const composeError = $('#compose-error');
const buildError = $('#build-error');
const buildPrompt = $('#build-prompt');
const buildStatus = $('#build-status');
const progressFill = $('#progress-fill');
const elapsedEl = $('#elapsed');

// Voice → prompt: dictate the avatar description instead of typing it. Feeds
// the exact same #prompt textarea /api/avatars/reconstruct already consumes —
// no new generation path, just a new way to fill the existing one. Renders
// nothing when this browser can't dictate (see prompt-dictation.js).
mountPromptDictation($('#prompt-dictate-slot'), promptEl);

let _submitting = false;
let _startedAt = 0;
let _elapsedTimer = 0;
let _aborter = /** @type {AbortController | null} */ (null);
let _stallNoted = false;

// Monotonic build token. Every start() claims the next one; cancelling or
// returning to compose burns the current token. A run whose token is no longer
// current is "stale" and must not touch the UI: without this, cancelling a
// build and immediately starting another let the abandoned poll loop wake from
// its sleep, keep polling the old job, and drop the OLD avatar onto the done
// screen while the NEW build was still running.
let _runId = 0;
const isStale = (run) => run !== _runId;

function showStep(step) {
	for (const el of document.querySelectorAll('.step')) {
		el.classList.toggle('active', el.getAttribute('data-step') === step);
	}
}

function setError(box, message) {
	if (message) {
		box.innerHTML = message;
		box.classList.add('show');
	} else {
		box.textContent = '';
		box.classList.remove('show');
	}
}

// ── Compose ─────────────────────────────────────────────────────────────────

function updateCounter() {
	const n = promptEl.value.length;
	counterEl.textContent = `${n} / 600`;
	counterEl.classList.toggle('warn', n > 600);
	generateBtn.disabled = promptEl.value.trim().length < 3 || _submitting;
}

promptEl.addEventListener('input', () => {
	updateCounter();
	if (composeError.classList.contains('show')) setError(composeError, '');
});

// Cmd/Ctrl+Enter submits.
promptEl.addEventListener('keydown', (e) => {
	if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !generateBtn.disabled) {
		e.preventDefault();
		start();
	}
});

// Independence Day (July 1–5, viewer's local time): prepend a set of themed
// "Made in America" avatar presets so the seasonal moment reaches the create
// flow, not just the homepage. They self-retire outside the window and are
// wired through the same generic handler below (fill the composer — no submit).
injectFestivePresets({
	container: document.querySelector('.examples'),
	prompts: [
		'Uncle Sam in a star-spangled top hat and tailcoat, confident stance',
		'A bald eagle mascot in a blue bomber jacket, wings folded, proud pose',
		'Lady Liberty reimagined as a hero, flowing robe, torch raised high',
		'A firework sparkler sprite, glowing red-white-and-blue trails, cheerful',
	],
});

for (const chip of document.querySelectorAll('.example')) {
	chip.addEventListener('click', () => {
		promptEl.value = chip.textContent.trim();
		updateCounter();
		promptEl.focus();
	});
}

$('#back-btn').addEventListener('click', () => {
	if (history.length > 1) history.back();
	else window.location.href = '/create';
});

generateBtn.addEventListener('click', start);

// ── Submit + poll ────────────────────────────────────────────────────────────

function nameFromPrompt(prompt) {
	const words = prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
	return (words.length > 60 ? words.slice(0, 60) : words) || 'Prompt avatar';
}

async function start() {
	if (_submitting) return;
	const prompt = promptEl.value.trim();
	if (prompt.length < 3) {
		setError(composeError, 'Add a few words describing what you want.');
		return;
	}

	const run = ++_runId;
	_submitting = true;
	_stallNoted = false;
	_aborter = new AbortController();
	generateBtn.disabled = true;
	setError(composeError, '');

	buildPrompt.textContent = `“${prompt}”`;
	setError(buildError, '');
	// Seed the first progress band so the bar creeps from the very first second.
	_phaseFloor = PHASE.queued.floor;
	_phaseCeil = PHASE.queued.ceil;
	_phaseStartedAt = Date.now();
	setProgress(PHASE.queued.floor, 'Rendering a reference image…');
	startElapsed();
	showStep('building');

	let jobId;
	try {
		const res = await fetch(SUBMIT_ENDPOINT, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: nameFromPrompt(prompt), prompt, visibility: 'private' }),
			signal: _aborter.signal,
		});
		if (res.status === 401) {
			window.location.assign(`/login?next=${encodeURIComponent('/create/prompt')}`);
			return;
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data.jobId) {
			throw new ApiError(mapSubmitError(res.status, data));
		}
		jobId = data.jobId;
	} catch (err) {
		if (_cancelled || err?.name === 'AbortError') return;
		failBuild(err);
		return;
	}

	try {
		const final = await pollUntilDone(jobId);
		await renderDone(final.resultAvatarId);
	} catch (err) {
		if (_cancelled || err?.name === 'AbortError') return;
		failBuild(err);
	}
}

// Cancel an in-flight build: abort the network, stop the clock, and return to
// the compose step. The job may still finish server-side (and will appear on the
// dashboard) — we just stop watching it, so the user is never trapped on a
// spinner.
function cancelBuild() {
	if (!_submitting) return;
	_cancelled = true;
	try { _aborter?.abort(); } catch (_) {}
	resetToCompose();
}

class ApiError extends Error {}

/** @param {string | null | undefined} raw */
function friendlyJobError(raw) {
	if (!raw) return 'Generation failed. Try a different prompt.';
	const lower = raw.toLowerCase();
	if (lower.includes('face') && (lower.includes('detect') || lower.includes('no face')))
		return 'Couldn\'t find a face in the generated reference image. Try rewording your prompt to describe the person more clearly.';
	if (lower.includes('nsfw'))
		return 'Content safety blocked this image. Try a different prompt.';
	if (lower.includes('unreachable') || lower.includes('502') || lower.includes('503'))
		return 'The avatar engine is temporarily unavailable. Try again in a few minutes.';
	if (lower.includes('timeout') || lower.includes('timed out'))
		return 'The engine took too long. Try again in a moment.';
	if (lower.includes('oom') || lower.includes('memory'))
		return 'The engine ran out of resources. Try a simpler prompt.';
	return 'Generation failed. Try a different prompt.';
}

function mapSubmitError(status, data) {
	// The API error envelope is { error: <code string>, error_description: <message> }
	// (see api/_lib/http.js error()). Read those fields directly — older code that
	// reached for data.error.code / data.message never matched and collapsed every
	// failure into the generic fallback, hiding the real reason from the user.
	const code = typeof data?.error === 'string' ? data.error : data?.code;
	const description = data?.error_description;
	if (code === 'txt2img_rate_limited' || status === 429) {
		return 'The image engine is busy right now — wait a moment and try again.';
	}
	if (code === 'regen_unconfigured' || code === 'txt2img_unconfigured') {
		return 'The avatar generator isn\'t configured on this deployment yet. Try the <a href="/create/selfie">selfie scanner</a> instead.';
	}
	if (code === 'txt2img_billing') return 'The image engine is temporarily unavailable (provider billing). Try again later.';
	if (code === 'txt2img_unreachable') return 'Couldn\'t reach the image engine. Check your connection and try again.';
	if (code === 'txt2img_error') return 'Couldn\'t render a reference image from that prompt. Try rewording it.';
	if (code === 'regen_needs_byok')
		return 'Avatar generation needs a 3D engine key on this deployment. Add a Meshy or Tripo key in <a href="/settings">settings</a>, or try the <a href="/create/selfie">selfie scanner</a>.';
	// Reached only after the server has tried every configured backend (platform
	// providers + your BYOK keys) and all of them failed — so this is a genuine
	// transient outage, not a single-provider hiccup. Offer the photo path as an
	// immediate alternative rather than leaving the user to guess.
	if (code === 'regen_provider_error')
		return 'The avatar engines are all busy right now. Try again in a moment, or use the <a href="/create/selfie">selfie scanner</a> instead.';
	return description || `The avatar engine returned ${status}. Try again.`;
}

async function pollUntilDone(jobId) {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (_cancelled) {
			const e = new Error('cancelled');
			e.name = 'AbortError';
			throw e;
		}
		await sleep(POLL_INTERVAL_MS);
		let data;
		try {
			const res = await fetch(`${STATUS_ENDPOINT}?jobId=${encodeURIComponent(jobId)}`, {
				credentials: 'include',
				signal: _aborter?.signal,
			});
			if (res.status === 401) {
				window.location.assign(`/login?next=${encodeURIComponent('/create/prompt')}`);
				throw new ApiError('redirecting');
			}
			data = await res.json().catch(() => ({}));
			if (!res.ok) throw new ApiError(data?.error_description || `status ${res.status}`);
		} catch (err) {
			if (err?.name === 'AbortError') throw err;
			if (err instanceof ApiError) throw err;
			// Transient network blip — keep polling until the deadline.
			log.warn('[create-prompt] poll blip', err);
			continue;
		}

		advanceProgress(data.status);

		if (data.status === 'done' && data.resultAvatarId) {
			setProgress(100, 'Done.');
			return data;
		}
		if (data.status === 'failed') {
			throw new ApiError(friendlyJobError(data.error));
		}

		// Soft stall note: if it's still running well past the typical minute,
		// reassure rather than fail — the hard deadline below still hands off to
		// the dashboard, and Cancel is always available.
		if (!_stallNoted && Date.now() - _startedAt > 5 * 60 * 1000) {
			_stallNoted = true;
			buildStatus.textContent = 'Still working — this one is taking a little longer than usual…';
		}
	}
	throw new ApiError('This is taking longer than expected. Your avatar may still finish — check your dashboard in a minute.');
}

// Map backend job states to human progress. Each state owns a [floor, ceil]
// band; the bar eases toward the band's ceil from REAL elapsed-in-phase time
// (never reaching it), so it advances every second instead of freezing for the
// minutes a phase takes — yet a true state transition still produces a visible
// forward jump to the next band's floor. Honest on both axes: motion is tied to
// the wall clock, jumps are tied to real backend state.
const PHASE = {
	queued: { floor: 8, ceil: 18, label: 'Rendering a reference image…' },
	running: { floor: 18, ceil: 55, label: 'Reconstructing it into 3D…' },
	rigging: { floor: 55, ceil: 85, label: 'Adding a skeleton so it can move…' },
};
const CREEP_TAU_MS = 40_000; // ~63% of the band consumed by 40s in-phase.
let _phaseFloor = 8;
let _phaseCeil = 18;
let _phaseStartedAt = 0;

function advanceProgress(status) {
	const phase = PHASE[status];
	if (!phase) return;
	// Reset the band only on a real forward transition, so the creep doesn't
	// restart every poll while the status is unchanged.
	if (phase.floor !== _phaseFloor || phase.ceil !== _phaseCeil) {
		_phaseFloor = phase.floor;
		_phaseCeil = phase.ceil;
		_phaseStartedAt = Date.now();
	}
	buildStatus.textContent = phase.label;
	tickProgress();
}

// Drive the within-phase creep from elapsed-in-phase time. Called every second
// by the elapsed clock and once on each transition.
function tickProgress() {
	if (!_phaseStartedAt) return;
	const t = (Date.now() - _phaseStartedAt) / CREEP_TAU_MS;
	setProgressWidth(_phaseFloor + (_phaseCeil - _phaseFloor) * (1 - Math.exp(-t)));
}

function setProgress(pct, label) {
	setProgressWidth(pct);
	if (label) buildStatus.textContent = label;
}
function setProgressWidth(pct) {
	const clamped = Math.min(100, Math.max(0, pct));
	progressFill.style.width = `${clamped.toFixed(1)}%`;
	const track = document.getElementById('progress-track');
	if (track) track.setAttribute('aria-valuenow', String(Math.round(clamped)));
}

// ── Done ─────────────────────────────────────────────────────────────────────

async function renderDone(avatarId) {
	let avatar = null;
	try {
		const res = await fetch(`/api/avatars/${encodeURIComponent(avatarId)}`, { credentials: 'include' });
		const data = await res.json().catch(() => ({}));
		avatar = data?.avatar || data || null;
	} catch (err) {
		log.warn('[create-prompt] could not fetch finished avatar', err);
	}

	const editorUrl = `/avatars/${encodeURIComponent(avatarId)}/edit`;
	$('#open-editor').setAttribute('href', editorUrl);
	$('#make-another').addEventListener('click', () => resetToCompose());

	// Private avatars (the default for this flow) have a null public model_url;
	// the owner's GET response carries a short-lived presigned `url` instead.
	// Read both so the "done" preview renders the result the user just made
	// rather than silently bouncing them to the editor.
	const modelUrl = avatar?.model_url || avatar?.url || avatar?.modelUrl;
	const viewer = /** @type {any} */ ($('#done-model'));
	if (modelUrl && viewer) viewer.setAttribute('src', modelUrl);
	// Honour reduced-motion: stop the preview from auto-spinning.
	if (viewer && prefersReducedMotion()) viewer.removeAttribute('auto-rotate');

	const rigged = avatar?.source_meta?.is_rigged ?? avatar?.tags?.includes?.('rigged');
	const tagsEl = $('#done-tags');
	tagsEl.innerHTML = '';
	const tag = (text, ok) => {
		const s = document.createElement('span');
		s.className = `tag${ok ? ' ok' : ''}`;
		s.textContent = text;
		tagsEl.appendChild(s);
	};
	if (rigged) tag('Animation-ready', true);
	else tag('Static mesh — riggable in editor', false);
	tag('Private to you', false);

	stopElapsed();
	// If the model can't render (no URL yet), go straight to the editor rather
	// than showing an empty viewer box.
	if (!modelUrl) {
		window.location.assign(editorUrl);
		return;
	}
	showStep('done');
	// Let the site-wide discovery layer offer the natural next steps
	// (Studio, agent wizard, Walk) with this avatar pre-loaded.
	document.dispatchEvent(
		new CustomEvent('tws:feature-done', {
			detail: {
				feature: 'prompt',
				avatarId,
				model: {
					glbUrl: modelUrl,
					label: avatar?.display_name || avatar?.name || 'Prompt avatar',
				},
			},
		}),
	);
}

function resetToCompose() {
	_submitting = false;
	stopElapsed();
	setError(composeError, '');
	updateCounter();
	showStep('compose');
	promptEl.focus();
}

// ── Failure ──────────────────────────────────────────────────────────────────

function failBuild(err) {
	if (err instanceof ApiError && err.message === 'redirecting') return;
	stopElapsed();
	_submitting = false;
	log.error('[create-prompt]', err);
	const message =
		err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
	// Two recovery paths: "Try again" re-submits the same prompt in place (the
	// textarea still holds it) for transient engine outages; "Edit prompt" returns
	// to compose to reword. Both keep the user moving instead of stranding them.
	setError(
		buildError,
		`<span>${message}</span>` +
			` <button type="button" id="build-retry-now" class="cancel-build" style="margin-left:10px">Try again</button>` +
			` <button type="button" id="build-edit" class="cancel-build" style="margin-left:8px">Edit prompt</button>`,
	);
	document.getElementById('build-retry-now')?.addEventListener('click', () => start());
	document.getElementById('build-edit')?.addEventListener('click', resetToCompose);
}

// ── Elapsed clock ────────────────────────────────────────────────────────────

function startElapsed() {
	_startedAt = Date.now();
	stopElapsed();
	_elapsedTimer = window.setInterval(() => {
		const s = Math.floor((Date.now() - _startedAt) / 1000);
		elapsedEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
		tickProgress();
	}, 1000);
}
function stopElapsed() {
	if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = 0; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prefersReducedMotion() {
	try {
		return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
	} catch (_) {
		return false;
	}
}

// Cancel button on the building screen — and Escape as a keyboard equivalent.
const cancelBtn = document.getElementById('cancel-build');
cancelBtn?.addEventListener('click', cancelBuild);
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && _submitting) cancelBuild();
});

// Deep link: /create/prompt?prompt=<text> prefills the composer, so "copy
// prompt" / "remix" buttons anywhere on the platform (galleries, agent
// profiles, external embedders) can hand a visitor a ready-to-run prompt.
// Same trust level as typing: the text just lands in the textarea; nothing
// auto-submits.
const linkedPrompt = new URLSearchParams(location.search).get('prompt');
if (linkedPrompt && !promptEl.value) {
	promptEl.value = linkedPrompt.slice(0, promptEl.maxLength > 0 ? promptEl.maxLength : 600);
}

updateCounter();
promptEl.focus();
