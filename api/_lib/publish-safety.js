// Brand-safety classifier for content THIS PLATFORM PUBLISHES outward.
//
// Scope is deliberately narrow: the only caller is the Sketchfab showcase cron
// (api/cron/sketchfab-showcase.js), which uploads visitor-generated 3D models to
// our own official Sketchfab account. That is an outbound publishing decision
// under our brand on a third party's platform, subject to their terms, so we
// screen what we push there alongside the local denylist in _lib/sketchfab.js.
//
// ── THIS IS NOT A CHAT FILTER ────────────────────────────────────────────────
// It used to also pre-screen anonymous chat, concierge, widget, and agent-idea
// input. That is gone (owner directive 2026-08-07): no three.ws surface screens
// what a user may ASK. An 8B classifier judging a single message with no
// conversation context flagged plenty of ordinary questions, and a refusal the
// user never earned is worse than an answer the model itself would have
// declined. Whatever safety judgment the serving model makes is now the only
// one those routes apply. Do not wire this module back into a chat path.
//
// ── FAIL-OPEN ────────────────────────────────────────────────────────────────
// A timeout, an outage, a bad key, a non-200, an unparseable reply: ANY failure
// returns { flagged: false } and publishing proceeds. The only outcome that
// blocks an upload is a successful, parsed "unsafe" verdict.
//
// Autonomous-spend governance is a separate concern and stays with IBM Granite
// Guardian (granite-guardian.js). Probe + schema: tasks/nvidia-nim/probes/moderation.md

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// nvidia/llama-3.1-nemoguard-8b-content-safety returns a JSON verdict + named
// categories, median ~340 ms on the free tier (see probe). Override via
// PUBLISH_SAFETY_MODEL; the parser also understands the Llama-Guard
// `unsafe\nS#` text form, so meta/llama-guard-4-12b is a drop-in.
const DEFAULT_MODEL = 'nvidia/llama-3.1-nemoguard-8b-content-safety';

// Per-call abort budget. Probe median is ~340 ms with a ~680 ms tail; 2 s leaves
// generous headroom and still fails over fast when the lane stalls.
const DEFAULT_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 8000;

// The classifier only needs the text itself; cap the slice we send so a giant
// payload can't blow the latency budget.
const MAX_CLASSIFY_CHARS = 4000;

function clampTimeout(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, ms));
}

/**
 * Resolve the publish-safety config from the environment.
 *   enabled:   true iff a NIM key is present AND the kill-switch is not set.
 *   key:       NVIDIA_API_KEY (the free NIM lane), or null.
 *   model:     PUBLISH_SAFETY_MODEL override, else the NemoGuard default.
 *   timeoutMs: PUBLISH_SAFETY_TIMEOUT_MS override (clamped), else 2000.
 *
 * Kill switch: PUBLISH_SAFETY_DISABLED=true turns the classifier off without a
 * code change (mirrors the GUARDIAN_DISABLE convention). It is otherwise ON
 * whenever the free NIM key is configured.
 */
export function publishSafetyConfig(env = process.env) {
	const key = env.NVIDIA_API_KEY || null;
	const disabled = String(env.PUBLISH_SAFETY_DISABLED || '').toLowerCase() === 'true';
	return {
		enabled: !!key && !disabled,
		key,
		model: env.PUBLISH_SAFETY_MODEL?.trim() || DEFAULT_MODEL,
		timeoutMs: clampTimeout(parseInt(env.PUBLISH_SAFETY_TIMEOUT_MS || '', 10)),
	};
}

/** Whether the publish-time classifier is active for this deploy. */
export function publishSafetyEnabled(env = process.env) {
	return publishSafetyConfig(env).enabled;
}

/**
 * Parse a safety classifier's reply into { unsafe, categories }.
 * Accepts NemoGuard JSON ({"User Safety":"unsafe","Safety Categories":"…"}) and
 * the Llama-Guard text form ("unsafe\nS9" / "safe"). Anything unrecognized is
 * treated as SAFE (fail-open); we never block on a reply we can't read.
 */
export function parseVerdict(content) {
	const raw = String(content ?? '').trim();
	if (!raw) return { unsafe: false, categories: [], parsed: false };

	// NemoGuard: clean JSON object (sometimes with a trailing space).
	try {
		const j = JSON.parse(raw);
		const us = String(j['User Safety'] ?? j.user_safety ?? '').toLowerCase();
		const cats = splitCategories(j['Safety Categories'] ?? j.safety_categories);
		if (us === 'unsafe') return { unsafe: true, categories: cats, parsed: true };
		if (us === 'safe') return { unsafe: false, categories: [], parsed: true };
	} catch {
		// not JSON, so fall through to the text form
	}

	// Llama-Guard text form: first line "safe" | "unsafe", codes on line 2.
	const head = raw.toLowerCase();
	if (/^unsafe\b/.test(head)) {
		const codes = raw.split('\n').slice(1).join(' ').trim();
		return { unsafe: true, categories: codes ? [codes] : [], parsed: true };
	}
	if (/^safe\b/.test(head)) return { unsafe: false, categories: [], parsed: true };

	return { unsafe: false, categories: [], parsed: false };
}

function splitCategories(value) {
	return String(value ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Classify one piece of outbound text before we publish it. ALWAYS fail-open.
 *
 * @returns {Promise<{
 *   checked: boolean,        // did a verdict actually come back?
 *   flagged: boolean,        // true ONLY on a parsed "unsafe" verdict
 *   categories?: string[],   // named risk categories when flagged
 *   model?: string,
 *   latencyMs?: number,
 *   error?: string,          // reason we failed open, when applicable
 * }>}
 */
export async function classifyPublishSafety(text, opts = {}) {
	const cfg = opts.config || publishSafetyConfig();
	if (!cfg.enabled || !cfg.key) return { checked: false, flagged: false };

	const content = String(text ?? '').trim();
	if (!content) return { checked: false, flagged: false };

	const started = Date.now();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
	try {
		const res = await fetch(NIM_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${cfg.key}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: cfg.model,
				messages: [{ role: 'user', content: content.slice(0, MAX_CLASSIFY_CHARS) }],
				max_tokens: 64,
				temperature: 0,
			}),
			signal: ctrl.signal,
		});
		const latencyMs = Date.now() - started;
		if (!res.ok) {
			// Non-200 (auth/billing/rate-limit/5xx) → fail open.
			return { checked: false, flagged: false, error: `publish-safety ${res.status}`, latencyMs };
		}
		const data = await res.json();
		const verdict = parseVerdict(data?.choices?.[0]?.message?.content);
		return {
			checked: verdict.parsed,
			flagged: verdict.unsafe,
			categories: verdict.categories,
			model: cfg.model,
			latencyMs,
		};
	} catch (err) {
		// Timeout (AbortError), network failure, JSON error: all fail open.
		return {
			checked: false,
			flagged: false,
			error: err?.name === 'AbortError' ? 'timeout' : err?.message || 'error',
			latencyMs: Date.now() - started,
		};
	} finally {
		clearTimeout(timer);
	}
}
