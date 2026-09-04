// forge-frames.js — pure logic for the Live Avatar Forge.
//
// Shared by THREE callers so the staged narration and the final-frame sidecar
// never drift between them:
//   • src/agent-screen.js   — the in-browser forge driver (the viewer watches)
//   • workers/agent-forge/   — the headless broadcast worker
//   • tests/forge-frame.test.js
//
// Zero DOM, zero env, zero network: every export is a pure function of its
// input. The real generation (POST/poll /api/forge on the free NVIDIA NIM
// TRELLIS lane) and the real GLB load/animation live in the callers; this file
// only turns a generation state into a holder-readable line and packs/unpacks
// the GLB url that rides along with the final frame.

// The free TRELLIS lane conditions on ~77 characters; a longer prompt is
// silently truncated by the model, so we trim with intent and tell the user.
export const TRELLIS_PROMPT_LIMIT = 77;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Normalize a raw prompt for the free lane. Returns the cleaned prompt, whether
// it was trimmed to the conditioning window, and the original length so the UI
// can show "trimmed to fit". Trimming happens on a word boundary when possible
// so we never cut a word in half mid-token.
export function clampPrompt(raw) {
	const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
	if (text.length <= TRELLIS_PROMPT_LIMIT) {
		return { prompt: text, trimmed: false, originalLength: text.length };
	}
	let cut = text.slice(0, TRELLIS_PROMPT_LIMIT);
	const lastSpace = cut.lastIndexOf(' ');
	// Only snap to the word boundary if it doesn't throw away too much (>60% kept).
	if (lastSpace > TRELLIS_PROMPT_LIMIT * 0.6) cut = cut.slice(0, lastSpace);
	return { prompt: cut.trim(), trimmed: true, originalLength: text.length };
}

// Is a prompt acceptable to submit? The free lane needs ≥3 characters of actual
// subject. Returns { ok } or { ok:false, reason } with a holder-readable reason.
export function validatePrompt(raw) {
	const text = String(raw == null ? '' : raw).trim();
	if (text.length < 3) {
		return { ok: false, reason: 'Describe a concrete object — at least a few characters.' };
	}
	return { ok: true };
}

// Backend id → the lane name a person recognizes, so a narration can name the
// engine that actually ran instead of guessing one. Mirrors ENGINE_LABELS in
// src/forge.js; it lives here because this module is the one every non-/forge
// surface shares (agent-screen, ar-studio, workers/agent-forge). An unknown or
// absent id returns null, and callers fall back to a lane-agnostic line.
const LANE_LABELS = {
	nvidia: 'free NVIDIA NIM',
	huggingface: 'free Hunyuan3D',
	trellis: 'Fast',
	trellis_selfhost: 'TRELLIS',
	meshy: 'Meshy',
	tripo: 'Tripo',
	rodin: 'Rodin',
	stability: 'Stability',
	replicate_byok: 'Replicate',
	hunyuan3d: 'Hunyuan3D',
	triposg: 'TripoSG',
};

export function laneLabel(backendId) {
	const id = String(backendId == null ? '' : backendId).trim();
	return LANE_LABELS[id] || null;
}

// Map a real /api/forge job/poll state to a single holder-readable narration
// line. The states come straight from the pipeline — no fabricated steps:
//   submitting           → before the job is accepted
//   queued               → accepted, waiting for a free GPU slot
//   running / reconstruct → the mesh is being built (TRELLIS reconstruct)
//   done                 → GLB ready
//   failed               → generation failed
// `mode` ('image' before the mesh stage) and `eta_seconds` refine the line when
// the pipeline reports them. Unknown states fall back to a neutral "working".
//
// Two optional numbers make a wait measurable instead of merely named, and both
// come off the poll payload (/api/forge returns `elapsed_seconds` and
// `eta_remaining_seconds` on every non-terminal poll): `elapsed_seconds` is how
// long the job has really been alive, `eta_remaining_seconds` is the lane's
// typical total minus that. Neither is ever synthesized here from a local clock,
// so a page reopened mid-generation reports the job's age, not the tab's.
export function forgeStageNarration(state = {}) {
	const status = String(state.status || state.stage || '').toLowerCase();
	const num = (v) => (Number(v) > 0 ? Math.round(Number(v)) : null);
	const eta = num(state.eta_seconds);
	const elapsed = Number(state.elapsed_seconds) >= 0 ? Math.round(Number(state.elapsed_seconds)) : null;
	// Prefer the live remaining estimate: repeating the lane's static total on
	// every frame is what made a poll loop read as "stuck at ~60s" for a minute.
	const remaining = num(state.eta_remaining_seconds) ?? eta;
	const etaSuffix = remaining ? ` (~${remaining}s left)` : '';
	// The lane that actually ran, when the caller knows it. Older callers pass no
	// `backend`, so every line degrades to a lane-agnostic phrasing rather than
	// naming the wrong engine.
	const lane = laneLabel(state.backend);
	const laneSuffix = lane ? ` on the ${lane} lane` : ' on the free lane';
	// A scale-to-zero GPU worker booting is a real, nameable wait, not a stall.
	// `cold_seconds` is the lane's spin-up budget from the API, never a timer we
	// invent; without it we still name the state but promise no number.
	const cold = Boolean(state.cold_start);
	const coldSeconds = num(state.cold_seconds);
	const coldWho = lane ? ` ${lane}` : '';
	// Elapsed is only worth showing once it means something; under 5s it just
	// flickers. A boot past its budget says so instead of counting into negatives.
	const elapsedSuffix = elapsed != null && elapsed >= 5 ? ` (${elapsed}s in)` : '';

	switch (status) {
		case 'submitting':
		case 'submit':
			return `Forging${laneSuffix}…`;
		case 'queued':
		case 'queue':
			if (cold) {
				if (!coldSeconds) return `Waking up the${coldWho} GPU worker, then sculpting starts`;
				const bootLeft = elapsed != null ? coldSeconds - elapsed : null;
				if (bootLeft != null && bootLeft <= 0) {
					return `Still waking the${coldWho} GPU worker${elapsedSuffix}. The job is accepted and starts the moment it answers`;
				}
				return bootLeft != null
					? `Waking up the${coldWho} GPU worker${elapsedSuffix}, about ${bootLeft}s of boot left, then sculpting starts`
					: `Waking up the${coldWho} GPU worker (about ${coldSeconds}s), then sculpting starts`;
			}
			return `Queued${laneSuffix}${elapsedSuffix}${etaSuffix}`;
		case 'image':
		case 'texturing':
			return 'Drafting the look…';
		case 'running':
		case 'reconstruct':
		case 'mesh':
			return `Building geometry & texturing${elapsedSuffix}${etaSuffix}`;
		case 'done':
		case 'ready':
			return 'Model ready — loading into the cam';
		case 'failed':
		case 'error':
			return 'Forge failed — try a more concrete prompt';
		default:
			return `Forging${etaSuffix}`;
	}
}

// A forge progress frame for screenPush — the live narration other viewers see.
// `type: 'analysis'` matches the activity-log "analysis" lane. The optional
// `meta` rides in the frame sidecar (used only on the final frame).
export function buildForgeFrame({ activity, type = 'analysis', meta = null }) {
	const frame = { activity: String(activity || ''), type };
	if (meta && typeof meta === 'object') frame.meta = meta;
	return frame;
}

// The final forge frame: narration + a sidecar carrying the durable GLB url and
// the three.ws viewer link so every connected viewer can load and animate the
// freshly-forged avatar. `kind:'forge'` tags it for parseForgeFrame().
export function finalForgeFrame({ prompt, glbUrl, viewerUrl, tier = null, backend = null, durable = null }) {
	const meta = {
		kind: 'forge',
		glbUrl: String(glbUrl || ''),
		viewerUrl: String(viewerUrl || ''),
		prompt: String(prompt || ''),
	};
	if (tier) meta.tier = String(tier);
	if (backend) meta.backend = String(backend);
	if (durable != null) meta.durable = Boolean(durable);
	const shortPrompt = meta.prompt.length > 60 ? `${meta.prompt.slice(0, 57)}…` : meta.prompt;
	return buildForgeFrame({
		activity: `Forged "${shortPrompt}" — rigging & animating`,
		type: 'analysis',
		meta,
	});
}

// Pull the forge sidecar out of an incoming SSE frame, or null if the frame
// isn't a forge-completion frame. Validates the GLB url is an http(s) link so a
// viewer never tries to load a junk value. Used by the viewer (agent-screen.js)
// to know when to swap the Avatar Cam to the new model, and by the live wall
// (agents-live.js) to show "forged: <prompt>".
export function parseForgeFrame(frame) {
	const meta = frame && typeof frame === 'object' ? frame.meta : null;
	if (!meta || meta.kind !== 'forge') return null;
	const glbUrl = typeof meta.glbUrl === 'string' ? meta.glbUrl.trim() : '';
	if (!/^https?:\/\//i.test(glbUrl)) return null;
	const viewerUrl = typeof meta.viewerUrl === 'string' && /^https?:\/\//i.test(meta.viewerUrl.trim())
		? meta.viewerUrl.trim()
		: '';
	return {
		glbUrl,
		viewerUrl,
		prompt: typeof meta.prompt === 'string' ? meta.prompt : '',
		tier: typeof meta.tier === 'string' ? meta.tier : null,
		backend: typeof meta.backend === 'string' ? meta.backend : null,
		durable: typeof meta.durable === 'boolean' ? meta.durable : null,
	};
}

// Build the three.ws viewer link for a GLB url, given a site origin. Mirrors the
// `${base}/viewer?src=…` link the forge tools return.
export function viewerLinkFor(glbUrl, origin = 'https://three.ws') {
	const base = String(origin || 'https://three.ws').replace(/\/$/, '');
	return `${base}/viewer?src=${encodeURIComponent(String(glbUrl || ''))}`;
}

// A bounded, sanitized sidecar for the push API to persist. Caps every string so
// a frame record can't be inflated past the store's size budget, and drops any
// field that isn't part of the forge contract. Returns null for non-forge meta.
export function sanitizeFrameMeta(meta, { maxLen = 2048 } = {}) {
	if (!meta || typeof meta !== 'object') return null;
	if (meta.kind === 'a2a_hire') return sanitizeHireMeta(meta);
	if (meta.kind !== 'forge') return null;
	const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
	const out = {
		kind: 'forge',
		glbUrl: str(meta.glbUrl, maxLen),
		viewerUrl: str(meta.viewerUrl, maxLen),
		prompt: str(meta.prompt, 320),
	};
	if (typeof meta.tier === 'string') out.tier = meta.tier.slice(0, 32);
	if (typeof meta.backend === 'string') out.backend = meta.backend.slice(0, 64);
	if (typeof meta.durable === 'boolean') out.durable = meta.durable;
	// A forge sidecar is only meaningful with an http(s) GLB url.
	if (!/^https?:\/\//i.test(out.glbUrl)) return null;
	return out;
}

// Bounded sanitizer for the live agent-to-agent hire visualizer sidecar. Mirrors
// the shape api/_lib/a2a-hire-phases.js#hirePhaseFrame emits: a phase tag plus the
// quote/cap/signature payload the receipt + coin-transfer UI render. Strings are
// capped; explorer urls are http(s)-gated so a push can't smuggle a junk link to
// the viewer; numbers are coerced finite-or-null.
function sanitizeHireMeta(meta) {
	const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
	const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	const httpUrl = (v) => {
		const s = str(v, 512);
		return s && /^https?:\/\//i.test(s) ? s : null;
	};
	const cap = meta.cap && typeof meta.cap === 'object'
		? {
			perCallCap: num(meta.cap.perCallCap),
			dailyUsd: num(meta.cap.dailyUsd),
			dailyRemaining: num(meta.cap.dailyRemaining),
			overCap: typeof meta.cap.overCap === 'boolean' ? meta.cap.overCap : undefined,
		}
		: null;
	return {
		kind: 'a2a_hire',
		phase: str(meta.phase, 32),
		phaseIndex: num(meta.phaseIndex),
		ok: typeof meta.ok === 'boolean' ? meta.ok : true,
		hireId: str(meta.hireId, 64),
		slug: str(meta.slug, 120),
		skill: str(meta.skill, 120),
		providerName: str(meta.providerName, 120),
		providerId: str(meta.providerId, 64),
		hirerId: str(meta.hirerId, 64),
		hirerName: str(meta.hirerName, 120),
		usd: num(meta.usd),
		maxUsd: num(meta.maxUsd),
		cap,
		network: str(meta.network, 16) || 'mainnet',
		txSig: str(meta.txSig, 128),
		paymentExplorer: httpUrl(meta.paymentExplorer),
		invocationSig: str(meta.invocationSig, 128),
		invocationExplorer: httpUrl(meta.invocationExplorer),
		resultSummary: str(meta.resultSummary, 280),
		error: str(meta.error, 280),
	};
}

export { clamp as _clamp };
