/**
 * Selfie capture flow — entry for /create.
 *
 * Manages two steps:
 *   1. Method choice (camera vs upload)
 *   2. 3-photo capture (Frontal / Left / Right) + body/avatar type selectors
 *
 * On submit, dispatches a `selfie:submit` CustomEvent on document with
 *   detail = { files: { frontal, left, right }, bodyType, avatarType, method }
 * which the selfie pipeline picks up to drive avatar reconstruction.
 */

const SLOT_KEYS = /** @type {const} */ (['frontal', 'left', 'right']);

const state = {
	method: /** @type {'camera' | 'upload' | null} */ (null),
	bodyType: /** @type {'male' | 'female'} */ ('male'),
	avatarType: /** @type {'v1' | 'v2'} */ ('v1'),
	files: /** @type {Record<string, File | null>} */ ({ frontal: null, left: null, right: null }),
};

const cameraSupported =
	typeof navigator !== 'undefined' &&
	!!navigator.mediaDevices &&
	typeof navigator.mediaDevices.getUserMedia === 'function';

// ── DOM refs ───────────────────────────────────────────────────────────────
const steps = /** @type {NodeListOf<HTMLElement>} */ (
	document.querySelectorAll('.step[data-step]')
);
const backBtn = /** @type {HTMLButtonElement} */ (document.getElementById('back-btn'));
const choiceButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (
	document.querySelectorAll('.choice[data-method]')
);
const unsupportedMsg = document.getElementById('unsupported-msg');
const slotFrames = /** @type {NodeListOf<HTMLElement>} */ (
	document.querySelectorAll('.slot-frame[data-slot]')
);
const slotInputs = /** @type {NodeListOf<HTMLInputElement>} */ (
	document.querySelectorAll('input[data-slot-input]')
);
const submitBar = document.getElementById('submit-bar');
const submitBtn = /** @type {HTMLButtonElement} */ (document.getElementById('submit-btn'));
const bodyBtns = /** @type {NodeListOf<HTMLButtonElement>} */ (
	document.querySelectorAll('[data-body]')
);
const typeBtns = /** @type {NodeListOf<HTMLButtonElement>} */ (
	document.querySelectorAll('[data-type]')
);

// ── Step 1: method picker ──────────────────────────────────────────────────
if (!cameraSupported) {
	const camChoice = /** @type {HTMLButtonElement | null} */ (
		document.querySelector('.choice[data-method="camera"]')
	);
	if (camChoice) {
		camChoice.disabled = true;
		camChoice.setAttribute('aria-disabled', 'true');
	}
	unsupportedMsg?.classList.add('show');
}

choiceButtons.forEach((btn) => {
	btn.addEventListener('click', () => {
		const method = /** @type {'camera'|'upload'|null} */ (btn.getAttribute('data-method'));
		if (!method || btn.disabled) return;
		if (method === 'camera' && !cameraSupported) return;
		state.method = method;
		goToStep('capture');
	});
});

backBtn.addEventListener('click', () => {
	const current = currentStep();
	if (current === 'capture') {
		goToStep('method');
	} else {
		window.location.assign('/');
	}
});

// ── Step 2: slot fill ──────────────────────────────────────────────────────
slotFrames.forEach((frame) => {
	const slot = frame.getAttribute('data-slot');
	if (!slot) return;

	const open = () => {
		if (state.files[slot]) return; // already filled — use retake button to replace
		if (state.method === 'camera') {
			openCamera(slot);
		} else {
			/** @type {HTMLInputElement | null} */ (
				document.querySelector(`input[data-slot-input="${slot}"]`)
			)?.click();
		}
	};

	frame.addEventListener('click', open);
	frame.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			open();
		}
	});

	// Drag + drop
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
typeBtns.forEach((btn) => {
	btn.addEventListener('click', () => {
		const val = /** @type {'v1'|'v2'} */ (btn.getAttribute('data-type'));
		state.avatarType = val;
		typeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
	});
});

// ── Submit ─────────────────────────────────────────────────────────────────
submitBtn.addEventListener('click', () => {
	if (!allSlotsFilled()) return;
	document.dispatchEvent(
		new CustomEvent('selfie:submit', {
			detail: {
				files: { ...state.files },
				bodyType: state.bodyType,
				avatarType: state.avatarType,
				method: state.method,
			},
		}),
	);
	submitBtn.textContent = 'Sending…';
	submitBtn.disabled = true;
	submitBtn.classList.remove('ready');
});

// ── Step machine ───────────────────────────────────────────────────────────
/** @returns {'method' | 'capture'} */
function currentStep() {
	const active = document.querySelector('.step.active');
	return /** @type {'method'|'capture'} */ (active?.getAttribute('data-step') || 'method');
}

/** @param {'method' | 'capture'} step */
function goToStep(step) {
	steps.forEach((el) => el.classList.toggle('active', el.getAttribute('data-step') === step));
	if (submitBar) submitBar.hidden = step !== 'capture';
	window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

// ── Slot helpers ───────────────────────────────────────────────────────────
/** @param {File} file */
function isImage(file) {
	return /^image\/(jpeg|png)$/i.test(file.type || '');
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
	const frame = /** @type {HTMLElement | null} */ (
		document.querySelector(`.slot-frame[data-slot="${slot}"]`)
	);
	if (!frame) return;
	const file = state.files[slot];

	// Clean up any existing preview / retake artefacts.
	frame.querySelector('img.preview')?.remove();
	frame.querySelector('.retake-btn')?.remove();

	if (!file) {
		frame.classList.remove('filled');
		return;
	}

	frame.classList.add('filled');

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

function allSlotsFilled() {
	return SLOT_KEYS.every((k) => !!state.files[k]);
}

function updateSubmit() {
	const n = SLOT_KEYS.filter((k) => !!state.files[k]).length;
	submitBtn.textContent = n === 3 ? 'Submit' : `Upload ${n}/3`;
	const ready = n === 3;
	submitBtn.disabled = !ready;
	submitBtn.classList.toggle('ready', ready);
}

// ── Camera overlay ─────────────────────────────────────────────────────────
const camOverlay = document.getElementById('cam-overlay');
const camVideo = /** @type {HTMLVideoElement | null} */ (document.getElementById('cam-video'));
const camSlotName = document.getElementById('cam-slot-name');
const camError = document.getElementById('cam-error');
const camActionsLive = document.getElementById('cam-actions-live');
const camActionsReview = document.getElementById('cam-actions-review');

const cam = {
	stream: /** @type {MediaStream | null} */ (null),
	slot: /** @type {string | null} */ (null),
	pendingFile: /** @type {File | null} */ (null),
	pendingUrl: /** @type {string | null} */ (null),
};

/** @param {string} slot */
async function openCamera(slot) {
	if (!camOverlay || !camVideo) return;
	cam.slot = slot;
	if (camSlotName) camSlotName.textContent = slotPretty(slot);
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
	}
}

function closeCamera() {
	if (cam.stream) {
		cam.stream.getTracks().forEach((t) => t.stop());
		cam.stream = null;
	}
	if (camVideo) camVideo.srcObject = null;
	camOverlay?.classList.remove('open');
	clearPending();
	cam.slot = null;
}

function clearPending() {
	if (cam.pendingUrl) URL.revokeObjectURL(cam.pendingUrl);
	cam.pendingUrl = null;
	cam.pendingFile = null;
	// Remove any transient preview img in the stage.
	document.querySelector('#cam-stage img.preview')?.remove();
}

/** @param {'live' | 'review'} mode */
function setCamMode(mode) {
	if (mode === 'live') {
		camActionsLive?.removeAttribute('hidden');
		camActionsReview?.setAttribute('hidden', '');
	} else {
		camActionsLive?.setAttribute('hidden', '');
		camActionsReview?.removeAttribute('hidden');
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
	else if (action === 'shoot') shoot();
	else if (action === 'retake') {
		clearPending();
		setCamMode('live');
	} else if (action === 'use') confirmCamShot();
});

async function shoot() {
	if (!camVideo || !cam.stream) return;
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

	const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
	if (!blob) {
		showCamError('Snapshot failed. Try again.');
		return;
	}
	const file = new File([blob], `${cam.slot || 'photo'}.jpg`, { type: 'image/jpeg' });
	cam.pendingFile = file;
	cam.pendingUrl = URL.createObjectURL(file);

	// Show preview over the video feed.
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
	if (slot === 'frontal') return 'Frontal';
	if (slot === 'left') return 'Left';
	if (slot === 'right') return 'Right';
	return slot;
}
