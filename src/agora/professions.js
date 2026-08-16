// Task 06 reward styling helpers for the Commons economy layer.
//
// Profession → accent colour is owned by src/agora/citizen-avatar.js (Task 05)
// so the labour market reads the same everywhere — a Sculptor is one colour on
// its citizen ring, its job-board marker and its ticker chip. We re-export that
// single source and add only what the economy visuals need on top: a Three.js
// colour wrapper (markers/coins are 3D, the source is a CSS string) and reward
// sizing/formatting. No second colour map, ever.

import * as THREE from 'three';
import {
	professionColor, PROFESSION_COLORS, PROFESSION_LABELS,
	professionLabelFor, primaryProfessionKey, citizenProfessionLabel,
} from './citizen-avatar.js';

// The profession vocabulary (colour, label, and which craft a citizen is known
// for) has exactly one home, next to the crowd that renders it. Re-exported here
// so the economy visuals keep importing from one module. No second map, ever.
export {
	professionColor, PROFESSION_COLORS, PROFESSION_LABELS,
	professionLabelFor, primaryProfessionKey, citizenProfessionLabel,
};

// The CSS accent for a profession as a Three.js Color (markers, coin arcs, the
// board glow all live in the 3D scene). Memoised so we don't allocate a Color
// per marker per frame.
const _colorCache = new Map();
export function professionThreeColor(profession) {
	const css = professionColor(profession);
	let c = _colorCache.get(css);
	if (!c) { c = new THREE.Color(css); _colorCache.set(css, c); }
	return c;
}

// Derive a comparable magnitude from a task reward so markers can be sized by
// value. Rewards arrive either as an atomic string (`amountAtomic`) or only as a
// formatted label ("25,000 $THREE", "$0.01"). Prefer the atomic count (token
// decimals don't matter for a *relative* size) and fall back to the first number
// readable from the label. Returns 0 when nothing parses — never NaN.
export function rewardMagnitude(reward) {
	if (!reward) return 0;
	const atomic = reward.amountAtomic;
	if (atomic != null && atomic !== '') {
		const n = Number(atomic);
		if (Number.isFinite(n) && n > 0) return n;
	}
	const label = reward.label || reward.priceLabel || '';
	const m = String(label).replace(/,/g, '').match(/[\d.]+/);
	if (m) {
		const n = parseFloat(m[0]);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return 0;
}

// Map a reward magnitude onto a marker scale on a log curve so a 1,000,000-unit
// bounty doesn't dwarf a 100-unit one off the screen, while still reading as
// "bigger reward = bigger glow". Clamped to a sane visual band.
export function rewardMarkerScale(magnitude) {
	const MIN = 0.6;
	const MAX = 1.7;
	if (!(magnitude > 0)) return MIN;
	const t = Math.min(1, Math.max(0, Math.log10(magnitude) / 9)); // 1 → 1e9 over 0..1
	return MIN + (MAX - MIN) * t;
}

// A short reward chip string for HUD/tooltip use. Honours whatever the API
// formatted (it already says "$THREE" or the devnet unit) and never invents a
// coin. Falls back to the raw atomic count only when no label exists.
export function rewardChip(reward) {
	if (!reward) return null;
	if (reward.label) return reward.label;
	if (reward.priceLabel) return reward.priceLabel;
	if (reward.amountAtomic != null) {
		const cur = reward.currency || reward.mint || '';
		return `${reward.amountAtomic}${cur ? ' ' + cur : ''}`;
	}
	return null;
}
