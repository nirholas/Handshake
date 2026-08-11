// @three-ws/pose: a phrase in, a deterministic seed + the full Euler
// joint-rotation map for a rigged 3D avatar out.
//
// The zero-config path computes the pose LOCALLY: the pose_model algorithm is
// pure deterministic computation (token scoring + sha256) over the preset
// library this package bundles, so `poseSeed('wave hello')` needs no network,
// no key, and no payment, and returns the same result as the hosted tool.
//
// The hosted lane on the Streamable-HTTP MCP server at POST /api/mcp-3d stays
// available as an opt-in: pass `baseUrl`, `apiKey`, or `fetch` to createPose()
// and calls go over the wire as standard JSON-RPC `tools/call` requests.
// Keyless wire calls are x402-priced per call; OAuth principals (apiKey) run
// operator-funded. See README.md for the full reference.

import { createHttp, ThreeWsError } from './http.js';
import { resolvePoseLocal, resolvePresetLocal } from './local.js';
import { PRESETS, PRESET_GROUPS, getPresetById } from './pose-presets.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';
export { PRESETS, PRESET_GROUPS } from './pose-presets.js';

const MCP_PATH = '/api/mcp-3d';
const TOOL_NAME = 'pose_model';
const PREVIEW_BASE = 'https://three.ws/pose';
const MAX_PROMPT = 500;

// The MCP server speaks Streamable HTTP: it may answer a tools/call with a
// JSON body or a single SSE frame, so we accept both content types.
const MCP_ACCEPT = 'application/json, text/event-stream';

/** Typed error for every @three-ws/pose failure. Mirrors ThreeWsError. */
export class PoseError extends ThreeWsError {
	constructor(message, opts = {}) {
		super(message, opts);
		this.name = 'PoseError';
	}
}

/**
 * Create a Pose client. With no transport options this resolves poses locally
 * (no network, no key, no payment). Passing `baseUrl`, `apiKey`, or `fetch`
 * switches the client to the hosted pose_model tool on /api/mcp-3d: use that
 * to reuse configuration (a payment-aware fetch for the x402 lane, an OAuth
 * key for operator-funded calls, a custom origin) across many calls.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]   API origin (default https://three.ws). Selects the hosted lane.
 * @param {typeof fetch} [options.fetch]  fetch implementation. Selects the hosted lane.
 * @param {string} [options.apiKey]    OAuth bearer, runs hosted calls operator-funded. Selects the hosted lane.
 * @param {string} [options.previewBase]  base URL for the returned previewUrl (local or hosted).
 * @param {Record<string,string>} [options.headers]
 */
export function createPose(options = {}) {
	const remote = Boolean(options.baseUrl || options.apiKey || options.fetch);
	const request = remote ? createHttp(options) : null;
	const previewBase = stripTrailingSlash(options.previewBase || PREVIEW_BASE);

	let nextId = 1;

	/**
	 * Resolve a natural-language pose description to a deterministic seed and the
	 * full joint-rotation map. `prompt` is a string, 1–500 characters.
	 */
	async function poseSeed(prompt, opts = {}) {
		const text = typeof prompt === 'string' ? prompt : '';
		if (text.length < 1 || text.length > MAX_PROMPT) {
			throw new PoseError(
				`poseSeed() needs a prompt of 1–${MAX_PROMPT} characters.`,
				{ code: 'invalid_prompt' },
			);
		}
		return remote ? callPoseModel(text, opts) : resolveLocally(text, opts);
	}

	/**
	 * Skip selection and resolve a specific preset by id. Seeds with the preset
	 * id as the prompt, so the same preset always returns the same seed.
	 */
	async function presetPose(presetId, opts = {}) {
		if (!presetId || typeof presetId !== 'string' || !getPresetById(presetId)) {
			const known = PRESETS.map((p) => p.id).join(', ');
			throw new PoseError(
				`Unknown preset "${presetId}". Known presets: ${known}.`,
				{ code: 'invalid_prompt' },
			);
		}
		if (remote) return callPoseModel(presetId, opts);
		throwIfAborted(opts);
		return shape(await resolvePresetLocal(presetId), previewBase);
	}

	// The zero-config lane: run the pose_model algorithm in-process over the
	// bundled preset library, then normalize through the same shape() step the
	// wire response goes through, so both lanes return identical PoseResults.
	async function resolveLocally(prompt, opts) {
		throwIfAborted(opts);
		return shape(await resolvePoseLocal(prompt), previewBase);
	}

	// One JSON-RPC tools/call to pose_model, shaped into a PoseResult.
	async function callPoseModel(prompt, opts) {
		const envelope = {
			jsonrpc: '2.0',
			id: nextId++,
			method: 'tools/call',
			params: { name: TOOL_NAME, arguments: { prompt } },
		};

		const payload = await request(MCP_PATH, {
			method: 'POST',
			headers: { accept: MCP_ACCEPT, ...(opts.headers || {}) },
			body: envelope,
			signal: opts.signal,
		});

		// JSON-RPC envelope: a tool error rides in `error`; a tool result that
		// itself failed rides in `result.isError`.
		if (payload?.error) {
			throw new PoseError(payload.error.message || 'The pose tool returned an error.', {
				code: 'tool_error',
				detail: payload.error.data ?? null,
				body: payload,
			});
		}
		const result = payload?.result;
		if (result?.isError) {
			const msg = result.content?.find((c) => c.type === 'text')?.text || 'The pose tool returned an error.';
			throw new PoseError(msg, { code: 'tool_error', body: payload });
		}
		const sc = result?.structuredContent;
		if (!sc || typeof sc !== 'object') {
			throw new PoseError('Unexpected empty response from the pose tool.', {
				code: 'tool_error',
				body: payload,
			});
		}
		return shape(sc, previewBase);
	}

	return { poseSeed, presetPose, listPresetGroups };
}

// A module-level default client for the zero-config path: `import { poseSeed }`.
let shared = null;
function defaultClient() {
	return (shared ||= createPose());
}

/** Resolve a phrase to a deterministic seed + full joint-rotation map. */
export function poseSeed(prompt, opts) {
	return defaultClient().poseSeed(prompt, opts);
}
/** Resolve a specific preset by id (skips prompt selection). */
export function presetPose(presetId, opts) {
	return defaultClient().presetPose(presetId, opts);
}

/**
 * The four pose groups, returned synchronously for menu scaffolding:
 * ['Standing', 'Action', 'Sitting & Floor', 'Expressive']. From the real
 * in-repo preset library — no network call.
 */
export function listPresetGroups() {
	return [...PRESET_GROUPS];
}

// Normalize the tool's snake_case structuredContent into the camelCase
// PoseResult, rebasing the preview URL onto the configured previewBase and
// keeping a `.raw` escape hatch.
function shape(sc, previewBase) {
	const presetId = sc.preset_id ?? null;
	const seed = sc.seed ?? null;
	const previewUrl =
		presetId && seed
			? `${previewBase}?seed=${encodeURIComponent(seed)}&preset=${encodeURIComponent(presetId)}`
			: (sc.preview_url ?? null);
	return {
		seed,
		presetId,
		presetLabel: sc.preset_label ?? null,
		group: sc.group ?? null,
		parameters: sc.parameters ?? {},
		previewUrl,
		match: sc.match ?? null,
		groups: Array.isArray(sc.groups) ? sc.groups : [...PRESET_GROUPS],
		raw: sc,
	};
}

function stripTrailingSlash(s) {
	return String(s).replace(/\/+$/, '');
}

function throwIfAborted(opts) {
	if (opts?.signal?.aborted) {
		const e = new Error('The operation was aborted.');
		e.name = 'AbortError';
		throw e;
	}
}
