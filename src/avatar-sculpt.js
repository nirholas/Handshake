/**
 * Avatar sculpt — face/body morph sliders for /avatars/:id/edit
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
		// RPM-style body morphs all start with these prefixes. Daz/CC use
		// uppercase but normalize-friendly here since we match by name.
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

/** Detect whether a morph name is a Left/Right variant. Returns the pair root or null. */
function pairRootOf(name) {
	const m = name.match(/^(.*)(Left|Right)$/);
	return m ? m[1] : null;
}
/** Detect Left/Right side of a paired morph. */
function sideOf(name) {
	if (name.endsWith('Left')) return 'L';
	if (name.endsWith('Right')) return 'R';
	return null;
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

	// Build DOM
	container.innerHTML = `
		<div class="ae-sculpt-head">
			<button class="ae-btn ae-sculpt-capture" type="button" id="ae-sculpt-capture">
				<span class="ae-sculpt-capture-icon" aria-hidden="true">📸</span>
				Capture from photo
			</button>
			<button class="ae-btn ae-sculpt-reset" type="button" id="ae-sculpt-reset">
				Reset all
			</button>
		</div>
		<p class="ae-sculpt-note">
			Drag a slider to sculpt that morph in real time. The capture button
			takes one selfie and writes the 52 ARKit blendshapes into your
			avatar so it carries your resting expression.
		</p>
		${groups
			.map((g) => `
				<details class="ae-sculpt-group" ${g.collapsed ? '' : 'open'}>
					<summary>
						<span>${g.label}</span>
						<span class="ae-sculpt-count">${g.morphs.length}</span>
					</summary>
					<div class="ae-sculpt-rows">
						${g.morphs
							.map((m) => sliderRow(m, working.morphs[m] || 0))
							.join('')}
					</div>
				</details>
			`)
			.join('')}
	`;

	container.querySelectorAll('input[type="range"][data-morph]').forEach((input) => {
		const name = input.dataset.morph;
		const valEl = container.querySelector(`output[data-for="${cssEscape(name)}"]`);
		const onChange = () => {
			const w = Number(input.value);
			if (w === 0) {
				delete working.morphs[name];
			} else {
				working.morphs[name] = w;
			}
			applyMorphsToRoot(root, { [name]: w });
			if (valEl) valEl.textContent = w.toFixed(2);
			onDirty?.();
		};
		input.addEventListener('input', onChange);
		input.addEventListener('dblclick', () => {
			input.value = '0';
			onChange();
		});
	});

	container.querySelector('#ae-sculpt-reset')?.addEventListener('click', () => {
		// Wipe all morphs we control, re-apply 0, re-render so sliders snap back.
		const previousKeys = Object.keys(working.morphs);
		working.morphs = {};
		const zeros = {};
		for (const k of previousKeys) zeros[k] = 0;
		applyMorphsToRoot(root, zeros);
		renderSculptPanel({ container, root, working, onDirty });
		onDirty?.();
	});

	container.querySelector('#ae-sculpt-capture')?.addEventListener('click', () => {
		openFaceCaptureModal({ root, working, onDirty, rerender: () => {
			renderSculptPanel({ container, root, working, onDirty });
		} });
	});
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Slider wiring — with mirror-lock support for L/R paired morphs.
 * ────────────────────────────────────────────────────────────────────────── */

function wireSliders(container, root, working, onDirty) {
	container.querySelectorAll('input[type="range"][data-morph]').forEach((input) => {
		const name = input.dataset.morph;
		const valEl = container.querySelector(`output[data-for="${cssEscape(name)}"]`);
		const pairName = input.dataset.pair || null; // companion morph when mirroring

		const onChange = () => {
			const w = Number(input.value);
			writeMorph(working, name, w);
			applyMorphsToRoot(root, { [name]: w });
			if (valEl) valEl.textContent = w.toFixed(2);
			// Mirror the value to the companion morph if active.
			if (pairName) {
				writeMorph(working, pairName, w);
				applyMorphsToRoot(root, { [pairName]: w });
			}
			onDirty?.();
		};
		input.addEventListener('input', onChange);
		input.addEventListener('dblclick', () => {
			input.value = '0';
			onChange();
		});
	});
}

function writeMorph(working, name, w) {
	if (w === 0) delete working.morphs[name];
	else working.morphs[name] = w;
}

function renderGroup(g, morphs) {
	if (_mirrorLocked) {
		// Collapse {fooLeft, fooRight} → single "Foo" slider that mutates both.
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
					<span>${g.label}</span>
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
				<span>${g.label}</span>
				<span class="ae-sculpt-count">${g.morphs.length}</span>
			</summary>
			<div class="ae-sculpt-rows">
				${g.morphs.map((m) => sliderRow(m, morphs[m] || 0)).join('')}
			</div>
		</details>
	`;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Face capture modal — webcam → MediaPipe → ARKit-52 weights
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

			// Use identity morphs (from landmark ratios) as the primary signal.
			// The blendshape map is intentionally ignored for seeding — those
			// describe the user's expression in the photo, not their face shape.
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

function groupMorphs(all) {
	const seen = new Set();
	const groups = [];
	for (const cat of CATEGORIES) {
		const ours = [];
		// Preferred names first (in spec order), then any other matches.
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
	// "Other" bucket for anything custom (e.g. RPM Outfit_Top morphs)
	const leftovers = all.filter((n) => !seen.has(n));
	if (leftovers.length) {
		groups.push({ id: 'other', label: 'Other', morphs: leftovers, collapsed: true });
	}
	return groups;
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

function isVisemeName(name) {
	return /^viseme_/.test(name);
}

function escHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escAttr(s) { return escHtml(s); }
function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
