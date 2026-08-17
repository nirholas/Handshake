/**
 * Selfie pipeline -- bridges the capture UI on /create/selfie to the native
 * avatar reconstruction backend.
 *
 * Flow:
 *   [selfie:submit] -> downscale photos (frontal required, sides optional)
 *     -> dispatches selfie:preview { dataUrl } so the build view can show the
 *       user's own photo on a placeholder body while the real GLB renders
 *     -> POST /api/avatars/reconstruct
 *     -> dispatches selfie:building { jobId }
 *     -> poll /api/avatars/regenerate-status?jobId=...
 *     -> dispatches selfie:progress { label } on each poll tick
 *     -> on { status: 'done', resultAvatarId } -> dispatches selfie:done { avatarId }
 *     -> on { status: 'failed' } or timeout -> dispatches selfie:build-error
 *         { message, slot? } where slot is the photo that likely caused the failure
 */

import { assessPhoto, refineSelfie, warmRefiner } from './selfie-refine.js';
import { log } from './shared/log.js';

// Prefetch the detection + segmentation models so the refine step is instant by
// the time the user has framed and submitted their photo. Fire-and-forget.
warmRefiner();

const SUBMIT_ENDPOINT = '/api/avatars/reconstruct';
const STATUS_ENDPOINT = '/api/avatars/regenerate-status';
const MAX_DIM = 1024;
const JPEG_QUALITY = 0.88;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 8 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Extra polls to allow a 'done' job whose avatar has not materialized yet. */
const MATERIALIZE_RETRY_POLLS = 3;

// BYOK key session storage keys — readable by the page to pre-populate the
// key entry form and by the pipeline to attach the key to submit requests.
const BYOK_KEY_STORAGE = 'selfie:byok:key';
const BYOK_PROVIDER_STORAGE = 'selfie:byok:provider';

/** Read the BYOK credentials stored for this session, if any. */
export function getStoredByokKey() {
	try {
		const key = sessionStorage.getItem(BYOK_KEY_STORAGE);
		const provider = sessionStorage.getItem(BYOK_PROVIDER_STORAGE);
		if (key && provider) return { key, provider };
	} catch (_) {}
	return null;
}

/** Persist BYOK credentials to the session. */
export function storeByokKey(provider, key) {
	try {
		sessionStorage.setItem(BYOK_PROVIDER_STORAGE, provider);
		sessionStorage.setItem(BYOK_KEY_STORAGE, key);
	} catch (_) {}
}

/** Clear any stored BYOK credentials (e.g. after an invalid-key error). */
export function clearStoredByokKey() {
	try {
		sessionStorage.removeItem(BYOK_KEY_STORAGE);
		sessionStorage.removeItem(BYOK_PROVIDER_STORAGE);
	} catch (_) {}
}

let _building = false;
let _lastSlotsSent = /** @type {string[]} */ ([]);
let _jobStartTime = 0;
let _rateLimitedUntil = 0;

document.addEventListener('selfie:submit', (event) => {
	const ev = /** @type {CustomEvent} */ (event);
	_building = false;
	run(ev.detail).catch((err) => {
		log.error('[selfie-pipeline]', err);
		if (err?.redirect) {
			window.location.assign(err.redirect);
			return;
		}
		// No platform backend + no BYOK key: surface the key-entry form.
		if (err?.needsByok) {
			document.dispatchEvent(new CustomEvent('selfie:needs-byok', {
				detail: { providers: err.providers || ['meshy', 'tripo'] },
			}));
			return;
		}
		if (_building) {
			document.dispatchEvent(new CustomEvent('selfie:build-error', {
				detail: {
					message: err.userMessage || 'Something went wrong. Try again.',
					slot: err.slot || null,
				},
			}));
		} else {
			setStatus(err.userMessage || 'Something went wrong. Try again.', { error: true });
			if (err.slot) highlightSlotError(err.slot);
			if (err.rateLimited) {
				startRateLimitCooldown();
			} else {
				resetSubmit();
			}
		}
	});
});

// Resume polling if we have a pending job from a previous page load.
(function resumePendingJob() {
	try {
		const pending = sessionStorage.getItem('selfie:pendingJobId');
		if (!pending) return;
		sessionStorage.removeItem('selfie:pendingJobId');
		_building = true;
		_jobStartTime = Date.now();
		document.dispatchEvent(new CustomEvent('selfie:building', { detail: { jobId: pending } }));
		pollUntilDone(pending).then((finalJob) => {
			if (finalJob.resultAvatarId) {
				document.dispatchEvent(new CustomEvent('selfie:done', {
					detail: { avatarId: finalJob.resultAvatarId },
				}));
			}
		}).catch((err) => {
			log.error('[selfie-pipeline] resume failed:', err);
			if (err?.redirect) {
				window.location.assign(err.redirect);
				return;
			}
			document.dispatchEvent(new CustomEvent('selfie:build-error', {
				detail: { message: err.userMessage || 'Could not resume. Try again.', slot: null },
			}));
		});
	} catch (_) {}
})();

/**
 * @param {{
 *   files: Record<'frontal'|'left'|'right', File | null>,
 *   avatarType: 'v1' | 'v2',
 *   method: 'camera' | 'upload' | null,
 * }} detail
 */
async function run(detail) {
	_building = false;
	if (!detail?.files?.frontal) {
		throw withMessage(new Error('missing frontal'), 'Add a front-facing photo to start.', 'frontal');
	}

	if (Date.now() < _rateLimitedUntil) {
		const secsLeft = Math.ceil((_rateLimitedUntil - Date.now()) / 1000);
		const e = withMessage(
			new Error('rate_limited'),
			`Too many attempts -- wait ${secsLeft}s and try again.`,
		);
		/** @type {any} */ (e).rateLimited = true;
		throw e;
	}

	setStatus('Preparing photos...');
	const slots = /** @type {const} */ (['frontal', 'left', 'right']);
	_lastSlotsSent = [];
	const photos = [];
	const warnings = [];
	for (const slot of slots) {
		const file = detail.files[slot];
		if (!file) continue;

		const bitmap = await loadBitmap(file);
		try {
			// Gate the input. The frontal must contain a face — that's the only hard
			// stop. Everything else (soft/blurry/illustration/far) is a non-fatal
			// warning the user sees but can proceed past.
			setStatus(slot === 'frontal' ? 'Checking your photo...' : `Checking ${slot} angle...`);
			const assessment = await assessPhoto(bitmap);
			if (slot === 'frontal' && assessment.verdict === 'block') {
				throw withMessage(
					new Error(`quality block: ${assessment.primary}`),
					assessment.message,
					'frontal',
				);
			}
			if (assessment.primary && assessment.primary !== 'multiple-faces') {
				warnings.push({ slot, primary: assessment.primary, message: assessment.message });
			}

			// Isolate the subject from its background and reframe to a clean
			// head-and-shoulders square — the composition the reconstruction lane
			// handles best. This is the fix for the "whole photo on a card" failure.
			setStatus('Isolating subject...');
			let dataUrl;
			try {
				const refined = await refineSelfie(bitmap, {
					faceBox: assessment.faceBox,
					onStep: (label) => setStatus(label),
				});
				dataUrl = refined.dataUrl;
			} catch (refineErr) {
				// Refinement is an enhancement, never a gate: fall back to a plain
				// downscale so a model/canvas hiccup can't block avatar creation.
				log.warn('[selfie-pipeline] refine failed, using raw photo:', refineErr);
				dataUrl = await fileToDataUrl(file);
			}

			if (!dataUrl || dataUrl.length < 500) {
				throw withMessage(new Error('invalid image data'), 'One of your photos could not be processed. Try a different file.', slot);
			}
			photos.push(dataUrl);
			_lastSlotsSent.push(slot);
		} finally {
			try { bitmap.close?.(); } catch (_) {}
		}
	}

	if (warnings.length) {
		document.dispatchEvent(new CustomEvent('selfie:quality', { detail: { warnings } }));
	}

	// Preview the refined frontal — the user sees exactly what the engine sees.
	document.dispatchEvent(new CustomEvent('selfie:preview', {
		detail: { dataUrl: photos[0] },
	}));

	setStatus('Submitting to avatar engine...');
	const byok = getStoredByokKey();
	const submitBody = {
		name: defaultAvatarName(),
		photos,
		visibility: 'private',
		params: { style: detail.avatarType },
		...(byok ? { provider_key: byok.key, provider_name: byok.provider } : {}),
	};
	const submitRes = await fetch(SUBMIT_ENDPOINT, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(submitBody),
	});

	if (!submitRes.ok) {
		const payload = await submitRes.json().catch(() => ({}));
		// The platform has no backend and the user has no stored BYOK key.
		// Dispatch a dedicated event so the page can show the key entry form.
		if (payload.code === 'regen_needs_byok') {
			const e = new Error('regen_needs_byok');
			/** @type {any} */ (e).needsByok = true;
			/** @type {any} */ (e).providers = payload.providers || ['meshy', 'tripo'];
			throw e;
		}
		throw mapApiError(submitRes.status, payload);
	}

	const submitData = await submitRes.json();
	if (!submitData.jobId) {
		throw withMessage(new Error('no jobId'), 'The avatar engine did not return a job.');
	}

	_building = true;
	_jobStartTime = Date.now();
	try { sessionStorage.setItem('selfie:pendingJobId', submitData.jobId); } catch (_) {}
	document.dispatchEvent(new CustomEvent('selfie:building', { detail: { jobId: submitData.jobId } }));

	const finalJob = await pollUntilDone(submitData.jobId);
	try { sessionStorage.removeItem('selfie:pendingJobId'); } catch (_) {}

	if (!finalJob.resultAvatarId) {
		throw withMessage(
			new Error('done without resultAvatarId'),
			'Avatar finished but could not be saved. Try again.',
		);
	}

	document.dispatchEvent(new CustomEvent('selfie:done', {
		detail: { avatarId: finalJob.resultAvatarId },
	}));
}

/**
 * Poll the status endpoint until the job reaches a terminal state, throwing
 * with a user-facing message on failure or timeout.
 * @param {string} jobId
 */
async function pollUntilDone(jobId) {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let attempt = 0;
	let consecutiveErrors = 0;
	// A 'done' job with no avatar id means the server's materialize stage threw
	// after the mesh was already generated. That stage re-runs on every poll, so
	// a transient (a storage blip, a lock) clears itself if we look again instead
	// of failing the user out of a reconstruction they already waited through.
	// Bounded: a deterministic failure must not spin until the poll deadline.
	let unmaterializedPolls = 0;
	const url = `${STATUS_ENDPOINT}?jobId=${encodeURIComponent(jobId)}`;

	while (Date.now() < deadline) {
		const interval = attempt === 0 ? 1500 : backoffInterval(consecutiveErrors);
		await sleep(interval);
		attempt += 1;

		let res;
		try {
			res = await fetch(url, { credentials: 'include' });
			consecutiveErrors = 0;
		} catch (err) {
			consecutiveErrors += 1;
			log.warn('[selfie-pipeline] poll fetch failed (%d):', consecutiveErrors, err);
			if (consecutiveErrors >= 5) {
				throw withMessage(
					new Error('poll network failure'),
					'Lost connection to the avatar engine. Check your internet and try again.',
				);
			}
			continue;
		}

		if (!res.ok) {
			if (res.status === 404) {
				throw withMessage(new Error('job vanished'), 'Job disappeared. Try again.');
			}
			if (res.status === 401 || res.status === 403) {
				// Session expired (or never authenticated) mid-build. Bounce to
				// login and resume this job on return — don't spin for 8 minutes
				// on a status that retrying can never recover from.
				try { sessionStorage.setItem('selfie:pendingJobId', jobId); } catch (_) {}
				throw mapApiError(res.status, await res.json().catch(() => ({})));
			}
			consecutiveErrors += 1;
			continue;
		}

		const job = await res.json().catch(() => ({}));
		const elapsed = Date.now() - _jobStartTime;

		document.dispatchEvent(new CustomEvent('selfie:progress', {
			detail: { label: statusLabel(job.status, attempt, elapsed), attempt },
		}));

		if (job.status === 'done') {
			if (job.resultAvatarId) return job;
			unmaterializedPolls += 1;
			if (unmaterializedPolls <= MATERIALIZE_RETRY_POLLS) continue;
			return job;
		}
		if (job.status === 'failed') {
			// errorKind 'input' means the API already vetted this string as
			// caller-facing copy (a plan refusal, a worker's "no face detected").
			// Running it back through friendlyJobError's keyword match would
			// overwrite an exact reason with a guess, "your library is full"
			// becomes "try again with a clearer photo", which sends the user off
			// to retake a photo that was never the problem.
			throw withMessage(
				new Error(job.error || 'reconstruct failed'),
				job.errorKind === 'input' && job.error ? job.error : friendlyJobError(job.error),
				inferFailingSlot(job.error),
			);
		}

		if (elapsed > 10 * 60 * 1000 && job.status === 'running') {
			throw withMessage(
				new Error('stalled job'),
				'This is taking unusually long. Your avatar may still be processing -- check your dashboard in a few minutes.',
			);
		}
	}

	throw withMessage(
		new Error('poll timeout'),
		'Avatar is taking longer than expected. Check your dashboard in a few minutes.',
	);
}

/** @param {number} errors */
function backoffInterval(errors) {
	if (errors <= 0) return POLL_INTERVAL_MS;
	return Math.min(POLL_INTERVAL_MS * Math.pow(1.5, errors), 30_000);
}

/**
 * @param {'queued'|'running'|'rigging'|'done'|'failed'|undefined} status
 * @param {number} attempt
 * @param {number} elapsedMs
 */
function statusLabel(status, attempt, elapsedMs) {
	if (status === 'queued') return 'Queued -- waiting for a reconstruction slot...';
	if (status === 'rigging') return 'Auto-rigging skeleton and skinning...';
	if (status === 'running') {
		if (attempt <= 4) return 'Generating 3D mesh from your photo...';
		if (attempt <= 12) return 'Building geometry and textures...';
		if (attempt <= 25) return 'Auto-rigging skeleton and skinning...';
		if (attempt <= 35) return 'Finishing avatar...';
		if (elapsedMs > 5 * 60 * 1000) return 'Still working -- this one is taking a bit longer...';
		return 'Almost there -- finalizing...';
	}
	if (status === 'done') return 'Done!';
	return 'Processing...';
}

/** @param {string | null | undefined} raw */
function friendlyJobError(raw) {
	if (!raw) return 'Avatar reconstruction failed. Try clearer photos in better light.';
	const lower = raw.toLowerCase();

	if (lower.includes('face') && lower.includes('detect'))
		return 'We could not find a face in your front photo. Try a clearer, well-lit shot.';
	if (lower.includes('nsfw'))
		return 'Your photo was flagged by content safety. Try a different shot.';
	if (lower.includes('blur'))
		return 'Your photo looks blurry. Try again with a sharper shot in better light.';

	if (lower.includes('unreachable') || lower.includes('service') || lower.includes('502') || lower.includes('503'))
		return 'The avatar engine is temporarily unavailable. Please try again in a few minutes.';
	if (lower.includes('timeout') || lower.includes('timed out'))
		return 'The engine took too long. Try again in a moment.';
	if (lower.includes('oom') || lower.includes('memory'))
		return 'The engine ran out of resources. Try again with a simpler photo.';

	return 'Avatar reconstruction failed. Try again with a clearer photo.';
}

/**
 * @param {string | null | undefined} raw
 */
function inferFailingSlot(raw) {
	if (!_lastSlotsSent.length) return null;
	if (!raw) return _lastSlotsSent[0];
	const lower = raw.toLowerCase();
	if (lower.includes('left')) return _lastSlotsSent.includes('left') ? 'left' : null;
	if (lower.includes('right')) return _lastSlotsSent.includes('right') ? 'right' : null;
	if (lower.includes('front') || lower.includes('face')) return _lastSlotsSent[0];
	return _lastSlotsSent[0];
}

function defaultAvatarName() {
	const d = new Date();
	const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	return `Selfie avatar · ${stamp}`;
}

/**
 * @param {File} file
 */
async function fileToDataUrl(file) {
	const bitmap = await loadBitmap(file);
	const { width, height } = fit(bitmap.width, bitmap.height, MAX_DIM);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('2d canvas unsupported');
	ctx.drawImage(bitmap, 0, 0, width, height);
	try { bitmap.close?.(); } catch (_) {}
	return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

/** @param {File} file @returns {Promise<ImageBitmap | HTMLImageElement>} */
async function loadBitmap(file) {
	if (typeof createImageBitmap === 'function') {
		try {
			return await createImageBitmap(file);
		} catch (_) {}
	}
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('could not decode image'));
		img.src = URL.createObjectURL(file);
	});
}

/**
 * @param {number} w
 * @param {number} h
 * @param {number} max
 */
function fit(w, h, max) {
	if (w <= max && h <= max) return { width: w, height: h };
	const s = Math.min(max / w, max / h);
	return { width: Math.round(w * s), height: Math.round(h * s) };
}

/**
 * @param {number} status
 * @param {{ error?: string, error_description?: string }} payload
 */
function mapApiError(status, payload) {
	const code = payload.error;
	// BYOK-specific errors must be checked before the generic 401/402 handlers.
	if (status === 401 && (code === 'invalid_key' || code === 'missing_key')) {
		clearStoredByokKey();
		return withMessage(
			new Error(code),
			'Your API key was rejected. Check the key and try again.',
		);
	}
	if (status === 402 && code === 'insufficient_credits')
		return withMessage(
			new Error(code),
			'Your API key is out of credits. Top up your account and try again.',
		);
	if (status === 401) {
		// Return to /create/selfie so the post-login round-trip resumes on the right page.
		const here = typeof location !== 'undefined' ? location.pathname : '/create/selfie';
		const next = encodeURIComponent(here);
		const e = withMessage(
			new Error(code || 'unauthorized'),
			'Please sign in to create an avatar.',
		);
		/** @type {any} */ (e).redirect = `/login?next=${next}`;
		return e;
	}
	if (status === 402)
		return withMessage(
			new Error(code || 'plan_limit'),
			payload.error_description || 'Avatar quota reached. Upgrade your plan to create more.',
		);
	if (status === 413)
		return withMessage(new Error(code || 'too_large'), 'Photos are too large. Try again.');
	if (status === 429) {
		const e = withMessage(
			new Error(code || 'rate_limited'),
			'Too many attempts -- wait a minute and try again.',
		);
		/** @type {any} */ (e).rateLimited = true;
		return e;
	}
	if (status === 501)
		return withMessage(
			new Error(code || 'not_configured'),
			'Avatar engine is not available right now. Please try again later.',
		);
	if (status === 502)
		return withMessage(
			new Error(code || 'upstream_error'),
			'Avatar engine is having trouble. Try again shortly.',
		);
	return withMessage(
		new Error(code || `http_${status}`),
		payload.error_description || 'Could not create avatar.',
	);
}

/**
 * @param {Error} err
 * @param {string} userMessage
 * @param {string | null} [slot]
 */
function withMessage(err, userMessage, slot) {
	/** @type {any} */ (err).userMessage = userMessage;
	if (slot) /** @type {any} */ (err).slot = slot;
	return err;
}

/** @param {number} ms */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── UI helpers ────────────────────────────────────────────────────────────
const submitBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('submit-btn'));
let errorBanner = /** @type {HTMLElement | null} */ (null);
let _cooldownTimer = 0;

/** @param {string} text @param {{ error?: boolean }} [opts] */
function setStatus(text, opts = {}) {
	if (submitBtn) {
		const labelEl = submitBtn.querySelector('.label');
		const metaEl = submitBtn.querySelector('.meta');
		if (labelEl) labelEl.textContent = text;
		else submitBtn.textContent = text;
		if (metaEl) metaEl.remove();
		submitBtn.disabled = true;
		submitBtn.classList.remove('ready');
	}
	if (opts.error) {
		const isNew = !errorBanner;
		if (!errorBanner) {
			errorBanner = document.createElement('p');
			errorBanner.className = 'unsupported show';
			errorBanner.setAttribute('role', 'alert');
			errorBanner.style.maxWidth = '720px';
			errorBanner.style.margin = '0 auto 16px';
			const bar = document.getElementById('submit-bar');
			bar?.parentNode?.insertBefore(errorBanner, bar);
		}
		errorBanner.textContent = text;
		// The submit bar is sticky, so it is reachable from anywhere on the page —
		// but the banner lands at the bar's NATURAL position, near the bottom of a
		// phone-height page. Tapping the button from higher up therefore put the
		// only explanation off-screen while resetSubmit restored the button to its
		// idle label, which reads as "nothing happened". Bring the banner to the
		// user. Only on first appearance: the rate-limit cooldown rewrites this
		// text every second and must not fight their scrolling.
		if (isNew) {
			errorBanner.scrollIntoView({
				block: 'center',
				behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
			});
		}
	} else if (errorBanner) {
		errorBanner.remove();
		errorBanner = null;
	}
}

function resetSubmit() {
	if (!submitBtn) return;
	submitBtn.disabled = false;
	submitBtn.classList.add('ready');
	const labelEl = submitBtn.querySelector('.label');
	if (labelEl) labelEl.textContent = 'Build my avatar';
	else submitBtn.textContent = 'Build my avatar';
}

/** @param {string} slot */
function highlightSlotError(slot) {
	const frame = document.querySelector(
		slot === 'frontal'
			? '.hero-slot[data-slot="frontal"]'
			: `.slot-frame[data-slot="${slot}"]`,
	);
	frame?.classList.add('error');
	if (slot !== 'frontal') {
		const fid = /** @type {HTMLDetailsElement|null} */ (document.getElementById('fidelity-boost'));
		if (fid) fid.open = true;
	}
}

function startRateLimitCooldown() {
	_rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
	if (_cooldownTimer) clearInterval(_cooldownTimer);
	_cooldownTimer = window.setInterval(() => {
		const remaining = Math.ceil((_rateLimitedUntil - Date.now()) / 1000);
		if (remaining <= 0) {
			clearInterval(_cooldownTimer);
			_cooldownTimer = 0;
			_rateLimitedUntil = 0;
			resetSubmit();
			return;
		}
		setStatus(`Rate limited -- try again in ${remaining}s`, { error: true });
	}, 1000);
}
