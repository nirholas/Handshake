// three.ws 3D Studio MCP — generation tools.
//
// text_to_3d / image_to_3d submit a reconstruction job and return a job handle.
//   Both accept a quality tier (draft/standard/high), a generation path ("image"
//   reference-image reconstruction, the platform-keyed default, or "geometry"
//   native text/image→mesh, BYOK), and a three.ws-branded `engine` selector
//   (see the ENGINES map). generation_status polls any job — it is engine-aware,
//   decoding the forge job token to route geometry jobs.
// auto_rig_model adds a skeleton + skin weights to a static mesh (rerig).
// preview_3d renders any GLB inline. remove_background strips image backgrounds.
// remesh_model converts, simplifies, and repairs meshes.
// stylize_model applies one-click geometric filters (voxel/brick/voronoi/lowpoly).
// retexture_model paints a new texture onto a mesh from a text prompt.
// retexture_region (magic brush) repaints only a masked UV region, preserving the rest.
// pose_model maps a prompt to a deterministic pose-studio seed + joint rotations.
// direct_prompt (IBM Granite) rewrites a rough idea into an optimized 3D spec.
// generate_material (IBM Granite) emits a glTF PBR material from a description.

import { createHash } from 'node:crypto';
import { limits } from '../../_lib/rate-limit.js';
import { assertSafePublicUrl, fetchSafePublicUrlPinned, MaxBytesExceededError } from '../../_lib/ssrf-guard.js';
import { createRegenProvider as createReplicateProvider } from '../../_providers/replicate.js';
import { createRegenProvider as createGcpProvider } from '../../_providers/gcp.js';
import { BYOK_PROVIDER_FACTORIES, isByokGeometryBackend } from '../../_providers/byok-registry.js';
import { textToImage } from '../text-to-image.js';
import {
	PATHS,
	DEFAULT_PATH,
	TIER_IDS,
	DEFAULT_TIER,
	BACKENDS,
	resolveTier,
	resolveBackendId,
	estimateEtaSeconds,
	estimateCredits,
	isSelfHostBackend,
	coldStartSecondsFor,
} from '../../_lib/forge-tiers.js';
import { laneHealthSnapshot } from '../../_lib/forge-lane-health.js';
import { resolveProviderKey } from '../../_lib/forge-provider-key.js';
import { encodeJobToken, decodeJobToken } from '../../_lib/forge-job-token.js';
import { watsonxConfig, watsonxChatComplete } from '../../_lib/watsonx.js';
import { createAvatar, storageKeyFor } from '../../_lib/avatars.js';
import { putObject } from '../../_lib/r2.js';
import { isValidGlbHeader, inspectGlb } from '../../_lib/glb-inspect.js';
import { buildSpatialArtifact } from '../../_lib/spatial-mcp.js';
import { env } from '../../_lib/env.js';
import {
	createPersona,
	getPersona,
	touchPersona,
	personaPublicView,
	isPersonaId,
} from '../../_lib/persona-store.js';
import { expressionForText, expressionFor } from '../../../src/embodiment/emotion.js';
import { embodimentArtifact } from '../../_lib/embodiment-artifact.js';
import { PRESETS, PRESET_GROUPS } from '../../../src/pose-presets.js';
import {
	renderModelViewerHtml,
	safeCssValue,
	safeCssLength,
	safeHttpsUrl,
} from '../../_mcp/render.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

function rateKey(auth) {
	return auth.userId || auth.rateKey || 'anon';
}

// MCP tool annotations (2025-06-18 spec). destructiveHint defaults to TRUE
// when omitted, so every tool sets all four hints explicitly. The generation
// and mesh-op tools create new assets/jobs (never overwrite the source), so
// they are non-read-only, non-destructive, and non-idempotent.
const GENERATIVE_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

async function enforce(limiter, auth) {
	const rl = await limiter(rateKey(auth));
	if (!rl.success) {
		throw rpcError(-32000, 'rate_limited', {
			retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
		});
	}
}

// Resolve the best available provider for a given mode.
// GCP takes priority when the service URL is configured for that mode;
// falls back to Replicate for the standard reconstruct/remesh/retex/rerig modes.
function regenProvider(mode = 'reconstruct') {
	const gcpKey = process.env?.GCP_RECONSTRUCTION_KEY;
	if (gcpKey) {
		try {
			const gcp = createGcpProvider();
			if (gcp.supportsMode(mode)) return gcp;
		} catch {
			// fall through to Replicate
		}
	}
	try {
		return createReplicateProvider();
	} catch (err) {
		throw rpcError(-32000, '3D generation is not configured', { reason: err.message });
	}
}

// Region (magic-brush) edits MUST run on the GCP texture worker — the Replicate
// path has no masked-inpaint model, so we never silently fall back to it and
// drop the mask. Require GCP explicitly and fail with a clear message otherwise.
function regionProvider() {
	if (process.env?.GCP_RECONSTRUCTION_KEY) {
		try {
			const gcp = createGcpProvider();
			if (gcp.supportsMode('retex_region')) return gcp;
		} catch {
			// fall through to the explicit error below
		}
	}
	throw rpcError(
		-32000,
		'Region retexture requires the GCP texture worker (set GCP_RECONSTRUCTION_KEY and GCP_TEXTURE_URL).',
	);
}

// Validate via the shared DNS-resolving SSRF guard: https-only, the hostname is
// resolved and every A/AAAA record is checked against the full private/loopback/
// link-local/ULA/IPv4-mapped/metadata blocklist (covering 172.16/12, [::1],
// fc00::/7, fe80::/10, ::ffff: and decimal/hex IP encodings the old ad-hoc
// prefix checks missed). Async because it performs DNS resolution.
async function isPublicHttpsUrl(s) {
	try {
		await assertSafePublicUrl(String(s), { allowHttp: false });
		return true;
	} catch {
		return false;
	}
}

const POLL_HINT =
	'Call generation_status with this job_id to check progress. ' +
	'Reconstruction typically finishes in 30–90 seconds.';

// An MCP tool call is one-shot text, not a pollable UI — so the honesty bar
// (CLAUDE.md: no fabricated progress) means baking the REAL eta_seconds this
// job was submitted with into the poll instruction, not a generic static
// range. Falls back to `fallback` (a category-appropriate static estimate)
// only when the caller genuinely has no eta signal for this lane.
function pollHint(etaSeconds, fallback) {
	const eta = Number(etaSeconds) > 0 ? Math.round(Number(etaSeconds)) : null;
	if (eta == null) return `Call generation_status with this job_id to check progress. ${fallback}`;
	return `Call generation_status with this job_id to check progress — usually ~${eta}s.`;
}

// Ceiling on a GLB copied into durable storage by save_avatar. Matches the
// reconstruct + forge pipelines so a runaway model can't ingest an unbounded blob.
const MAX_GLB_BYTES = 64 * 1024 * 1024;

// How long save_avatar will wait for one GLB download. A model URL that accepts
// the connection and then stalls used to hold the MCP call open for the whole
// invocation and return nothing; bounded, it fails with an answer the caller can
// act on.
const GLB_FETCH_TIMEOUT_MS = 30_000;

// Fetch a caller-supplied GLB into a Buffer, so save_avatar can persist its own
// durable copy before the provider's delivery URL expires. Routed through the
// pinned SSRF guard rather than a bare fetch for three reasons: the hostname is
// re-resolved and IP-pinned, closing the DNS-rebinding window that the
// isPublicHttpsUrl() check at the call site leaves open; the size ceiling is
// enforced WHILE streaming, so an oversized or lying host is torn down instead
// of buffered; and redirects are re-validated hop by hop. The declared-length
// and post-read checks stay as defense in depth.
async function fetchGlbBuffer(url) {
	let resp;
	try {
		resp = await fetchSafePublicUrlPinned(
			url,
			{ signal: AbortSignal.timeout(GLB_FETCH_TIMEOUT_MS) },
			{ allowHttp: false, maxBytes: MAX_GLB_BYTES },
		);
	} catch (err) {
		if (err instanceof MaxBytesExceededError) {
			throw rpcError(-32000, `GLB too large to save (max ${MAX_GLB_BYTES} bytes).`);
		}
		const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'unreachable';
		throw rpcError(-32000, `Could not fetch the GLB (${reason}).`);
	}
	if (!resp.ok) throw rpcError(-32000, `Could not fetch the GLB (${resp.status}).`);
	const declared = Number(resp.headers.get('content-length') || 0);
	if (declared && declared > MAX_GLB_BYTES) {
		throw rpcError(-32000, `GLB too large to save (${declared} bytes; max ${MAX_GLB_BYTES}).`);
	}
	const buf = Buffer.from(await resp.arrayBuffer());
	if (buf.length > MAX_GLB_BYTES) {
		throw rpcError(
			-32000,
			`GLB too large to save (${buf.length} bytes; max ${MAX_GLB_BYTES}).`,
		);
	}
	return buf;
}

function viewerArtifact({ glbUrl, name, options = {} }) {
	const html = renderModelViewerHtml({
		src: glbUrl,
		name: name || '3D model',
		poster: safeHttpsUrl(options.poster),
		background: safeCssValue(options.background, 'transparent'),
		height: safeCssLength(options.height, '480px'),
		width: safeCssLength(options.width, '100%'),
		autoRotate: options.auto_rotate !== false,
		ar: options.ar !== false,
		cameraOrbit: safeCssValue(options.camera_orbit, ''),
	});
	return {
		type: 'resource',
		resource: { uri: glbUrl, mimeType: 'text/html', text: html },
	};
}

// Inline artifact for a captured point cloud (.ply). model-viewer can't render a
// raw point cloud, so we embed the three.ws WebGL point-cloud viewer (/capture in
// chrome-less embed mode) pointed at the .ply via its ?src= deep link.
function pointCloudArtifact({ plyUrl, name }) {
	const viewer = `${env.APP_ORIGIN}/capture?embed=1&src=${encodeURIComponent(plyUrl)}`;
	const safeName = String(name || 'Captured 3D scene').replace(/[&<>"]/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
	const html =
		`<!doctype html><html><head><meta charset="utf-8"><title>${safeName}</title>` +
		`<style>html,body{margin:0;height:100%;background:#0a0a0a}iframe{border:0;width:100%;height:100%;display:block}</style>` +
		`</head><body><iframe src="${viewer}" sandbox="allow-scripts allow-same-origin" allow="fullscreen" title="${safeName}"></iframe></body></html>`;
	return {
		type: 'resource',
		resource: { uri: plyUrl, mimeType: 'text/html', text: html },
	};
}

// The inline "living body" artifact (buildEmbedUrl + embodimentArtifact) is shared
// with the free studio in api/_lib/embodiment-artifact.js so both front doors drive
// the SAME hosted embed page.

// Annotations for the persona lifecycle tools. create mints a new body (write,
// non-destructive). get is a pure read. say is a render directive that also bumps
// the persona's turn counter — a write, never destructive.
const PERSONA_CREATE_ANNOTATIONS = {
	readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
};
const PERSONA_READ_ANNOTATIONS = {
	readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
};
const PERSONA_SAY_ANNOTATIONS = {
	readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
};

// ── Quality tier + generation path/engine (shared by text_to_3d/image_to_3d) ──
// Mirrors the /api/forge axes: `path` ("image" vs "geometry"), `tier`
// (draft/standard/high poly budget), and `backend` — exposed as the white-labeled
// three.ws `engine` vocabulary (ENGINES, above) rather than vendor ids. The
// default — path "image", engine "auto" — keeps the existing fast platform-keyed
// reconstruction untouched.
function parsePathArg(args) {
	const p = typeof args?.path === 'string' ? args.path.trim() : '';
	return PATHS.includes(p) ? p : DEFAULT_PATH;
}
function parseTierArg(args) {
	const t = typeof args?.tier === 'string' ? args.tier.trim() : '';
	return TIER_IDS.includes(t) ? t : DEFAULT_TIER;
}

const TIER_PROP = {
	type: 'string',
	enum: TIER_IDS,
	default: DEFAULT_TIER,
	description:
		'Quality tier: draft (~12k poly, fast), standard (~30k, balanced), high (~200k + PBR, slower). Honoured by the poly-aware engines (the geometry, sculpt, and detail engines); the default image engine records it as provenance.',
};
const PATH_PROP = {
	type: 'string',
	enum: PATHS,
	default: DEFAULT_PATH,
	description:
		'Generation path: "image" (reference-image reconstruction on the platform-keyed image engine, the default) or "geometry" (native text/image→mesh on a geometry engine — cleaner topology, but bring-your-own-key: needs your own provider key).',
};
const MCP_UNSELECTABLE_BACKENDS = new Set([
	// replicate_byok runs on the platform reconstruction path with the caller's
	// own Replicate account; that BYOK-token routing only exists on /api/forge, so
	// it isn't offered over MCP.
	'replicate_byok',
	// huggingface is the free Spaces image→3D lane, but it is wired ONLY on
	// /api/forge (runHfImageLane). The MCP studio path reconstructs via Replicate/GCP
	// (regenProvider), so selecting it here would silently run a DIFFERENT, paid
	// engine. Hide it until the free Spaces lane is wired into the MCP path rather
	// than advertise a free engine that doesn't run here. Free text→3D over MCP is
	// the separate forge_free tool, which targets the NVIDIA lane via /api/forge.
	'huggingface',
]);

// ── White-labeled engine taxonomy ────────────────────────────────────────────
// The MCP wire speaks only in three.ws-branded engine names; the underlying
// generation vendors never surface in a tool schema, response, or artifact. Each
// public engine maps to one internal forge backend. Legacy vendor ids are still
// ACCEPTED on input as hidden back-compat aliases (resolveEngineArg), but only
// the branded names are advertised. The default is "auto" — the platform picks
// the best engine for the chosen path and tier.
const ENGINES = Object.freeze({
	'three-image': Object.freeze({ internal: 'trellis', label: 'three.ws Image engine' }),
	'three-geometry': Object.freeze({ internal: 'meshy', label: 'three.ws Geometry engine' }),
	'three-geometry-pro': Object.freeze({ internal: 'tripo', label: 'three.ws Geometry Pro engine' }),
	'three-sculpt': Object.freeze({ internal: 'rodin', label: 'three.ws Sculpt engine' }),
	'three-detail': Object.freeze({ internal: 'hunyuan3d', label: 'three.ws Detail engine' }),
	'three-instant': Object.freeze({ internal: 'stability', label: 'three.ws Instant engine' }),
	'three-sketch': Object.freeze({ internal: 'triposg', label: 'three.ws Sketch engine' }),
});
// Internal backend id → branded engine id, for shaping responses. Every platform
// image lane (the hosted, self-hosted, and free reconstruction backends) presents
// as the single "three.ws Image engine" — the caller never learns which one ran.
const INTERNAL_TO_ENGINE = Object.freeze({
	trellis: 'three-image',
	nvidia: 'three-image',
	trellis_selfhost: 'three-image',
	huggingface: 'three-image',
	replicate_byok: 'three-image',
	meshy: 'three-geometry',
	tripo: 'three-geometry-pro',
	rodin: 'three-sculpt',
	hunyuan3d: 'three-detail',
	stability: 'three-instant',
	triposg: 'three-sketch',
});
function engineIdFor(internalId) {
	return INTERNAL_TO_ENGINE[internalId] || 'three-image';
}
function engineLabelFor(internalId) {
	return ENGINES[engineIdFor(internalId)]?.label || 'three.ws engine';
}
// Map a caller's engine argument to an internal backend id. Accepts a branded
// engine id (preferred), "auto"/empty (→ undefined, the platform picks), or a
// legacy vendor id (hidden back-compat, excluding the never-selectable lanes).
// Anything unrecognised falls through to undefined so resolveBackendId applies
// the platform default — forgiving at the boundary, never a hard 422.
function resolveEngineArg(args) {
	const raw = typeof args?.backend === 'string' ? args.backend.trim() : '';
	if (!raw || raw === 'auto') return undefined;
	if (ENGINES[raw]) return ENGINES[raw].internal;
	if (BACKENDS[raw] && !MCP_UNSELECTABLE_BACKENDS.has(raw)) return raw;
	return undefined;
}
const BACKEND_PROP = {
	// Intentionally no `enum`: branded names are the advertised vocabulary (below),
	// but legacy vendor ids are still accepted silently for back-compat, which a
	// strict enum would reject. resolveEngineArg validates and normalizes instead.
	type: 'string',
	default: 'auto',
	description:
		'three.ws generation engine. "auto" (default) lets the platform pick the best engine for the chosen path and tier. Override with: three-image (image-reconstruction), three-geometry or three-geometry-pro (native text/image→mesh, clean quad topology), three-sculpt (high-poly detail), three-instant (fast single-image), three-sketch (sketch→mesh). An engine that does not serve the chosen path is ignored.',
};

// "needs a BYOK key" — a designed, branchable result (mirrors /api/forge's
// needs_key state), not an error: the geometry providers have no platform key,
// so a caller without one is told exactly how to enable the path.
// Honest cold-start signal for a self-hosted lane, mirroring api/forge.js: true
// only when the shared liveness probe reached the worker but it answered slowly
// (a scale-to-zero container spinning up). Without this an MCP caller is handed a
// warm ETA while the GPU is still booting, which reads as a stalled job.
async function coldStartFor(backendId) {
	if (!isSelfHostBackend(backendId) || !coldStartSecondsFor(backendId)) return false;
	try {
		const snap = await laneHealthSnapshot([backendId]);
		const rec = snap.byId[backendId];
		return Boolean(rec && rec.status === 'ok' && rec.warm === false);
	} catch {
		return false;
	}
}

function needsKeyResult(backendId) {
	const meta = BACKENDS[backendId];
	// The bring-your-own-key path is the one place a credential provider name must
	// be disclosed — the caller has to know which key to supply. The engine itself
	// is still presented under its three.ws brand.
	const provider = meta?.byok || backendId;
	return {
		content: [
			{
				type: 'text',
				text:
					`The ${engineLabelFor(backendId)} runs on a bring-your-own-key provider. ` +
					`Send your ${provider} key as the "x-forge-provider-key" request header (or store a ${provider} key on your three.ws account) and retry, ` +
					'or use the default image path (omit "path", or set path="image").',
			},
		],
		structuredContent: {
			status: 'needs_key',
			engine: engineIdFor(backendId),
			provider,
		},
		isError: true,
	};
}

// Submit a native geometry-first job (Meshy/Tripo, BYOK) and shape the MCP
// response. Returns a needs_key result when no key is available. The job handle
// is a forge token so generation_status routes the poll back to this provider.
async function submitGeometryJob({
	req,
	args,
	backendId,
	isImageMode,
	prompt,
	primaryImage,
	tier,
	path,
}) {
	const providerName = BACKENDS[backendId].byok; // 'meshy' | 'tripo' | 'rodin' | 'stability'
	const key = await resolveProviderKey(req, args, providerName);
	if (!key) return needsKeyResult(backendId);

	let gp;
	try {
		gp = BYOK_PROVIDER_FACTORIES[providerName](key);
	} catch {
		return needsKeyResult(backendId);
	}

	let submitted;
	if (isImageMode) {
		submitted = await gp.imageTo3d({ imageUrl: primaryImage, prompt: prompt || undefined, tier });
	} else if (typeof gp.textToGeometry === 'function') {
		submitted = await gp.textToGeometry({ prompt, tier });
	} else {
		// Image-only engine asked to run text→3D.
		return {
			content: [
				{
					type: 'text',
					text: `The ${engineLabelFor(backendId)} reconstructs from a reference image — use image_to_3d with this engine, or drop it to run text→3D.`,
				},
			],
			structuredContent: {
				status: 'failed',
				error: 'engine_image_only',
				engine: engineIdFor(backendId),
			},
			isError: true,
		};
	}

	// Synchronous completion (the instant single-image engine): the GLB is already
	// persisted to R2, so there is no job to poll — return it done.
	if (!submitted.taskId && submitted.resultGlbUrl) {
		return {
			content: [
				{
					type: 'text',
					text: `Generated a 3D model on the ${engineLabelFor(backendId)} (${path} path, ${tier.id} tier).\nGLB: ${submitted.resultGlbUrl}`,
				},
			],
			structuredContent: {
				status: 'done',
				glb_url: submitted.resultGlbUrl,
				mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
				path,
				tier: tier.id,
				engine: engineIdFor(backendId),
				prompt: prompt || null,
				source_image_url: isImageMode ? primaryImage : null,
			},
		};
	}

	const token = encodeJobToken({
		provider: providerName,
		kind: submitted.kind,
		taskId: submitted.taskId,
	});
	const cold = await coldStartFor(backendId);
	const etaSeconds = estimateEtaSeconds({ backendId, tier, cold });

	return {
		content: [
			{
				type: 'text',
				text:
					`Started ${isImageMode ? 'image-to-3D' : 'text-to-3D'} on the ${engineLabelFor(backendId)} ` +
					`(${path} path, ${tier.id} tier).\nJob ID: ${token}\n` +
					(cold
						? `That worker scales to zero, so it is booting now (about ${coldStartSecondsFor(backendId)}s). The job is accepted and starts the moment it answers.\n`
						: '') +
					pollHint(etaSeconds, 'Reconstruction typically finishes in 30–90 seconds.'),
			},
		],
		structuredContent: {
			job_id: token,
			status: 'queued',
			mode: isImageMode ? 'image_to_3d' : 'text_to_3d',
			path,
			tier: tier.id,
			engine: engineIdFor(backendId),
			prompt: prompt || null,
			source_image_url: isImageMode ? primaryImage : null,
			cold_start: cold,
			cold_start_seconds: cold ? coldStartSecondsFor(backendId) : undefined,
			eta_seconds: etaSeconds,
			estimated_credits: estimateCredits({ backendId, path, tier }),
		},
	};
}

// Poll whichever upstream owns a job. A bare id (legacy / image-TRELLIS path)
// polls Replicate. A forge token (f1.*) decodes to the geometry provider
// (Meshy/Tripo, BYOK re-resolved per poll) or the self-hosted GCP backend.
async function pollAnyProvider(req, jobId) {
	const token = decodeJobToken(jobId);
	if (token) {
		if (BYOK_PROVIDER_FACTORIES[token.provider]) {
			const key = await resolveProviderKey(req, null, token.provider);
			if (!key) {
				return {
					status: 'failed',
					error: 'Your provider API key is required to check this job. Send it as the x-forge-provider-key header and retry.',
				};
			}
			const gp = BYOK_PROVIDER_FACTORIES[token.provider](key);
			return gp.status({ kind: token.kind, taskId: token.taskId });
		}
		if (token.provider === 'gcp') {
			let gcp;
			try {
				gcp = createGcpProvider();
			} catch {
				return {
					status: 'failed',
					error: 'The self-hosted reconstruction backend is not configured.',
				};
			}
			return gcp.status(token.taskId);
		}
		return regenProvider().status(token.taskId);
	}
	return regenProvider().status(jobId);
}

// ── pose_model: deterministic preset selection (ported from the pose-seed tool) ─
function poseTokensOf(str) {
	return String(str || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.filter(Boolean);
}
const POSE_INDEX = PRESETS.map((preset) => {
	const idTokens = poseTokensOf(preset.id);
	const labelTokens = poseTokensOf(preset.label);
	const groupTokens = poseTokensOf(preset.group);
	return {
		preset,
		all: new Set([...idTokens, ...labelTokens, ...groupTokens]),
		idTokens,
		labelTokens,
	};
});
function scorePosePreset(promptTokens, entry) {
	let score = 0;
	for (const t of promptTokens) {
		if (entry.all.has(t)) score += 3;
		else {
			for (const tok of [...entry.idTokens, ...entry.labelTokens]) {
				if (tok.includes(t) || t.includes(tok)) {
					score += 1;
					break;
				}
			}
		}
	}
	return score;
}
function pickPosePreset(prompt) {
	const tokens = poseTokensOf(prompt);
	const deterministic = () => {
		const hash = createHash('sha256').update(String(prompt)).digest();
		return {
			entry: POSE_INDEX[hash.readUInt32BE(0) % POSE_INDEX.length],
			score: 0,
			reason: 'no-match-deterministic-pick',
		};
	};
	if (tokens.length === 0) return deterministic();
	let best = null;
	let bestScore = -1;
	for (const entry of POSE_INDEX) {
		const sc = scorePosePreset(tokens, entry);
		if (sc > bestScore) {
			best = entry;
			bestScore = sc;
		}
	}
	if (bestScore <= 0) return deterministic();
	return { entry: best, score: bestScore, reason: 'token-match' };
}
const POSE_PREVIEW_BASE = process.env.MCP_POSE_PREVIEW_BASE || 'https://three.ws/pose';

// ── IBM Granite (watsonx.ai) config guard for direct_prompt / generate_material ─
function graniteConfigOrThrow() {
	const cfg = watsonxConfig();
	if (!cfg.configured) {
		throw rpcError(
			-32000,
			'IBM watsonx.ai is not configured on this server (set WATSONX_API_KEY and WATSONX_PROJECT_ID).',
		);
	}
	return cfg;
}
function stripJsonFence(text) {
	const raw = String(text || '').trim();
	return raw.startsWith('```') ? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : raw;
}

export const toolDefs = [
	{
		name: 'text_to_3d',
		title: 'Generate a 3D model from a text prompt',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Turn a text description into a textured 3D model (GLB). Runs a fast text-to-image pass, then reconstructs a mesh from that image with the three.ws image engine. Returns a job_id (poll with generation_status) plus the intermediate preview image. Best results: a single, clearly described object — "a worn leather armchair", "a low-poly red fox", "a sci-fi helmet".',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					minLength: 3,
					maxLength: 1000,
					description: 'What to generate. Describe one subject clearly.',
				},
				aspect_ratio: {
					type: 'string',
					enum: ['1:1', '4:3', '3:4', '16:9', '9:16'],
					default: '1:1',
					description:
						'Aspect ratio of the intermediate reference image (image path only).',
				},
				tier: TIER_PROP,
				path: PATH_PROP,
				backend: BACKEND_PROP,
			},
			required: ['prompt'],
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			await enforce(limits.mcp3dGenerate, auth);
			const path = parsePathArg(args);
			const tier = resolveTier(parseTierArg(args));
			const backendId = resolveBackendId({ path, backend: resolveEngineArg(args) });

			// BYOK geometry-style engines (the geometry/sculpt/instant engines) — native text→mesh.
			// Routed by registry membership, not just path, so an explicitly chosen
			// BYOK backend is honoured even if its default path is "image".
			if (isByokGeometryBackend(BACKENDS[backendId])) {
				return submitGeometryJob({
					req,
					args,
					backendId,
					isImageMode: false,
					prompt: args.prompt,
					primaryImage: null,
					tier,
					path,
				});
			}

			// Image path (default): synthesize a reference image, then reconstruct.
			const provider = regenProvider();
			const { imageUrl, model } = await textToImage(args.prompt, {
				aspectRatio: args.aspect_ratio || '1:1',
			});
			// Only poly-aware backends accept a budget; TRELLIS would 422 on an
			// unknown field, so the tier rides along as provenance only there.
			const params = { image: imageUrl, prompt: args.prompt };
			if (BACKENDS[backendId].polyControl) {
				params.target_polycount = tier.polycount;
				params.tier = tier.id;
			}
			const job = await provider.submit({ mode: 'reconstruct', params });
			return {
				content: [
					{
						type: 'text',
						text:
							`Started generating a 3D model for "${args.prompt}" (${tier.id} tier).\n` +
							`Reference image: ${imageUrl}\n` +
							`Job ID: ${job.extJobId}\n` +
							pollHint(job.eta, 'Reconstruction typically finishes in 30–90 seconds.'),
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					prompt: args.prompt,
					path,
					tier: tier.id,
					engine: engineIdFor(backendId),
					preview_image_url: imageUrl,
					text_to_image_model: model,
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'image_to_3d',
		title: 'Reconstruct a 3D model from one or more images',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Reconstruct a textured 3D model (GLB) from a reference image using the three.ws image engine. Pass a single image_url, or image_urls (2–4 views of the SAME object from different angles — front/back/left/right) for multi-view reconstruction, which removes the back-of-object hallucination of single-image reconstruction. Returns a job_id to poll with generation_status, plus how many views were fused and which engine handled it. The cleaner the inputs — one subject, plain background, even lighting — the better the mesh.',
		inputSchema: {
			type: 'object',
			properties: {
				image_url: {
					type: 'string',
					format: 'uri',
					description:
						'Public https URL of the reference image (PNG/JPG/WebP). Use image_urls for multi-view.',
				},
				image_urls: {
					type: 'array',
					items: { type: 'string', format: 'uri' },
					minItems: 1,
					maxItems: 4,
					description:
						'1–4 public https URLs of the same object from different angles. Takes precedence over image_url; >1 enables multi-view reconstruction.',
				},
				prompt: {
					type: 'string',
					maxLength: 1000,
					description: 'Optional text hint passed to the reconstruction model.',
				},
				tier: TIER_PROP,
				path: PATH_PROP,
				backend: BACKEND_PROP,
			},
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			await enforce(limits.mcp3dGenerate, auth);

			// Merge the multi-view array form with the single image_url, de-duped
			// and order-preserving. image_urls wins when both are present.
			const rawViews = Array.isArray(args.image_urls)
				? args.image_urls
				: typeof args.image_url === 'string'
					? [args.image_url]
					: [];
			const seen = new Set();
			const views = [];
			for (const v of rawViews) {
				if (typeof v !== 'string') continue;
				const t = v.trim();
				if (!t || seen.has(t)) continue;
				seen.add(t);
				views.push(t);
			}
			if (views.length === 0) {
				return {
					content: [
						{ type: 'text', text: 'Error: provide image_url or image_urls (1–4).' },
					],
					isError: true,
				};
			}
			if (views.length > 4) {
				return {
					content: [{ type: 'text', text: 'Error: provide between 1 and 4 images.' }],
					isError: true,
				};
			}
			for (const v of views) {
				if (!(await isPublicHttpsUrl(v))) {
					return {
						content: [
							{
								type: 'text',
								text: 'Error: every image URL must be a public https URL.',
							},
						],
						isError: true,
					};
				}
			}

			const path = parsePathArg(args);
			const tier = resolveTier(parseTierArg(args));
			const backendId = resolveBackendId({ path, backend: resolveEngineArg(args) });

			// BYOK geometry-style engines (the geometry/sculpt/instant engines)
			// reconstruct from the primary view; multi-view fusion stays on the
			// platform image engine below. Routed by registry membership, not just path.
			if (isByokGeometryBackend(BACKENDS[backendId])) {
				return submitGeometryJob({
					req,
					args,
					backendId,
					isImageMode: true,
					prompt: args.prompt,
					primaryImage: views[0],
					tier,
					path,
				});
			}

			const provider = regenProvider();
			const reconstructParams = { images: views, prompt: args.prompt };
			if (BACKENDS[backendId].polyControl) {
				reconstructParams.target_polycount = tier.polycount;
				reconstructParams.tier = tier.id;
			}
			const job = await provider.submit({
				mode: 'reconstruct',
				sourceUrl: views[0],
				params: reconstructParams,
			});
			const viewsUsed = typeof job.viewsUsed === 'number' ? job.viewsUsed : views.length;
			const multiview = Boolean(job.multiview);
			const summary =
				views.length > 1
					? `Started multi-view reconstruction from ${views.length} views (${viewsUsed} fused${multiview ? '' : ', single-view fallback'}).`
					: 'Started reconstructing a 3D model from the image.';
			return {
				content: [
					{
						type: 'text',
						text:
							`${summary}\nJob ID: ${job.extJobId}\n` +
							pollHint(job.eta, 'Reconstruction typically finishes in 30–90 seconds.'),
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_image_url: views[0],
					source_image_urls: views,
					views_requested: views.length,
					views_used: viewsUsed,
					multiview,
					path,
					tier: tier.id,
					engine: engineIdFor(job.backend ?? backendId),
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'generation_status',
		title: 'Check a 3D generation job',
		// Status poll — pure read; the job state changes between calls.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Poll a text_to_3d or image_to_3d job by its job_id. While running it reports the status; when finished it returns the GLB download URL and an inline <model-viewer> artifact — display that text/html resource as an interactive 3D artifact.',
		inputSchema: {
			type: 'object',
			properties: {
				job_id: {
					type: 'string',
					minLength: 1,
					maxLength: 200,
					description: 'The job_id returned by text_to_3d or image_to_3d.',
				},
			},
			required: ['job_id'],
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			await enforce(limits.mcp3dStatus, auth);
			const result = await pollAnyProvider(req, args.job_id);

			if (result.status === 'done' && result.resultGlbUrl) {
				const glbUrl = result.resultGlbUrl;
				// A segmentation job carries a parts manifest — surface the named,
				// addressable parts (and where to inspect them) alongside the GLB.
				if (Array.isArray(result.parts) && result.parts.length) {
					const partLines = result.parts
						.map((p) => `  • ${p.id} — ${p.name} (${p.face_count} faces, ${p.color})`)
						.join('\n');
					return {
						content: [
							{
								type: 'text',
								text:
									`Segmented into ${result.partCount || result.parts.length} parts.\n` +
									`Segmented GLB (each part is a named node): ${glbUrl}\n` +
									(result.manifestUrl
										? `Parts manifest: ${result.manifestUrl}\n`
										: '') +
									`Parts:\n${partLines}\n` +
									'Display the attached text/html resource as an inline 3D artifact.',
							},
							viewerArtifact({ glbUrl, name: 'Segmented 3D model' }),
						],
						structuredContent: {
							job_id: args.job_id,
							status: 'done',
							glb_url: glbUrl,
							manifest_url: result.manifestUrl || null,
							part_count: result.partCount || result.parts.length,
							parts: result.parts,
							source_faces: result.sourceFaces ?? null,
							method: result.segmentMethod || null,
						},
					};
				}
				return {
					content: [
						{
							type: 'text',
							text:
								`Your 3D model is ready.\nGLB: ${glbUrl}\n` +
								'Display the attached text/html resource as an inline 3D artifact.',
						},
						viewerArtifact({ glbUrl, name: '3D model' }),
					],
					structuredContent: { job_id: args.job_id, status: 'done', glb_url: glbUrl },
				};
			}

			// Scene-capture jobs (capture_scene) finish as a .ply point cloud, not a
			// GLB mesh — return the cloud URL + an inline point-cloud viewer artifact.
			if (result.status === 'done' && result.resultPointCloudUrl) {
				const plyUrl = result.resultPointCloudUrl;
				const pts = result.numPoints ? `${result.numPoints.toLocaleString('en-US')} points` : 'point cloud';
				const frames = result.frames ? ` from ${result.frames} frames` : '';
				return {
					content: [
						{
							type: 'text',
							text:
								`Your 3D scene is ready — ${pts}${frames}.\nPoint cloud (.ply): ${plyUrl}\n` +
								`Explore it: ${env.APP_ORIGIN}/capture?src=${encodeURIComponent(plyUrl)}\n` +
								'Display the attached text/html resource as an inline 3D point-cloud viewer.',
						},
						pointCloudArtifact({ plyUrl, name: 'Captured 3D scene' }),
					],
					structuredContent: {
						job_id: args.job_id,
						status: 'done',
						point_cloud_url: plyUrl,
						num_points: result.numPoints ?? null,
						frames: result.frames ?? null,
						viewer_url: `${env.APP_ORIGIN}/capture?src=${encodeURIComponent(plyUrl)}`,
					},
				};
			}

			if (result.status === 'failed') {
				return {
					content: [
						{
							type: 'text',
							text: `Generation failed: ${result.error || 'unknown error'}`,
						},
					],
					structuredContent: {
						job_id: args.job_id,
						status: 'failed',
						error: result.error || null,
					},
					isError: true,
				};
			}

			return {
				content: [
					{
						type: 'text',
						text: `Still ${result.status}. ${POLL_HINT}`,
					},
				],
				structuredContent: { job_id: args.job_id, status: result.status },
			};
		},
	},
	{
		name: 'capture_scene',
		title: 'Reconstruct a 3D scene from a video',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Turn a video of a real space (a room, a street, an object walkaround) into an explorable 3D ' +
			'point cloud. A feed-forward streaming reconstructor (LingBot-Map) grounds coordinates, reads ' +
			'dense geometry, and corrects drift across the whole clip, then returns a coloured .ply point ' +
			'cloud. Pass a public https video URL (mp4/mov/webm). Returns a job_id — poll generation_status; ' +
			'when finished it returns the point-cloud URL and an inline viewer artifact. Best with steady, ' +
			'well-lit footage that orbits or walks through the space. This is geometry capture of a REAL ' +
			'scene — distinct from text_to_3d/image_to_3d, which synthesize a single object mesh.',
		inputSchema: {
			type: 'object',
			properties: {
				video_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the source video (mp4, mov, or webm).',
				},
				mode: {
					type: 'string',
					enum: ['streaming', 'windowed'],
					default: 'streaming',
					description: 'streaming = default; windowed = for very long clips (>3000 frames).',
				},
				fps: {
					type: 'integer',
					minimum: 1,
					maximum: 30,
					default: 8,
					description: 'Frames per second to sample from the video.',
				},
				keyframe_interval: {
					type: 'integer',
					minimum: 1,
					maximum: 64,
					default: 4,
					description: 'Cache every N-th frame as a keyframe — lower is denser/slower.',
				},
				mask_sky: {
					type: 'boolean',
					default: true,
					description: 'Drop sky points from the reconstruction.',
				},
				max_points: {
					type: 'integer',
					minimum: 50000,
					maximum: 3000000,
					default: 1500000,
					description: 'Cap on the total points in the output cloud.',
				},
			},
			required: ['video_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.video_url))) {
				return {
					content: [{ type: 'text', text: 'Error: video_url must be a public https URL.' }],
					isError: true,
				};
			}
			let provider;
			try {
				provider = regenProvider('video2scene');
			} catch {
				provider = null;
			}
			if (!provider || !provider.supportsMode('video2scene')) {
				return {
					content: [{
						type: 'text',
						text: 'Scene capture is not configured on this server (set GCP_VIDEO2SCENE_URL and GCP_RECONSTRUCTION_KEY).',
					}],
					isError: true,
				};
			}
			const params = {
				mode: args.mode === 'windowed' ? 'windowed' : 'streaming',
				fps: args.fps || 8,
				keyframe_interval: args.keyframe_interval || 4,
				mask_sky: args.mask_sky !== false,
				max_points: args.max_points || 1_500_000,
			};
			const job = await provider.submit({ mode: 'video2scene', sourceUrl: args.video_url, params });
			return {
				content: [{
					type: 'text',
					text:
						`Started reconstructing a 3D scene from the video (${params.mode}).\n` +
						`Job ID: ${job.extJobId}\n` +
						pollHint(job.eta, 'Reconstruction typically takes a few minutes for a longer clip.'),
				}],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_video_url: args.video_url,
					mode: params.mode,
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'preview_3d',
		title: 'Preview any GLB as an interactive 3D artifact',
		// Builds viewer HTML in-memory — deterministic for the same arguments.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		description:
			'Render any public GLB URL as an inline <model-viewer> HTML artifact — orbit controls, AR on mobile, auto-rotate. Display the returned text/html resource as an inline 3D artifact. Use it to view a generated model, or any GLB on the web.',
		inputSchema: {
			type: 'object',
			properties: {
				glb_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of a .glb file.',
				},
				auto_rotate: { type: 'boolean', default: true },
				ar: { type: 'boolean', default: true },
				background: {
					type: 'string',
					default: 'transparent',
					description: 'CSS background color or gradient.',
				},
				height: { type: 'string', default: '480px' },
				width: { type: 'string', default: '100%' },
				camera_orbit: {
					type: 'string',
					description: 'model-viewer camera-orbit value, e.g. "0deg 80deg 2m".',
				},
			},
			required: ['glb_url'],
			additionalProperties: false,
		},
		async handler(args) {
			if (!(await isPublicHttpsUrl(args.glb_url))) {
				return {
					content: [{ type: 'text', text: 'Error: glb_url must be a public https URL.' }],
					isError: true,
				};
			}
			return {
				content: [
					{
						type: 'text',
						text: 'Display the attached text/html resource as an inline 3D artifact.',
					},
					viewerArtifact({ glbUrl: args.glb_url, name: '3D model', options: args }),
				],
				structuredContent: {
					glb_url: args.glb_url,
					// Conformant Spatial MCP artifact (specs/SPATIAL_MCP.md) so any
					// Spatial-MCP renderer can display this model, not just ours.
					spatial: buildSpatialArtifact({
						glbUrl: args.glb_url,
						kind: 'model',
						autoRotate: args.auto_rotate !== false,
						cameraOrbit: typeof args.camera_orbit === 'string' ? args.camera_orbit : undefined,
						viewerUrl: `https://three.ws/viewer?src=${encodeURIComponent(args.glb_url)}`,
					}),
				},
			};
		},
	},
	{
		name: 'remove_background',
		title: 'Remove the background from an image',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Strip the background from a photo or illustration with the three.ws background-removal engine. Returns a PNG with a transparent background — useful for preparing clean inputs before image_to_3d reconstruction.',
		inputSchema: {
			type: 'object',
			properties: {
				image_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the source image (PNG/JPG/WebP).',
				},
				model: {
					type: 'string',
					enum: ['rmbg2', 'u2net', 'isnet', 'u2net_human_seg', 'silueta'],
					default: 'rmbg2',
					description:
						'Background removal model. rmbg2 is highest quality; u2net_human_seg is optimised for people.',
				},
			},
			required: ['image_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.image_url))) {
				return {
					content: [
						{ type: 'text', text: 'Error: image_url must be a public https URL.' },
					],
					isError: true,
				};
			}
			const provider = regenProvider('rembg');
			const job = await provider.submit({
				mode: 'rembg',
				sourceUrl: args.image_url,
				params: { model: args.model || 'rmbg2' },
			});
			return {
				content: [
					{
						type: 'text',
						text:
							`Background removal started.\nJob ID: ${job.extJobId}\n` +
							pollHint(job.eta, 'Typically completes in 3–10 seconds.'),
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_image_url: args.image_url,
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'remesh_model',
		title: 'Remesh, simplify, repair, or convert a 3D model',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Process an existing GLB/OBJ/STL/PLY mesh: fix holes and degenerate geometry, reduce face count via quadric decimation, or convert to a different format (including FBX with skeleton for Unity/Unreal — a convert of a rigged GLB keeps its bones, skin weights, and blendshapes). Returns a clean GLB (or the requested format) job_id to poll with generation_status.',
		inputSchema: {
			type: 'object',
			properties: {
				mesh_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the source mesh (GLB/OBJ/FBX/STL/PLY).',
				},
				operation: {
					type: 'string',
					enum: ['full', 'simplify', 'repair', 'convert'],
					default: 'full',
					description:
						'full = repair + simplify; simplify = face reduction only; repair = hole-fill + normal fix; convert = format change only.',
				},
				target_faces: {
					type: 'integer',
					minimum: 1000,
					maximum: 500000,
					default: 50000,
					description: 'Target polygon count for simplification.',
				},
				output_format: {
					type: 'string',
					enum: ['glb', 'obj', 'stl', 'ply', 'usdz', '3mf', 'fbx'],
					default: 'glb',
					description:
						"Target format. fbx + operation=convert preserves a rigged GLB's skeleton, skin weights, and blendshapes (for Unity/Unreal); other operations produce a static fbx.",
				},
			},
			required: ['mesh_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.mesh_url))) {
				return {
					content: [
						{ type: 'text', text: 'Error: mesh_url must be a public https URL.' },
					],
					isError: true,
				};
			}
			const provider = regenProvider('remesh');
			const job = await provider.submit({
				mode: 'remesh',
				sourceUrl: args.mesh_url,
				params: {
					operation: args.operation || 'full',
					target_faces: args.target_faces || 50_000,
					output_format: args.output_format || 'glb',
				},
			});
			return {
				content: [
					{
						type: 'text',
						text:
							`Mesh processing started (${args.operation || 'full'}).\nJob ID: ${job.extJobId}\n` +
							pollHint(job.eta, 'Typically completes in 10–60 seconds.'),
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_mesh_url: args.mesh_url,
					operation: args.operation || 'full',
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'stylize_model',
		title: 'Apply a one-click geometric stylization filter to a 3D model',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Transform any GLB/OBJ/STL/PLY mesh into a stylized variant with a single geometry pass — ' +
			'no model inference, fast and cheap. Styles: "voxel" (blocky cubes on a grid), "brick" ' +
			'(voxels + studs, LEGO-like), "voronoi" (open strut-and-node lattice shell), "lowpoly" ' +
			'(decimated + hard flat-shaded facets). Source color is preserved where the style allows. ' +
			'Returns a job_id to poll with generation_status; typically completes in 10–40 seconds.',
		inputSchema: {
			type: 'object',
			properties: {
				mesh_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the source mesh (GLB/OBJ/FBX/STL/PLY).',
				},
				style: {
					type: 'string',
					enum: ['voxel', 'brick', 'voronoi', 'lowpoly'],
					default: 'voxel',
					description:
						'voxel = blocky cubes; brick = voxels + studs (LEGO-like); voronoi = open lattice shell; lowpoly = faceted flat-shaded.',
				},
				resolution: {
					type: 'integer',
					minimum: 8,
					maximum: 120,
					description:
						'Style-specific density (clamped per style): voxel/brick = grid resolution, voronoi = cell density, lowpoly = detail level. Omit for a sensible per-style default.',
				},
				output_format: {
					type: 'string',
					enum: ['glb', 'obj', 'stl', 'ply'],
					default: 'glb',
				},
			},
			required: ['mesh_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.mesh_url))) {
				return {
					content: [
						{ type: 'text', text: 'Error: mesh_url must be a public https URL.' },
					],
					isError: true,
				};
			}
			const provider = regenProvider('stylize');
			const style = args.style || 'voxel';
			const job = await provider.submit({
				mode: 'stylize',
				sourceUrl: args.mesh_url,
				params: {
					style,
					resolution: Number.isInteger(args.resolution) ? args.resolution : null,
					output_format: args.output_format || 'glb',
				},
			});
			return {
				content: [
					{
						type: 'text',
						text:
							`Stylization started (${style}).\nJob ID: ${job.extJobId}\n` +
							pollHint(job.eta, 'Typically completes in 10–40 seconds.'),
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_mesh_url: args.mesh_url,
					style,
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'segment_model',
		title: 'Split a 3D model into named, separable parts',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Segment a GLB/OBJ/STL/PLY mesh into meaningful parts with clean boundaries — head/torso/limbs on a character, body/wheels on a vehicle. Splits at physically disconnected shells and at concave creases (the minima rule), then names each part by region and tints it a distinct colour. Returns a GLB whose nodes ARE the parts (so each can be hidden, recoloured, replaced, or exported on its own) plus a parts manifest. Poll with generation_status; the result lists every part with its id, name, face count, and colour. Pass only_part to export a single part on its own.',
		inputSchema: {
			type: 'object',
			properties: {
				mesh_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the source mesh (GLB/OBJ/FBX/STL/PLY).',
				},
				method: {
					type: 'string',
					enum: ['auto', 'connected', 'crease'],
					default: 'auto',
					description:
						'auto = disconnected shells + concave-crease splitting inside each shell (best); connected = split only at disconnected shells; crease = minima-rule crease splitting over the whole mesh.',
				},
				max_parts: {
					type: 'integer',
					minimum: 2,
					maximum: 64,
					default: 24,
					description:
						'Upper bound on parts. Smaller fragments are merged into neighbours until the count fits.',
				},
				min_part_faces: {
					type: 'integer',
					minimum: 4,
					maximum: 100000,
					default: 64,
					description:
						'Parts smaller than this many faces are merged into their largest neighbour.',
				},
				crease_angle: {
					type: 'number',
					minimum: 5,
					maximum: 170,
					default: 40,
					description:
						'Dihedral angle (degrees) above which a concave edge is treated as a part boundary. Lower = more parts.',
				},
				only_part: {
					type: 'string',
					maxLength: 64,
					description:
						'Optional: export just this part by id ("part_03") or name ("upper-left"). Run once without it to discover part ids.',
				},
			},
			required: ['mesh_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.mesh_url))) {
				return {
					content: [
						{ type: 'text', text: 'Error: mesh_url must be a public https URL.' },
					],
					isError: true,
				};
			}
			const provider = regenProvider('segment');
			const job = await provider.submit({
				mode: 'segment',
				sourceUrl: args.mesh_url,
				params: {
					method: args.method || 'auto',
					max_parts: args.max_parts || 24,
					min_part_faces: args.min_part_faces || 64,
					crease_angle: args.crease_angle ?? 40,
					only_part: args.only_part,
				},
			});
			return {
				content: [
					{
						type: 'text',
						text:
							`Segmentation started (${args.method || 'auto'}).\nJob ID: ${job.extJobId}\n` +
							`${pollHint(job.eta, 'Typically completes in 10–60 seconds.')} When done it lists every named part.`,
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_mesh_url: args.mesh_url,
					method: args.method || 'auto',
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'retexture_model',
		title: 'Paint a new texture onto a 3D model from a text prompt',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Generate a fresh texture for an untextured or poorly-textured GLB with the three.ws depth-guided multi-view texturing engine. Renders the mesh from 8 viewpoints, generates coherent texture views guided by your prompt, and back-projects them onto the UV atlas. Returns a job_id to poll with generation_status.',
		inputSchema: {
			type: 'object',
			properties: {
				mesh_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the source GLB mesh.',
				},
				prompt: {
					type: 'string',
					minLength: 3,
					maxLength: 500,
					description:
						'Texture description, e.g. "worn leather armour, dark brown, scratched metal buckles".',
				},
				negative_prompt: {
					type: 'string',
					maxLength: 200,
					default: 'blurry, low quality, distorted, watermark',
				},
				num_views: {
					type: 'integer',
					enum: [4, 8],
					default: 8,
					description: '4 = faster; 8 = better coverage.',
				},
				texture_size: {
					type: 'integer',
					enum: [512, 1024, 2048],
					default: 1024,
				},
				material_class: {
					type: 'string',
					enum: ['person', 'metal', 'wood', 'fabric', 'plastic', 'glass'],
					description:
						'Optional. Bakes measured real-world roughness/metallic values for this material family instead of a flat guess, and nudges the prompt with material-appropriate descriptors (e.g. "metal" adds brushed-metal micro-detail cues).',
				},
			},
			required: ['mesh_url', 'prompt'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.mesh_url))) {
				return {
					content: [
						{ type: 'text', text: 'Error: mesh_url must be a public https URL.' },
					],
					isError: true,
				};
			}
			const provider = regenProvider('retex');
			const job = await provider.submit({
				mode: 'retex',
				sourceUrl: args.mesh_url,
				params: {
					prompt: args.prompt,
					negative_prompt: args.negative_prompt,
					num_views: args.num_views || 8,
					texture_size: args.texture_size || 1024,
					material_class: args.material_class || null,
				},
			});
			return {
				content: [
					{
						type: 'text',
						text:
							`Texture generation started for "${args.prompt}".\nJob ID: ${job.extJobId}\n` +
							pollHint(job.eta, 'Typically completes in 2–5 minutes.'),
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_mesh_url: args.mesh_url,
					prompt: args.prompt,
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'retexture_region',
		title: "Repaint one masked region of a model's texture (magic brush)",
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Surgically repaint ONLY a region of an existing texture from a prompt and/or colour, ' +
			'leaving the rest of the surface untouched and feathering the seam so the edit is invisible. ' +
			'Real UV-space texture inpainting — fix a seam, recolour one panel, add a logo to a chest plate. ' +
			"Supply mask_url: a UV-space mask PNG in the model's own UV layout where WHITE marks the area to " +
			'repaint and black is preserved. Safe to run repeatedly — chain passes by feeding the previous ' +
			'result GLB back in as mesh_url. Returns a job_id to poll with generation_status.',
		inputSchema: {
			type: 'object',
			properties: {
				mesh_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the textured GLB to edit.',
				},
				mask_url: {
					type: 'string',
					format: 'uri',
					description:
						'Public https URL of the UV-space mask PNG (white = repaint, black = keep), ' +
						'in the same UV layout as the mesh.',
				},
				prompt: {
					type: 'string',
					maxLength: 500,
					description:
						'What to paint into the masked region, e.g. "weathered copper plate".',
				},
				color: {
					type: 'string',
					pattern: '^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$',
					description: 'Optional target colour as a hex value, e.g. "#1e90ff".',
				},
				negative_prompt: {
					type: 'string',
					maxLength: 300,
					default: 'blurry, low quality, distorted, watermark, seam',
				},
				texture_size: {
					type: 'integer',
					enum: [512, 1024, 2048],
					default: 1024,
				},
				strength: {
					type: 'number',
					minimum: 0.2,
					maximum: 1,
					default: 0.85,
					description:
						'How aggressively to regenerate the region (higher = more change).',
				},
				feather: {
					type: 'integer',
					minimum: 1,
					maximum: 128,
					default: 24,
					description: 'Seam feather radius in atlas pixels — larger blends softer.',
				},
			},
			required: ['mesh_url', 'mask_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.mesh_url))) {
				return {
					content: [
						{ type: 'text', text: 'Error: mesh_url must be a public https URL.' },
					],
					isError: true,
				};
			}
			if (!(await isPublicHttpsUrl(args.mask_url))) {
				return {
					content: [
						{ type: 'text', text: 'Error: mask_url must be a public https URL.' },
					],
					isError: true,
				};
			}
			if (!args.prompt && !args.color) {
				return {
					content: [
						{
							type: 'text',
							text: 'Error: provide a prompt and/or a color for the region.',
						},
					],
					isError: true,
				};
			}
			const provider = regionProvider();
			const job = await provider.submit({
				mode: 'retex_region',
				sourceUrl: args.mesh_url,
				params: {
					prompt: args.prompt || '',
					negative_prompt: args.negative_prompt,
					mask: args.mask_url,
					color: args.color || null,
					texture_size: args.texture_size || 1024,
					strength: args.strength ?? 0.85,
					feather: args.feather ?? 24,
				},
			});
			return {
				content: [
					{
						type: 'text',
						text:
							`Region retexture started${args.prompt ? ` for "${args.prompt}"` : ''}.\n` +
							`Job ID: ${job.extJobId}\n` +
							`${pollHint(job.eta, 'Typically completes in 30–90 seconds.')} ` +
							'To stack edits, feed the resulting GLB back in as mesh_url.',
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_mesh_url: args.mesh_url,
					mask_url: args.mask_url,
					prompt: args.prompt || null,
					color: args.color || null,
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'auto_rig_model',
		title: 'Auto-rig a static 3D model (skeleton + skin weights)',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Turn a static GLB mesh into an animation-ready character: adds a humanoid skeleton and per-vertex skin weights via the three.ws rig pipeline. Pairs with text_to_3d / image_to_3d — generate a mesh, then rig it, then drive it with apply_animation or pose_model. Returns a job_id; poll generation_status for the rigged GLB.',
		inputSchema: {
			type: 'object',
			properties: {
				glb_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the static GLB mesh to rig.',
				},
			},
			required: ['glb_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.glb_url))) {
				return {
					content: [{ type: 'text', text: 'Error: glb_url must be a public https URL.' }],
					isError: true,
				};
			}
			const provider = regenProvider('rerig');
			if (!provider.supportsMode('rerig')) {
				return {
					content: [
						{
							type: 'text',
							text: 'Auto-rigging is not configured on this deployment.',
						},
					],
					isError: true,
				};
			}
			const job = await provider.submit({
				mode: 'rerig',
				sourceUrl: args.glb_url,
				params: {},
			});
			return {
				content: [
					{
						type: 'text',
						text:
							`Auto-rigging started.\nJob ID: ${job.extJobId}\n` +
							'Poll with generation_status — when done it returns a rigged, animation-ready GLB. Typically completes in 30–90 seconds.',
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_glb_url: args.glb_url,
					eta_seconds: typeof job.eta === 'number' ? job.eta : null,
				},
			};
		},
	},
	{
		name: 'pose_model',
		title: 'Resolve a text prompt to a pose-studio seed + joint rotations',
		// Pure local computation over the in-repo preset library — deterministic
		// ("the same prompt always yields the same pose"), no external calls,
		// nothing persisted.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		description:
			'Map a natural-language pose description to a deterministic pose-studio seed and the full Euler joint-rotation map for the three.ws humanoid mannequin, picked from the in-repo preset library. Returns the preset id, the complete pose (radians per joint), a stable seed, and a previewUrl on three.ws/pose. Deterministic: the same prompt always yields the same pose. Same engine as the free local @three-ws/pose npm package. Pair with auto_rig_model to pose a rigged character.',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					minLength: 1,
					maxLength: 500,
					description:
						'Pose description, e.g. "warrior stance", "wave hello", "sitting cross-legged".',
				},
			},
			required: ['prompt'],
			additionalProperties: false,
		},
		async handler(args) {
			const picked = pickPosePreset(args.prompt);
			const preset = picked.entry.preset;
			const seed = createHash('sha256')
				.update(`${args.prompt}|${preset.id}`)
				.digest('hex')
				.slice(0, 16);
			const previewUrl = `${POSE_PREVIEW_BASE}?seed=${encodeURIComponent(seed)}&preset=${encodeURIComponent(preset.id)}`;
			return {
				content: [
					{
						type: 'text',
						text: `Pose "${preset.label}" (${preset.group}) — seed ${seed}.\nPreview: ${previewUrl}`,
					},
				],
				structuredContent: {
					seed,
					preset_id: preset.id,
					preset_label: preset.label,
					group: preset.group,
					parameters: preset.pose,
					preview_url: previewUrl,
					match: { score: picked.score, reason: picked.reason },
					groups: PRESET_GROUPS,
				},
			};
		},
	},
	{
		name: 'direct_prompt',
		title: 'Optimize a rough idea into a 3D-generation prompt (IBM Granite)',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Rewrite a rough idea into an optimized text_to_3d prompt using IBM Granite. Returns one clean single-subject description plus structured directives (subject, style, materials, colors, detail) that produce cleaner meshes. Run before text_to_3d when a prompt is vague, conflicting, or multi-subject. Requires IBM watsonx.ai credentials on the server.',
		inputSchema: {
			type: 'object',
			properties: {
				idea: {
					type: 'string',
					minLength: 1,
					maxLength: 2000,
					description:
						'The rough idea or prompt to optimize, e.g. "some kind of cool dragon thing".',
				},
				style: {
					type: 'string',
					maxLength: 200,
					description:
						'Optional style hint, e.g. "low-poly", "realistic", "stylized PBR".',
				},
			},
			required: ['idea'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			const cfg = graniteConfigOrThrow();
			const system =
				'You are a 3D-generation prompt director. Given a rough idea, produce a prompt that yields a single, clearly-described object for image-to-3D reconstruction. Return ONLY valid JSON with keys: "prompt" (one concise sentence describing ONE subject), "subject", "style", "materials" (array), "colors" (array), "detail" (one of draft|standard|high), "notes". No markdown, no prose outside the JSON.';
			const user = args.style ? `${args.idea}\n\nPreferred style: ${args.style}` : args.idea;
			const result = await watsonxChatComplete(cfg, {
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				maxTokens: 700,
				temperature: 0.3,
			});
			let parsed = null;
			try {
				parsed = JSON.parse(stripJsonFence(result.text));
			} catch {
				// Granite didn't return clean JSON — surface the raw text below.
			}
			if (!parsed || typeof parsed.prompt !== 'string') {
				return {
					content: [{ type: 'text', text: result.text }],
					structuredContent: {
						ok: true,
						optimized_prompt: null,
						raw_response: result.text,
						model: result.model,
					},
				};
			}
			return {
				content: [{ type: 'text', text: `Optimized prompt: ${parsed.prompt}` }],
				structuredContent: {
					ok: true,
					optimized_prompt: parsed.prompt,
					spec: parsed,
					model: result.model,
					usage: result.usage,
				},
			};
		},
	},
	{
		name: 'generate_material',
		title: 'Generate a glTF PBR material from a description (IBM Granite)',
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Generate a physically-based (PBR) glTF 2.0 material from a text description using IBM Granite — base color, metallic, roughness, and emissive factors. Returns a pbrMetallicRoughness material object you can attach to a generated mesh. Requires IBM watsonx.ai credentials on the server.',
		inputSchema: {
			type: 'object',
			properties: {
				description: {
					type: 'string',
					minLength: 3,
					maxLength: 500,
					description:
						'Material to describe, e.g. "worn copper, scratched, slightly oxidized".',
				},
				name: {
					type: 'string',
					maxLength: 100,
					description: 'Optional material name.',
				},
			},
			required: ['description'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			const cfg = graniteConfigOrThrow();
			const system =
				'You are a 3D material author. Given a description, return ONLY a valid glTF 2.0 material JSON object with keys: "name", "pbrMetallicRoughness" { "baseColorFactor": [r,g,b,a] (0-1), "metallicFactor" (0-1), "roughnessFactor" (0-1) }, "emissiveFactor": [r,g,b] (0-1), "doubleSided" (bool), and a "_notes" string. No markdown, no prose outside the JSON.';
			const user = args.name
				? `Name: ${args.name}\nMaterial: ${args.description}`
				: args.description;
			const result = await watsonxChatComplete(cfg, {
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				maxTokens: 600,
				temperature: 0.2,
			});
			let material = null;
			try {
				material = JSON.parse(stripJsonFence(result.text));
			} catch {
				// Fall through to raw text when Granite returns non-JSON.
			}
			if (!material || typeof material !== 'object') {
				return {
					content: [{ type: 'text', text: result.text }],
					structuredContent: {
						ok: true,
						material: null,
						raw_response: result.text,
						model: result.model,
					},
				};
			}
			if (args.name && !material.name) material.name = args.name;
			return {
				content: [
					{
						type: 'text',
						text: `Generated glTF material${material.name ? ` "${material.name}"` : ''}.`,
					},
				],
				structuredContent: { ok: true, material, model: result.model, usage: result.usage },
			};
		},
	},
	{
		name: 'save_avatar',
		title: 'Save a generated GLB as a durable, named avatar',
		// Each call mints a fresh slug + storage object — additive, never
		// overwrites, so non-idempotent and non-destructive.
		annotations: GENERATIVE_ANNOTATIONS,
		description:
			'Persist a generated GLB (e.g. the glb_url returned by generation_status) as a durable avatar in your three.ws library. The mesh is copied into our own storage so it survives the provider URL expiring, then registered as a named avatar you own. Returns avatar_id, slug, model_url, and a view_url. This is the bridge from the studio to the avatar system: after saving, get_avatar, render_avatar_image, embeds, and on-chain identity all work on the result. Requires you to be signed in.',
		inputSchema: {
			type: 'object',
			properties: {
				glb_url: {
					type: 'string',
					format: 'uri',
					description:
						'Public https URL of the GLB to save (e.g. from generation_status).',
				},
				name: {
					type: 'string',
					minLength: 1,
					maxLength: 80,
					description: 'A name for the avatar, 1–80 characters.',
				},
				visibility: {
					type: 'string',
					enum: ['public', 'unlisted', 'private'],
					default: 'unlisted',
					description:
						'public = listed in the gallery; unlisted = anyone with the link; private = only you.',
				},
				source_prompt: {
					type: 'string',
					maxLength: 1000,
					description:
						'Optional: the prompt that generated this model, kept as provenance.',
				},
				tags: {
					type: 'array',
					items: { type: 'string', minLength: 1, maxLength: 40 },
					maxItems: 20,
					description: 'Optional tags for organizing and searching your library.',
				},
			},
			required: ['glb_url', 'name'],
			additionalProperties: false,
		},
		scope: 'avatars:write',
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);

			if (!auth.userId) {
				return {
					content: [
						{
							type: 'text',
							text:
								'Sign in to save an avatar. Saving writes to your three.ws library, ' +
								'so it needs a signed-in account (an OAuth bearer token), not an ' +
								'anonymous pay-per-call session.',
						},
					],
					structuredContent: { status: 'sign_in_required' },
					isError: true,
				};
			}

			if (!(await isPublicHttpsUrl(args.glb_url))) {
				return {
					content: [{ type: 'text', text: 'Error: glb_url must be a public https URL.' }],
					isError: true,
				};
			}

			const buf = await fetchGlbBuffer(args.glb_url);
			const info = isValidGlbHeader(buf) ? inspectGlb(buf) : null;
			if (!info) {
				return {
					content: [
						{
							type: 'text',
							text: 'Error: that URL did not return a valid GLB (binary glTF). Pass a .glb model URL.',
						},
					],
					isError: true,
				};
			}

			const visibility = ['public', 'unlisted', 'private'].includes(args.visibility)
				? args.visibility
				: 'unlisted';
			const name = String(args.name).trim().slice(0, 80);
			// Random suffix (matches the reconstruct pipeline) so re-saving the same
			// model never collides on the per-owner unique slug constraint.
			const slug = `studio-${Math.random().toString(36).slice(2, 8)}`;
			const storageKey = storageKeyFor({ userId: auth.userId, slug });

			await putObject({
				key: storageKey,
				body: buf,
				contentType: 'model/gltf-binary',
				metadata: { source: 'studio', user_id: auth.userId },
			});

			const tags = Array.isArray(args.tags)
				? args.tags
						.map((t) => String(t).trim())
						.filter(Boolean)
						.slice(0, 20)
				: [];

			const avatar = await createAvatar({
				userId: auth.userId,
				storageKey,
				input: {
					slug,
					name,
					description: null,
					size_bytes: buf.length,
					content_type: 'model/gltf-binary',
					source: 'studio',
					source_meta: {
						source_glb_url: args.glb_url,
						source_prompt: args.source_prompt ?? null,
						is_rigged: info.isRigged ?? null,
						mesh_count: info.meshCount ?? null,
						animation_count: info.animationCount ?? null,
					},
					visibility,
					tags,
					checksum_sha256: null,
					parent_avatar_id: null,
				},
			});

			const viewUrl = `${env.APP_ORIGIN}/avatars/${avatar.id}`;
			return {
				content: [
					{
						type: 'text',
						text:
							`Saved "${avatar.name}" to your library (${visibility}).\n` +
							`Avatar ID: ${avatar.id}\nView: ${viewUrl}\n` +
							'Render it with render_avatar_image, or fetch it with get_avatar.',
					},
				],
				structuredContent: {
					avatar_id: avatar.id,
					slug: avatar.slug,
					model_url: avatar.model_url,
					view_url: viewUrl,
					visibility,
				},
			};
		},
	},
	{
		name: 'create_agent_persona',
		title: 'Mint a persistent, living agent persona from a rigged GLB',
		annotations: PERSONA_CREATE_ANNOTATIONS,
		description:
			'Turn a generated GLB into a NAMED, persistent agent body — a "persona" the agent reuses across turns and across sessions. The mesh is copied into durable storage so the body survives the provider URL expiring, then registered under a stable persona_id. The returned text/html resource renders the LIVING body inline: it idles between turns, and persona_say makes it lip-sync and emote a reply. The persona_id is the capability — keep it and pass it to get_agent_persona or persona_say later to bring the exact same body back. No sign-in required.',
		inputSchema: {
			type: 'object',
			properties: {
				glb_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the rigged GLB to embody (e.g. from generation_status).',
				},
				name: {
					type: 'string',
					minLength: 1,
					maxLength: 80,
					description: 'A display name for the persona, 1–80 characters.',
				},
				voice: {
					type: 'string',
					maxLength: 64,
					description: 'Optional voice id/name to speak with (used for TTS-driven lip-sync when available).',
				},
				source_prompt: {
					type: 'string',
					maxLength: 1000,
					description: 'Optional: the prompt that generated this body, kept as provenance.',
				},
			},
			required: ['glb_url', 'name'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!(await isPublicHttpsUrl(args.glb_url))) {
				return {
					content: [{ type: 'text', text: 'Error: glb_url must be a public https URL.' }],
					isError: true,
				};
			}
			const buf = await fetchGlbBuffer(args.glb_url);
			const info = isValidGlbHeader(buf) ? inspectGlb(buf) : null;
			if (!info) {
				return {
					content: [
						{ type: 'text', text: 'Error: that URL did not return a valid GLB (binary glTF). Pass a .glb model URL.' },
					],
					isError: true,
				};
			}

			const record = await createPersona({
				name: args.name,
				glbUrl: args.glb_url,
				glbBuffer: buf,
				voice: args.voice ?? null,
				sourcePrompt: args.source_prompt ?? null,
				ownerId: auth.userId ?? null,
				look: {
					rigged: info.isRigged ?? null,
					mesh_count: info.meshCount ?? null,
					animation_count: info.animationCount ?? null,
				},
			});
			const persona = personaPublicView(record);

			return {
				content: [
					{
						type: 'text',
						text:
							`Minted "${persona.name}" as a living persona.\n` +
							`Persona ID: ${persona.persona_id}\n` +
							(persona.look?.rigged ? 'Rig: humanoid — full body animation + lip-sync.\n' : 'Rig: static/non-humanoid — will fall back to the default rig gracefully.\n') +
							'Display the attached text/html resource to see the body. ' +
							'Call persona_say with this persona_id to make it speak a reply, or get_agent_persona to bring it back in a future session.',
					},
					embodimentArtifact({ persona, state: 'idle' }),
				],
				structuredContent: { ...persona, status: 'created' },
			};
		},
	},
	{
		name: 'get_agent_persona',
		title: 'Reload a persisted persona by id (continuity across sessions)',
		annotations: PERSONA_READ_ANNOTATIONS,
		description:
			'Bring back a previously minted persona by its persona_id — the SAME body and identity, in a fresh session. Returns the persona name, its GLB, accumulated turn count, and the inline living-body artifact. Use this at the start of a conversation when the user returns to a named agent.',
		inputSchema: {
			type: 'object',
			properties: {
				persona_id: {
					type: 'string',
					minLength: 8,
					maxLength: 64,
					description: 'The persona_id returned by create_agent_persona.',
				},
			},
			required: ['persona_id'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dStatus, auth);
			if (!isPersonaId(args.persona_id)) {
				return {
					content: [{ type: 'text', text: 'Error: that is not a valid persona_id.' }],
					structuredContent: { status: 'invalid_id' },
					isError: true,
				};
			}
			const record = await getPersona(args.persona_id);
			if (!record) {
				return {
					content: [{ type: 'text', text: 'No persona found for that id. Mint one with create_agent_persona.' }],
					structuredContent: { status: 'not_found' },
					isError: true,
				};
			}
			const persona = personaPublicView(record);
			return {
				content: [
					{
						type: 'text',
						text:
							`Welcome back, ${persona.name}.\n` +
							`Persona ID: ${persona.persona_id}\n` +
							`Turns spoken so far: ${persona.turn_count}.\n` +
							'Display the attached text/html resource to see the body; call persona_say to make it speak.',
					},
					embodimentArtifact({ persona, state: 'idle' }),
				],
				structuredContent: { ...persona, status: 'loaded' },
			};
		},
	},
	{
		name: 'persona_say',
		title: 'Speak a reply through a persona: lip-sync + emotion + gesture',
		annotations: PERSONA_SAY_ANNOTATIONS,
		description:
			"Make a persona PERFORM a reply: the body lip-syncs the text and shows the matching expression and body gesture. Pass the persona_id and the exact text the agent is saying this turn; the emotion is detected from the text automatically (or override it). The returned text/html resource animates the body for this turn — display it alongside the spoken reply. This is the turn-by-turn embodiment hook.",
		inputSchema: {
			type: 'object',
			properties: {
				persona_id: {
					type: 'string',
					minLength: 8,
					maxLength: 64,
					description: 'The persona to speak through.',
				},
				text: {
					type: 'string',
					minLength: 1,
					maxLength: 2000,
					description: 'The reply text the agent is saying this turn — drives lip-sync and emotion.',
				},
				emotion: {
					type: 'string',
					enum: ['neutral', 'joy', 'sad', 'angry', 'surprised', 'thinking'],
					description: 'Optional explicit emotion override; omit to auto-detect from the text.',
				},
			},
			required: ['persona_id', 'text'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerateFree, auth);
			if (!isPersonaId(args.persona_id)) {
				return {
					content: [{ type: 'text', text: 'Error: that is not a valid persona_id.' }],
					structuredContent: { status: 'invalid_id' },
					isError: true,
				};
			}
			const record = await getPersona(args.persona_id);
			if (!record) {
				return {
					content: [{ type: 'text', text: 'No persona found for that id. Mint one with create_agent_persona.' }],
					structuredContent: { status: 'not_found' },
					isError: true,
				};
			}
			const expr = args.emotion
				? { ...expressionFor(args.emotion, 0.85), scores: {} }
				: expressionForText(args.text);
			const updated = await touchPersona(args.persona_id);
			const persona = personaPublicView(updated || record);

			return {
				content: [
					{
						type: 'text',
						text:
							`${persona.name} says it with a ${expr.emotion} expression` +
							(expr.gesture ? ` and a ${expr.gesture} gesture` : '') +
							`. Display the attached text/html resource — the body lip-syncs the reply and emotes.`,
					},
					embodimentArtifact({
						persona,
						state: 'speaking',
						text: args.text,
						emotion: expr.emotion,
						intensity: expr.intensity,
						gesture: expr.gesture,
					}),
				],
				structuredContent: {
					persona_id: persona.persona_id,
					name: persona.name,
					glb_url: persona.glb_url,
					text: args.text,
					emotion: expr.emotion,
					intensity: expr.intensity,
					gesture: expr.gesture,
					turn_count: persona.turn_count,
					status: 'spoken',
				},
			};
		},
	},
];
