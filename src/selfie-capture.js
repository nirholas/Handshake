/**
 * Selfie capture flow — entry for /create/selfie.
 *
 * Hero slot (frontal) is required. Side slots (left / right) are optional —
 * they live under the "Add side angles" disclosure and bump reconstruction
 * fidelity when supplied. Capture method (camera vs upload) is picked per slot.
 *
 * On submit, dispatches a `selfie:submit` CustomEvent on document with
 *   detail = { files: { frontal, left?, right? }, avatarType, method }
 * which the selfie pipeline picks up to drive avatar reconstruction.
 *
 * Camera overlay uses the face-quality engine for real-time 468-point wireframe,
 * head-pose estimation, blur/lighting/centering quality gates.
 */

import { checkImageQuality, createQualitySession, preload } from './face-quality.js';
import { GATES } from './selfie-gates.js';
import { log } from './shared/log.js';
import { clearSharedIntent, sharedIntent, takeSharedFiles } from './shared/share-target.js';

const REQUIRED_SLOT = 'frontal';
const OPTIONAL_SLOTS = /** @type {const} */ (['left', 'right']);
const ALL_SLOTS = /** @type {const} */ ([REQUIRED_SLOT, ...OPTIONAL_SLOTS]);

const ETA_FAST_SEC = 90;
const ETA_HIGH_SEC = 120;

const state = {
	avatarType: /** @type {'v1' | 'v2'} */ ('v1'),
	files: /** @type {Record<string, File | null>} */ ({ frontal: null, left: null, right: null }),
	lastMethod: /** @type {'camera' | 'upload' | null} */ (null),
};

const cameraSupported =
	typeof navigator !== 'undefined' &&
	!!navigator.mediaDevices &&
	typeof navigator.mediaDevices.getUserMedia === 'function';

// ── DOM refs ───────────────────────────────────────────────────────────────
const backBtn = /** @type {HTMLButtonElement} */ (document.getElementById('back-btn'));
const unsupportedMsg = document.getElementById('unsupported-msg');
const heroSlot = /** @type {HTMLElement | null} */ (
	document.querySelector('.hero-slot[data-slot="frontal"]')
);
const heroCameraBtn = /** @type {HTMLButtonElement | null} */ (
	document.querySelector('.hero-pill[data-action="open-camera"]')
);
const heroUploadBtn = /** @type {HTMLButtonElement | null} */ (
	document.querySelector('.hero-pill[data-action="open-upload"]')
);
const sideFrames = /** @type {NodeListOf<HTMLElement>} */ (
	document.querySelectorAll('.slot-frame[data-slot]')
);
const slotInputs = /** @type {NodeListOf<HTMLInputElement>} */ (
	document.querySelectorAll('input[data-slot-input]')
);
const submitBtn = /** @type {HTMLButtonElement} */ (document.getElementById('submit-btn'));
const styleBtns = /** @type {NodeListOf<HTMLButtonElement>} */ (
	document.querySelectorAll('.style-card[data-type]')
);

// ── Camera support gating ──────────────────────────────────────────────────
if (!cameraSupported) {
	heroCameraBtn?.setAttribute('disabled', '');
	heroCameraBtn?.setAttribute('aria-disabled', 'true');
	heroCameraBtn?.setAttribute('title', 'Camera not available in this browser');
	unsupportedMsg?.classList.add('show');
}

// ── Top bar back ───────────────────────────────────────────────────────────
backBtn?.addEventListener('click', () => {
	const active = document.querySelector('.step.active')?.getAttribute('data-step');
	if (active === 'capture') window.location.assign('/create');
	else if (active === 'building' || active === 'done') showStep('capture');
	else window.location.assign('/');
});

// ── Hero slot: tap → contextual default (camera if supported, else upload)
heroSlot?.addEventListener('click', (e) => {
	const target = /** @type {HTMLElement} */ (e.target);
	if (target.closest('.retake-btn')) return;
	if (state.files[REQUIRED_SLOT]) return;
	openForSlot(REQUIRED_SLOT, cameraSupported ? 'camera' : 'upload');
});
heroSlot?.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' || e.key === ' ') {
		e.preventDefault();
		if (state.files[REQUIRED_SLOT]) return;
		openForSlot(REQUIRED_SLOT, cameraSupported ? 'camera' : 'upload');
	}
});

heroCameraBtn?.addEventListener('click', () => {
	if (heroCameraBtn.hasAttribute('disabled')) return;
	openForSlot(REQUIRED_SLOT, 'camera');
});
heroUploadBtn?.addEventListener('click', () => openForSlot(REQUIRED_SLOT, 'upload'));

// Hero drag/drop
heroSlot?.addEventListener('dragover', (e) => {
	e.preventDefault();
	heroSlot.classList.add('drag');
});
heroSlot?.addEventListener('dragleave', () => heroSlot.classList.remove('drag'));
heroSlot?.addEventListener('drop', (e) => {
	e.preventDefault();
	heroSlot.classList.remove('drag');
	const file = e.dataTransfer?.files?.[0];
	if (file && isImage(file)) setSlot(REQUIRED_SLOT, file);
});

// ── Side slots ─────────────────────────────────────────────────────────────
sideFrames.forEach((frame) => {
	const slot = frame.getAttribute('data-slot');
	if (!slot || slot === REQUIRED_SLOT) return;

	const open = () => {
		if (state.files[slot]) return;
		openForSlot(slot, state.lastMethod || (cameraSupported ? 'camera' : 'upload'));
	};

	frame.addEventListener('click', open);
	frame.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			open();
		}
	});

	frame.addEventListener('dragover', (e) => {
		e.preventDefault();
		frame.classList.add('drag');
	});
	frame.addEventListener('dragleave', () => frame.classList.remove('drag'));
	frame.addEventListener('drop', (e) => {
		e.preventDefault();
		frame.classList.remove('drag');
		const file = e.dataTransfer?.files?.[0];
		if (file && isImage(file)) setSlot(slot, file);
	});
});

// ── File inputs ────────────────────────────────────────────────────────────
slotInputs.forEach((input) => {
	input.addEventListener('change', () => {
		const slot = input.getAttribute('data-slot-input');
		const file = input.files?.[0];
		if (slot && file && isImage(file)) setSlot(slot, file);
		input.value = '';
	});
});

// ── Selectors ──────────────────────────────────────────────────────────────
styleBtns.forEach((btn) => {
	btn.addEventListener('click', () => {
		const val = /** @type {'v1'|'v2'} */ (btn.getAttribute('data-type'));
		state.avatarType = val;
		styleBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
		persistProgress();
	});
});

// ── External reset (e.g. "Try again" on the done step) ────────────────────
document.addEventListener('selfie:reset', () => {
	ALL_SLOTS.forEach((s) => { state.files[s] = null; });
	ALL_SLOTS.forEach(renderSlot);
	updateSubmit();
	clearProgress();
});

// The avatar landed in the user's library; the capture session is spent.
document.addEventListener('selfie:done', clearProgress);

// ── Submit ─────────────────────────────────────────────────────────────────
submitBtn.addEventListener('click', () => {
	if (!state.files[REQUIRED_SLOT]) return;
	document.dispatchEvent(
		new CustomEvent('selfie:submit', {
			detail: {
				files: { ...state.files },
				avatarType: state.avatarType,
				method: state.lastMethod || (cameraSupported ? 'camera' : 'upload'),
			},
		}),
	);
	submitBtn.innerHTML = '<span class="label">Sending…</span>';
	submitBtn.disabled = true;
	submitBtn.classList.remove('ready');
});

// ── Step machine ───────────────────────────────────────────────────────────
/** @param {'capture' | 'building' | 'done'} step */
function showStep(step) {
	document.querySelectorAll('.step[data-step]').forEach((s) => {
		s.classList.toggle('active', s.getAttribute('data-step') === step);
	});
	window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

// ── Slot helpers ───────────────────────────────────────────────────────────
/** @param {File} file */
function isImage(file) {
	return /^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || '');
}

/**
 * @param {string} slot
 * @param {'camera' | 'upload'} method
 */
function openForSlot(slot, method) {
	state.lastMethod = method;
	if (method === 'camera' && cameraSupported) {
		openCamera(slot);
	} else {
		/** @type {HTMLInputElement | null} */ (
			document.querySelector(`input[data-slot-input="${slot}"]`)
		)?.click();
	}
}

/**
 * @param {string} slot
 * @param {File} file
 */
function setSlot(slot, file) {
	state.files[slot] = file;
	renderSlot(slot);
	updateSubmit();
	persistProgress();
	// Let the page assess the freshly-added photo and warn early (before the
	// minute-long build) if it's a drawing, blurry, or has no face.
	document.dispatchEvent(new CustomEvent('selfie:photo-added', { detail: { slot, file } }));
}

/** @param {string} slot */
function clearSlot(slot) {
	state.files[slot] = null;
	renderSlot(slot);
	updateSubmit();
	persistProgress();
}

/** @param {string} slot */
function renderSlot(slot) {
	const isHero = slot === REQUIRED_SLOT;
	const frame = /** @type {HTMLElement | null} */ (
		document.querySelector(
			isHero ? '.hero-slot[data-slot="frontal"]' : `.slot-frame[data-slot="${slot}"]`,
		)
	);
	if (!frame) return;
	const file = state.files[slot];

	// Clear any previous error highlight; user has acted.
	frame.classList.remove('error');

	// Strip prior preview/retake artefacts.
	frame.querySelector('img.preview')?.remove();
	frame.querySelector('.retake-btn')?.remove();

	if (!file) {
		frame.classList.remove('filled');
		// Hero: restore default icon/title/sub if they were hidden via inline style.
		if (isHero) {
			frame.querySelectorAll(':scope > .hero-icon, :scope > .hero-title, :scope > .hero-sub').forEach((el) => {
				el.removeAttribute('style');
			});
		}
		return;
	}

	frame.classList.add('filled');

	// Hide hero defaults when filled.
	if (isHero) {
		frame.querySelectorAll(':scope > .hero-icon, :scope > .hero-title, :scope > .hero-sub').forEach((el) => {
			/** @type {HTMLElement} */ (el).style.display = 'none';
		});
	}

	const img = document.createElement('img');
	img.className = 'preview';
	img.alt = `${slot} photo preview`;
	img.src = URL.createObjectURL(file);
	img.onload = () => URL.revokeObjectURL(img.src);
	frame.appendChild(img);

	const retake = document.createElement('button');
	retake.type = 'button';
	retake.className = 'retake-btn';
	retake.setAttribute('aria-label', `Remove ${slot} photo`);
	retake.innerHTML =
		'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/></svg>';
	retake.addEventListener('click', (e) => {
		e.stopPropagation();
		clearSlot(slot);
	});
	frame.appendChild(retake);

	frame.addEventListener('keydown', (e) => {
		if ((e.key === 'Delete' || e.key === 'Backspace') && state.files[slot]) {
			e.preventDefault();
			clearSlot(slot);
		}
	});
}

function updateSubmit() {
	const hasRequired = !!state.files[REQUIRED_SLOT];
	const extras = OPTIONAL_SLOTS.filter((k) => !!state.files[k]).length;
	const labelEl = submitBtn.querySelector('.label');
	const metaEl = submitBtn.querySelector('.meta');

	if (!hasRequired) {
		submitBtn.disabled = true;
		submitBtn.classList.remove('ready');
		if (labelEl) labelEl.textContent = 'Add a photo to start';
		if (metaEl) metaEl.remove();
		return;
	}

	const eta = extras === 0 ? ETA_FAST_SEC : ETA_HIGH_SEC;
	const fidelityNote = extras === 0 ? '~' : extras === 1 ? '+1 angle · ~' : '+2 angles · ~';
	const labelText = ALL_SLOTS.filter((k) => !!state.files[k]).length === 1
		? 'Build my avatar'
		: 'Build high-fidelity avatar';

	submitBtn.disabled = false;
	submitBtn.classList.add('ready');
	if (labelEl) {
		labelEl.textContent = labelText;
	}
	let meta = metaEl;
	if (!meta) {
		meta = document.createElement('span');
		meta.className = 'meta';
		submitBtn.appendChild(meta);
	}
	meta.textContent = `· ${fidelityNote}${eta}s`;
}

// ── Camera overlay ─────────────────────────────────────────────────────────
const camOverlay = document.getElementById('cam-overlay');
const camVideo = /** @type {HTMLVideoElement | null} */ (document.getElementById('cam-video'));
const camSlotName = document.getElementById('cam-slot-name');
const camError = document.getElementById('cam-error');
const camActionsLive = document.getElementById('cam-actions-live');
const camActionsReview = document.getElementById('cam-actions-review');
const camOval = document.getElementById('cam-oval');
const camHint = document.getElementById('cam-hint');
const camShutter = /** @type {HTMLButtonElement | null} */ (document.getElementById('cam-shutter'));
const camCountdown = document.getElementById('cam-countdown');
const camCountNum = document.getElementById('cam-count-num');

const cam = {
	stream: /** @type {MediaStream | null} */ (null),
	slot: /** @type {string | null} */ (null),
	pendingFile: /** @type {File | null} */ (null),
	pendingUrl: /** @type {string | null} */ (null),
	qualitySession: /** @type {any} */ (null),
	faceLocked: false,
	countdownTimers: /** @type {number[]} */ ([]),
};

/** @param {string} slot */
async function openCamera(slot) {
	if (!camOverlay || !camVideo) return;
	cam.slot = slot;
	cam.faceLocked = false;
	if (camSlotName) camSlotName.textContent = slotPretty(slot);
	if (camHint) {
		camHint.textContent = slot === REQUIRED_SLOT
			? 'Center your face in the oval'
			: slot === 'left'
				? 'Turn ~45° to your left'
				: 'Turn ~45° to your right';
		camHint.classList.remove('ok');
	}
	camOval?.classList.remove('detected');
	setShutterEnabled(slot !== REQUIRED_SLOT);
	setCamMode('live');
	camError?.setAttribute('hidden', '');
	camOverlay.classList.add('open');

	try {
		cam.stream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1706 } },
			audio: false,
		});
		camVideo.srcObject = cam.stream;
	} catch (err) {
		log.warn('[selfie] camera error:', err);
		const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
		const msg = denied
			? 'Camera access was denied. Grant permission in your browser settings, or use Upload instead.'
			: 'Could not access camera. Check permissions and try again, or use Upload.';
		// Closing the overlay hides #cam-error the same frame, so the user would
		// see "nothing happened". Surface the reason on the persistent page banner
		// (next to the Upload affordance) instead, then close the overlay.
		showPageNotice(msg);
		closeCamera();
		return;
	}

	startFaceQuality(slot);
}

async function startFaceQuality(slot) {
	const meshOverlay = document.getElementById('cam-mesh-overlay');
	const badges = document.getElementById('cam-badges');
	if (!camVideo || !meshOverlay) {
		setShutterEnabled(true);
		return;
	}

	preload();

	await new Promise((res) => {
		if (camVideo.readyState >= 2) return res();
		camVideo.addEventListener('loadeddata', res, { once: true });
	});

	try {
		const slotKey = slot === REQUIRED_SLOT ? 'frontal' : slot;
		cam.qualitySession = await createQualitySession(camVideo, meshOverlay, {
			slot: slotKey,
			onUpdate: (report) => {
				renderQualityBadges(badges, report, slotKey);
				updateCameraHints(report);
			},
		});
		cam.qualitySession.start();
		camOval?.setAttribute('hidden', '');
	} catch (err) {
		log.warn('[selfie] face-quality init failed, falling back:', err);
		setShutterEnabled(true);
	}
}

function renderQualityBadges(container, report, slot) {
	if (!container) return;

	if (!report.faceFound) {
		container.innerHTML = '<span class="cam-badge-chip bad">No face</span>';
		return;
	}

	const chips = [
		{ text: 'Face', ok: true },
		{ text: `Yaw ${Math.round(report.yaw)}°`, ok: report.yawOk },
		{ text: report.centered ? 'Centered' : 'Recenter', ok: report.centered },
		{ text: report.blurOk ? 'Sharp' : 'Blurry', ok: report.blurOk },
	];

	// Read the shared thresholds rather than repeating them: a local copy drifts
	// silently, and it cannot see the blown-highlight gate at all, so the chip
	// would read "Lit" while the hint underneath said the face was blown out.
	const lumaLabel = report.luma < GATES.LUMA_MIN
		? 'Too dark'
		: report.luma > GATES.LUMA_MAX || (report.clippedFrac ?? 0) > GATES.CLIPPED_FRAC_MAX
			? 'Blown out'
			: 'Lit';
	chips.push({ text: lumaLabel, ok: report.lumaOk });

	container.innerHTML = chips.map((c) =>
		`<span class="cam-badge-chip ${c.ok ? 'ok' : 'bad'}">${c.text}</span>`
	).join('');
}

function updateCameraHints(report) {
	if (!report.faceFound) {
		setShutterEnabled(false);
		camOval?.classList.remove('detected');
		if (camHint) {
			camHint.textContent = report.reason || 'No face detected. Face the camera.';
			camHint.classList.remove('ok');
		}
		return;
	}

	setShutterEnabled(true);
	camOval?.classList.toggle('detected', report.allPass);

	if (camHint) {
		if (report.allPass) {
			camHint.textContent = 'Looks good. Tap the shutter.';
			camHint.classList.add('ok');
			cam.faceLocked = true;
		} else {
			// The grader names the single most actionable fix (yaw, framing,
			// blur, lighting) in the order the user should address them.
			camHint.textContent = report.reason || 'Almost there...';
			camHint.classList.remove('ok');
		}
	}
}

function stopFaceQuality() {
	if (cam.qualitySession) {
		cam.qualitySession.stop();
		cam.qualitySession = null;
	}
	const meshOverlay = document.getElementById('cam-mesh-overlay');
	if (meshOverlay) {
		const ctx = meshOverlay.getContext('2d');
		if (ctx) ctx.clearRect(0, 0, meshOverlay.width, meshOverlay.height);
	}
	const badges = document.getElementById('cam-badges');
	if (badges) badges.innerHTML = '';
}

/** @param {boolean} on */
function setShutterEnabled(on) {
	if (!camShutter) return;
	if (on) camShutter.removeAttribute('disabled');
	else camShutter.setAttribute('disabled', '');
}

function closeCamera() {
	stopFaceQuality();
	cancelCountdown();
	if (cam.stream) {
		cam.stream.getTracks().forEach((t) => t.stop());
		cam.stream = null;
	}
	if (camVideo) camVideo.srcObject = null;
	camOverlay?.classList.remove('open');
	clearPending();
	cam.slot = null;
	cam.faceLocked = false;
}

function clearPending() {
	if (cam.pendingUrl) URL.revokeObjectURL(cam.pendingUrl);
	cam.pendingUrl = null;
	cam.pendingFile = null;
	document.querySelector('#cam-stage img.preview')?.remove();
	clearStillVerdict();
}

/** @param {'live' | 'review'} mode */
function setCamMode(mode) {
	if (mode === 'live') {
		camActionsLive?.removeAttribute('hidden');
		camActionsReview?.setAttribute('hidden', '');
		// Re-show the oval while shooting.
		camOval?.removeAttribute('hidden');
		camHint?.removeAttribute('hidden');
	} else {
		camActionsLive?.setAttribute('hidden', '');
		camActionsReview?.removeAttribute('hidden');
		camOval?.setAttribute('hidden', '');
		camHint?.setAttribute('hidden', '');
	}
}

/** @param {string} msg */
function showCamError(msg) {
	if (!camError) return;
	camError.textContent = msg;
	camError.removeAttribute('hidden');
}

// Surface an actionable notice on the persistent page banner (the same element
// used for unsupported browsers). Used when the camera can't open — its message
// must outlive the overlay being closed.
function showPageNotice(msg) {
	if (!unsupportedMsg) return;
	unsupportedMsg.textContent = msg;
	unsupportedMsg.classList.add('show');
}

camOverlay?.addEventListener('click', (e) => {
	const target = /** @type {HTMLElement} */ (e.target);
	const action = target.closest('[data-cam-action]')?.getAttribute('data-cam-action');
	if (!action) return;
	if (action === 'cancel') closeCamera();
	else if (action === 'shoot') startCountdown();
	else if (action === 'retake') {
		clearPending();
		setCamMode('live');
		startFaceQuality(cam.slot || REQUIRED_SLOT);
	} else if (action === 'use') confirmCamShot();
});

// Escape closes the camera dialog (it's role="dialog" aria-modal) — keyboard
// parity with the Cancel button so the overlay is never a mouse-only trap.
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && camOverlay?.classList.contains('open')) {
		e.preventDefault();
		closeCamera();
	}
});

function startCountdown() {
	if (!camShutter || camShutter.hasAttribute('disabled')) return;
	if (cam.countdownTimers.length) return;
	setShutterEnabled(false);
	camOval?.setAttribute('hidden', '');
	camHint?.setAttribute('hidden', '');
	const steps = ['3', '2', '1'];
	camCountdown?.classList.add('show');
	steps.forEach((s, i) => {
		const t = window.setTimeout(() => {
			if (camCountNum) {
				camCountNum.textContent = s;
				// retrigger animation by removing/adding
				camCountNum.style.animation = 'none';
				void camCountNum.offsetWidth;
				camCountNum.style.animation = '';
			}
		}, i * 950);
		cam.countdownTimers.push(t);
	});
	const fireT = window.setTimeout(() => {
		camCountdown?.classList.remove('show');
		shoot();
		cam.countdownTimers = [];
	}, steps.length * 950);
	cam.countdownTimers.push(fireT);
}

function cancelCountdown() {
	cam.countdownTimers.forEach((t) => clearTimeout(t));
	cam.countdownTimers = [];
	camCountdown?.classList.remove('show');
}

async function shoot() {
	if (!camVideo || !cam.stream) return;
	if (camShutter?.hasAttribute('disabled')) return;
	const w = camVideo.videoWidth;
	const h = camVideo.videoHeight;
	if (!w || !h) return;
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	// Un-mirror: the <video> is CSS-flipped for selfie feel, but the saved file
	// should match what the camera actually sees.
	ctx.drawImage(camVideo, 0, 0, w, h);

	stopFaceQuality();

	const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
	if (!blob) {
		showCamError('Snapshot failed. Try again.');
		return;
	}
	const file = new File([blob], `${cam.slot || 'photo'}.jpg`, { type: 'image/jpeg' });
	cam.pendingFile = file;
	cam.pendingUrl = URL.createObjectURL(file);

	const stage = document.getElementById('cam-stage');
	if (stage) {
		const img = document.createElement('img');
		img.className = 'preview';
		img.alt = 'captured preview';
		img.src = cam.pendingUrl;
		stage.appendChild(img);
	}
	setCamMode('review');
	scoreStill(canvas, cam.slot || REQUIRED_SLOT);
}

/**
 * Score the frozen still in review mode. The live gates watched the video
 * feed, but the countdown leaves ~3s for motion blur, a lighting change, or a
 * head turn to land in the actual capture; this grades the exact pixels that
 * would be submitted, against the same shared gates. Only a missing face
 * blocks "Use this" (mirroring the reconstruction worker's one hard input
 * rejection); everything else is a warning the user can accept.
 *
 * @param {HTMLCanvasElement} canvas the captured frame
 * @param {string} slot
 */
async function scoreStill(canvas, slot) {
	const badges = document.getElementById('cam-badges');
	const verdictEl = document.getElementById('cam-review-verdict');
	const useBtn = /** @type {HTMLButtonElement | null} */ (
		document.querySelector('[data-cam-action="use"]')
	);
	const seq = ++_stillSeq;
	if (verdictEl) {
		verdictEl.textContent = 'Checking shot...';
		verdictEl.className = '';
		verdictEl.removeAttribute('hidden');
	}
	let report;
	try {
		report = await checkImageQuality(canvas, slot);
	} catch (err) {
		// Scoring is advisory; if the model can't load, the server-side
		// assessment at submit time remains the authority. Never trap the user.
		log.warn('[selfie] still scoring failed, allowing through:', err);
		if (seq === _stillSeq) verdictEl?.setAttribute('hidden', '');
		return;
	}
	// A retake or slot change superseded this scoring pass.
	if (seq !== _stillSeq || !cam.pendingFile) return;

	renderQualityBadges(badges, report, slot);
	if (verdictEl) {
		if (!report.faceFound) {
			verdictEl.textContent =
				'No face in this shot. Retake it so your avatar has something to build from.';
			verdictEl.className = 'bad';
		} else if (report.allPass) {
			verdictEl.textContent = 'Sharp, lit, and framed. Use this shot.';
			verdictEl.className = 'ok';
		} else {
			verdictEl.textContent = `${report.reason || 'This shot could be better.'} You can still use it.`;
			verdictEl.className = 'warn';
		}
		verdictEl.removeAttribute('hidden');
	}
	if (useBtn) useBtn.disabled = !report.faceFound;
}

let _stillSeq = 0;

function clearStillVerdict() {
	_stillSeq++;
	const verdictEl = document.getElementById('cam-review-verdict');
	verdictEl?.setAttribute('hidden', '');
	const useBtn = /** @type {HTMLButtonElement | null} */ (
		document.querySelector('[data-cam-action="use"]')
	);
	if (useBtn) useBtn.disabled = false;
	const badges = document.getElementById('cam-badges');
	if (badges) badges.innerHTML = '';
}

function confirmCamShot() {
	if (!cam.pendingFile || !cam.slot) return;
	const slot = cam.slot;
	const file = cam.pendingFile;
	cam.pendingFile = null;
	cam.pendingUrl = null;
	closeCamera();
	setSlot(slot, file);
}

// ── Capture progress persistence ───────────────────────────────────────────
// A phone refresh, an accidental back-swipe, or a tab discard mid-capture used
// to throw away every shot already taken. Each confirmed slot is mirrored to
// sessionStorage (downscaled: the reconstruction lane caps input at 1024px
// anyway) and restored on load, so the user resumes exactly where they were.
// The building phase has its own resume rail (selfie:pendingJobId in
// selfie-pipeline.js); this covers the capture phase before submit.
const PROGRESS_KEY = 'threews:selfie-progress';
const PERSIST_MAX_DIM = 1024;
const PERSIST_JPEG_QUALITY = 0.85;

async function persistProgress() {
	let payload;
	try {
		payload = { avatarType: state.avatarType, slots: {} };
		for (const slot of ALL_SLOTS) {
			const file = state.files[slot];
			if (!file) continue;
			payload.slots[slot] = {
				name: file.name || `${slot}.jpg`,
				dataUrl: await fileToScaledDataUrl(file),
			};
		}
	} catch (err) {
		log.warn('[selfie] could not serialize capture progress:', err);
		return;
	}
	try {
		if (Object.keys(payload.slots).length === 0 && state.avatarType === 'v1') {
			sessionStorage.removeItem(PROGRESS_KEY);
		} else {
			sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(payload));
		}
	} catch (err) {
		// Storage full or blocked: capture still works, it just won't survive a
		// refresh. Never let persistence break the flow.
		log.warn('[selfie] could not persist capture progress:', err);
	}
}

function clearProgress() {
	try { sessionStorage.removeItem(PROGRESS_KEY); } catch (_) {}
}

/** @param {File} file */
async function fileToScaledDataUrl(file) {
	const bitmap = await (async () => {
		if (typeof createImageBitmap === 'function') {
			try { return await createImageBitmap(file); } catch (_) {}
		}
		return new Promise((resolve, reject) => {
			const img = new Image();
			const url = URL.createObjectURL(file);
			img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
			img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not decode image')); };
			img.src = url;
		});
	})();
	const w = bitmap.width || bitmap.naturalWidth;
	const h = bitmap.height || bitmap.naturalHeight;
	const scale = Math.min(1, PERSIST_MAX_DIM / Math.max(w, h));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(w * scale));
	canvas.height = Math.max(1, Math.round(h * scale));
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('2d canvas unsupported');
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	try { bitmap.close?.(); } catch (_) {}
	return canvas.toDataURL('image/jpeg', PERSIST_JPEG_QUALITY);
}

(function restoreProgress() {
	let raw;
	try {
		raw = sessionStorage.getItem(PROGRESS_KEY);
	} catch {
		return; // storage blocked (private mode / cookies off)
	}
	if (!raw) return;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		clearProgress();
		return;
	}
	if (parsed?.avatarType === 'v2') {
		state.avatarType = 'v2';
		styleBtns.forEach((b) => {
			b.setAttribute('aria-pressed', String(b.getAttribute('data-type') === 'v2'));
		});
	}
	let restoredAny = false;
	for (const slot of ALL_SLOTS) {
		const entry = parsed?.slots?.[slot];
		if (!entry || typeof entry.dataUrl !== 'string' || !entry.dataUrl.startsWith('data:image/')) continue;
		const file = dataUrlToFile(entry.dataUrl, typeof entry.name === 'string' ? entry.name : `${slot}.jpg`);
		if (!file) continue;
		state.files[slot] = file;
		renderSlot(slot);
		restoredAny = true;
		if (slot !== REQUIRED_SLOT) {
			// Reveal restored side shots; they live behind the disclosure.
			const fid = /** @type {HTMLDetailsElement|null} */ (document.getElementById('fidelity-boost'));
			if (fid) fid.open = true;
		}
	}
	if (restoredAny) {
		updateSubmit();
		if (state.files[REQUIRED_SLOT]) {
			document.dispatchEvent(new CustomEvent('selfie:photo-added', {
				detail: { slot: REQUIRED_SLOT, file: state.files[REQUIRED_SLOT] },
			}));
		}
	}
})();

// ── Homepage handoff ─────────────────────────────────────────────────────────
// The homepage Avatar Studio teaser lets a visitor drop/capture a selfie, then
// sends them here to finish the real build. It stashes that photo in
// sessionStorage; pick it up as the frontal slot so they don't re-capture.
(function ingestHandoff() {
	let raw;
	try {
		raw = sessionStorage.getItem('threews:selfie-handoff');
		if (raw) sessionStorage.removeItem('threews:selfie-handoff');
	} catch {
		return; // storage blocked (private mode / cookies off)
	}
	if (!raw) return;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	const dataUrl = parsed?.dataUrl;
	if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return;
	const file = dataUrlToFile(dataUrl, typeof parsed?.name === 'string' ? parsed.name : 'selfie.jpg');
	if (file) setSlot(REQUIRED_SLOT, file);
})();

// ── Android share-sheet handoff ─────────────────────────────────────────────
// On the Seeker app (and any installed PWA) a photo shared into three.ws is
// POSTed to /create/share, parked in the Cache API by public/share-target-sw.js,
// and the user lands here with ?shared=1. Fill frontal, then left and right,
// with whatever images arrived; the read is one-shot, and the param is
// stripped so a reload does not look like a fresh share.
(async function ingestSharedPhotos() {
	if (!sharedIntent()) return;
	const order = [REQUIRED_SLOT, 'left', 'right'];
	try {
		const { files } = await takeSharedFiles();
		const images = files.filter(isImage);
		images.slice(0, order.length).forEach((file, i) => setSlot(order[i], file));
	} catch (err) {
		log.warn('[selfie] could not read shared photos:', err);
	} finally {
		clearSharedIntent();
	}
})();

/**
 * @param {string} dataUrl
 * @param {string} name
 * @returns {File | null}
 */
function dataUrlToFile(dataUrl, name) {
	const comma = dataUrl.indexOf(',');
	if (comma < 0) return null;
	const header = dataUrl.slice(0, comma);
	const mime = (header.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
	const body = dataUrl.slice(comma + 1);
	let bytes;
	try {
		const bin = /;base64/i.test(header) ? atob(body) : decodeURIComponent(body);
		bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	} catch {
		return null;
	}
	const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
	const safeName = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${ext}`;
	return new File([bytes], safeName, { type: mime });
}

// ── Utilities ──────────────────────────────────────────────────────────────
/** @param {string} slot */
function slotPretty(slot) {
	if (slot === 'frontal') return 'selfie';
	if (slot === 'left') return 'left angle';
	if (slot === 'right') return 'right angle';
	return slot;
}
