/**
 * The three.ws forge, over the public JSON-RPC endpoint.
 *
 * `https://three.ws/api/mcp-studio` is open: no key, no account, no signup. The
 * platform's own provider keys cover the cost, which is what makes
 * `npm create @three-ws/agent "a knight"` work on a machine that has never
 * heard of three.ws.
 *
 * Two tools are used here:
 *   forge_avatar  a humanoid character, generated and then rigged (a skeleton,
 *                 so it can be posed and animated)
 *   forge_free    any other object or prop, mesh only, on the free lane
 *
 * Both are long jobs: the call blocks server-side until the model exists. That
 * is why every request carries an explicit deadline and the caller gets real
 * elapsed-time progress rather than a fake bar.
 */

export const FORGE_ORIGIN = 'https://three.ws';
const RPC_PATH = '/api/mcp-studio';

// Generation genuinely takes minutes on the high tier. The deadline is long,
// but it exists: a hung socket must fail with an explanation, not sit forever.
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 15_000;

export class ForgeError extends Error {
	constructor(message, { code = 'forge_failed', cause } = {}) {
		super(message);
		this.name = 'ForgeError';
		this.code = code;
		if (cause) this.cause = cause;
	}
}

/** The tool's human-readable line, when it sent one. */
function textOf(result) {
	const text = result?.content?.find?.((c) => c?.type === 'text')?.text;
	return typeof text === 'string' ? text.split('\n')[0] : '';
}

/**
 * Normalize whatever the tool returned into one shape.
 * Exported because it is the part worth testing without a network.
 */
export function readForgeResult(body, { kind }) {
	if (body?.error) {
		throw new ForgeError(body.error.message || 'the forge refused the request', {
			code: 'rpc_error',
		});
	}
	const result = body?.result;
	const structured = result?.structuredContent || result;

	// A generation that outlives the endpoint's inline wait hands back a public
	// poll handle instead of a model. That is the NORMAL path for a rigged
	// character (generate plus rig is minutes of GPU time), not an error: collect
	// the job rather than failing the command.
	if (structured?.status === 'pending' && structured.jobId) {
		return {
			pending: true,
			jobId: structured.jobId,
			pollUrl: structured.pollUrl,
			stage: structured.stage || 'mesh',
			etaSeconds: Number(structured.etaRemainingSeconds) || null,
		};
	}
	if (result?.isError) {
		throw new ForgeError(textOf(result) || 'the forge could not build that', { code: 'tool_error' });
	}

	const glbUrl = structured?.glbUrl || structured?.riggedGlbUrl || structured?.modelUrl;
	if (!glbUrl) {
		throw new ForgeError(textOf(result) || 'the forge answered without a model URL', {
			code: 'no_model',
		});
	}
	return {
		pending: false,
		kind: structured.kind || kind,
		glbUrl,
		meshUrl: structured.meshUrl || null,
		viewerUrl: structured.viewerUrl || `${FORGE_ORIGIN}/viewer?src=${encodeURIComponent(glbUrl)}`,
		studioUrl: structured.studioUrl || structured.poseUrl || null,
		rigged: Boolean(structured.rigged ?? kind === 'avatar'),
		backend: structured.backend || null,
		durationMs: Number(structured.durationMs) || null,
	};
}

/**
 * Call one forge tool and wait for the model.
 *
 * @param {object} opts
 * @param {'forge_avatar'|'forge_free'} opts.tool
 * @param {object} opts.args tool arguments
 * @param {(event:{phase:string, elapsedMs:number, message:string}) => void} [opts.onProgress]
 * @param {string} [opts.origin]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal]
 */
export async function callForge({
	tool,
	args,
	onProgress = () => {},
	origin = FORGE_ORIGIN,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	fetchImpl,
	signal,
}) {
	const doFetch = fetchImpl || globalThis.fetch;
	if (typeof doFetch !== 'function') throw new ForgeError('no fetch implementation available');

	const startedAt = Date.now();
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener('abort', onAbort, { once: true });
	const deadline = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

	// The job runs server-side inside one request, so there is no poll to report.
	// A heartbeat with real elapsed seconds is the honest alternative to a
	// progress bar that is making its numbers up.
	const heartbeat = setInterval(() => {
		onProgress({
			phase: 'working',
			elapsedMs: Date.now() - startedAt,
			message: describeWait(Date.now() - startedAt, tool),
		});
	}, HEARTBEAT_MS);

	onProgress({ phase: 'submitted', elapsedMs: 0, message: 'sent to the three.ws forge' });

	try {
		const res = await doFetch(new URL(RPC_PATH, origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: tool, arguments: args },
			}),
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new ForgeError(`three.ws answered ${res.status}`, { code: `http_${res.status}` });
		}
		const kind = tool === 'forge_avatar' ? 'avatar' : 'model';
		let result = readForgeResult(await res.json(), { kind });

		if (result.pending) {
			clearInterval(heartbeat);
			result = await collectJob(result, {
				kind,
				doFetch,
				origin,
				signal: controller.signal,
				startedAt,
				onProgress,
			});
		}

		onProgress({
			phase: 'done',
			elapsedMs: Date.now() - startedAt,
			message: result.rigged ? 'rigged model ready' : 'model ready',
		});
		return result;
	} catch (err) {
		if (err instanceof ForgeError) throw err;
		if (controller.signal.aborted) {
			throw new ForgeError(
				`the forge did not answer within ${Math.round(timeoutMs / 1000)}s. The job may still finish: check https://three.ws/creations`,
				{ code: 'timeout', cause: err },
			);
		}
		throw new ForgeError(`could not reach three.ws: ${err?.message || err}`, {
			code: 'unreachable',
			cause: err,
		});
	} finally {
		clearInterval(heartbeat);
		clearTimeout(deadline);
		signal?.removeEventListener('abort', onAbort);
	}
}


// How often to ask a running job whether it is done. Long enough that a
// ten-minute render is a handful of requests, short enough that the CLI reacts
// within a few seconds of the model landing.
const POLL_EVERY_MS = 5000;

/**
 * Collect a job that outlived the endpoint's inline wait.
 *
 * `stage` says what the job produces: a bare `mesh` (which still needs rigging)
 * or the finished `rig`. Returning a T-posed mesh to someone who asked for a
 * rigged character would be the quiet kind of wrong, so the mesh case is rigged
 * here rather than reported as done.
 */
async function collectJob(pending, { kind, doFetch, origin, signal, startedAt, onProgress }) {
	let job = pending;
	let glbUrl = await pollUntilDone(job, { doFetch, signal, startedAt, onProgress });

	if (kind === 'avatar' && job.stage === 'mesh') {
		onProgress({
			phase: 'working',
			elapsedMs: Date.now() - startedAt,
			message: 'mesh done, adding the skeleton',
		});
		const res = await doFetch(new URL(RPC_PATH, origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'rig_mesh', arguments: { glb_url: glbUrl } },
			}),
			signal,
		});
		if (!res.ok) throw new ForgeError(`three.ws answered ${res.status}`, { code: `http_${res.status}` });
		const rigResult = readForgeResult(await res.json(), { kind: 'avatar' });
		if (!rigResult.pending) return { ...rigResult, rigged: true };
		job = rigResult;
		glbUrl = await pollUntilDone(job, { doFetch, signal, startedAt, onProgress });
	}

	return {
		pending: false,
		kind,
		glbUrl,
		meshUrl: null,
		viewerUrl: `${FORGE_ORIGIN}/viewer?src=${encodeURIComponent(glbUrl)}`,
		studioUrl: null,
		rigged: kind === 'avatar',
		backend: null,
		durationMs: Date.now() - startedAt,
	};
}

async function pollUntilDone(job, { doFetch, signal, startedAt, onProgress }) {
	const pollUrl = job.pollUrl || `${FORGE_ORIGIN}/api/gpt-forge?job=${encodeURIComponent(job.jobId)}`;
	for (;;) {
		if (signal?.aborted) throw new ForgeError('the wait was cancelled', { code: 'timeout' });
		await sleep(POLL_EVERY_MS, signal);
		const res = await doFetch(pollUrl, { headers: { accept: 'application/json' }, signal });
		if (!res.ok) throw new ForgeError(`the job endpoint answered ${res.status}`, { code: `http_${res.status}` });
		const body = await res.json();
		const status = String(body?.status || '').toLowerCase();
		if (status === 'done' || status === 'succeeded' || status === 'completed') {
			const url = body.glb_url || body.glbUrl;
			if (!url) throw new ForgeError('the job finished without a model URL', { code: 'no_model' });
			return url;
		}
		if (status === 'error' || status === 'failed' || status === 'canceled') {
			throw new ForgeError(body?.error || body?.message || 'the job failed', { code: 'job_failed' });
		}
		onProgress({
			phase: 'working',
			elapsedMs: Date.now() - startedAt,
			message: describeJobWait(job, Date.now() - startedAt),
		});
	}
}

function describeJobWait(job, elapsedMs) {
	const s = Math.round(elapsedMs / 1000);
	const what = job.stage === 'rig' ? 'rigging' : 'sculpting the mesh';
	return `${what} (${s}s)`;
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				reject(new ForgeError('the wait was cancelled', { code: 'timeout' }));
			},
			{ once: true },
		);
	});
}

function describeWait(elapsedMs, tool) {
	const s = Math.round(elapsedMs / 1000);
	if (tool === 'forge_avatar') {
		if (s < 45) return `generating the figure (${s}s)`;
		if (s < 120) return `generating the figure, then the skeleton (${s}s)`;
		return `still working (${s}s). Rigging is the slow half`;
	}
	return `generating geometry and texture (${s}s)`;
}

/**
 * Download the model bytes. Returns the buffer and its size; the caller decides
 * where to put it.
 */
export async function downloadModel(url, { fetchImpl, timeoutMs = 120_000 } = {}) {
	const doFetch = fetchImpl || globalThis.fetch;
	const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch((err) => {
		throw new ForgeError(`could not download the model: ${err?.message || err}`, {
			code: 'download_failed',
			cause: err,
		});
	});
	if (!res.ok) {
		throw new ForgeError(`the model URL answered ${res.status}`, { code: `http_${res.status}` });
	}
	const bytes = Buffer.from(await res.arrayBuffer());
	if (!bytes.length) throw new ForgeError('the model URL returned an empty file', { code: 'empty' });
	return bytes;
}
