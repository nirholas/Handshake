/**
 * Forge Reel: turn a forged model into shareable media without leaving the page.
 *
 * A text-to-3D site normally hands back a GLB and stops there. That is the
 * wrong last mile: almost nobody's next step is "open Blender", it is "show
 * someone". Cinema mode already gave /forge a clean fullscreen turntable, but
 * it still assumed the user owned a screen recorder, knew how to crop it, and
 * would accept whatever framerate their capture tool felt like.
 *
 * This module removes that entire detour. It drives the result <model-viewer>
 * along a scripted camera track, records the live WebGL canvas through
 * MediaRecorder, and hands back three real files:
 *
 *   - a looping video (MP4 where the browser can encode it, WebM otherwise)
 *   - a hero still at the reel's aspect
 *   - a square still sized for link previews and app icons
 *
 * Everything runs client side. No upload, no queue, no worker, no server cost,
 * and the pixels are the exact pixels the user is looking at: same GLB, same
 * HDRI environment, same tone mapping. The camera track is expressed in
 * multiples of the model's own framed radius, so a teacup and a cathedral get
 * the same shot rather than the same numbers.
 *
 * The pure pieces (the shot tracks, the sampler, the codec choice, the output
 * dimensions) are exported and covered by tests/forge-reel.test.js. The mount
 * is DOM guarded so importing this file in Node is safe.
 */

/** Frames per second requested from the canvas stream. */
export const REEL_FPS = 30;

/** Video bitrate. High enough that a dark model on a dark stage stays clean. */
const VIDEO_BITRATE = 12_000_000;

/**
 * Output sizes, in CSS pixels.
 *
 * The recorded canvas is this multiplied by devicePixelRatio, so a 2x display
 * yields a 2560x1440 file from the 16:9 entry. The stage is scaled down with a
 * CSS transform when the viewport is smaller, which changes what the user sees
 * and not what gets encoded.
 */
export const REEL_ASPECTS = [
	{ id: 'wide', label: '16:9', hint: 'Landscape, for sites and decks', width: 1280, height: 720 },
	{ id: 'square', label: '1:1', hint: 'Square, for link previews', width: 900, height: 900 },
	{ id: 'tall', label: '9:16', hint: 'Vertical, for phone video', width: 540, height: 960 },
];

/** Reel lengths offered. Short is the default: most people rewatch, few wait. */
export const REEL_DURATIONS = [4, 8, 12];

/**
 * Camera tracks.
 *
 * A keyframe is `{ t, theta, phi, radius, fov }`:
 *   t       0..1 position along the reel
 *   theta   yaw in degrees, allowed to exceed 360 so a spin reads as a spin
 *   phi     polar angle in degrees (90 is eye level, smaller looks down)
 *   radius  multiple of the model's own framed distance, so scale is irrelevant
 *   fov     multiple of the viewer's default field of view
 *
 * `ease` names the curve used to reach that keyframe from the previous one.
 * `heroT` marks the moment the stills are taken: the frame the shot was built
 * to arrive at.
 */
export const REEL_PRESETS = [
	{
		id: 'turntable',
		label: 'Turntable',
		blurb: 'One clean revolution. Loops seamlessly, reads as a product shot.',
		heroT: 0.12,
		track: [
			{ t: 0, theta: 0, phi: 78, radius: 1, fov: 1, ease: 'linear' },
			{ t: 1, theta: 360, phi: 78, radius: 1, fov: 1, ease: 'linear' },
		],
	},
	{
		id: 'hero',
		label: 'Hero push',
		blurb: 'Opens wide, pushes in, settles on a three-quarter hero angle.',
		heroT: 1,
		track: [
			{ t: 0, theta: -58, phi: 88, radius: 1.55, fov: 1.14, ease: 'linear' },
			{ t: 0.55, theta: -16, phi: 72, radius: 1.02, fov: 1, ease: 'out' },
			{ t: 1, theta: 16, phi: 68, radius: 0.95, fov: 0.95, ease: 'inout' },
		],
	},
	{
		id: 'reveal',
		label: 'Low reveal',
		blurb: 'Rises from below the horizon into the hero angle. Good for props.',
		heroT: 1,
		track: [
			{ t: 0, theta: 200, phi: 104, radius: 1.4, fov: 1.1, ease: 'linear' },
			{ t: 0.55, theta: 300, phi: 84, radius: 1.08, fov: 1, ease: 'out' },
			{ t: 1, theta: 382, phi: 70, radius: 1, fov: 0.96, ease: 'inout' },
		],
	},
];

const EASINGS = {
	linear: (x) => x,
	out: (x) => 1 - (1 - x) ** 3,
	in: (x) => x ** 3,
	inout: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
};

/**
 * Sample a camera track at normalised time `t`.
 *
 * Returns `{ theta, phi, radius, fov }` with radius and fov still expressed as
 * multiples. Out-of-range `t` clamps to the endpoints rather than extrapolating,
 * because an extrapolated camera flies through the model.
 */
export function sampleTrack(track, t) {
	if (!Array.isArray(track) || track.length === 0) {
		throw new Error('sampleTrack needs at least one keyframe');
	}
	const clamped = Math.min(1, Math.max(0, Number(t) || 0));
	if (clamped <= track[0].t) return frameOf(track[0]);
	const last = track[track.length - 1];
	if (clamped >= last.t) return frameOf(last);

	let i = 0;
	while (i < track.length - 1 && track[i + 1].t < clamped) i++;
	const a = track[i];
	const b = track[i + 1];
	const span = b.t - a.t;
	const local = span <= 0 ? 1 : (clamped - a.t) / span;
	const ease = EASINGS[b.ease] || EASINGS.inout;
	const k = ease(local);
	return {
		theta: lerp(a.theta, b.theta, k),
		phi: lerp(a.phi, b.phi, k),
		radius: lerp(a.radius, b.radius, k),
		fov: lerp(a.fov, b.fov, k),
	};
}

const lerp = (a, b, k) => a + (b - a) * k;
const frameOf = (kf) => ({ theta: kf.theta, phi: kf.phi, radius: kf.radius, fov: kf.fov });

/**
 * Candidate recording formats, best first.
 *
 * MP4 is preferred because it drops straight into a slide, a phone, or an X
 * post without conversion. Chrome gained MP4 recording only recently and Safari
 * spells its codecs differently, so VP9 WebM stays as the universal floor.
 */
export const REEL_MIME_CANDIDATES = [
	{ mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
	{ mime: 'video/mp4', ext: 'mp4' },
	{ mime: 'video/webm;codecs=vp9', ext: 'webm' },
	{ mime: 'video/webm;codecs=vp8', ext: 'webm' },
	{ mime: 'video/webm', ext: 'webm' },
];

/**
 * Pick the first candidate the browser will actually encode.
 *
 * `isSupported` is injected so the choice is testable without a MediaRecorder.
 * Returns null when nothing is supported, which is a real state: the caller
 * falls back to stills instead of pretending a recording happened.
 */
export function pickVideoFormat(isSupported, candidates = REEL_MIME_CANDIDATES) {
	if (typeof isSupported !== 'function') return null;
	for (const candidate of candidates) {
		try {
			if (isSupported(candidate.mime)) return candidate;
		} catch {
			// A browser that throws on an unknown codec string is saying "no".
		}
	}
	return null;
}

/**
 * Build the download filename for one reel artefact.
 *
 * Keeps the model's own name so a folder of downloads stays sorted next to the
 * GLB it came from, and strips anything a filesystem would object to.
 */
export function reelFilename(base, presetId, kind, ext) {
	const safe =
		String(base || 'forge')
			.replace(/\.[a-z0-9]+$/i, '')
			.replace(/[^\w.-]+/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 64) || 'forge';
	return `${safe}-${presetId}-${kind}.${ext}`;
}

/** Human file size for the result panel. Bytes are never the useful unit here. */
export function formatBytes(bytes) {
	const n = Number(bytes) || 0;
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Fit an output size inside the viewport without changing the output size.
 *
 * Returns the CSS transform scale for the stage. Capped at 1 so a small reel
 * is never blown up past its own resolution on a large screen.
 */
export function stageScale(output, viewport, padding = { x: 48, y: 210 }) {
	const availW = Math.max(160, viewport.width - padding.x);
	const availH = Math.max(160, viewport.height - padding.y);
	return Math.min(1, availW / output.width, availH / output.height);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function mountForgeReel() {
	const viewer = document.getElementById('viewer');
	const download = document.getElementById('download');
	const cinema = document.getElementById('cinema');
	const shell = document.getElementById('viewer-shell');
	const resultPanel = document.getElementById('state-result');
	if (!viewer || !shell || !resultPanel || !download) return;

	injectStyles();

	// ---- trigger ----------------------------------------------------------

	const trigger = document.createElement('button');
	trigger.type = 'button';
	trigger.className = 'btn btn-ghost reel-trigger';
	trigger.id = 'reel-open';
	trigger.title = 'Reel: record a cinematic video and stills of this model (R)';
	trigger.setAttribute('aria-haspopup', 'dialog');
	trigger.innerHTML = `${ICON_REEL}Reel`;
	if (cinema && cinema.parentNode) cinema.parentNode.insertBefore(trigger, cinema);
	else download.parentNode.insertBefore(trigger, download);

	// ---- dialog -----------------------------------------------------------

	const dialog = document.createElement('div');
	dialog.className = 'reel-dialog';
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	dialog.setAttribute('aria-label', 'Record a reel of this model');
	dialog.hidden = true;
	dialog.innerHTML = dialogMarkup();
	document.body.appendChild(dialog);

	const el = {
		panel: dialog.querySelector('.reel-panel'),
		close: dialog.querySelector('.reel-close'),
		setup: dialog.querySelector('.reel-setup'),
		presets: dialog.querySelector('.reel-presets'),
		aspects: dialog.querySelector('.reel-aspects'),
		durations: dialog.querySelector('.reel-durations'),
		start: dialog.querySelector('.reel-start'),
		summary: dialog.querySelector('.reel-summary'),
		recording: dialog.querySelector('.reel-recording'),
		bar: dialog.querySelector('.reel-bar-fill'),
		clock: dialog.querySelector('.reel-clock'),
		cancel: dialog.querySelector('.reel-cancel'),
		done: dialog.querySelector('.reel-done'),
		video: dialog.querySelector('.reel-video'),
		files: dialog.querySelector('.reel-files'),
		again: [...dialog.querySelectorAll('.reel-again')],
		fallback: dialog.querySelector('.reel-fallback'),
		fallbackShots: dialog.querySelector('.reel-fallback-shots'),
		recordingTitle: dialog.querySelector('.reel-recording-title'),
	};

	// ---- capture stage ----------------------------------------------------

	const backdrop = document.createElement('div');
	backdrop.className = 'reel-stage-backdrop';
	backdrop.hidden = true;
	backdrop.innerHTML =
		'<p class="reel-stage-note" role="status" aria-live="polite">Recording. Do not switch tabs: a background tab stops painting and the reel stops with it.</p>';
	document.body.appendChild(backdrop);

	const spacer = document.createElement('div');
	spacer.className = 'reel-spacer';
	spacer.hidden = true;
	shell.parentNode.insertBefore(spacer, shell);

	// ---- state ------------------------------------------------------------

	const choice = { preset: REEL_PRESETS[0], aspect: REEL_ASPECTS[0], duration: REEL_DURATIONS[0] };
	let capturing = false;
	let cancelled = false;
	let lastFocus = null;
	const artefacts = [];

	buildChoiceRow(el.presets, REEL_PRESETS, 'preset');
	buildChoiceRow(el.aspects, REEL_ASPECTS, 'aspect');
	buildDurationRow(el.durations);
	syncSummary();

	function buildChoiceRow(host, items, kind) {
		for (const item of items) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'reel-chip';
			b.dataset.kind = kind;
			b.dataset.id = item.id;
			b.setAttribute('aria-pressed', String(item.id === choice[kind].id));
			b.innerHTML = `<span class="reel-chip-label">${item.label}</span><span class="reel-chip-hint">${item.blurb || item.hint || ''}</span>`;
			b.addEventListener('click', () => {
				choice[kind] = item;
				for (const sib of host.querySelectorAll('.reel-chip')) {
					sib.setAttribute('aria-pressed', String(sib.dataset.id === item.id));
				}
				syncSummary();
			});
			host.appendChild(b);
		}
	}

	function buildDurationRow(host) {
		for (const seconds of REEL_DURATIONS) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'reel-chip is-compact';
			b.dataset.id = String(seconds);
			b.setAttribute('aria-pressed', String(seconds === choice.duration));
			b.innerHTML = `<span class="reel-chip-label">${seconds}s</span>`;
			b.addEventListener('click', () => {
				choice.duration = seconds;
				for (const sib of host.querySelectorAll('.reel-chip')) {
					sib.setAttribute('aria-pressed', String(Number(sib.dataset.id) === seconds));
				}
				syncSummary();
			});
			host.appendChild(b);
		}
	}

	function syncSummary() {
		const fmt = pickVideoFormat(supportsMime);
		const { width, height } = outputSize();
		el.summary.textContent = fmt
			? `${width}x${height} ${fmt.ext.toUpperCase()}, ${choice.duration}s, plus two PNG stills.`
			: 'This browser cannot record video. Reel will still capture the stills.';
	}

	function supportsMime(mime) {
		return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
	}

	/** Output pixels, which is CSS size multiplied by the display's pixel ratio. */
	function outputSize() {
		const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
		return {
			width: Math.round(choice.aspect.width * dpr),
			height: Math.round(choice.aspect.height * dpr),
		};
	}

	// ---- open / close -----------------------------------------------------

	function open() {
		if (capturing) return;
		lastFocus = document.activeElement;
		resetArtefacts();
		showStep('setup');
		dialog.hidden = false;
		requestAnimationFrame(() => dialog.classList.add('is-open'));
		syncSummary();
		el.start.focus();
		document.addEventListener('keydown', onDialogKey, true);
	}

	function close() {
		if (capturing) {
			cancelled = true;
			return;
		}
		dialog.classList.remove('is-open');
		document.removeEventListener('keydown', onDialogKey, true);
		const hide = () => {
			dialog.hidden = true;
		};
		if (prefersReducedMotion()) hide();
		else setTimeout(hide, 180);
		if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
	}

	function onDialogKey(event) {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			return;
		}
		if (event.key !== 'Tab' || dialog.hidden) return;
		const focusables = [...el.panel.querySelectorAll(FOCUSABLE)].filter(
			(node) => !node.disabled && node.offsetParent !== null,
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function showStep(step) {
		el.setup.hidden = step !== 'setup';
		el.recording.hidden = step !== 'recording';
		el.done.hidden = step !== 'done';
		el.fallback.hidden = step !== 'fallback';
	}

	function resetArtefacts() {
		for (const a of artefacts.splice(0)) URL.revokeObjectURL(a.url);
		el.files.textContent = '';
		el.fallbackShots.textContent = '';
		el.video.removeAttribute('src');
	}

	trigger.addEventListener('click', open);
	el.close.addEventListener('click', close);
	for (const button of el.again) button.addEventListener('click', () => showStep('setup'));
	el.cancel.addEventListener('click', () => {
		cancelled = true;
	});
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) close();
	});
	el.start.addEventListener('click', () => {
		run().catch((err) => fail(err));
	});

	// `R` mirrors cinema mode's `F`. Ignored while typing, and only while a
	// result is actually on screen.
	document.addEventListener('keydown', (event) => {
		if (event.key !== 'r' && event.key !== 'R') return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isTypingTarget(event.target)) return;
		if (resultPanel.classList.contains('is-hidden')) return;
		if (!dialog.hidden) return;
		event.preventDefault();
		open();
	});

	// ---- the capture itself ------------------------------------------------

	async function run() {
		const format = pickVideoFormat(supportsMime);
		const probe = findCanvas(viewer);
		const canRecord = Boolean(format && probe && typeof probe.captureStream === 'function');

		capturing = true;
		cancelled = false;
		trigger.disabled = true;
		resetArtefacts();
		el.recordingTitle.textContent = canRecord ? 'Rolling' : 'Capturing stills';
		showStep('recording');
		setProgress(0);

		const restore = enterStage();
		try {
			const baseline = await frameModel();
			if (canRecord) {
				// Re-resolve after the stage is up: the shared canvas can move
				// between shadow roots when viewer visibility changes.
				const video = await recordVideo(findCanvas(viewer), format, baseline);
				if (video) addArtefact('Video', video.blob, video.filename);
			}
			if (!cancelled) {
				el.recordingTitle.textContent = 'Capturing stills';
				const stills = await captureStills(baseline);
				for (const still of stills) addArtefact(still.label, still.blob, still.filename);
				setProgress(1, choice.duration * 1000);
			}
		} finally {
			restore();
			capturing = false;
			trigger.disabled = false;
		}

		if (cancelled && artefacts.length === 0) {
			showStep('setup');
			return;
		}
		presentResults(canRecord);
	}

	function fail(err) {
		capturing = false;
		trigger.disabled = false;
		showStep('fallback');
		el.fallbackShots.textContent = '';
		const p = document.createElement('p');
		p.className = 'reel-error';
		p.textContent = `Recording stopped: ${err?.message || err}. The stills below still work, and the GLB download is unaffected.`;
		el.fallbackShots.appendChild(p);
	}

	/**
	 * Take the viewer over for the duration of the capture.
	 *
	 * The shell is pinned to the exact output size so the encoded frames are the
	 * size we advertise rather than whatever the layout happened to be. A spacer
	 * holds the vacated height so the page underneath does not jump, and the
	 * returned function puts everything back including the user's camera.
	 */
	function enterStage() {
		const heldOrbit = viewer.getCameraOrbit?.();
		const heldFov = viewer.getFieldOfView?.();
		const heldRotate = viewer.hasAttribute('auto-rotate');
		const heldControls = viewer.hasAttribute('camera-controls');
		const heldDecay = viewer.getAttribute('interpolation-decay');

		spacer.style.height = `${shell.getBoundingClientRect().height}px`;
		spacer.hidden = false;
		backdrop.hidden = false;
		requestAnimationFrame(() => backdrop.classList.add('is-open'));

		const { width, height } = choice.aspect;
		const scale = stageScale(
			{ width, height },
			{ width: window.innerWidth, height: window.innerHeight },
		);
		shell.style.setProperty('--reel-w', `${width}px`);
		shell.style.setProperty('--reel-h', `${height}px`);
		shell.style.setProperty('--reel-scale', String(scale));
		shell.classList.add('is-reel-stage');
		document.body.classList.add('forge-reel-capturing');

		// Auto-rotate and user drag both fight the scripted track, so both go
		// away for the take. `interpolation-decay` at 1ms makes model-viewer
		// honour our easing instead of smoothing on top of it.
		viewer.removeAttribute('auto-rotate');
		viewer.removeAttribute('camera-controls');
		viewer.setAttribute('interpolation-decay', '1');

		return () => {
			shell.classList.remove('is-reel-stage');
			shell.style.removeProperty('--reel-w');
			shell.style.removeProperty('--reel-h');
			shell.style.removeProperty('--reel-scale');
			document.body.classList.remove('forge-reel-capturing');
			backdrop.classList.remove('is-open');
			backdrop.hidden = true;
			spacer.hidden = true;
			if (heldControls) viewer.setAttribute('camera-controls', '');
			if (heldRotate) viewer.setAttribute('auto-rotate', '');
			if (heldDecay === null) viewer.removeAttribute('interpolation-decay');
			else viewer.setAttribute('interpolation-decay', heldDecay);
			if (heldOrbit) {
				viewer.cameraOrbit = `${heldOrbit.theta}rad ${heldOrbit.phi}rad ${heldOrbit.radius}m`;
			}
			if (typeof heldFov === 'number') viewer.fieldOfView = `${heldFov}rad`;
			viewer.jumpCameraToGoal?.();
		};
	}

	/**
	 * Reset to the viewer's own framing and read the numbers the track scales.
	 *
	 * Radius has to come from the model, not from a constant: the same "1.55x"
	 * pull-back has to work for a ring and for a building.
	 */
	async function frameModel() {
		viewer.cameraOrbit = '0deg 78deg auto';
		viewer.fieldOfView = 'auto';
		viewer.jumpCameraToGoal?.();
		await nextFrame();
		await nextFrame();
		const orbit = viewer.getCameraOrbit?.();
		const fov = viewer.getFieldOfView?.();
		return {
			radius: orbit?.radius || 1,
			fov: typeof fov === 'number' && fov > 0 ? fov : 45,
		};
	}

	function applyFrame(sample, baseline) {
		viewer.cameraOrbit = `${sample.theta}deg ${sample.phi}deg ${sample.radius * baseline.radius}m`;
		viewer.fieldOfView = `${sample.fov * baseline.fov}deg`;
		viewer.jumpCameraToGoal?.();
	}

	async function recordVideo(canvas, format, baseline) {
		const stream = canvas.captureStream(REEL_FPS);
		const recorder = new MediaRecorder(stream, {
			mimeType: format.mime,
			videoBitsPerSecond: VIDEO_BITRATE,
		});
		const chunks = [];
		recorder.ondataavailable = (event) => {
			if (event.data && event.data.size > 0) chunks.push(event.data);
		};
		const finished = new Promise((resolve) => {
			recorder.onstop = () => resolve();
		});

		// One frame on the mark before the recorder opens, so the first encoded
		// frame is the shot's opening frame and not the previous camera.
		applyFrame(sampleTrack(choice.preset.track, 0), baseline);
		await nextFrame();

		recorder.start(250);
		const totalMs = choice.duration * 1000;
		const startedAt = performance.now();

		for (;;) {
			await nextFrame();
			const elapsed = performance.now() - startedAt;
			const t = elapsed / totalMs;
			if (cancelled || t >= 1) break;
			applyFrame(sampleTrack(choice.preset.track, t), baseline);
			setProgress(t, elapsed, totalMs);
		}

		setProgress(1, totalMs, totalMs);
		// Flush before tearing the stream down. Killing the tracks first drops
		// whatever the encoder had not handed over yet, which reads as a
		// successful recording that produced no file.
		recorder.stop();
		await finished;
		for (const track of stream.getTracks()) track.stop();

		if (cancelled || chunks.length === 0) return null;
		const blob = new Blob(chunks, { type: format.mime.split(';')[0] });
		return {
			blob,
			filename: reelFilename(baseName(), choice.preset.id, 'reel', format.ext),
		};
	}

	/**
	 * Two stills from the shot's own hero frame.
	 *
	 * The square one is taken by briefly restaging at 1:1 rather than by cropping
	 * the wide frame, because cropping a 16:9 hero to a square cuts the model's
	 * head off exactly as often as not.
	 */
	async function captureStills(baseline) {
		const out = [];
		const hero = sampleTrack(choice.preset.track, choice.preset.heroT);
		applyFrame(hero, baseline);
		await nextFrame();
		await nextFrame();

		const wide = await snapshot();
		if (wide) {
			out.push({
				label: `Hero still ${choice.aspect.label}`,
				blob: wide,
				filename: reelFilename(baseName(), choice.preset.id, 'hero', 'png'),
			});
		}

		if (choice.aspect.id !== 'square') {
			shell.style.setProperty('--reel-w', '1080px');
			shell.style.setProperty('--reel-h', '1080px');
			shell.style.setProperty(
				'--reel-scale',
				String(
					stageScale(
						{ width: 1080, height: 1080 },
						{ width: window.innerWidth, height: window.innerHeight },
					),
				),
			);
			await nextFrame();
			await nextFrame();
			applyFrame(hero, baseline);
			await nextFrame();
			const square = await snapshot();
			if (square) {
				out.push({
					label: 'Square still 1:1',
					blob: square,
					filename: reelFilename(baseName(), choice.preset.id, 'square', 'png'),
				});
			}
		}
		return out;
	}

	async function snapshot() {
		try {
			if (typeof viewer.toBlob === 'function') {
				return await viewer.toBlob({ mimeType: 'image/png', idealAspect: false });
			}
			const url = viewer.toDataURL?.('image/png');
			if (!url) return null;
			return await (await fetch(url)).blob();
		} catch {
			return null;
		}
	}

	function setProgress(t, elapsed = 0, total = choice.duration * 1000) {
		const pct = Math.round(Math.min(1, Math.max(0, t)) * 100);
		el.bar.style.width = `${pct}%`;
		el.bar.parentElement.setAttribute('aria-valuenow', String(pct));
		el.clock.textContent = `${(elapsed / 1000).toFixed(1)}s of ${(total / 1000).toFixed(0)}s`;
	}

	function addArtefact(label, blob, filename) {
		const url = URL.createObjectURL(blob);
		artefacts.push({ label, blob, filename, url });
	}

	function presentResults(hadVideo) {
		showStep(artefacts.some((a) => a.label === 'Video') ? 'done' : 'fallback');
		const host = artefacts.some((a) => a.label === 'Video') ? el.files : el.fallbackShots;
		host.textContent = '';

		const video = artefacts.find((a) => a.label === 'Video');
		if (video) {
			el.video.src = video.url;
			el.video.play().catch(() => {
				// Autoplay refusal is fine: the controls are right there.
			});
		} else if (hadVideo) {
			const p = document.createElement('p');
			p.className = 'reel-error';
			p.textContent =
				'The recorder produced no frames, which usually means the tab lost focus mid-take. The stills below are from the same shot.';
			host.appendChild(p);
		} else {
			const p = document.createElement('p');
			p.className = 'reel-note';
			p.textContent =
				'This browser has no canvas video recording, so Reel captured the shot as stills instead. Chrome, Edge and Firefox record video.';
			host.appendChild(p);
		}

		for (const artefact of artefacts) {
			const row = document.createElement('a');
			row.className = 'reel-file';
			row.href = artefact.url;
			row.download = artefact.filename;
			row.innerHTML = `
				<span class="reel-file-kind">${escapeHtml(artefact.label)}</span>
				<span class="reel-file-name">${escapeHtml(artefact.filename)}</span>
				<span class="reel-file-size">${formatBytes(artefact.blob.size)}</span>
				<span class="reel-file-cta">Download</span>`;
			host.appendChild(row);
		}
	}

	function baseName() {
		return (download.getAttribute('download') || 'forge.glb').replace(/\.glb$/i, '') || 'forge';
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Choose which of a model-viewer's canvases is actually being painted.
 *
 * There are two, and picking the wrong one is silent: the recording completes,
 * reports success, and contains zero frames. model-viewer runs a single shared
 * WebGL renderer whose canvas carries `id="webgl-canvas"`. While one viewer is
 * on screen that shared canvas is moved into its shadow root and marked `show`,
 * and the viewer's own 2D canvas sits idle. As soon as a second viewer becomes
 * visible the shared canvas is pulled back out and each element's own canvas is
 * blitted into instead.
 *
 * So: record the shared canvas when it is the one being shown here, otherwise
 * record this element's own canvas. Items are `{ id, shown }` so the rule can
 * be tested without a browser.
 */
export function pickCaptureCanvas(canvases) {
	if (!Array.isArray(canvases) || canvases.length === 0) return -1;
	const shared = canvases.findIndex((c) => c.id === 'webgl-canvas' && c.shown);
	if (shared !== -1) return shared;
	const own = canvases.findIndex((c) => c.id !== 'webgl-canvas');
	return own !== -1 ? own : 0;
}

function findCanvas(viewer) {
	const nodes = [...(viewer.shadowRoot?.querySelectorAll('canvas') || [])];
	if (nodes.length === 0) return null;
	const index = pickCaptureCanvas(
		nodes.map((node) => ({ id: node.id, shown: node.classList.contains('show') })),
	);
	return nodes[index] || null;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const prefersReducedMotion = () =>
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function isTypingTarget(node) {
	if (!node) return false;
	const tag = node.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

function escapeHtml(text) {
	return String(text).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

const ICON_REEL =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>';

function dialogMarkup() {
	return `
	<div class="reel-panel">
		<header class="reel-head">
			<div>
				<h2 class="reel-title">Record a reel</h2>
				<p class="reel-sub">A cinematic pass over this model, encoded in your browser. Nothing is uploaded.</p>
			</div>
			<button type="button" class="reel-close" aria-label="Close">&times;</button>
		</header>

		<section class="reel-setup">
			<h3 class="reel-legend">Shot</h3>
			<div class="reel-presets reel-row"></div>
			<h3 class="reel-legend">Aspect</h3>
			<div class="reel-aspects reel-row"></div>
			<h3 class="reel-legend">Length</h3>
			<div class="reel-durations reel-row is-tight"></div>
			<p class="reel-summary"></p>
			<button type="button" class="btn btn-primary reel-start">Record reel</button>
		</section>

		<section class="reel-recording" hidden>
			<p class="reel-recording-title">Rolling</p>
			<div class="reel-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Recording progress">
				<span class="reel-bar-fill"></span>
			</div>
			<p class="reel-clock" aria-live="polite">0.0s</p>
			<button type="button" class="btn btn-ghost reel-cancel">Cancel</button>
		</section>

		<section class="reel-done" hidden>
			<video class="reel-video" playsinline muted loop controls></video>
			<div class="reel-files"></div>
			<button type="button" class="btn btn-ghost reel-again">Record another</button>
		</section>

		<section class="reel-fallback" hidden>
			<div class="reel-fallback-shots"></div>
			<button type="button" class="btn btn-ghost reel-again">Back</button>
		</section>
	</div>`;
}

function injectStyles() {
	const style = document.createElement('style');
	style.id = 'forge-reel-styles';
	style.textContent = `
	.reel-trigger svg { margin-right: 0.35rem; }

	/* Stage: the viewer is pinned to the exact output size while recording, and
	   scaled to fit the viewport without changing the encoded resolution. */
	.viewer-shell.is-reel-stage {
		position: fixed;
		top: 50%;
		left: 50%;
		width: var(--reel-w);
		height: var(--reel-h);
		margin: 0;
		transform: translate(-50%, -50%) scale(var(--reel-scale, 1));
		transform-origin: center center;
		z-index: 10001;
		border-radius: 14px;
		overflow: hidden;
		box-shadow: 0 40px 120px rgba(0, 0, 0, 0.65);
	}
	.viewer-shell.is-reel-stage model-viewer { width: 100%; height: 100%; }
	body.forge-reel-capturing { overflow: hidden; }

	.reel-stage-backdrop {
		position: fixed;
		inset: 0;
		z-index: 10000;
		background: rgba(6, 6, 10, 0.94);
		opacity: 0;
		transition: opacity 0.2s ease;
	}
	.reel-stage-backdrop.is-open { opacity: 1; }
	.reel-stage-note {
		position: absolute;
		left: 50%;
		bottom: 2.2rem;
		transform: translateX(-50%);
		margin: 0;
		max-width: min(90vw, 44ch);
		text-align: center;
		font-size: 0.8rem;
		line-height: 1.5;
		color: rgba(255, 255, 255, 0.62);
	}

	/* Dialog */
	.reel-dialog {
		position: fixed;
		inset: 0;
		z-index: 10002;
		display: grid;
		place-items: center;
		padding: 1.25rem;
		background: rgba(6, 6, 10, 0.72);
		backdrop-filter: blur(6px);
		opacity: 0;
		transition: opacity 0.18s ease;
	}
	.reel-dialog.is-open { opacity: 1; }
	.reel-panel {
		width: min(560px, 100%);
		max-height: min(88vh, 760px);
		overflow-y: auto;
		padding: 1.25rem 1.35rem 1.45rem;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 18px;
		background: var(--surface-1, #14141b);
		box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
		transform: translateY(10px);
		transition: transform 0.18s ease;
	}
	.reel-dialog.is-open .reel-panel { transform: translateY(0); }

	.reel-head { display: flex; align-items: flex-start; gap: 1rem; margin-bottom: 1.1rem; }
	.reel-title { margin: 0; font-size: 1.08rem; letter-spacing: -0.01em; }
	.reel-sub { margin: 0.3rem 0 0; font-size: 0.82rem; line-height: 1.5; opacity: 0.7; }
	.reel-close {
		margin-left: auto;
		width: 32px; height: 32px;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 9px;
		background: transparent; color: inherit;
		font-size: 1.15rem; line-height: 1; cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}
	.reel-close:hover { background: var(--surface-3, rgba(255, 255, 255, 0.09)); }
	.reel-close:focus-visible { outline: 2px solid var(--accent, #7c6cff); outline-offset: 2px; }

	.reel-legend {
		margin: 0 0 0.5rem;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		opacity: 0.55;
	}
	.reel-row { display: grid; gap: 0.5rem; margin-bottom: 1.05rem; }
	.reel-row.is-tight { grid-auto-flow: column; grid-auto-columns: 1fr; }
	@media (min-width: 520px) {
		.reel-aspects { grid-template-columns: repeat(3, 1fr); }
	}

	.reel-chip {
		display: block;
		width: 100%;
		padding: 0.62rem 0.75rem;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 11px;
		background: var(--surface-2, rgba(255, 255, 255, 0.04));
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
	}
	.reel-chip:hover { background: var(--surface-3, rgba(255, 255, 255, 0.08)); transform: translateY(-1px); }
	.reel-chip:focus-visible { outline: 2px solid var(--accent, #7c6cff); outline-offset: 2px; }
	.reel-chip[aria-pressed='true'] {
		border-color: var(--accent, #7c6cff);
		background: color-mix(in srgb, var(--accent, #7c6cff) 16%, transparent);
	}
	.reel-chip.is-compact { text-align: center; }
	.reel-chip-label { display: block; font-size: 0.87rem; font-weight: 600; }
	.reel-chip-hint { display: block; margin-top: 0.16rem; font-size: 0.74rem; line-height: 1.4; opacity: 0.66; }
	.reel-chip.is-compact .reel-chip-hint { display: none; }

	.reel-summary { margin: 0 0 0.95rem; font-size: 0.78rem; opacity: 0.66; }
	.reel-start { width: 100%; }

	.reel-recording-title { margin: 0 0 0.75rem; font-size: 0.92rem; font-weight: 600; }
	.reel-bar {
		height: 6px;
		border-radius: 999px;
		background: var(--surface-3, rgba(255, 255, 255, 0.1));
		overflow: hidden;
	}
	.reel-bar-fill {
		display: block;
		height: 100%;
		width: 0%;
		border-radius: inherit;
		background: var(--accent, #7c6cff);
		transition: width 0.1s linear;
	}
	.reel-clock { margin: 0.55rem 0 1rem; font-size: 0.78rem; opacity: 0.7; font-variant-numeric: tabular-nums; }

	.reel-video {
		width: 100%;
		border-radius: 12px;
		background: #06060a;
		margin-bottom: 0.9rem;
	}
	.reel-files, .reel-fallback-shots { display: grid; gap: 0.5rem; margin-bottom: 0.95rem; }
	.reel-file {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.15rem 0.75rem;
		align-items: center;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 11px;
		background: var(--surface-2, rgba(255, 255, 255, 0.04));
		color: inherit;
		text-decoration: none;
		transition: background 0.14s ease, border-color 0.14s ease;
	}
	.reel-file:hover { background: var(--surface-3, rgba(255, 255, 255, 0.09)); border-color: var(--accent, #7c6cff); }
	.reel-file:focus-visible { outline: 2px solid var(--accent, #7c6cff); outline-offset: 2px; }
	.reel-file-kind { font-size: 0.85rem; font-weight: 600; }
	.reel-file-cta { grid-row: 1 / span 2; font-size: 0.78rem; opacity: 0.8; }
	.reel-file-name { grid-column: 1; font-size: 0.73rem; opacity: 0.6; word-break: break-all; }
	.reel-file-size { display: none; }

	.reel-note, .reel-error { margin: 0 0 0.6rem; font-size: 0.8rem; line-height: 1.5; opacity: 0.75; }
	.reel-error { color: var(--danger, #ff6b6b); opacity: 0.95; }

	@media (prefers-reduced-motion: reduce) {
		.reel-dialog, .reel-panel, .reel-chip, .reel-stage-backdrop, .reel-bar-fill { transition: none; }
		.reel-chip:hover { transform: none; }
	}`;
	document.head.appendChild(style);
}

if (typeof document !== 'undefined') mountForgeReel();
