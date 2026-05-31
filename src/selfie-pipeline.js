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

import { detectFaceIdentity } from './avatar-face-capture.js';

const SUBMIT_ENDPOINT = '/api/avatars/reconstruct';
const STATUS_ENDPOINT = '/api/avatars/regenerate-status';
const MAX_DIM = 1024;
const JPEG_QUALITY = 0.88;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 8 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

let _building = false;
let _lastSlotsSent = /** @type {string[]} */ ([]);
let _jobStartTime = 0;
let _rateLimitedUntil = 0;

document.addEventListener('selfie:submit', (event) => {
	const ev = /** @type {CustomEvent} */ (event);
	_building = false;
	run(ev.detail).catch((err) => {
		console.error('[selfie-pipeline]', err);
		if (err?.redirect) {
			window.location.assign(err.redirect);
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
			console.error('[selfie-pipeline] resume failed:', err);
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
 *   bodyType: 'male' | 'female',
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
	for (const slot of slots) {
		const file = detail.files[slot];
		if (!file) continue;
		const dataUrl = await fileToDataUrl(file);
		if (!dataUrl || dataUrl.length < 500) {
			throw withMessage(new Error('invalid image data'), 'One of your photos could not be processed. Try a different file.', slot);
		}
		photos.push(dataUrl);
		_lastSlotsSent.push(slot);
	}

	setStatus('Checking face...');
	const failedSlot = await checkFacesLocal(detail.files);
	if (failedSlot) {
		throw withMessage(
			new Error('client face check failed'),
			failedSlot === 'frontal'
				? "We couldn't detect a face in your photo. Make sure your face is clearly visible, well-lit, and not obscured by sunglasses or a mask."
				: `We couldn't detect a face in your ${failedSlot} angle photo. Try a clearer shot or remove it.`,
			failedSlot,
		);
	}

	document.dispatchEvent(new CustomEvent('selfie:preview', {
		detail: { dataUrl: photos[0] },
	}));

	setStatus('Submitting to avatar engine...');
	const submitRes = await fetch(SUBMIT_ENDPOINT, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			name: defaultAvatarName(),
			photos,
			visibility: 'private',
			params: { bodyType: detail.bodyType, style: detail.avatarType },
		}),
	});

	if (!submitRes.ok) {
		const payload = await submitRes.json().catch(() => ({}));
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
 * Check all submitted photos for faces. Returns the first failing slot name,
 * or null if all pass. Frontal is required; sides are optional.
 * @param {Record<string, File | null>} files
 * @returns {Promise<string | null>}
 */
async function checkFacesLocal(files) {
	const slots = ['frontal', 'left', 'right'];
	for (const slot of slots) {
		const file = files[slot];
		if (!file) continue;
		const ok = await checkFaceLocal(file);
		if (!ok) return slot;
	}
	return null;
}

/**
 * Quick client-side face check via MediaPipe. Returns true if a face is
 * found, false otherwise. Never blocks submission on load failure -- if
 * MediaPipe can't load, we skip and let the server decide.
 * @param {File} file
 * @returns {Promise<boolean>}
 */
async function checkFaceLocal(file) {
	try {
		const img = await loadBitmap(file);
		const result = await detectFaceIdentity(img);
		if (img.close) img.close();
		return result !== null;
	} catch (_) {
		return true;
	}
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
			console.warn('[selfie-pipeline] poll fetch failed (%d):', consecutiveErrors, err);
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

		if (job.status === 'done') return job;
		if (job.status === 'failed') {
			throw withMessage(
				new Error(job.error || 'reconstruct failed'),
				friendlyJobError(job.error),
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
 * @param {'queued'|'running'|'done'|'failed'|undefined} status
 * @param {number} attempt
 * @param {number} elapsedMs
 */
function statusLabel(status, attempt, elapsedMs) {
	if (status === 'queued') return 'Queued -- waiting for a reconstruction slot...';
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
	if (status === 401) {
		// Return to whichever surface initiated the flow (/create/selfie or /scan)
		// so the post-login round-trip resumes on the right page.
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
