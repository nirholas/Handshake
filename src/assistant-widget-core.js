// Assistant widget — shared pure helpers.
//
// Used by the /assistant-frame runtime (src/assistant-frame.js) and the
// /assistant builder page (src/assistant-page.js). The loader
// (public/assistant/v1.js) is a standalone no-build IIFE, so it passes raw
// config through as URL params and THIS module is the authoritative validator:
// every param that ends up in CSS or a fetch URL goes through here first. A
// hostile host page can therefore never inject styles or URLs into the frame —
// anything that doesn't match the strict grammars below falls back to a safe
// default instead of being interpolated.

/** Widget interaction modes. 'both' shows the Chat|Speak segmented control. */
export const MODES = ['chat', 'speak', 'both'];

/** Launcher/panel screen positions. */
export const POSITIONS = ['right', 'left'];

/** Chat lanes: platform free chain, or the visitor's own key. */
export const LANES = ['free', 'groq', 'openrouter'];

export const DEFAULT_ACCENT = '#f97316';

/**
 * Named gradient presets — the "or a color / gradient" background option.
 * Angles in degrees. Colors are baked constants, so preset output never
 * contains caller-controlled text.
 */
export const GRADIENT_PRESETS = {
	ember: ['#1a0b05', '#7c2d12', 160],
	ocean: ['#020617', '#0c4a6e', 160],
	violet: ['#0f0518', '#5b21b6', 160],
	forest: ['#02120b', '#14532d', 160],
	dusk: ['#0b0714', '#9d174d', 200],
	slate: ['#09090b', '#27272a', 180],
};

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** True when `raw` is a #rgb / #rrggbb / #rrggbbaa hex color. */
export function isHexColor(raw) {
	return typeof raw === 'string' && HEX_RE.test(raw.trim());
}

/**
 * Parse the `bg` param into a safe background descriptor.
 *
 * Grammar (anything else → transparent, never interpolated):
 *   ''|'transparent'          → { kind: 'transparent', css: null }
 *   '#rrggbb'                 → { kind: 'solid', css: '#rrggbb' }
 *   '<preset-name>'           → { kind: 'gradient', css: 'linear-gradient(...)' }
 *   'gradient:#a,#b[,120]'    → { kind: 'gradient', css: 'linear-gradient(120deg, #a, #b)' }
 *
 * @param {string|null|undefined} raw
 * @returns {{ kind: 'transparent'|'solid'|'gradient', css: string|null }}
 */
export function parseBackground(raw) {
	const value = String(raw ?? '').trim().toLowerCase();
	if (!value || value === 'transparent') return { kind: 'transparent', css: null };
	if (isHexColor(value)) return { kind: 'solid', css: value };
	if (GRADIENT_PRESETS[value]) {
		const [from, to, angle] = GRADIENT_PRESETS[value];
		return { kind: 'gradient', css: `linear-gradient(${angle}deg, ${from}, ${to})` };
	}
	if (value.startsWith('gradient:')) {
		const parts = value.slice('gradient:'.length).split(',').map((s) => s.trim());
		const [from, to, angleRaw] = parts;
		if (isHexColor(from) && isHexColor(to)) {
			const angle = clampAngle(angleRaw);
			return { kind: 'gradient', css: `linear-gradient(${angle}deg, ${from}, ${to})` };
		}
	}
	return { kind: 'transparent', css: null };
}

function clampAngle(raw) {
	const trimmed = String(raw ?? '').replace(/deg$/, '').trim();
	if (!trimmed) return 160;
	const n = Number(trimmed);
	if (!Number.isFinite(n)) return 160;
	return ((Math.round(n) % 360) + 360) % 360;
}

/** Normalize the interaction mode; unknown values → 'both'. */
export function normalizeMode(raw) {
	const value = String(raw ?? '').trim().toLowerCase();
	return MODES.includes(value) ? value : 'both';
}

/** Normalize launcher position; unknown values → 'right'. */
export function normalizePosition(raw) {
	const value = String(raw ?? '').trim().toLowerCase();
	return POSITIONS.includes(value) ? value : 'right';
}

/** Accent color for buttons/focus rings; only hex passes, else the default. */
export function sanitizeAccent(raw) {
	const value = String(raw ?? '').trim().toLowerCase();
	return isHexColor(value) ? value : DEFAULT_ACCENT;
}

/** Normalize the BYOK/free lane id; unknown values → 'free'. */
export function normalizeLane(raw) {
	const value = String(raw ?? '').trim().toLowerCase();
	return LANES.includes(value) ? value : 'free';
}

/**
 * Config keys the frame accepts, in the order the builder emits them.
 * Single source of truth for loader data-attrs, frame params, and docs.
 */
export const FRAME_PARAM_KEYS = [
	'avatar',
	'agent',
	'bg',
	'mode',
	'accent',
	'name',
	'greeting',
	'context',
	'voice',
	'badge',
	'targetOrigin',
];

const TEXT_LIMITS = { name: 60, greeting: 200, context: 500 };

/**
 * Build the /assistant-frame query string from a config object. Unknown keys
 * are dropped; text fields are length-clamped so the URL stays shareable and
 * the frame never receives oversized payloads.
 *
 * @param {Record<string, string|boolean|undefined>} config
 * @returns {string} query string without the leading '?', '' when empty
 */
export function buildFrameQuery(config = {}) {
	const params = new URLSearchParams();
	for (const key of FRAME_PARAM_KEYS) {
		let value = config[key];
		if (value === undefined || value === null || value === '') continue;
		if (typeof value === 'boolean') value = value ? 'true' : 'false';
		value = String(value);
		if (TEXT_LIMITS[key]) value = value.slice(0, TEXT_LIMITS[key]);
		params.set(key, value);
	}
	return params.toString();
}

/**
 * Estimate how long spoken text stays audible — used to hold the bubble and
 * the talking animation when the platform has no TTS (or is muted). ~15 chars
 * per second of natural speech, floored so one-word lines don't blink away.
 */
export function estimateSpeechMs(text) {
	const len = String(text ?? '').trim().length;
	if (!len) return 0;
	return Math.max(1800, Math.round((len / 15) * 1000));
}

/** Default chat models per BYOK provider (OpenAI-compatible endpoints). */
export const BYOK_DEFAULT_MODELS = {
	groq: 'llama-3.3-70b-versatile',
	openrouter: 'google/gemma-4-31b-it:free',
};

/** OpenAI-compatible chat-completions endpoints for BYOK lanes. */
export const BYOK_ENDPOINTS = {
	groq: 'https://api.groq.com/openai/v1/chat/completions',
	openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};
