/**
 * Avatar sculpt — face/body morph sliders + face-type blend wheel for /avatars/:id/edit
 *
 * The avatar GLBs we ship (Avaturn, Ready Player Me, three.ws Studio) carry
 * the 52 ARKit blendshapes by name (see src/runtime/arkit52.js). Plus, RPM-
 * style bodies carry a handful of body-shape morphs (height, breast, etc.).
 *
 * This module renders a grouped slider panel against whatever morphs the
 * loaded avatar actually exposes. No invented sliders; no silently-broken
 * controls. What the user sees == what the rig can do.
 *
 * State model: avatar-edit.js owns `workingAppearance.morphs = { name: w }`.
 * We mutate that dict on slider input + apply influence to every skinned
 * mesh's `morphTargetInfluences` in real time. Save flow is unchanged.
 *
 * Blend wheel: MetaHuman-style 2-D barycentric blend of 6 face-type presets.
 * IDW (inverse distance weighting) maps puck position → weighted morph sum.
 * Slider fine-tuning still works on top — they share the same morphs dict.
 */

import { detectFaceAll } from './avatar-face-capture.js';

/* ────────────────────────────────────────────────────────────────────────── *
 * Category map — orders + groups the 52 ARKit names + common body morphs
 * into something a human can scan. Names not in this map fall into "Other".
 * Display label is generated from camelCase on render — no per-name copy.
 * ────────────────────────────────────────────────────────────────────────── */

const CATEGORIES = [
	{
		id: 'eyes',
		label: 'Eyes',
		match: /^eye/,
		preferred: [
			'eyeBlinkLeft', 'eyeBlinkRight',
			'eyeWideLeft', 'eyeWideRight',
			'eyeSquintLeft', 'eyeSquintRight',
			'eyeLookUpLeft', 'eyeLookUpRight',
			'eyeLookDownLeft', 'eyeLookDownRight',
			'eyeLookInLeft', 'eyeLookInRight',
			'eyeLookOutLeft', 'eyeLookOutRight',
		],
	},
	{
		id: 'brows',
		label: 'Brows',
		match: /^brow/,
		preferred: ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'browDownLeft', 'browDownRight'],
	},
	{
		id: 'nose',
		label: 'Nose',
		match: /^(nose|noseSneer)/,
		preferred: ['noseSneerLeft', 'noseSneerRight'],
	},
	{
		id: 'mouth',
		label: 'Mouth',
		match: /^mouth/,
		preferred: [
			'mouthSmileLeft', 'mouthSmileRight',
			'mouthFrownLeft', 'mouthFrownRight',
			'mouthDimpleLeft', 'mouthDimpleRight',
			'mouthStretchLeft', 'mouthStretchRight',
			'mouthPressLeft', 'mouthPressRight',
			'mouthShrugLower', 'mouthShrugUpper',
			'mouthLowerDownLeft', 'mouthLowerDownRight',
			'mouthUpperUpLeft', 'mouthUpperUpRight',
			'mouthRollLower', 'mouthRollUpper',
			'mouthFunnel', 'mouthPucker', 'mouthClose',
			'mouthLeft', 'mouthRight',
		],
	},
	{
		id: 'jaw',
		label: 'Jaw',
		match: /^jaw/,
		preferred: ['jawOpen', 'jawForward', 'jawLeft', 'jawRight'],
	},
	{
		id: 'cheeks',
		label: 'Cheeks',
		match: /^cheek/,
		preferred: ['cheekPuff', 'cheekSquintLeft', 'cheekSquintRight'],
	},
	// tongueOut intentionally omitted — RPM/Avaturn bake the morph but nobody
	// wants a "Tongue Out" slider on their face customizer. Drivers that need
	// it (lipsync, mocap) still hit it via runtime APIs.
	{
		id: 'body',
		label: 'Body',
		match: /^(body|shape|height|breast|chest|waist|hip|muscle|weight|bust|gluteus|figure|thighs|arms)/i,
	},
	{
		id: 'visemes',
		label: 'Visemes (advanced)',
		match: /^viseme_/,
		collapsed: true,
		preferred: [
			'viseme_sil', 'viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD',
			'viseme_kk', 'viseme_CH', 'viseme_SS', 'viseme_nn', 'viseme_RR',
			'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U',
		],
	},
];

const ARKIT52 = new Set([
	'eyeBlinkLeft','eyeBlinkRight','eyeLookDownLeft','eyeLookDownRight','eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight','eyeLookUpLeft','eyeLookUpRight','eyeSquintLeft','eyeSquintRight','eyeWideLeft','eyeWideRight','jawForward','jawLeft','jawRight','jawOpen','mouthClose','mouthFunnel','mouthPucker','mouthLeft','mouthRight','mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight','mouthDimpleLeft','mouthDimpleRight','mouthStretchLeft','mouthStretchRight','mouthRollLower','mouthRollUpper','mouthShrugLower','mouthShrugUpper','mouthPressLeft','mouthPressRight','mouthLowerDownLeft','mouthLowerDownRight','mouthUpperUpLeft','mouthUpperUpRight','browDownLeft','browDownRight','browInnerUp','browOuterUpLeft','browOuterUpRight','cheekPuff','cheekSquintLeft','cheekSquintRight','noseSneerLeft','noseSneerRight','tongueOut',
]);

/* ────────────────────────────────────────────────────────────────────────── *
 * Blend wheel presets — 6 face archetypes placed on a 2-D [-1..1] plane.
 *
 * Positions are chosen so the 6 points span the space and avoid overlap.
 * Morph keys use whatever the avatar exposes; unknown keys silently skip.
 * Body-shape morphs (bodyJawWide, bodyNoseWide, bodyFaceLong, bodyLipsThick)
 * are RPM / Avaturn extensions and simply won't fire on ARKit-only rigs.
 * ────────────────────────────────────────────────────────────────────────── */

const BLEND_PRESETS = [
	{
		id: 'round',
		label: 'Round',
		pos: [-0.55, -0.65],
		morphs: {
			cheekPuff: 0.45,
			cheekSquintLeft: 0.2,
			cheekSquintRight: 0.2,
			browInnerUp: 0.25,
			mouthShrugUpper: 0.15,
			bodyJawWide: 0.3,
			bodyFaceLong: 0.05,
		},
	},
	{
		id: 'angular',
		label: 'Angular',
		pos: [0.55, -0.65],
		morphs: {
			browDownLeft: 0.38,
			browDownRight: 0.38,
			bodyJawWide: 0.55,
			cheekPuff: 0.0,
			noseSneerLeft: 0.12,
			noseSneerRight: 0.12,
		},
	},
	{
		id: 'wide',
		label: 'Wide',
		pos: [0.85, 0.1],
		morphs: {
			bodyJawWide: 0.72,
			bodyNoseWide: 0.55,
			cheekPuff: 0.22,
			mouthShrugLower: 0.18,
			bodyLipsThick: 0.2,
		},
	},
	{
		id: 'narrow',
		label: 'Narrow',
		pos: [-0.85, 0.1],
		morphs: {
			bodyJawWide: 0.0,
			bodyNoseWide: 0.0,
			cheekPuff: 0.0,
			bodyLipsThick: 0.0,
			cheekSquintLeft: 0.0,
			cheekSquintRight: 0.0,
		},
	},
	{
		id: 'long',
		label: 'Long',
		pos: [0.0, 0.85],
		morphs: {
			bodyFaceLong: 0.62,
			bodyJawWide: 0.18,
			cheekPuff: 0.0,
			browInnerUp: 0.1,
		},
	},
	{
		id: 'soft',
		label: 'Soft',
		pos: [0.0, -0.85],
		morphs: {
			browInnerUp: 0.38,
			mouthShrugLower: 0.22,
			cheekPuff: 0.28,
			bodyFaceLong: 0.08,
			mouthShrugUpper: 0.12,
		},
	},
];

/* ────────────────────────────────────────────────────────────────────────── *
 * Module-level mirror lock state (survives re-renders within a page visit)
 * ────────────────────────────────────────────────────────────────────────── */

let _mirrorLocked = true;

/* ────────────────────────────────────────────────────────────────────────── *
 * Public API
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Discover every morph target on the loaded scene root and return the union
 * of names (across all skinned meshes). Returns alphabetized for stable UI.
 * tongueOut filtered out — it's a real morph but a useless slider.
 */
export function discoverMorphs(root) {
	const found = new Set();
	root?.traverse?.((obj) => {
		if (obj.isMesh && obj.morphTargetDictionary) {
			for (const k of Object.keys(obj.morphTargetDictionary)) {
				if (k === 'tongueOut') continue;
				found.add(k);
			}
		}
	});
	return [...found].sort();
}

/**
 * Apply { name: weight } to every mesh on the root. Out-of-range weights are
 * clamped; unknown names are silently skipped (mirrors AccessoryManager).
 */
export function applyMorphsToRoot(root, morphs) {
	if (!root || !morphs) return;
	root.traverse((node) => {
		if (!node.isMesh || !node.morphTargetDictionary || !node.morphTargetInfluences) return;
		for (const [name, weight] of Object.entries(morphs)) {
			const idx = node.morphTargetDictionary[name];
			if (idx === undefined) continue;
			node.morphTargetInfluences[idx] = Math.max(-1, Math.min(1, weight));
		}
	});
}

/**
 * Render the sculpt panel into the supplied container. Idempotent — calling
 * twice rebuilds. The opts wire to avatar-edit.js's state machinery so we
 * don't fork the dirty-tracking or save path.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container — element to render into
 * @param {object} opts.root — Three.js scene root (used to discover morphs)
 * @param {object} opts.working — workingAppearance reference (we mutate .morphs)
 * @param {() => void} opts.onDirty — called after each change
 */
export function renderSculptPanel({ container, root, working, onDirty }) {
	const all = discoverMorphs(root);
	if (!all.length) {
		container.innerHTML = `
			<div class="ae-empty">
				This avatar has no sculptable morph targets.<br/>
				Re-import it through <a href="/create" style="color:inherit">/create</a>
				to get a rig with ARKit-52 blendshapes.
			</div>`;
		return;
	}

	const groups = groupMorphs(all);
	working.morphs = working.morphs || {};
	const available = new Set(all);

	container.innerHTML = `
		<div class="ae-sculpt-head">
			<button class="ae-btn ae-sculpt-capture" type="button" id="ae-sculpt-capture">
				<span class="ae-sculpt-capture-icon" aria-hidden="true">📸</span>
				Capture from photo
			</button>
			<label class="ae-sculpt-mirror" title="Keep left/right morphs in sync">
				<input type="checkbox" id="ae-sculpt-mirror-lock" ${_mirrorLocked ? 'checked' : ''}>
				Mirror L/R
			</label>
			<button class="ae-btn ae-sculpt-reset" type="button" id="ae-sculpt-reset">Reset all</button>
		</div>
		<p class="ae-sculpt-note">
			Drag the wheel puck to blend face types. Use sliders for fine control.
			Double-click any slider to zero it. Capture button reads face geometry
			from your webcam — expression in the photo is ignored.
		</p>

		${blendWheelHtml()}

		${groups.map((g) => renderGroup(g, working.morphs)).join('')}
	`;

	wireSliders(container, root, working, onDirty);
	wireBlendWheel(container, root, working, available, onDirty);

	container.querySelector('#ae-sculpt-mirror-lock')?.addEventListener('change', (e) => {
		_mirrorLocked = e.target.checked;
		renderSculptPanel({ container, root, working, onDirty });
	});

	container.querySelector('#ae-sculpt-reset')?.addEventListener('click', () => {
		working.morphs = {};
		applyMorphsToRoot(root, clearAll(all));
		renderSculptPanel({ container, root, working, onDirty });
		onDirty?.();
	});

	container.querySelector('#ae-sculpt-capture')?.addEventListener('click', () => {
		openFaceCaptureModal({
			root,
			working,
			onDirty,
			rerender: () => renderSculptPanel({ container, root, working, onDirty }),
		});
	});
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Blend wheel — MetaHuman-style 2-D preset interpolation
 * ────────────────────────────────────────────────────────────────────────── */

function blendWheelHtml() {
	const toPercent = (v) => `${((v + 1) / 2 * 100).toFixed(1)}%`;
	const labels = BLEND_PRESETS.map((p) => `
		<span class="ae-blend-label" style="left:${toPercent(p.pos[0])};top:${toPercent(p.pos[1])}" aria-hidden="true">${escHtml(p.label)}</span>
	`).join('');

	return `
		<details class="ae-sculpt-group ae-blend-group" open>
			<summary>
				<span>Face Type Blend</span>
				<span class="ae-sculpt-count" id="ae-blend-count">neutral</span>
			</summary>
			<div class="ae-sculpt-rows ae-blend-body">
				<div class="ae-blend-canvas" id="ae-blend-canvas" role="slider" tabindex="0"
				     aria-label="Face type blend wheel" aria-valuetext="neutral">
					${labels}
					<div class="ae-blend-puck" id="ae-blend-puck"></div>
				</div>
				<p class="ae-blend-desc" id="ae-blend-desc">Drag the puck to blend face archetypes</p>
				<button class="ae-btn" id="ae-blend-reset" type="button">Center (neutral)</button>
			</div>
		</details>
	`;
}

function wireBlendWheel(container, root, working, available, onDirty) {
	const canvas = container.querySelector('#ae-blend-canvas');
	const puck = container.querySelector('#ae-blend-puck');
	const desc = container.querySelector('#ae-blend-desc');
	const count = container.querySelector('#ae-blend-count');
	if (!canvas || !puck) return;

	let puckX = 0;
	let puckY = 0;

	function movePuck(nx, ny) {
		const mag = Math.sqrt(nx * nx + ny * ny);
		if (mag > 1) { nx /= mag; ny /= mag; }
		puckX = nx;
		puckY = ny;
		puck.style.left = `${((nx + 1) / 2 * 100).toFixed(2)}%`;
		puck.style.top = `${((ny + 1) / 2 * 100).toFixed(2)}%`;
		applyBlend();
	}

	function applyBlend() {
		const blended = computeBlend(puckX, puckY, available);
		const blendKeys = new Set(BLEND_PRESETS.flatMap((p) => Object.keys(p.morphs)));
		for (const k of blendKeys) delete working.morphs[k];
		for (const [name, w] of Object.entries(blended)) {
			if (w >= 0.005) working.morphs[name] = w;
		}
		applyMorphsToRoot(root, working.morphs);
		onDirty?.();

		const strength = Math.round(Math.sqrt(puckX * puckX + puckY * puckY) / Math.SQRT2 * 100);
		const label = strength < 4 ? 'neutral' : dominantLabel(puckX, puckY);
		if (desc) {
			desc.textContent = strength < 4
				? 'Drag the puck to blend face archetypes'
				: `Blending towards ${label} (${strength}% strength)`;
		}
		if (count) count.textContent = label;
		canvas.setAttribute('aria-valuetext', label);
	}

	function eventToNorm(e) {
		const rect = canvas.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const r = Math.min(rect.width, rect.height) / 2;
		return [(e.clientX - cx) / r, (e.clientY - cy) / r];
	}

	// Pointer drag on puck
	let dragging = false;
	puck.addEventListener('pointerdown', (e) => {
		dragging = true;
		puck.setPointerCapture(e.pointerId);
		e.preventDefault();
	});
	puck.addEventListener('pointermove', (e) => {
		if (!dragging) return;
		const [nx, ny] = eventToNorm(e);
		movePuck(nx, ny);
	});
	puck.addEventListener('pointerup', () => { dragging = false; });
	puck.addEventListener('pointercancel', () => { dragging = false; });

	// Click anywhere on canvas to teleport puck
	canvas.addEventListener('pointerdown', (e) => {
		if (e.target === puck) return;
		const [nx, ny] = eventToNorm(e);
		movePuck(nx, ny);
	});

	// Keyboard nudge (arrow keys when canvas has focus)
	const STEP = 0.08;
	canvas.addEventListener('keydown', (e) => {
		const map = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
		const delta = map[e.key];
		if (!delta) return;
		e.preventDefault();
		movePuck(puckX + delta[0], puckY + delta[1]);
	});

	container.querySelector('#ae-blend-reset')?.addEventListener('click', () => {
		puckX = 0;
		puckY = 0;
		puck.style.left = '50%';
		puck.style.top = '50%';
		const blendKeys = new Set(BLEND_PRESETS.flatMap((p) => Object.keys(p.morphs)));
		for (const k of blendKeys) delete working.morphs[k];
		applyMorphsToRoot(root, working.morphs);
		if (desc) desc.textContent = 'Drag the puck to blend face archetypes';
		if (count) count.textContent = 'neutral';
		canvas.setAttribute('aria-valuetext', 'neutral');
		onDirty?.();
	});
}

function computeBlend(px, py, available) {
	const strength = Math.min(1, Math.sqrt(px * px + py * py));
	if (strength < 0.01) return {};

	const EPS = 0.0001;
	const POWER = 2;
	const raw = BLEND_PRESETS.map((p) => {
		const dx = px - p.pos[0];
		const dy = py - p.pos[1];
		return 1 / (Math.pow(dx * dx + dy * dy, POWER / 2) + EPS);
	});
	const total = raw.reduce((a, b) => a + b, 0);
	const norm = raw.map((w) => w / total);

	const result = {};
	for (let i = 0; i < BLEND_PRESETS.length; i++) {
		const p = BLEND_PRESETS[i];
		const w = norm[i] * strength;
		for (const [name, v] of Object.entries(p.morphs)) {
			if (available && !available.has(name)) continue;
			result[name] = (result[name] || 0) + w * v;
		}
	}
	return result;
}

function dominantLabel(px, py) {
	let best = Infinity;
	let label = '';
	for (const p of BLEND_PRESETS) {
		const dx = px - p.pos[0];
		const dy = py - p.pos[1];
		const d = dx * dx + dy * dy;
		if (d < best) { best = d; label = p.label; }
	}
	return label;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Slider wiring — mirror-lock support for L/R paired morphs
 * ────────────────────────────────────────────────────────────────────────── */

function wireSliders(container, root, working, onDirty) {
	container.querySelectorAll('input[type="range"][data-morph]').forEach((input) => {
		const name = input.dataset.morph;
		const valEl = container.querySelector(`output[data-for="${cssEscape(name)}"]`);
		const pairName = input.dataset.pair || null;

		const onChange = () => {
			const w = Number(input.value);
			writeMorph(working, name, w);
			applyMorphsToRoot(root, { [name]: w });
			if (valEl) valEl.textContent = w.toFixed(2);
			if (pairName) {
				writeMorph(working, pairName, w);
				applyMorphsToRoot(root, { [pairName]: w });
			}
			onDirty?.();
		};
		input.addEventListener('input', onChange);
		input.addEventListener('dblclick', () => { input.value = '0'; onChange(); });
	});
}

function writeMorph(working, name, w) {
	if (w === 0) delete working.morphs[name];
	else working.morphs[name] = w;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Group rendering — mirror-lock collapses L/R pairs to a single slider
 * ────────────────────────────────────────────────────────────────────────── */

function renderGroup(g, morphs) {
	if (_mirrorLocked) {
		const visible = [];
		const seenPair = new Set();
		for (const name of g.morphs) {
			const root = pairRootOf(name);
			if (root) {
				if (seenPair.has(root)) continue;
				seenPair.add(root);
				const left = `${root}Left`;
				const right = `${root}Right`;
				const hasLeft = g.morphs.includes(left);
				const hasRight = g.morphs.includes(right);
				if (hasLeft && hasRight) {
					visible.push({ name: left, pair: right, displayName: root });
					continue;
				}
			}
			visible.push({ name, pair: null, displayName: name });
		}
		return `
			<details class="ae-sculpt-group" ${g.collapsed ? '' : 'open'}>
				<summary>
					<span>${escHtml(g.label)}</span>
					<span class="ae-sculpt-count">${visible.length}</span>
				</summary>
				<div class="ae-sculpt-rows">
					${visible.map((v) => sliderRow(v.name, morphs[v.name] || 0, v.displayName, v.pair)).join('')}
				</div>
			</details>
		`;
	}
	return `
		<details class="ae-sculpt-group" ${g.collapsed ? '' : 'open'}>
			<summary>
				<span>${escHtml(g.label)}</span>
				<span class="ae-sculpt-count">${g.morphs.length}</span>
			</summary>
			<div class="ae-sculpt-rows">
				${g.morphs.map((m) => sliderRow(m, morphs[m] || 0)).join('')}
			</div>
		</details>
	`;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Face capture modal — webcam → MediaPipe → ARKit-52 identity weights
 * ────────────────────────────────────────────────────────────────────────── */

let activeFaceModal = null;

function openFaceCaptureModal({ root, working, onDirty, rerender }) {
	if (activeFaceModal) return;

	const backdrop = document.createElement('div');
	backdrop.className = 'ae-face-backdrop';
	backdrop.innerHTML = `
		<div class="ae-face-dialog" role="dialog" aria-modal="true">
			<button class="ae-face-close" type="button" aria-label="Close">✕</button>
			<h3>Capture face shape</h3>
			<p class="ae-face-lede">
				Face the camera with a relaxed expression. We read the geometry
				of your face — width, jaw, nose, lips — and write those ratios
				as identity morphs. The expression you're wearing in the photo
				is ignored on purpose so a candid smile doesn't burn in
				forever. Runs entirely in your browser.
			</p>
			<div class="ae-face-stage">
				<video id="ae-face-video" autoplay playsinline muted></video>
				<canvas id="ae-face-canvas" hidden></canvas>
				<div class="ae-face-status" id="ae-face-status">Allow camera access to start.</div>
			</div>
			<div class="ae-face-actions">
				<button class="ae-btn" type="button" id="ae-face-cancel">Cancel</button>
				<button class="ae-btn primary" type="button" id="ae-face-shoot" disabled>Capture</button>
			</div>
		</div>
	`;
	document.body.appendChild(backdrop);
	activeFaceModal = backdrop;

	const video = backdrop.querySelector('#ae-face-video');
	const canvas = backdrop.querySelector('#ae-face-canvas');
	const status = backdrop.querySelector('#ae-face-status');
	const shootBtn = backdrop.querySelector('#ae-face-shoot');
	const cancelBtn = backdrop.querySelector('#ae-face-cancel');
	const closeBtn = backdrop.querySelector('.ae-face-close');

	let stream = null;
	let landmarker = null;
	let cancelled = false;

	async function boot() {
		status.textContent = 'Requesting camera…';
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
				audio: false,
			});
			if (cancelled) return;
			video.srcObject = stream;
			await video.play().catch(() => {});
			status.textContent = 'Loading face model… (5–10 MB)';
		} catch (err) {
			status.textContent = `Camera unavailable: ${err.message}`;
			return;
		}
		try {
			landmarker = await detectFaceAll.loadLandmarker();
			if (cancelled) return;
			status.textContent = 'Ready. Hold still and capture.';
			shootBtn.disabled = false;
		} catch (err) {
			status.textContent = `Couldn't load face model: ${err.message}`;
		}
	}

	function teardown() {
		cancelled = true;
		stream?.getTracks()?.forEach((t) => t.stop());
		activeFaceModal?.remove();
		activeFaceModal = null;
	}

	cancelBtn.addEventListener('click', teardown);
	closeBtn.addEventListener('click', teardown);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) teardown(); });

	shootBtn.addEventListener('click', async () => {
		shootBtn.disabled = true;
		status.textContent = 'Reading face…';
		try {
			canvas.width = video.videoWidth || 640;
			canvas.height = video.videoHeight || 640;
			const ctx = canvas.getContext('2d');
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			const full = await detectFaceAll(canvas, landmarker);
			if (!full || !full.identity || !Object.keys(full.identity).length) {
				status.textContent = 'No face detected. Try again with better lighting.';
				shootBtn.disabled = false;
				return;
			}

			// Use identity morphs (landmark ratios) — not the expression blendshapes.
			// Expression weights describe how the user looked in the photo, not their face shape.
			const available = new Set(discoverMorphs(root));
			let applied = 0;
			for (const [name, weight] of Object.entries(full.identity)) {
				if (!available.has(name)) continue;
				const clamped = Math.max(0, Math.min(0.7, weight));
				if (clamped < 0.02) {
					delete working.morphs[name];
				} else {
					working.morphs[name] = clamped;
					applied++;
				}
			}
			applyMorphsToRoot(root, working.morphs);
			status.textContent = applied
				? `Applied ${applied} identity ratios. Fine-tune with the sliders below.`
				: "Face read OK, but this avatar doesn't expose matching shape morphs.";
			onDirty?.();
			rerender?.();
			setTimeout(teardown, 1200);
		} catch (err) {
			console.error('[avatar-sculpt] capture failed', err);
			status.textContent = `Capture failed: ${err.message}`;
			shootBtn.disabled = false;
		}
	});

	boot();
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

function clearAll(names) {
	return Object.fromEntries(names.map((n) => [n, 0]));
}

function groupMorphs(all) {
	const seen = new Set();
	const groups = [];
	for (const cat of CATEGORIES) {
		const ours = [];
		if (cat.preferred) {
			for (const name of cat.preferred) {
				if (all.includes(name) && !seen.has(name)) {
					ours.push(name);
					seen.add(name);
				}
			}
		}
		for (const name of all) {
			if (seen.has(name)) continue;
			if (cat.match.test(name)) {
				ours.push(name);
				seen.add(name);
			}
		}
		if (ours.length) {
			groups.push({ id: cat.id, label: cat.label, morphs: ours, collapsed: !!cat.collapsed });
		}
	}
	const leftovers = all.filter((n) => !seen.has(n));
	if (leftovers.length) {
		groups.push({ id: 'other', label: 'Other', morphs: leftovers, collapsed: true });
	}
	return groups;
}

function pairRootOf(name) {
	const m = name.match(/^(.*)(Left|Right)$/);
	return m ? m[1] : null;
}

function sliderRow(name, value, displayLabel, pairName) {
	const labelSource = displayLabel || name;
	const label = humanize(labelSource);
	const meta = ARKIT52.has(name) ? 'ARKit' : isVisemeName(name) ? 'Viseme' : '';
	const pairAttr = pairName ? ` data-pair="${escAttr(pairName)}"` : '';
	return `
		<div class="ae-sculpt-row">
			<div class="ae-sculpt-label">
				<span class="ae-sculpt-name" title="${escAttr(name)}">${escHtml(label)}</span>
				${meta ? `<span class="ae-sculpt-meta">${meta}</span>` : ''}
			</div>
			<input
				type="range"
				min="0" max="1" step="0.01"
				value="${value}"
				data-morph="${escAttr(name)}"${pairAttr}
				aria-label="${escAttr(label)}"
			/>
			<output class="ae-sculpt-value" data-for="${escAttr(name)}">${(+value).toFixed(2)}</output>
		</div>
	`;
}

function humanize(name) {
	return name
		.replace(/^viseme_/, '')
		.replace(/_/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/\b(left|right)$/i, (m) => m.toUpperCase() === 'LEFT' ? 'Left' : 'Right')
		.replace(/^./, (c) => c.toUpperCase());
}

function isVisemeName(name) { return /^viseme_/.test(name); }

function escHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escAttr(s) { return escHtml(s); }
function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
