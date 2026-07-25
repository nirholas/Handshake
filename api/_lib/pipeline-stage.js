// Shared execution rail for the paid 3D-pipeline x402 stages.
//
// The free pipeline routes (api/forge-remesh.js, forge-gameready.js,
// forge-stylize.js, forge-rembg.js, and the rig lane) are asynchronous: POST
// submits a job, the client polls a GET for the result. Their paid x402 twins
// (api/x402/pipeline-*.js) are SYNCHRONOUS: one payment buys one finished
// asset, so the handler submits the same GCP worker job, polls it to completion
// inside the request window, validates the output bytes, persists a durable
// first-party copy, and returns its URL. This module holds the machinery every
// paid stage shares so each route file only declares its slug, price, schema,
// and the worker mode + params it drives.
//
// The buyer-never-charged guarantee (00-CONTEXT rule 4): every failure path here
// THROWS a StageError before the paidEndpoint rail settles. An unconfigured
// worker, a bad input URL, a non-GLB payload, a worker failure, a poll timeout,
// or a corrupt output all surface as a thrown status/code — settlement never
// runs, so the buyer keeps their USDC and can retry. Nothing is caught-and-
// continued into a settled response.

import { createRegenProvider } from '../_providers/gcp.js';
import { readBody } from './http.js';
import { validatePublicUrl, resolvePublicHost, SsrfError } from './ssrf.js';
import { fetchSafePublicUrlPinned, MaxBytesExceededError } from './ssrf-guard.js';
import { putObject, publicUrl } from './r2.js';

// Poll cadence + budget. The x402 payment authorization carries
// maxTimeoutSeconds:60, so completion + settlement must land inside that window;
// 45s of polling leaves headroom for the settle round-trip. Both are
// env-overridable for slower deployments.
const POLL_INTERVAL_MS = Number(process.env.X402_PIPELINE_POLL_INTERVAL_MS) || 2_000;
const POLL_BUDGET_MS = Number(process.env.X402_PIPELINE_POLL_BUDGET_MS) || 45_000;
const OUTPUT_FETCH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024; // matches forge-store MAX_GLB_BYTES

export class StageError extends Error {
	constructor(message, { status = 500, code = 'stage_error' } = {}) {
		super(message);
		this.name = 'StageError';
		this.status = status;
		this.code = code;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read + parse the JSON request body via readBody (api/_lib/http.js): the Cloud
// Run server's body parsers drain the raw stream before handlers run (bytes
// preserved on req.rawBody), so a direct stream read yields an empty body in
// production. A malformed or oversized body throws before any worker call.
export async function readJsonBody(req, maxBytes = 8_192) {
	let buf;
	try {
		buf = await readBody(req, maxBytes);
	} catch (err) {
		if (err?.status === 413) {
			throw new StageError('request body too large', { status: 413, code: 'body_too_large' });
		}
		throw new StageError(err?.message || 'could not read request body', {
			status: err?.status || 400,
			code: 'body_read_failed',
		});
	}
	const raw = buf.toString('utf8').trim();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw new StageError('request body must be valid JSON', {
			status: 400,
			code: 'invalid_json',
		});
	}
}

// ── Input validation ────────────────────────────────────────────────────────

// Validate a caller-supplied asset URL. Scheme + SSRF checks reject a malformed
// or private-network URL BEFORE any worker touches it. `validatePublicUrl`
// throws synchronously on a bad scheme (no DNS), so a "not a URL" input is a
// clean 400 without a network round-trip; the DNS resolution then rejects
// private/loopback/metadata hosts.
export async function validateAssetUrl(raw, field = 'glb_url') {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!value) {
		throw new StageError(`${field} is required`, { status: 400, code: 'missing_url' });
	}
	let url;
	try {
		url = validatePublicUrl(value);
	} catch (err) {
		const detail = err instanceof SsrfError ? err.message : 'must be a valid https URL';
		throw new StageError(`${field} rejected: ${detail}`, { status: 400, code: 'invalid_url' });
	}
	try {
		await resolvePublicHost(url.hostname);
	} catch (err) {
		const detail = err instanceof SsrfError ? err.message : 'host could not be resolved';
		throw new StageError(`${field} rejected: ${detail}`, { status: 400, code: 'invalid_url' });
	}
	return url.href;
}

// glTF binary magic — the first four bytes of every .glb are the ASCII "glTF"
// (0x67 0x6C 0x54 0x46). Pure predicate so tests can assert it on captured bytes
// with no network.
export function isGlbMagic(bytes) {
	if (!bytes || bytes.length < 12) return false;
	return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

// Recognized raster-image magic numbers (PNG, JPEG, WEBP, GIF) — the rembg stage
// takes an image, not a mesh. Pure predicate for the same reason.
export function isImageMagic(bytes) {
	if (!bytes || bytes.length < 12) return false;
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
	// JPEG: FF D8 FF
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
	// GIF: "GIF8"
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
	// WEBP: "RIFF"...."WEBP"
	if (
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	)
		return true;
	return false;
}

function magicMatches(kind, bytes) {
	return kind === 'image' ? isImageMagic(bytes) : isGlbMagic(bytes);
}

// Range-fetch the first bytes of the caller's asset and confirm it is the
// expected kind (glb | image). A 415 here means the URL resolved to something
// that isn't the asset the stage processes — thrown before settlement so the
// buyer is not charged for feeding, say, an HTML page to the remesher.
export async function sniffRemoteAsset(url, kind = 'glb') {
	let resp;
	try {
		// Pinned guard fetch: the URL was validated upstream, but a plain
		// redirect-following fetch would let a validated host 302 us to an
		// internal address. Every hop is re-validated and the socket is pinned
		// to the checked IP. The byte cap only bounds hosts that ignore the
		// Range header and stream the whole asset.
		resp = await fetchSafePublicUrlPinned(
			url,
			{
				headers: { range: 'bytes=0-63', accept: '*/*' },
				signal: AbortSignal.timeout(15_000),
			},
			{ maxBytes: MAX_OUTPUT_BYTES },
		);
	} catch (err) {
		throw new StageError(`could not fetch ${kind}: ${err.message}`, {
			status: 502,
			code: 'fetch_failed',
		});
	}
	if (!resp.ok && resp.status !== 206) {
		throw new StageError(`source URL returned ${resp.status}`, {
			status: resp.status === 404 ? 404 : 502,
			code: 'fetch_failed',
		});
	}
	const head = new Uint8Array((await resp.arrayBuffer()).slice(0, 64));
	if (!magicMatches(kind, head)) {
		throw new StageError(
			kind === 'image'
				? 'source URL is not a supported image (PNG, JPEG, WEBP, or GIF)'
				: 'source URL is not a binary glTF (.glb) — its bytes lack the "glTF" magic header',
			{ status: 415, code: 'unsupported_media_type' },
		);
	}
	return true;
}

// ── Worker execution ────────────────────────────────────────────────────────

// Submit one worker job and poll it to completion inside the request window.
// `provider` is injectable so the fixture-backed tests can drive captured worker
// response shapes without a live Cloud Run service; production defaults to the
// real GCP provider. Throws StageError on every non-success outcome so the
// caller never settles a payment for work that didn't finish.
export async function runStageJob({
	mode,
	sourceUrl,
	params,
	provider,
	pollBudgetMs = POLL_BUDGET_MS,
	pollIntervalMs = POLL_INTERVAL_MS,
}) {
	let regen = provider;
	if (!regen) {
		try {
			regen = createRegenProvider();
		} catch {
			throw new StageError(
				`${mode} worker is not configured on this deployment (set GCP_${mode.toUpperCase()}_URL and GCP_RECONSTRUCTION_KEY)`,
				{ status: 503, code: 'unconfigured' },
			);
		}
	}
	if (!regen.supportsMode(mode)) {
		throw new StageError(
			`${mode} worker is not configured on this deployment (set the worker URL and GCP_RECONSTRUCTION_KEY)`,
			{ status: 503, code: 'unconfigured' },
		);
	}

	let job;
	try {
		job = await regen.submit({ mode, sourceUrl, params });
	} catch (err) {
		throw new StageError(err?.message || `${mode} job could not start`, {
			status: err?.status || 502,
			code: err?.code || 'submit_failed',
		});
	}
	const extJobId = job?.extJobId || job?.jobId;
	if (!extJobId) {
		throw new StageError(`${mode} worker returned no job id`, {
			status: 502,
			code: 'submit_failed',
		});
	}

	const deadline = Date.now() + pollBudgetMs;
	// Poll immediately, then on the interval — fast workers (rembg ~5s) often
	// finish before the first sleep.
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const result = await regen.status(extJobId);
		if (result.status === 'done') {
			return { ...result, extJobId, mode };
		}
		if (result.status === 'failed') {
			throw new StageError(result.error || `${mode} job failed`, {
				status: 502,
				code: 'stage_failed',
			});
		}
		if (Date.now() + pollIntervalMs >= deadline) {
			throw new StageError(
				`${mode} job did not finish within ${Math.round(pollBudgetMs / 1000)}s — retry; you were not charged`,
				{ status: 504, code: 'stage_timeout' },
			);
		}
		await sleep(pollIntervalMs);
	}
}

// ── Output persistence ──────────────────────────────────────────────────────

// Fetch the finished worker artifact, confirm its magic bytes, and mirror it
// into R2 so the buyer's download URL is first-party and durable. When R2 is
// unconfigured the validated worker URL is returned as-is (a real, working
// result — never a faked one). A missing, unreachable, or wrong-kind output
// throws so the payment is not settled for a broken artifact.
export async function persistStageOutput({ resultUrl, key, contentType, kind = 'glb' }) {
	if (!resultUrl) {
		throw new StageError('worker finished but returned no result URL', {
			status: 502,
			code: 'no_output',
		});
	}
	let resp;
	try {
		// Worker-returned URL: lower trust than our own storage. Pinned guard
		// fetch so a compromised worker reply cannot redirect the retrieve into
		// an internal address; the streaming cap replaces the old post-hoc
		// length check so an over-limit body never buffers in full.
		resp = await fetchSafePublicUrlPinned(
			resultUrl,
			{ signal: AbortSignal.timeout(OUTPUT_FETCH_TIMEOUT_MS) },
			{ maxBytes: MAX_OUTPUT_BYTES },
		);
	} catch (err) {
		if (err instanceof MaxBytesExceededError) {
			throw new StageError(`worker output exceeds the ${MAX_OUTPUT_BYTES}-byte limit`, {
				status: 502,
				code: 'output_too_large',
			});
		}
		throw new StageError(`could not retrieve worker output: ${err.message}`, {
			status: 502,
			code: 'output_fetch_failed',
		});
	}
	if (!resp.ok) {
		throw new StageError(`worker output URL returned ${resp.status}`, {
			status: 502,
			code: 'output_fetch_failed',
		});
	}
	const buf = Buffer.from(await resp.arrayBuffer());
	if (!buf.length) {
		throw new StageError('worker output was empty', { status: 502, code: 'empty_output' });
	}
	if (!magicMatches(kind, new Uint8Array(buf.subarray(0, 64)))) {
		throw new StageError(
			`worker output is not a valid ${kind === 'image' ? 'image' : 'GLB'}`,
			{ status: 502, code: 'invalid_output' },
		);
	}

	// Mirror into R2 when configured; otherwise hand back the worker URL. Both are
	// real, working results — persistence is a durability upgrade, never a gate.
	try {
		await putObject({
			key,
			body: buf,
			contentType: contentType || (kind === 'image' ? 'image/png' : 'model/gltf-binary'),
			metadata: { source: 'x402-pipeline' },
		});
		return { url: publicUrl(key), bytes: buf.length, persisted: true };
	} catch {
		return { url: resultUrl, bytes: buf.length, persisted: false };
	}
}

// Stable, collision-resistant R2 namespace for a stage output, derived from the
// source URL so re-runs overwrite rather than orphan without leaking the URL.
export async function stageObjectKey({ stage, sourceUrl, ext }) {
	const { createHash } = await import('node:crypto');
	const h = createHash('sha256').update(String(sourceUrl)).digest('hex').slice(0, 16);
	return `x402-pipeline/${stage}/${h}.${ext}`;
}
