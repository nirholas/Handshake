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
 *
 * Proportions: morphs reshape a limb, they cannot lengthen one. Length, width
 * and stature are skeleton-space parameters, rendered here as their own group
 * from src/avatar-proportions.js and stored in `workingAppearance.proportions`.
 */

import { detectFaceAll } from './avatar-face-capture.js';
import {
	applyProportionsToRoot,
	availableProportionParams,
	proportionsGroupHtml,
	wireProportionsGroup,
} from './avatar-proportions.js';
import { canonicalBoneNodesFromObject } from './animation-retarget.js';
import {
	SculptBrush,
	BRUSH_DEFAULTS,
	BRUSH_LIMITS,
	SCULPT_TARGET_NAME,
	serializeSculpt,
	applySculptToRoot,
	clearSculpt,
} from './avatar-sculpt-brush.js';
import { sculptVertexCount } from './avatar-sculpt-doc.js';
import { log } from './shared/log.js';

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
	// Identity regions of the parametric base (scripts/build-parametric-base.mjs).
	// Bases without these morphs simply don't render the group.
	{
		id: 'ears',
		label: 'Ears',
		match: /^ear/,
	},
	{
		id: 'head',
		label: 'Head Shape',
		match: /^(head|forehead)/,
	},
	// tongueOut intentionally omitted — RPM/Avaturn bake the morph but nobody
	// wants a "Tongue Out" slider on their face customizer. Drivers that need
	// it (lipsync, mocap) still hit it via runtime APIs.
	// Body regions of the parametric base. These sit BEFORE the catch-all Body
	// group on purpose: its regex would otherwise swallow every one of them.
	// They default to collapsed because the parametric base carries hundreds of
	// body sliders and an all-open panel is a wall, not a control surface.
	{
		id: 'neck',
		label: 'Neck',
		match: /^neck/,
		collapsed: true,
	},
	{
		id: 'torso',
		label: 'Torso',
		match: /^(torso|chest|bust|breast|waist|shoulders)/,
		collapsed: true,
	},
	{
		id: 'midsection',
		label: 'Hips & Midsection',
		match: /^(hips|hip|gluteus|buttocks|belly|stomach)/,
		collapsed: true,
	},
	{
		id: 'arms',
		label: 'Arms',
		match: /^(arms|forearm|upperarm|hands)/,
		collapsed: true,
	},
	{
		id: 'legs',
		label: 'Legs',
		match: /^(legs|thighs|calves|knees|feet)/,
		collapsed: true,
	},
	{
		id: 'body',
		label: 'Body',
		match: /^(body|shape|height|muscle|weight|figure)/i,
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

/**
 * The category table, exported for the parametric-base test, which asserts that
 * every slider the baker ships lands in a named group instead of the "Other"
 * drawer. Read-only: mutate the table above, not this alias.
 */
export const CATEGORIES_FOR_TEST = CATEGORIES;

const ARKIT52 = new Set([
	'eyeBlinkLeft','eyeBlinkRight','eyeLookDownLeft','eyeLookDownRight','eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight','eyeLookUpLeft','eyeLookUpRight','eyeSquintLeft','eyeSquintRight','eyeWideLeft','eyeWideRight','jawForward','jawLeft','jawRight','jawOpen','mouthClose','mouthFunnel','mouthPucker','mouthLeft','mouthRight','mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight','mouthDimpleLeft','mouthDimpleRight','mouthStretchLeft','mouthStretchRight','mouthRollLower','mouthRollUpper','mouthShrugLower','mouthShrugUpper','mouthPressLeft','mouthPressRight','mouthLowerDownLeft','mouthLowerDownRight','mouthUpperUpLeft','mouthUpperUpRight','browDownLeft','browDownRight','browInnerUp','browOuterUpLeft','browOuterUpRight','cheekPuff','cheekSquintLeft','cheekSquintRight','noseSneerLeft','noseSneerRight','tongueOut',
]);

// Above this many morphs the panel stops being scannable and earns a filter.
// Parametric bases blow past it; a 52-blendshape RPM avatar never does, so its
// panel stays exactly as it was.
const FILTER_THRESHOLD = 80;

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
				// The free-sculpt delta is a shape, not a slider: its weight is
				// pinned at 1 and a control that could dial it back to 0.4 would
				// mean "half of the edits I made", which is not a thing a user
				// asks for. It is cleared from the Free Sculpt group instead.
				if (k === SCULPT_TARGET_NAME) continue;
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
 * @param {object} opts.root: Three.js scene root (used to discover morphs)
 * @param {object} opts.working: workingAppearance reference (we mutate .morphs / .proportions)
 * @param {() => void} opts.onDirty: called after each change
 * @param {() => void} [opts.onRigChanged]: called after a proportion edit settles,
 *   so the host can re-measure root motion (see AnimationManager.remeasureRigProportions)
 */
export function renderSculptPanel({ container, root, working, onDirty, onRigChanged, viewport = null }) {
	const all = discoverMorphs(root);
	const boneMap = canonicalBoneNodesFromObject(root);
	const proportionIds = availableProportionParams(root, { boneMap });

	// A panel rebuild replaces the DOM the brush's controls live on, so the
	// previous instance has to give up its canvas listeners and its ring before
	// the new one claims them. Without this a few tab switches leave several
	// brushes painting on the same stroke.
	teardownBrush();

	if (!all.length && !proportionIds.length) {
		container.innerHTML = `
			<div class="ae-empty">
				This avatar has no sculptable morph targets and no editable skeleton.<br/>
				Re-import it through <a href="/create" style="color:inherit">/create</a>
				to get a rig with ARKit-52 blendshapes.
			</div>`;
		return;
	}

	const groups = groupMorphs(all);
	working.morphs = working.morphs || {};
	const available = new Set(all);
	const rerender = () => renderSculptPanel({ container, root, working, onDirty, onRigChanged });

	container.innerHTML = `
		<div class="ae-sculpt-head">
			${all.length ? `
			<button class="ae-btn ae-sculpt-capture" type="button" id="ae-sculpt-capture">
				<span class="ae-sculpt-capture-icon" aria-hidden="true">📸</span>
				Capture from photo
			</button>
			<label class="ae-sculpt-mirror" title="Keep left/right morphs in sync">
				<input type="checkbox" id="ae-sculpt-mirror-lock" ${_mirrorLocked ? 'checked' : ''}>
				Mirror L/R
			</label>` : ''}
			<button class="ae-btn ae-sculpt-reset" type="button" id="ae-sculpt-reset">Reset all</button>
		</div>
		${all.length > FILTER_THRESHOLD ? `
		<div class="ae-sculpt-filter">
			<input type="search" id="ae-sculpt-filter-input" autocomplete="off"
			       placeholder="Filter ${all.length} sliders (nose, jaw, calf...)"
			       aria-label="Filter sculpt sliders">
			<span class="ae-sculpt-filter-count" id="ae-sculpt-filter-count" role="status" aria-live="polite"></span>
		</div>` : ''}
		<p class="ae-sculpt-note">
			${all.length
				? `Drag the wheel puck to blend face types. Use sliders for fine control.
				   Double-click any slider to reset it. Capture button reads face geometry
				   from your webcam: expression in the photo is ignored.`
				: `This rig carries no blendshapes, so its build is sculpted from the
				   skeleton. Double-click any slider to reset it.`}
		</p>

		${freeSculptGroupHtml(viewport, working)}

		${proportionsGroupHtml(proportionIds, working.proportions)}

		${all.length ? blendWheelHtml() : ''}

		${groups.map((g) => renderGroup(g, working.morphs)).join('')}
	`;

	ensureProportionCss();
	wireSliders(container, root, working, onDirty);
	wireFilter(container);
	wireFreeSculpt({ container, root, working, viewport, onDirty });
	if (all.length) wireBlendWheel(container, root, working, available, onDirty);
	wireProportionsGroup({ container, root, working, boneMap, onDirty, onRigChanged, rerender });

	container.querySelector('#ae-sculpt-mirror-lock')?.addEventListener('change', (e) => {
		_mirrorLocked = e.target.checked;
		rerender();
	});

	container.querySelector('#ae-sculpt-reset')?.addEventListener('click', () => {
		working.morphs = {};
		working.proportions = {};
		working.sculpt = null;
		applyMorphsToRoot(root, clearAll(all));
		applyProportionsToRoot(root, {}, { boneMap });
		clearSculpt(root);
		rerender();
		onDirty?.();
		onRigChanged?.();
	});

	container.querySelector('#ae-sculpt-capture')?.addEventListener('click', () => {
		openFaceCaptureModal({ root, working, onDirty, rerender });
	});
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Proportions styling: injected once. The sculpt CSS lives inline in both
 * pages/avatar-studio.html and pages/avatar-edit.html; the proportions group is
 * shared by both surfaces, so its rules ship with the module instead of being
 * copy-pasted into two <style> blocks that would drift.
 * ────────────────────────────────────────────────────────────────────────── */

function ensureProportionCss() {
	if (typeof document === 'undefined' || document.getElementById('ae-prop-css')) return;
	const style = document.createElement('style');
	style.id = 'ae-prop-css';
	style.textContent = `
		.ae-prop-note {
			margin: 2px 0 8px;
			font-size: 11px;
			line-height: 1.5;
			color: var(--text-3);
		}
		.ae-prop-section + .ae-prop-section { margin-top: 10px; }
		.ae-prop-heading {
			margin: 0 0 2px;
			font-size: 9px;
			font-weight: 600;
			letter-spacing: 0.1em;
			text-transform: uppercase;
			color: var(--text-3);
		}
		.ae-prop-row { grid-template-columns: minmax(0, 1.3fr) minmax(0, 2fr) 52px; }
		.ae-prop-row .ae-sculpt-value { color: var(--text-2, var(--text-3)); }
		.ae-prop-rows #ae-prop-reset { align-self: flex-start; margin-top: 10px; }

		/* Filter + edited badges. These ship with the module rather than with
		   either page's inline <style> because both surfaces render the same
		   panel and a copy-pasted rule is a rule that drifts. */
		.ae-sculpt-filter {
			display: flex;
			align-items: center;
			gap: 8px;
			margin: 0 0 10px;
		}
		.ae-sculpt-filter input[type='search'] {
			flex: 1 1 auto;
			min-width: 0;
			padding: 8px 10px;
			font: inherit;
			font-size: 12px;
			color: var(--text);
			background: var(--panel);
			border: 1px solid var(--border-2);
			border-radius: 8px;
			transition: border-color 0.12s, box-shadow 0.12s;
		}
		.ae-sculpt-filter input[type='search']:hover { border-color: var(--text-3); }
		.ae-sculpt-filter input[type='search']:focus-visible {
			outline: none;
			border-color: var(--accent);
			box-shadow: 0 0 0 2px var(--accent-dim, rgba(255, 255, 255, 0.14));
		}
		.ae-sculpt-filter-count {
			font-size: 10px;
			color: var(--text-3);
			white-space: nowrap;
		}
		/* .ae-sculpt-row sets display:grid, which outranks the UA [hidden] rule,
		   so filtering needs its own hide. Same for the group wrapper. */
		.ae-sculpt-row[hidden],
		.ae-sculpt-group[hidden] { display: none; }
		/* Let the group title claim the free space so the badges sit together on
		   the right whether or not the edited pill is showing. */
		.ae-sculpt-group summary > span:first-child { margin-right: auto; }
		.ae-sculpt-group summary .ae-sculpt-count { margin-left: 6px; }
		.ae-sculpt-edited {
			font-size: 10px;
			font-weight: 600;
			color: var(--accent-ink, #000);
			background: var(--accent);
			padding: 2px 7px;
			border-radius: 999px;
		}

		/* Free sculpt */
		.ae-brush-toggle {
			display: flex;
			align-items: center;
			gap: 8px;
			font-size: 12px;
			color: var(--text-2, var(--text));
			cursor: pointer;
			padding: 4px 0;
		}
		.ae-brush-toggle input { accent-color: var(--accent); cursor: pointer; }
		.ae-brush-modes { display: flex; gap: 6px; margin: 2px 0 4px; }
		.ae-brush-mode {
			flex: 1 1 0;
			padding: 7px 8px;
			font: inherit;
			font-size: 12px;
			font-weight: 600;
			color: var(--text-2, var(--text));
			background: var(--panel);
			border: 1px solid var(--border-2);
			border-radius: 8px;
			cursor: pointer;
			transition: background 0.12s, border-color 0.12s, color 0.12s;
		}
		.ae-brush-mode:hover { border-color: var(--text-3); }
		.ae-brush-mode:focus-visible {
			outline: none;
			box-shadow: 0 0 0 2px var(--accent-dim, rgba(255, 255, 255, 0.14));
		}
		.ae-brush-mode[aria-pressed='true'] {
			background: var(--accent);
			border-color: var(--accent);
			color: var(--accent-ink, #000);
		}
		.ae-brush-foot {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			margin-top: 6px;
		}
		.ae-brush-status { font-size: 11px; color: var(--text-3); min-width: 0; }
		.ae-brush-clear:disabled { opacity: 0.45; cursor: not-allowed; }
	`;
	document.head.appendChild(style);
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
			refreshEditedBadge(input);
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

/**
 * Live filter over every slider row. Groups whose rows all fall away are hidden
 * entirely and matching groups spring open, so a query lands the user on the
 * control instead of on a list of closed folders. Clearing the box restores the
 * group open/closed state exactly as it was before the first keystroke.
 */
function wireFilter(container) {
	const input = container.querySelector('#ae-sculpt-filter-input');
	if (!input) return;
	const countEl = container.querySelector('#ae-sculpt-filter-count');
	const groups = [...container.querySelectorAll('details.ae-sculpt-group')];
	const rows = [...container.querySelectorAll('.ae-sculpt-row[data-search]')];
	const total = rows.length;
	let restoreOpen = null;

	const apply = () => {
		const q = input.value.trim().toLowerCase();
		if (!q) {
			for (const row of rows) row.hidden = false;
			groups.forEach((g, i) => {
				g.hidden = false;
				if (restoreOpen) g.open = restoreOpen[i];
			});
			restoreOpen = null;
			if (countEl) countEl.textContent = '';
			return;
		}
		if (!restoreOpen) restoreOpen = groups.map((g) => g.open);

		const terms = q.split(/\s+/);
		let shown = 0;
		for (const row of rows) {
			const hay = row.dataset.search;
			const hit = terms.every((t) => hay.includes(t));
			row.hidden = !hit;
			if (hit) shown++;
		}
		for (const g of groups) {
			const hit = !!g.querySelector('.ae-sculpt-row[data-search]:not([hidden])');
			g.hidden = !hit;
			if (hit) g.open = true;
		}
		if (countEl) {
			countEl.textContent = shown
				? `${shown} of ${total}`
				: 'No slider matches that';
		}
	};

	input.addEventListener('input', apply);
	input.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape' || !input.value) return;
		e.stopPropagation();
		input.value = '';
		apply();
	});
}


/* ────────────────────────────────────────────────────────────────────────── *
 * Free sculpt: the brush group.
 *
 * The library sliders and the proportion table are both catalogues. This is the
 * escape hatch from them, so it sits at the top of the panel rather than buried
 * under three hundred sliders. It only renders when the host handed us a
 * viewport, because a brush with no canvas to paint on would be a dead control.
 * ────────────────────────────────────────────────────────────────────────── */

let _brush = null;
let _brushParams = { ...BRUSH_DEFAULTS };

/** Drop the live brush: canvas listeners, cursor ring, rig pause. */
function teardownBrush() {
	if (!_brush) return;
	_brush.viewport?.setPaused?.(false);
	_brush.instance.dispose();
	_brush = null;
}

function freeSculptGroupHtml(viewport, working) {
	if (!viewport?.camera || !viewport?.domElement) return '';
	const p = _brushParams;
	const r = BRUSH_LIMITS.radius;
	const st = BRUSH_LIMITS.strength;
	const recorded = sculptVertexCount(working.sculpt);
	return `
		<details class="ae-sculpt-group ae-brush-group" open>
			<summary>
				<span>Free Sculpt</span>
				<span class="ae-sculpt-edited" data-edited="${recorded}"${recorded ? '' : ' hidden'}>${recorded} points</span>
				<span class="ae-sculpt-count">brush</span>
			</summary>
			<div class="ae-sculpt-rows">
				<p class="ae-prop-note">
					Drag on the avatar to push or pull the surface. Dragging the
					background still orbits the camera. Playback pauses while the
					brush is on so the mesh holds still under your cursor.
				</p>
				<label class="ae-brush-toggle">
					<input type="checkbox" id="ae-brush-enable">
					<span>Brush on</span>
				</label>
				<div class="ae-brush-modes" role="group" aria-label="Brush direction">
					<button type="button" class="ae-brush-mode" data-direction="1"
					        aria-pressed="${p.direction > 0}">Pull out</button>
					<button type="button" class="ae-brush-mode" data-direction="-1"
					        aria-pressed="${p.direction < 0}">Push in</button>
				</div>
				<div class="ae-sculpt-row ae-prop-row">
					<div class="ae-sculpt-label"><span class="ae-sculpt-name">Size</span></div>
					<input type="range" id="ae-brush-radius"
					       min="${r.min}" max="${r.max}" step="${r.step}" value="${p.radius}"
					       aria-label="Brush size in centimetres">
					<output class="ae-sculpt-value" id="ae-brush-radius-out">${(p.radius * 100).toFixed(1)} cm</output>
				</div>
				<div class="ae-sculpt-row ae-prop-row">
					<div class="ae-sculpt-label"><span class="ae-sculpt-name">Strength</span></div>
					<input type="range" id="ae-brush-strength"
					       min="${st.min}" max="${st.max}" step="${st.step}" value="${p.strength}"
					       aria-label="Brush strength in millimetres per stroke">
					<output class="ae-sculpt-value" id="ae-brush-strength-out">${(p.strength * 1000).toFixed(1)} mm</output>
				</div>
				<label class="ae-brush-toggle">
					<input type="checkbox" id="ae-brush-symmetry" ${p.symmetry ? 'checked' : ''}>
					<span>Symmetry</span>
				</label>
				<div class="ae-brush-foot">
					<span class="ae-brush-status" id="ae-brush-status" role="status" aria-live="polite">
						${recorded ? `${recorded} points sculpted` : 'Nothing sculpted yet'}
					</span>
					<button type="button" class="ae-btn ae-brush-clear" id="ae-brush-clear"
					        ${recorded ? '' : 'disabled'}>Clear sculpt</button>
				</div>
			</div>
		</details>
	`;
}

function wireFreeSculpt({ container, root, working, viewport, onDirty }) {
	const enable = container.querySelector('#ae-brush-enable');
	if (!enable || !viewport) return;

	const status = container.querySelector('#ae-brush-status');
	const clearBtn = container.querySelector('#ae-brush-clear');
	const badge = container.querySelector('.ae-brush-group .ae-sculpt-edited');
	const radius = container.querySelector('#ae-brush-radius');
	const radiusOut = container.querySelector('#ae-brush-radius-out');
	const strength = container.querySelector('#ae-brush-strength');
	const strengthOut = container.querySelector('#ae-brush-strength-out');
	const symmetry = container.querySelector('#ae-brush-symmetry');

	// Rehydrate whatever the record already carries onto the live mesh. The
	// panel is the only place that knows both the document and the model, and
	// doing it here means a saved sculpt reappears on every tab visit rather
	// than only on the load that happened to run the host's boot path.
	if (working.sculpt) applySculptToRoot(root, working.sculpt);

	const report = (message) => {
		const count = sculptVertexCount(working.sculpt);
		if (status) status.textContent = message ?? (count ? `${count} points sculpted` : 'Nothing sculpted yet');
		if (clearBtn) clearBtn.disabled = count === 0;
		if (badge) {
			badge.dataset.edited = String(count);
			badge.textContent = `${count} points`;
			badge.hidden = count === 0;
		}
	};

	const commit = () => {
		working.sculpt = serializeSculpt(root);
		report();
		onDirty?.();
	};

	const ensureBrush = () => {
		if (_brush) return _brush.instance;
		const instance = new SculptBrush({
			root,
			camera: viewport.camera,
			domElement: viewport.domElement,
			controls: viewport.controls || null,
			onStroke: ({ vertices }) => {
				if (status) status.textContent = `Sculpting… ${vertices} vertices this step`;
			},
			onStrokeEnd: commit,
		});
		instance.setParams(_brushParams);
		_brush = { instance, viewport };
		return instance;
	};

	enable.addEventListener('change', () => {
		if (enable.checked) {
			const instance = ensureBrush();
			viewport.setPaused?.(true);
			instance.enable();
			report('Brush on. Drag the avatar to sculpt.');
		} else {
			teardownBrush();
			report();
		}
	});

	const pushParams = (patch) => {
		Object.assign(_brushParams, patch);
		_brush?.instance.setParams(_brushParams);
	};

	radius?.addEventListener('input', () => {
		const v = Number(radius.value);
		pushParams({ radius: v });
		if (radiusOut) radiusOut.textContent = `${(v * 100).toFixed(1)} cm`;
	});
	strength?.addEventListener('input', () => {
		const v = Number(strength.value);
		pushParams({ strength: v });
		if (strengthOut) strengthOut.textContent = `${(v * 1000).toFixed(1)} mm`;
	});
	symmetry?.addEventListener('change', () => pushParams({ symmetry: symmetry.checked }));

	for (const btn of container.querySelectorAll('.ae-brush-mode')) {
		btn.addEventListener('click', () => {
			const direction = Number(btn.dataset.direction);
			pushParams({ direction });
			for (const other of container.querySelectorAll('.ae-brush-mode')) {
				other.setAttribute('aria-pressed', String(Number(other.dataset.direction) === direction));
			}
		});
	}

	clearBtn?.addEventListener('click', () => {
		clearSculpt(root);
		working.sculpt = null;
		report('Free sculpt cleared.');
		onDirty?.();
	});
}

/**
 * "3 edited" pill on a collapsed group's summary. With hundreds of sliders the
 * panel is mostly closed, and without this the user has no way to tell which
 * closed groups they have already touched.
 */
function editedBadge(names, morphs) {
	const n = names.reduce((c, name) => c + (morphs[name] ? 1 : 0), 0);
	return `<span class="ae-sculpt-edited" data-edited="${n}"${n ? '' : ' hidden'}>${n} edited</span>`;
}

/** Recount the badge on the group owning `input` after a slider moves. */
function refreshEditedBadge(input) {
	const group = input.closest('details.ae-sculpt-group');
	const badge = group?.querySelector('.ae-sculpt-edited');
	if (!badge) return;
	let n = 0;
	group.querySelectorAll('input[type="range"][data-morph]').forEach((el) => {
		if (Number(el.value) !== 0) n++;
	});
	badge.dataset.edited = String(n);
	badge.textContent = `${n} edited`;
	badge.hidden = n === 0;
}

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
					${editedBadge(visible.map((v) => v.name), morphs)}
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
				${editedBadge(g.morphs, morphs)}
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
			log.error('[avatar-sculpt] capture failed', err);
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
	// data-search carries both the human label and the raw morph name so the
	// filter finds "cupids bow" and "mouthCupidsBowWider" with one query.
	const search = `${label} ${name}`.toLowerCase();
	return `
		<div class="ae-sculpt-row" data-search="${escAttr(search)}">
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
