// Hugging Face provider for avatar reconstruction.
//
// Calls HF Space Gradio /call/<api_name> endpoints for image-to-3D inference.
// Why "HF Spaces" instead of HF Inference Endpoints: image-to-3D model families
// (Hunyuan3D, TRELLIS, InstantMesh) need GPUs and aren't served on the
// serverless Inference API. Spaces give free GPU access — at the cost of
// queue waits and frequent cold-start / runtime failures.
//
// Failover: HF Spaces are unreliable (the headline Space goes down with
// "No @spaces.GPU function detected" or hits the queue, etc). We try a chain
// of Spaces in order and return the first GLB we get. Each Space has its own
// /call API name + payload builder so the chain can include different model
// families (Hunyuan3D, TRELLIS, etc).
//
// Submit is BLOCKING: Gradio queue state lives in the server-side event_id
// with no reconnect; once /call/<api>/<event_id> SSE is consumed, the result
// is gone. The reconstruct endpoint's maxDuration is 300s in vercel.json to
// absorb queue wait + processing.
//
// status() echoes the resultGlbUrl back from a packed extJobId so the
// regenerate-status poll loop materializes the avatar without re-hitting HF.
//
// Env:
//   HF_TOKEN                      — required; huggingface.co/settings/tokens
//                                   (read-only OK; public Spaces don't need write)
//   HF_RECONSTRUCT_SPACES         — comma-separated chain of Space slugs to try
//                                   in order. Format: "owner/name[:api_name]"
//                                   Default: a hand-curated chain of currently
//                                   working textured-GLB Spaces.
//   HF_RECONSTRUCT_SPACE          — legacy single-target alias; converted into
//                                   a 1-element chain if HF_RECONSTRUCT_SPACES
//                                   is unset.
//   HF_RECONSTRUCT_API_NAME       — legacy single-API alias.

const HF_INFERENCE_TIMEOUT_MS = 280_000; // leave headroom for response framing

// A reconstructed GLB is served from the Space's ephemeral gradio /tmp path,
// which is purged minutes (sometimes seconds) after the run. Every consumer of
// this provider — the forge image lane and the avatar reconstruct poll — fetches
// the result URL *later*, by which point the temp file can already be gone,
// surfacing as a client-side 404 in model-viewer's loader. So the instant the
// SSE completes (when the temp file is freshest) we pull the bytes and re-host
// them to durable object storage, returning that URL instead. This is fail-soft:
// a deployment without object storage configured keeps the raw Space URL exactly
// as before, so nothing regresses where there's nowhere durable to put it.
const REHOST_MAX_GLB_BYTES = 64 * 1024 * 1024; // 64 MB ceiling, matching reconstruct-finalize
const REHOST_MAX_ATTEMPTS = 3;
const REHOST_RETRY_BASE_MS = 350;

// Ordered failover chain. We try each entry in order until one returns a GLB.
// Each entry is { space, api, builder } where builder shapes the Gradio
// payload from the selfie photos. Add new Spaces as they come online; keep
// the most reliable / highest-quality at the top.
//
// Verified targets (2026-06, probed live against each Space's Gradio /info):
//   tencent/Hunyuan3D-2     — textured GLB via /generation_all (highest quality;
//                             flaky GPU/queue, recovers)
//   tencent/Hunyuan3D-2.1   — successor; same /generation_all shape
//   stabilityai/TripoSR     — fast feed-forward via /generate; takes
//                             [image, mc_resolution] and returns [OBJ, GLB].
//                             Reliable terminal fallback — keep it last so the
//                             chain always has a Space that actually returns a GLB.
//
// JeffreyXiang/TRELLIS was removed: the Space host now 404s (taken down), so
// listing it only burned a failover hop. Re-add a working TRELLIS Space here (or
// via HF_RECONSTRUCT_SPACES) if one comes back online.
const HF_FAILOVER_CHAIN = [
	{ space: 'tencent/Hunyuan3D-2',             api: 'generation_all',  builder: 'hunyuan' },
	{ space: 'tencent/Hunyuan3D-2.1',           api: 'generation_all',  builder: 'hunyuan' },
	{ space: 'stabilityai/TripoSR',             api: 'generate',        builder: 'triposr' },
];

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
	return null;
}

function packExtJobId(payload) {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function unpackExtJobId(extJobId) {
	try {
		return JSON.parse(Buffer.from(extJobId, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
}

function spaceBaseUrl(slug) {
	// HF subdomain: lowercase, all non-alphanumeric chars → hyphens.
	// e.g. tencent/Hunyuan3D-2.1 → tencent-hunyuan3d-2-1.hf.space
	const host = slug.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
	return `https://${host}.hf.space`;
}

// Gradio file-component input. data: URIs and http(s) URLs both work; the
// Space's preprocessor will fetch URLs server-side.
function toFileData(imageUrl) {
	if (!imageUrl) return null;
	return {
		path: imageUrl,
		url: imageUrl,
		meta: { _type: 'gradio.FileData' },
	};
}

function withTimeout(promise, ms, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Walk a Gradio output tree for the first GLB-looking file and return every
// address that file might be reachable at, in order of reliability. The Space
// returns outputs like:
//   [ { path: "/tmp/x.glb", url: "https://...hf.space/file=/tmp/x.glb", ... },
//     { ...white-mesh file...}, "Output text", {...stats...}, 1234 ]
// We want the *first* file: it's the textured mesh from /generation_all.
//
// Multiple candidates exist because a FileData's self-reported `url` is not
// trustworthy: Spaces behind HF's replica router stamp it with a stale proxy
// prefix (observed live on stabilityai/TripoSR: url ".../ca/file=/tmp/...glb"
// 404s while ".../file=/tmp/...glb" serves the same file). Building the URL
// from `path` with the canonical /file= route (Gradio ≤4) is the proven-good
// form, so it goes first; the reported url and the Gradio 5 /gradio_api/file=
// route follow as fallbacks.
function extractFirstGlbCandidates(data, spaceUrl) {
	const fromFileData = (node) => {
		const path = typeof node.path === 'string' && /\.glb($|\?)/i.test(node.path) ? node.path : null;
		const url = typeof node.url === 'string' && /\.glb($|\?)/i.test(node.url) ? node.url : null;
		if (!path && !url) return null;
		const candidates = [];
		if (path) {
			if (/^https?:\/\//i.test(path)) candidates.push(path);
			else {
				const rel = path.startsWith('/') ? path : `/${path}`;
				candidates.push(`${spaceUrl}/file=${rel}`, `${spaceUrl}/gradio_api/file=${rel}`);
			}
		}
		if (url && /^https?:\/\//i.test(url)) candidates.push(url);
		return candidates.length ? candidates : null;
	};
	const visit = (node) => {
		if (!node) return null;
		if (typeof node === 'string') {
			if (/^https?:\/\/.+\.glb($|\?)/i.test(node)) return [node];
			return null;
		}
		if (Array.isArray(node)) {
			for (const child of node) {
				const found = visit(child);
				if (found) return found;
			}
			return null;
		}
		if (typeof node === 'object') {
			const direct = fromFileData(node);
			if (direct) return direct;
			for (const v of Object.values(node)) {
				const found = visit(v);
				if (found) return found;
			}
		}
		return null;
	};
	return visit(data);
}

// Build the 13-arg payload for tencent/Hunyuan3D-2 /generation_all.
//
// Parameters in order:
//   caption(str), image(file), mv_front, mv_back, mv_left, mv_right,
//   steps(int), guidance_scale(float), seed(int), octree_resolution(int),
//   check_box_rembg(bool), num_chunks(int), randomize_seed(bool)
//
// We default to the Space's own defaults so users get a baseline-quality
// result; selfie callers can override via params.steps / params.seed / etc.
function buildHunyuanPayload({ photos, params }) {
	const [frontal, left, right] = photos;
	return [
		params?.caption ?? '',
		toFileData(params?.image || frontal),
		toFileData(frontal),
		null, // mv_back — we don't capture a back photo in the selfie flow
		toFileData(left),
		toFileData(right),
		Number(params?.steps ?? 30),
		Number(params?.guidance_scale ?? 5.0),
		Number(params?.seed ?? 1234),
		Number(params?.octree_resolution ?? 256),
		params?.check_box_rembg !== false,
		Number(params?.num_chunks ?? 8000),
		params?.randomize_seed !== false,
	];
}

// Stream SSE response and resolve with the parsed `complete` payload.
// Throws on `error` event or when the stream ends without `complete`.
async function consumeSseUntilComplete(response) {
	if (!response.ok || !response.body) {
		const body = await response.text().catch(() => '');
		throw Object.assign(
			new Error(`huggingface /call stream not available: ${response.status} ${body.slice(0, 200)}`),
			{ code: 'provider_error', status: 502 },
		);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	let pendingEvent = null;
	let result = null;
	let errorMessage = null;

	const drain = (async () => {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nlIdx;
			while ((nlIdx = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
				buffer = buffer.slice(nlIdx + 1);
				if (line === '') {
					pendingEvent = null;
					continue;
				}
				if (line.startsWith('event:')) {
					pendingEvent = line.slice(6).trim();
					continue;
				}
				if (line.startsWith('data:')) {
					const dataStr = line.slice(5).trim();
					if (pendingEvent === 'complete') {
						try { result = JSON.parse(dataStr); } catch { result = dataStr; }
						return;
					}
					if (pendingEvent === 'error') {
						// Gradio emits `data: null` on its error event when the Space dies
						// without a message — free-tier GPU quota exhausted or the Space
						// sleeping/rebuilding. Passing that through produced the useless
						// "inference failed: null" in production logs; name the likely
						// cause instead so the failover log line is diagnosable.
						errorMessage = dataStr && dataStr !== 'null' && dataStr !== '""'
							? dataStr
							: 'Space error event with no detail (typically GPU quota exhausted or Space sleeping)';
						return;
					}
					// heartbeat / generating / unknown: ignore
				}
			}
		}
	})();

	try {
		await withTimeout(drain, HF_INFERENCE_TIMEOUT_MS, 'huggingface SSE stream timed out');
	} catch (err) {
		try { await reader.cancel(); } catch (_) {}
		throw Object.assign(
			new Error(err?.message || 'huggingface stream timed out'),
			{ code: 'provider_timeout', status: 504 },
		);
	}

	if (errorMessage) {
		throw Object.assign(new Error(`huggingface inference failed: ${errorMessage}`), {
			code: 'provider_error',
			status: 502,
		});
	}
	if (result === null) {
		throw Object.assign(new Error('huggingface stream closed without complete event'), {
			code: 'provider_error',
			status: 502,
		});
	}
	return result;
}

// Resolve the failover chain from env, falling back to the curated default.
//
// Precedence (first present wins):
//   HF_RECONSTRUCT_SPACES — comma-separated "owner/name[:api]" pairs
//   HF_RECONSTRUCT_SPACE  — legacy single-Space alias (uses HF_RECONSTRUCT_API_NAME or 'generation_all')
//   HF_FAILOVER_CHAIN     — curated default chain (this module)
function resolveChain() {
	const chainCsv = readEnv('HF_RECONSTRUCT_SPACES');
	if (chainCsv) {
		return chainCsv
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => {
				const [space, api] = entry.split(':');
				return {
					space,
					api: api || 'generation_all',
					builder: builderForApi(api),
				};
			});
	}
	const legacySpace = readEnv('HF_RECONSTRUCT_SPACE');
	if (legacySpace) {
		const api = readEnv('HF_RECONSTRUCT_API_NAME') || 'generation_all';
		return [{ space: legacySpace, api, builder: builderForApi(api) }];
	}
	return HF_FAILOVER_CHAIN;
}

// Pick the payload builder for an env-supplied "owner/name[:api]" entry from its
// Gradio api_name. /generation_all is Hunyuan3D's 13-arg shape; /generate is
// TripoSR's [image, mc_resolution]; anything else (single-image endpoints) gets
// the bare one-file payload.
function builderForApi(api) {
	if (!api || api === 'generation_all') return 'hunyuan';
	if (api === 'generate') return 'triposr';
	return 'single';
}

// Per-Space payload builders. Map our normalized {photos, params} into the
// argument list that Space's Gradio endpoint expects.
const BUILDERS = {
	hunyuan: ({ photos, params }) => buildHunyuanPayload({ photos, params }),
	single: ({ photos }) => [toFileData(photos[0])],
	// stabilityai/TripoSR /generate: (image filepath, marching-cubes resolution
	// float) → [OBJ, GLB]. We pass the reference view straight through — the forge
	// image lane already supplies a clean subject view — and take the GLB output;
	// extractFirstGlbCandidates skips the OBJ and returns the .glb.
	triposr: ({ photos, params }) => [toFileData(photos[0]), Number(params?.mc_resolution ?? 256)],
};

// Object storage is configured only when every S3 var the bucket helpers read is
// present. Matches forge-store's gate so a partially-configured deployment skips
// re-hosting (and keeps the raw Space URL) instead of throwing mid-run.
function r2Configured() {
	return Boolean(
		readEnv('S3_ENDPOINT') &&
		readEnv('S3_BUCKET') &&
		readEnv('S3_PUBLIC_DOMAIN') &&
		readEnv('S3_ACCESS_KEY_ID') &&
		readEnv('S3_SECRET_ACCESS_KEY'),
	);
}

// Pull the freshly-produced GLB and re-host it to durable storage, returning the
// public URL. The HF bearer token is forwarded so private Spaces' file endpoints
// authorize the read; public Spaces ignore it.
//
// Two terminal outcomes, deliberately distinct:
//   • Storage unconfigured → return null. There is nowhere durable to put the
//     mesh, so the caller keeps the raw Space URL exactly as before. Nothing
//     regresses on storage-less deployments.
//   • Storage configured but the rehost can't complete (the temp file already
//     404'd, the fetch errored after retries, the body was empty/oversize, or
//     the upload failed) → THROW. Returning the raw gradio /tmp URL here would
//     be worse than failing: that URL is ephemeral and *will* 404 when a later
//     consumer (the forge poll, materializeCreation, model-viewer's loader)
//     fetches it — the exact "materializeCreation failed: ...glb 404" this
//     function exists to prevent. Throwing lets the failover loop regenerate on
//     the next Space, and if the chain is exhausted the caller surfaces a
//     designed error instead of a doomed URL.
async function rehostGlbToR2(glbUrls, token) {
	if (!r2Configured()) return null;

	const candidates = Array.isArray(glbUrls) ? glbUrls : [glbUrls];
	let buf = null;
	let lastErr = null;
	candidateLoop:
	for (const glbUrl of candidates) {
		for (let attempt = 1; attempt <= REHOST_MAX_ATTEMPTS; attempt++) {
			try {
				const resp = await fetch(glbUrl, { headers: { authorization: `Bearer ${token}` } });
				if (!resp.ok) {
					lastErr = Object.assign(new Error(`GLB fetch ${resp.status}`), { status: resp.status });
					// 404/410 on this address = wrong route or the temp file is gone;
					// retrying the same URL can't recover it, but another candidate
					// address for the same file still might (a stale proxy-prefixed
					// `url` 404s while the canonical /file= route serves the bytes).
					if (resp.status === 404 || resp.status === 410) continue candidateLoop;
				} else {
					const bytes = Buffer.from(await resp.arrayBuffer());
					if (bytes.length === 0) { lastErr = new Error('GLB body was empty'); break candidateLoop; }
					if (bytes.length > REHOST_MAX_GLB_BYTES) {
						lastErr = new Error(`GLB too large: ${bytes.length} bytes`);
						break candidateLoop;
					}
					buf = bytes;
					break candidateLoop;
				}
			} catch (err) {
				lastErr = err;
			}
			if (attempt < REHOST_MAX_ATTEMPTS) {
				await new Promise((r) => setTimeout(r, REHOST_RETRY_BASE_MS * attempt));
			}
		}
	}
	if (!buf) {
		throw Object.assign(
			new Error(`GLB rehost failed: ${lastErr?.message || 'unknown error'}`),
			{ code: 'rehost_failed', status: lastErr?.status, cause: lastErr },
		);
	}

	const { putObject, publicUrl } = await import('../_lib/r2.js');
	const { randomUUID } = await import('node:crypto');
	const key = `hf-recon/${randomUUID()}.glb`;
	await putObject({
		key,
		body: buf,
		contentType: 'model/gltf-binary',
		metadata: { source: 'huggingface-reconstruct' },
	});
	return publicUrl(key);
}

// Try one Space end-to-end: enqueue → consume SSE → extract GLB url.
// Throws with a tagged error containing the Space slug so the failover loop
// can decide whether to advance to the next entry.
async function runOnSpace({ token, target, photos, params }) {
	const { space, api, builder } = target;
	const spaceUrl = spaceBaseUrl(space);
	const payloadBuilder = BUILDERS[builder] || BUILDERS.single;
	const payload = payloadBuilder({ photos, params });

	const tag = (err) => Object.assign(err, { spaceSlug: space, apiName: api });

	// Step 1 — POST /call/<api> to enqueue. Returns event_id.
	let queueRes;
	try {
		queueRes = await fetch(`${spaceUrl}/call/${api}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ data: payload }),
		});
	} catch (err) {
		throw tag(Object.assign(new Error(`enqueue failed: ${err?.message}`), {
			code: 'provider_unreachable',
			status: 502,
		}));
	}
	if (!queueRes.ok) {
		const body = await queueRes.text().catch(() => '');
		throw tag(Object.assign(
			new Error(`enqueue ${queueRes.status}: ${body.slice(0, 200)}`),
			{ code: 'provider_error', status: 502, providerStatus: queueRes.status },
		));
	}
	const queueBody = await queueRes.json().catch(() => ({}));
	const eventId = queueBody?.event_id;
	if (!eventId) {
		throw tag(Object.assign(new Error('no event_id returned'), { code: 'provider_error', status: 502 }));
	}

	// Step 2 — GET /call/<api>/<event_id> SSE; block until complete.
	let streamRes;
	try {
		streamRes = await fetch(`${spaceUrl}/call/${api}/${eventId}`, {
			headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
		});
	} catch (err) {
		throw tag(Object.assign(new Error(`SSE GET failed: ${err?.message}`), {
			code: 'provider_unreachable',
			status: 502,
		}));
	}

	const output = await consumeSseUntilComplete(streamRes).catch((err) => {
		throw tag(err);
	});

	const glbCandidates = extractFirstGlbCandidates(output, spaceUrl);
	if (!glbCandidates) {
		throw tag(Object.assign(new Error('no GLB in output'), { code: 'provider_error', status: 502 }));
	}

	// Re-host the ephemeral gradio temp file to durable storage right now, while
	// it's freshest, so no consumer ever re-fetches the expiring Space URL. When
	// storage is configured this returns a durable URL or throws (the asset is
	// already gone / unwritable). A throw is tagged as this Space's failure so the
	// failover loop advances to the next Space and regenerates rather than handing
	// back a URL that will 404 downstream. When storage is unconfigured it returns
	// null and we keep the raw URL — the only option where there's nowhere durable.
	let durableUrl;
	try {
		durableUrl = await rehostGlbToR2(glbCandidates, token);
	} catch (err) {
		throw tag(Object.assign(
			new Error(`GLB produced but not persistable: ${err?.message}`),
			{ code: 'rehost_failed', status: err?.status || 502, cause: err },
		));
	}

	return { resultGlbUrl: durableUrl || glbCandidates[0], space, api };
}

export function createRegenProvider() {
	const token = readEnv('HF_TOKEN');
	if (!token) {
		throw Object.assign(new Error('HF_TOKEN env var is required for the huggingface provider'), {
			code: 'provider_unconfigured',
			status: 501,
		});
	}

	const chain = resolveChain();
	if (chain.length === 0) {
		throw Object.assign(new Error('huggingface failover chain is empty'), {
			code: 'provider_unconfigured',
			status: 501,
		});
	}

	return {
		async submit(request) {
			if (request.mode !== 'reconstruct') {
				throw Object.assign(
					new Error(`huggingface provider only supports mode "reconstruct" (got "${request.mode}")`),
					{ code: 'mode_unconfigured', status: 501 },
				);
			}

			const photos = Array.isArray(request.params?.images) ? request.params.images : [];
			if (photos.length === 0) {
				throw Object.assign(new Error('huggingface provider needs at least one input image'), {
					code: 'invalid_input',
					status: 400,
				});
			}

			// Try each Space in order. Capture per-Space errors so the final
			// failure message tells the operator which Spaces were tried and
			// why each failed — debugging "Avatar engine not available" without
			// this is painful.
			const failures = [];
			for (const target of chain) {
				try {
					const { resultGlbUrl, space, api } = await runOnSpace({
						token,
						target,
						photos,
						params: request.params,
					});
					return {
						extJobId: packExtJobId({ resultGlbUrl, space, api, fellBackFrom: failures.map((f) => f.space) }),
						eta: 0,
						rawStatus: 'completed',
						providerNote: failures.length
							? `succeeded on ${space} after ${failures.length} failover(s): ${failures.map((f) => `${f.space} (${f.message})`).join('; ')}`
							: undefined,
					};
				} catch (err) {
					failures.push({
						space: err.spaceSlug || target.space,
						api: err.apiName || target.api,
						message: err.message || 'unknown error',
						status: err.status,
					});
					// Continue to next Space.
				}
			}

			const summary = failures
				.map((f) => `${f.space} → ${f.message}`)
				.join(' | ');
			throw Object.assign(
				new Error(`all ${chain.length} huggingface Space(s) failed: ${summary}`),
				{ code: 'all_providers_failed', status: 502, failures },
			);
		},

		async status(extJobId) {
			const payload = unpackExtJobId(extJobId);
			if (!payload?.resultGlbUrl) {
				return { status: 'failed', error: 'missing or malformed ext_job_id' };
			}
			return {
				status: 'done',
				rawStatus: 'completed',
				resultGlbUrl: payload.resultGlbUrl,
			};
		},
	};
}
