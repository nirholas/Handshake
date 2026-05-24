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

// Ordered failover chain. We try each entry in order until one returns a GLB.
// Each entry is { space, api, builder } where builder shapes the Gradio
// payload from the selfie photos. Add new Spaces as they come online; keep
// the most reliable / highest-quality at the top.
//
// Verified targets (2026-05):
//   tencent/Hunyuan3D-2                 — textured GLB via /generation_all
//   tencent/Hunyuan3D-2.1               — successor; same /generation_all shape
//   JeffreyXiang/TRELLIS                — Microsoft TRELLIS, single image
//   stabilityai/TripoSR                 — fast feed-forward, single image
const HF_FAILOVER_CHAIN = [
	{ space: 'tencent/Hunyuan3D-2.1',           api: 'generation_all',  builder: 'hunyuan' },
	{ space: 'tencent/Hunyuan3D-2',             api: 'generation_all',  builder: 'hunyuan' },
	{ space: 'JeffreyXiang/TRELLIS',            api: 'image_to_3d',     builder: 'single' },
	{ space: 'stabilityai/TripoSR',             api: 'predict',         builder: 'single' },
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
	const host = slug.replace(/\//g, '-').toLowerCase();
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

// Walk a Gradio output tree for the first GLB-looking URL. The Space returns
// outputs like:
//   [ { path: "/tmp/x.glb", url: "https://...hf.space/file=/tmp/x.glb", ... },
//     { ...white-mesh file...}, "Output text", {...stats...}, 1234 ]
// We want the *first* file: it's the textured mesh from /generation_all.
function extractFirstGlbUrl(data) {
	const visit = (node) => {
		if (!node) return null;
		if (typeof node === 'string') {
			if (/^https?:\/\/.+\.glb($|\?)/i.test(node)) return node;
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
			if (typeof node.url === 'string' && /\.glb($|\?)/i.test(node.url)) return node.url;
			if (typeof node.path === 'string' && /\.glb($|\?)/i.test(node.path)) return node.path;
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
						errorMessage = dataStr || 'inference reported error';
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
					builder: api === 'image_to_3d' || api === 'predict' ? 'single' : 'hunyuan',
				};
			});
	}
	const legacySpace = readEnv('HF_RECONSTRUCT_SPACE');
	if (legacySpace) {
		const api = readEnv('HF_RECONSTRUCT_API_NAME') || 'generation_all';
		return [{ space: legacySpace, api, builder: api === 'generation_all' ? 'hunyuan' : 'single' }];
	}
	return HF_FAILOVER_CHAIN;
}

// Per-Space payload builders. Map our normalized {photos, params} into the
// argument list that Space's Gradio endpoint expects.
const BUILDERS = {
	hunyuan: ({ photos, params }) => buildHunyuanPayload({ photos, params }),
	single: ({ photos }) => [toFileData(photos[0])],
};

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

	let glbUrl = extractFirstGlbUrl(output);
	if (!glbUrl) {
		throw tag(Object.assign(new Error('no GLB in output'), { code: 'provider_error', status: 502 }));
	}
	if (glbUrl.startsWith('/')) glbUrl = `${spaceUrl}${glbUrl}`;
	else if (!/^https?:\/\//i.test(glbUrl)) glbUrl = `${spaceUrl}/file=${glbUrl}`;

	return { resultGlbUrl: glbUrl, space, api };
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
