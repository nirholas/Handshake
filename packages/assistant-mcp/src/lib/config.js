// Self-contained validators and snippet builders for the assistant widget.
//
// This package publishes to npm and cannot import from the main three.ws repo,
// so every validator here is its own implementation. The grammar is deliberately
// strict: anything that does not parse cleanly falls back to a safe default, so
// a hostile or malformed config can never produce broken HTML or an injected
// attribute. There is no network here, building an embed is a pure function of
// the input config and the target origin.

// --- Vocabulary -------------------------------------------------------------

export const DEFAULT_ACCENT = '#f97316';
export const DEFAULT_BACKGROUND = 'transparent';
export const DEFAULT_MODE = 'both';
export const DEFAULT_POSITION = 'right';

export const MODES = ['chat', 'speak', 'both'];
export const POSITIONS = ['right', 'left'];
export const BACKGROUND_PRESETS = ['ember', 'ocean', 'violet', 'forest', 'dusk', 'slate'];

// Built-in avatars shipped with the widget. Any three.ws avatar id, a
// `/avatars/*.glb` path, or a fully-qualified GLB URL also works at runtime.
export const BUILTIN_AVATARS = [
	{ id: '', label: 'Default mannequin' },
	{ id: '/avatars/selfie-girl.glb', label: 'Selfie girl' },
	{ id: '/avatars/realistic-male.glb', label: 'Realistic male' },
	{ id: '/avatars/realistic-female.glb', label: 'Realistic female' },
	{ id: '/avatars/michelle.glb', label: 'Michelle' },
	{ id: '/avatars/xbot.glb', label: 'X Bot' },
];

// Chat lanes the widget can drive. The free chain needs no key; the two BYOK
// lanes read a key the visitor pastes into the widget settings, which stays in
// their browser and is never sent to three.ws.
export const CHAT_LANES = [
	{ id: 'free', description: 'Default free LLM chain. No key, no account, works out of the box.' },
	{ id: 'byok-groq', description: 'Visitor supplies their own Groq key in the widget settings; the key stays in their browser.' },
	{
		id: 'byok-openrouter',
		description: 'Visitor supplies their own OpenRouter key in the widget settings; the key stays in their browser.',
	},
];

// Field-length caps, mirrored by the Zod schema on the tool. Text is clamped
// (never rejected) so a slightly-too-long string still yields a working embed.
export const LIMITS = {
	avatar: 300,
	agent: 120,
	background: 120,
	name: 60,
	greeting: 200,
	context: 500,
	accent: 9,
};

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// --- Primitive validators ---------------------------------------------------

/**
 * Return a normalized `#rgb` / `#rrggbb` / `#rrggbbaa` color, or null when the
 * value is not a valid hex color. Case is lowercased for stable output.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeHex(value) {
	if (typeof value !== 'string') return null;
	const v = value.trim();
	return HEX_COLOR.test(v) ? v.toLowerCase() : null;
}

/**
 * Clamp a free-text field to its cap and trim it. Non-strings and empty results
 * become `undefined` so callers can skip them cleanly.
 * @param {unknown} value
 * @param {number} max
 * @returns {string|undefined}
 */
export function clampText(value, max) {
	if (typeof value !== 'string') return undefined;
	const v = value.trim().slice(0, max);
	return v.length > 0 ? v : undefined;
}

/**
 * Resolve an enum field to one of `allowed`, falling back to `fallback`.
 * @param {unknown} value
 * @param {string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeEnum(value, allowed, fallback) {
	if (typeof value !== 'string') return fallback;
	const v = value.trim().toLowerCase();
	return allowed.includes(v) ? v : fallback;
}

/**
 * Booleans pass through; everything else (including undefined) becomes
 * undefined, so an unset toggle is distinguishable from an explicit false.
 * @param {unknown} value
 * @returns {boolean|undefined}
 */
export function normalizeBool(value) {
	return typeof value === 'boolean' ? value : undefined;
}

/**
 * Validate the background grammar. Only these forms pass; anything else (a color
 * function, a CSS injection attempt, an unknown preset) falls back to
 * `transparent`:
 *   • `transparent`
 *   • a valid hex color (`#rgb` / `#rrggbb` / `#rrggbbaa`)
 *   • one of the six preset names (ember, ocean, violet, forest, dusk, slate)
 *   • `gradient:#hex,#hex[,angle]` where angle is an integer 0-360
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeBackground(value) {
	if (typeof value !== 'string') return DEFAULT_BACKGROUND;
	const raw = value.trim();
	if (raw === '') return DEFAULT_BACKGROUND;

	const lower = raw.toLowerCase();
	if (lower === 'transparent') return 'transparent';
	if (BACKGROUND_PRESETS.includes(lower)) return lower;

	const hex = normalizeHex(raw);
	if (hex) return hex;

	if (lower.startsWith('gradient:')) {
		const parts = raw.slice('gradient:'.length).split(',').map((p) => p.trim());
		if (parts.length < 2 || parts.length > 3) return DEFAULT_BACKGROUND;
		const from = normalizeHex(parts[0]);
		const to = normalizeHex(parts[1]);
		if (!from || !to) return DEFAULT_BACKGROUND;
		if (parts.length === 3) {
			const angle = Number(parts[2]);
			if (!Number.isInteger(angle) || angle < 0 || angle > 360) return DEFAULT_BACKGROUND;
			return `gradient:${from},${to},${angle}`;
		}
		return `gradient:${from},${to}`;
	}

	return DEFAULT_BACKGROUND;
}

// --- Config normalization ---------------------------------------------------

/**
 * Turn a raw tool input into a fully-normalized, safe config. Enum and color
 * fields always resolve to a value (their default when invalid); text fields
 * and the two toggles are present only when meaningfully set. The result is
 * what every downstream builder (attributes, frame URL, JS API) reads from.
 * @param {Record<string, unknown>} [raw]
 * @returns {Record<string, unknown>}
 */
export function normalizeConfig(raw = {}) {
	const config = {
		// The widget's wire name for the backdrop is `bg` (data-bg / ?bg=); the
		// friendlier input field is `background`. Map it here so every emitter
		// speaks the real widget contract.
		bg: normalizeBackground(raw.background),
		mode: normalizeEnum(raw.mode, MODES, DEFAULT_MODE),
		accent: normalizeHex(raw.accent) || DEFAULT_ACCENT,
		position: normalizeEnum(raw.position, POSITIONS, DEFAULT_POSITION),
	};

	const avatar = clampText(raw.avatar, LIMITS.avatar);
	const agent = clampText(raw.agent, LIMITS.agent);
	const name = clampText(raw.name, LIMITS.name);
	const greeting = clampText(raw.greeting, LIMITS.greeting);
	const context = clampText(raw.context, LIMITS.context);
	const voice = normalizeBool(raw.voice);
	const badge = normalizeBool(raw.badge);

	if (avatar !== undefined) config.avatar = avatar;
	if (agent !== undefined) config.agent = agent;
	if (name !== undefined) config.name = name;
	if (greeting !== undefined) config.greeting = greeting;
	if (context !== undefined) config.context = context;
	if (voice !== undefined) config.voice = voice;
	if (badge !== undefined) config.badge = badge;

	return config;
}

// --- Emitters ---------------------------------------------------------------

/**
 * Escape a value for safe inclusion inside a double-quoted HTML attribute. Full
 * escaping (not just the quote) guarantees the generated markup is never broken
 * or injectable, no matter what a caller passes for name/greeting/context.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttr(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// Order in which data-* attributes are emitted onto the script tag. These are
// the widget's real wire names (data-bg, not data-background). `position` is a
// launcher-only attribute, so it appears here but NOT in FRAME_KEYS below.
const ATTR_ORDER = ['avatar', 'agent', 'bg', 'mode', 'name', 'greeting', 'context', 'accent', 'position', 'voice', 'badge'];

// Keys the frame itself reads (assistant-frame). `position` and `open` are the
// loader's concern (which corner, start-open) and are ignored by the frame, so
// a standalone frame URL omits them.
const FRAME_KEYS = ['avatar', 'agent', 'bg', 'mode', 'name', 'greeting', 'context', 'accent', 'voice', 'badge'];

/**
 * Build the ordered list of `data-*` attribute pairs for the embed, emitting
 * ONLY non-default values so a minimal config yields a minimal tag. Defaults
 * that are skipped: background `transparent`, mode `both`, accent `#f97316`,
 * position `right`; the voice/badge toggles emit only when explicitly `false`.
 * @param {Record<string, unknown>} config  A normalized config.
 * @returns {Array<[string, string]>} `[attrName, stringValue]` pairs.
 */
export function buildAttributes(config) {
	const pairs = [];
	for (const key of ATTR_ORDER) {
		const value = config[key];
		switch (key) {
			case 'avatar':
			case 'agent':
			case 'name':
			case 'greeting':
			case 'context':
				if (typeof value === 'string' && value.length > 0) pairs.push([key, value]);
				break;
			case 'bg':
				if (typeof value === 'string' && value !== DEFAULT_BACKGROUND) pairs.push([key, value]);
				break;
			case 'mode':
				if (value !== DEFAULT_MODE) pairs.push([key, String(value)]);
				break;
			case 'accent':
				if (value !== DEFAULT_ACCENT) pairs.push([key, String(value)]);
				break;
			case 'position':
				if (value !== DEFAULT_POSITION) pairs.push([key, String(value)]);
				break;
			case 'voice':
			case 'badge':
				// Both default ON; emit an explicit override only when turned off.
				if (value === false) pairs.push([key, 'false']);
				break;
			default:
				break;
		}
	}
	return pairs;
}

/**
 * Assemble the paste-ready `<script>` embed. Attribute values are HTML-escaped,
 * so the returned string is always well-formed markup.
 * @param {Record<string, unknown>} config  A normalized config.
 * @param {string} base  The target origin (no trailing slash).
 * @returns {string}
 */
export function buildSnippet(config, base) {
	const attrStr = buildAttributes(config)
		.map(([key, value]) => ` data-${key}="${escapeAttr(value)}"`)
		.join('');
	return `<script src="${base}/assistant/v1.js" async${attrStr}></script>`;
}

/**
 * Build the standalone frame URL. Unlike the script tag, this carries every
 * resolved value (including the defaults) so the frame renders deterministically
 * when opened directly or dropped into an <iframe>.
 * @param {Record<string, unknown>} config  A normalized config.
 * @param {string} base  The target origin (no trailing slash).
 * @returns {string}
 */
export function buildFrameUrl(config, base) {
	const params = new URLSearchParams();
	for (const key of FRAME_KEYS) {
		const value = config[key];
		if (value === undefined || value === null) continue;
		if (typeof value === 'string' && value.length === 0) continue;
		params.set(key, String(value));
	}
	const query = params.toString();
	return query ? `${base}/assistant-frame?${query}` : `${base}/assistant-frame`;
}

/**
 * Build the equivalent `ThreeAssistant.init({...})` JavaScript API snippet, for
 * callers who mount the widget programmatically instead of via the script tag.
 * `init` takes the config directly and renders a floating launcher (there is no
 * mount target), so the snippet passes the normalized config verbatim.
 * @param {Record<string, unknown>} config  A normalized config.
 * @returns {string}
 */
export function buildJsApi(config) {
	return `ThreeAssistant.init(${JSON.stringify(config, null, 2)});`;
}
