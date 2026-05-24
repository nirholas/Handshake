/**
 * Selfie pipeline — bridges the capture UI on /create/selfie to the native
 * avatar reconstruction backend.
 *
 * Flow:
 *   [selfie:submit] → downscale photos (frontal required, sides optional)
 *     → dispatches selfie:preview { dataUrl } so the build view can show the
 *       user's own photo on a placeholder body while the real GLB renders
 *     → POST /api/avatars/reconstruct
 *     → dispatches selfie:building { jobId }
 *     → poll /api/avatars/regenerate-status?jobId=…
 *     → dispatches selfie:progress { label } on each poll tick
 *     → on { status: 'done', resultAvatarId } → dispatches selfie:done { avatarId }
 *     → on { status: 'failed' } or timeout → dispatches selfie:build-error
 *         { message, slot? } where slot is the photo that likely caused the failure
 */

const SUBMIT_ENDPOINT = '/api/avatars/reconstruct';
const STATUS_ENDPOINT = '/api/avatars/regenerate-status';
const MAX_DIM = 1024;
const JPEG_QUALITY = 0.88;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

let _building = false;
let _lastSlotsSent = /** @type {string[]} */ ([]);

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
			resetSubmit();
		}
	});
});

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

	setStatus('Preparing photos…');
	const slots = /** @type {const} */ (['frontal', 'left', 'right']);
	_lastSlotsSent = [];
	const photos = [];
	for (const slot of slots) {
		const file = detail.files[slot];
		if (!file) continue;
		photos.push(await fileToDataUrl(file));
		_lastSlotsSent.push(slot);
	}

	// Emit the frontal photo immediately for the build view's fast preview —
	// a real image, mapped to the placeholder body until the engine returns.
	document.dispatchEvent(new CustomEvent('selfie:preview', {
		detail: { dataUrl: photos[0] },
	}));

	setStatus('Submitting to avatar engine…');
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
	document.dispatchEvent(new CustomEvent('selfie:building', { detail: { jobId: submitData.jobId } }));

	const finalJob = await pollUntilDone(submitData.jobId);

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
	const url = `${STATUS_ENDPOINT}?jobId=${encodeURIComponent(jobId)}`;

	while (Date.now() < deadline) {
		await sleep(attempt === 0 ? 1500 : POLL_INTERVAL_MS);
		attempt += 1;

		let res;
		try {
			res = await fetch(url, { credentials: 'include' });
		} catch (err) {
			console.warn('[selfie-pipeline] poll fetch failed:', err);
			continue;
		}

		if (!res.ok) {
			if (res.status === 404) {
				throw withMessage(new Error('job vanished'), 'Job disappeared. Try again.');
			}
			// transient — keep polling
			continue;
		}

		const job = await res.json().catch(() => ({}));
		document.dispatchEvent(new CustomEvent('selfie:progress', {
			detail: { label: statusLabel(job.status, attempt), attempt },
		}));

		if (job.status === 'done') return job;
		if (job.status === 'failed') {
			throw withMessage(
				new Error(job.error || 'reconstruct failed'),
				friendlyJobError(job.error),
				inferFailingSlot(job.error),
			);
		}
	}

	throw withMessage(
		new Error('poll timeout'),
		'Avatar is taking longer than expected. Check your dashboard in a few minutes.',
	);
}

/**
 * @param {'queued'|'running'|'done'|'failed'|undefined} status
 * @param {number} attempt
 */
function statusLabel(status, attempt) {
	if (status === 'queued') return 'Queued — waiting for a reconstruction slot…';
	if (status === 'running') {
		if (attempt <= 6) return 'Analyzing face geometry…';
		if (attempt <= 14) return 'Building mesh…';
		return 'Finishing rig…';
	}
	if (status === 'done') return 'Done!';
	return `Processing… (${attempt}s)`;
}

/** @param {string | null | undefined} raw */
function friendlyJobError(raw) {
	if (!raw) return 'Avatar reconstruction failed. Try clearer photos in better light.';
	const lower = raw.toLowerCase();
	if (lower.includes('face') && lower.includes('detect'))
		return 'We could not find a face in your front photo. Try a clearer, well-lit shot.';
	if (lower.includes('nsfw')) return 'Your photo was flagged by content safety. Try a different shot.';
	if (lower.includes('blur')) return 'Your photo looks blurry. Try again with a sharper shot in better light.';
	if (lower.includes('timeout')) return 'The engine took too long. Try again in a moment.';
	return 'Avatar reconstruction failed. Try again with a clearer photo.';
}

/**
 * Server errors don't always tell us which photo caused the failure. Use the
 * order we submitted (frontal first) plus error-text hints to guess so the UI
 * can flag the right slot for retake. Returns null when there's nothing useful
 * to infer.
 * @param {string | null | undefined} raw
 */
function inferFailingSlot(raw) {
	if (!_lastSlotsSent.length) return null;
	if (!raw) {
		// No detail — frontal is the most likely culprit and the one the user
		// definitely supplied.
		return _lastSlotsSent[0];
	}
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
 * Reads a File, paints it into a canvas clamped to MAX_DIM × MAX_DIM, returns
 * a JPEG data URL. Keeps upload payloads predictable across phone camera sizes.
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
	try {
		bitmap.close?.();
	} catch (_) {
		// ImageBitmap.close is optional on older browsers
	}
	return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

/** @param {File} file @returns {Promise<ImageBitmap | HTMLImageElement>} */
async function loadBitmap(file) {
	if (typeof createImageBitmap === 'function') {
		try {
			return await createImageBitmap(file);
		} catch (_) {
			// fall through to <img> fallback
		}
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
		const next = encodeURIComponent('/create/selfie');
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
	if (status === 429)
		return withMessage(
			new Error(code || 'rate_limited'),
			'Too many attempts — wait a minute and try again.',
		);
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

// ── UI helpers ─────────────────────────────────────────────────────────────
const submitBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('submit-btn'));
let errorBanner = /** @type {HTMLElement | null} */ (null);

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
