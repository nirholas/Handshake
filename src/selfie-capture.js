/**
 * Selfie capture flow — entry for /create/selfie.
 *
 * Hero slot (frontal) is required. Side slots (left / right) are optional —
 * they live under the "Add side angles" disclosure and bump reconstruction
 * fidelity when supplied. Capture method (camera vs upload) is picked per slot.
 *
 * On submit, dispatches a `selfie:submit` CustomEvent on document with
 *   detail = { files: { frontal, left?, right? }, bodyType, avatarType, method }
 * which the selfie pipeline picks up to drive avatar reconstruction.
 */

const REQUIRED_SLOT = 'frontal';
const OPTIONAL_SLOTS = /** @type {const} */ (['left', 'right']);
const ALL_SLOTS = /** @type {const} */ ([REQUIRED_SLOT, ...OPTIONAL_SLOTS]);

const ETA_FAST_SEC = 45;
const ETA_HIGH_SEC = 75;

const state = {
	bodyType: /** @type {'male' | 'female'} */ ('male'),
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
const bodyBtns = /** @type {NodeListOf<HTMLButtonElement>} */ (
	document.querySelectorAll('[data-body]')
);
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
bodyBtns.forEach((btn) => {
	btn.addEventListener('click', () => {
		const val = /** @type {'male'|'female'} */ (btn.getAttribute('data-body'));
		state.bodyType = val;
		bodyBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
	});
});
styleBtns.forEach((btn) => {
	btn.addEventListener('click', () => {
		const val = /** @type {'v1'|'v2'} */ (btn.getAttribute('data-type'));
		state.avatarType = val;
		styleBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
	});
});

// ── External reset (e.g. "Try again" on the done step) ────────────────────
document.addEventListener('selfie:reset', () => {
	ALL_SLOTS.forEach((s) => { state.files[s] = null; });
	ALL_SLOTS.forEach(renderSlot);
	updateSubmit();
});

// ── Submit ─────────────────────────────────────────────────────────────────
submitBtn.addEventListener('click', () => {
	if (!state.files[REQUIRED_SLOT]) return;
	document.dispatchEvent(
		new CustomEvent('selfie:submit', {
			detail: {
				files: { ...state.files },
				bodyType: state.bodyType,
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
}

/** @param {string} slot */
function clearSlot(slot) {
	state.files[slot] = null;
	renderSlot(slot);
	updateSubmit();
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
	detector: /** @type {any} */ (null),
	detectInterval: /** @type {number | null} */ (null),
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
		console.warn('[selfie] camera error:', err);
		showCamError('Could not access camera. Check permissions and try again.');
		setShutterEnabled(true);
		return;
	}

	// Best-effort face tracking. FaceDetector is non-standard but ships in
	// Chromium on Android/desktop; on Safari/Firefox we fall back to always-
	// enabled shutter and a softer hint.
	if (slot === REQUIRED_SLOT) {
		startFaceDetect();
	}
}

function startFaceDetect() {
	const FD = /** @type {any} */ (window).FaceDetector;
	if (typeof FD !== 'function') {
		// No detector available — let the user shoot freely; keep the dashed oval
		// as a framing guide.
		setShutterEnabled(true);
		return;
	}
	try {
		cam.detector = new FD({ fastMode: true, maxDetectedFaces: 1 });
	} catch (err) {
		console.warn('[selfie] FaceDetector init failed:', err);
		setShutterEnabled(true);
		return;
	}
	cam.detectInterval = window.setInterval(runDetect, 250);
}

async function runDetect() {
	if (!cam.detector || !camVideo || !cam.stream) return;
	if (camVideo.readyState < 2) return;
	let faces;
	try {
		faces = await cam.detector.detect(camVideo);
	} catch (_) {
		// Detector failed mid-stream — degrade gracefully, never block the user.
		stopFaceDetect();
		setShutterEnabled(true);
		return;
	}
	const got = Array.isArray(faces) && faces.length > 0;
	if (got) {
		const face = faces[0];
		const bb = face.boundingBox;
		const vw = camVideo.videoWidth || 1;
		const vh = camVideo.videoHeight || 1;
		const cx = (bb.x + bb.width / 2) / vw;
		const cy = (bb.y + bb.height / 2) / vh;
		const sz = Math.max(bb.width / vw, bb.height / vh);
		const centered = Math.abs(cx - 0.5) < 0.18 && Math.abs(cy - 0.5) < 0.22;
		const sized = sz > 0.32 && sz < 0.85;
		const ok = centered && sized;
		setShutterEnabled(true);
		camOval?.classList.toggle('detected', ok);
		if (camHint) {
			if (ok) {
				camHint.textContent = 'Looks good — tap the shutter';
				camHint.classList.add('ok');
				cam.faceLocked = true;
			} else if (!sized) {
				camHint.textContent = sz <= 0.32 ? 'Move closer' : 'Move back';
				camHint.classList.remove('ok');
			} else {
				camHint.textContent = 'Center your face in the oval';
				camHint.classList.remove('ok');
			}
		}
	} else {
		setShutterEnabled(false);
		camOval?.classList.remove('detected');
		if (camHint) {
			camHint.textContent = 'No face detected — face the camera';
			camHint.classList.remove('ok');
		}
	}
}

function stopFaceDetect() {
	if (cam.detectInterval != null) {
		clearInterval(cam.detectInterval);
		cam.detectInterval = null;
	}
	cam.detector = null;
}

/** @param {boolean} on */
function setShutterEnabled(on) {
	if (!camShutter) return;
	if (on) camShutter.removeAttribute('disabled');
	else camShutter.setAttribute('disabled', '');
}

function closeCamera() {
	stopFaceDetect();
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

camOverlay?.addEventListener('click', (e) => {
	const target = /** @type {HTMLElement} */ (e.target);
	const action = target.closest('[data-cam-action]')?.getAttribute('data-cam-action');
	if (!action) return;
	if (action === 'cancel') closeCamera();
	else if (action === 'shoot') startCountdown();
	else if (action === 'retake') {
		clearPending();
		setCamMode('live');
		if (cam.slot === REQUIRED_SLOT) startFaceDetect();
	} else if (action === 'use') confirmCamShot();
});

function startCountdown() {
	if (camShutter?.hasAttribute('disabled')) return;
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

	stopFaceDetect();

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
}

function confirmCamShot() {
	if (!cam.pendingFile || !cam.slot) return;
	const slot = cam.slot;
	const file = cam.pendingFile;
	closeCamera();
	setSlot(slot, file);
}

// ── Utilities ──────────────────────────────────────────────────────────────
/** @param {string} slot */
function slotPretty(slot) {
	if (slot === 'frontal') return 'selfie';
	if (slot === 'left') return 'left angle';
	if (slot === 'right') return 'right angle';
	return slot;
}
