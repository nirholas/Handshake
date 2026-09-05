// The one place this extension talks to the three.ws studio.
//
// Everything goes through POST /api/mcp-studio, the public JSON-RPC endpoint
// behind the free text to 3D lane: no API key, no account, no payment. The
// origin is a setting so the same code drives a local dev server or a preview
// deployment without a rebuild.

/** Tools this extension calls, with the argument each one takes. */
export const TOOLS = Object.freeze({
	model: 'forge_free',
	avatar: 'text_to_avatar',
	rig: 'rig_mesh',
	refine: 'refine_model',
	check: 'check_job',
});

/**
 * Pull the model out of a tools/call result.
 *
 * The studio answers with `structuredContent` when it has a model, and with
 * `content[]` text blocks when it has something to say instead (a refusal, a
 * provider error). Both shapes are handled so a lane change upstream degrades
 * to a readable message rather than "undefined".
 *
 * @param {any} result
 * @returns {{ glbUrl: string, viewerUrl?: string, format?: string, prompt?: string }}
 */
export function readModelResult(result) {
	if (!result || typeof result !== 'object') {
		throw new Error('the studio returned an empty response');
	}
	const structured = result.structuredContent;
	const glbUrl = structured?.glbUrl || structured?.glb_url;
	if (typeof glbUrl === 'string' && /^https?:\/\//.test(glbUrl)) {
		return {
			glbUrl,
			viewerUrl: structured.viewerUrl || structured.viewer_url,
			format: structured.format || 'glb',
			prompt: structured.prompt,
		};
	}
	const text = textOf(result);
	if (result.isError) throw new Error(text || 'the studio refused the request');
	// A successful call with no model is still a failure for the caller; surface
	// whatever the studio said rather than an empty viewer.
	throw new Error(text || 'the studio returned no model URL');
}

/** Join every text block of an MCP result into one message. */
export function textOf(result) {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	return blocks
		.map((b) => (typeof b?.text === 'string' ? b.text.trim() : ''))
		.filter(Boolean)
		.join('\n')
		.slice(0, 2000);
}

/**
 * Call one studio tool and return its model.
 *
 * @param {string} origin
 * @param {string} name tool name, see TOOLS
 * @param {Record<string, unknown>} args
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 */
export async function callTool(origin, name, args, opts = {}) {
	const body = {
		jsonrpc: '2.0',
		id: Date.now(),
		method: 'tools/call',
		params: { name, arguments: args },
	};
	const payload = await rpc(origin, body, opts);
	return readModelResult(payload.result);
}

/** Raw JSON-RPC call with a timeout, an abort hook, and readable errors. */
export async function rpc(origin, body, { signal, timeoutMs = 6 * 60_000 } = {}) {
	const url = new URL('/api/mcp-studio', normalizeOrigin(origin)).href;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener('abort', onAbort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let res;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (err) {
		if (controller.signal.aborted && !signal?.aborted) {
			throw new Error(`the studio did not answer within ${Math.round(timeoutMs / 1000)}s`);
		}
		throw new Error(`could not reach ${url}: ${err?.message || err}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}

	const text = await res.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`the studio returned ${res.status} with a non-JSON body`);
	}
	if (payload.error) {
		throw new Error(payload.error.message || `the studio returned error ${payload.error.code}`);
	}
	if (!res.ok) {
		throw new Error(`the studio returned HTTP ${res.status}`);
	}
	return payload;
}

/** Trim a trailing slash and reject anything that is not an http(s) origin. */
export function normalizeOrigin(raw) {
	const origin = String(raw || '').trim().replace(/\/+$/, '');
	if (!/^https?:\/\//.test(origin)) {
		throw new Error(`threews3d.origin must be an http(s) origin, got "${raw}"`);
	}
	return origin;
}
