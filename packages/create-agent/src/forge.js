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
	const glbUrl = structured?.glbUrl || structured?.riggedGlbUrl || structured?.modelUrl;
	if (!glbUrl) {
		throw new ForgeError('the forge answered without a model URL', { code: 'no_model' });
	}
	return {
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
		const result = readForgeResult(await res.json(), {
			kind: tool === 'forge_avatar' ? 'avatar' : 'model',
		});
		onProgress({
			phase: 'done',
			elapsedMs: Date.now() - startedAt,
			message: 'model ready',
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
