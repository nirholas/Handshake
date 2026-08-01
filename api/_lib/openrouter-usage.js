// OpenRouter usage accounting for AI SDK routes.
//
// OpenRouter reports what it actually charged for a call in `usage.cost` (USD),
// but only when the request opts in with `usage: { include: true }`. The AI SDK
// has no hook for either half: it neither sends that flag nor surfaces the extra
// usage field. So a /brain turn on a paid vendor mirror (anthropic/claude-opus-5
// and friends) drew real money with no record of it anywhere, which is how the
// platform key's $30 balance drained unnoticed.
//
// This wraps `fetch` for the AI SDK's OpenRouter provider: it injects the opt-in
// on the way out and reads the reported cost on the way back, for both the
// streaming (SSE) and single-JSON shapes. The response handed back to the SDK is
// byte-identical, so streaming behaviour is untouched; the cost is delivered
// out-of-band through the callback.

// Add `usage: { include: true }` to a JSON request body, leaving anything that
// is not a JSON object body untouched.
export function withUsageAccounting(init) {
	const body = init?.body;
	if (typeof body !== 'string') return init;
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return init;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return init;
	if (parsed.usage && typeof parsed.usage === 'object') return init;
	return { ...init, body: JSON.stringify({ ...parsed, usage: { include: true } }) };
}

// Pull `usage.cost` out of one already-decoded payload: a full chat-completion
// JSON body, or one SSE `data:` frame. Returns null when this payload carries no
// cost (every frame before the final usage frame).
function costFromPayload(payload) {
	const cost = payload?.usage?.cost;
	return Number.isFinite(cost) ? cost : null;
}

// Scan a response body for the reported cost. Handles both wire shapes: a plain
// JSON completion, and an SSE stream whose final usage frame carries the cost.
// Returns null when the body has no cost (a free model reports 0, which is a
// real answer and is returned as 0, not null).
export async function readReportedCost(text) {
	const trimmed = String(text || '').trim();
	if (!trimmed) return null;
	if (!trimmed.includes('data:')) {
		try {
			return costFromPayload(JSON.parse(trimmed));
		} catch {
			return null;
		}
	}
	let cost = null;
	for (const line of trimmed.split('\n')) {
		const s = line.trim();
		if (!s.startsWith('data:')) continue;
		const data = s.slice(5).trim();
		if (!data || data === '[DONE]') continue;
		try {
			const c = costFromPayload(JSON.parse(data));
			// Last frame that reports a cost wins: OpenRouter emits usage on the
			// final frame, and a mid-stream frame never carries it.
			if (c !== null) cost = c;
		} catch {
			// A partial or non-JSON frame is not an error here, keep scanning.
		}
	}
	return cost;
}

/**
 * A `fetch` for the AI SDK's OpenRouter provider that meters every call.
 *
 * @param {(costUsd: number) => void} onCost  called once per request that
 *        reports a cost, with the USD amount OpenRouter charged.
 * @param {typeof fetch} baseFetch  injectable for tests.
 */
export function openrouterUsageFetch(onCost, baseFetch = fetch) {
	return async (input, init) => {
		const res = await baseFetch(input, withUsageAccounting(init));
		// Nothing to meter on a failed call, and a body-less response has no usage.
		if (!res.ok || !res.body) return res;
		let mine;
		let theirs;
		try {
			[theirs, mine] = res.body.tee();
		} catch {
			// A non-teeable body (already consumed, or a shim in tests) must never
			// break the request: metering is best-effort, the completion is not.
			return res;
		}
		readAll(mine)
			.then((text) => readReportedCost(text))
			.then((cost) => {
				if (cost !== null) onCost(cost);
			})
			.catch(() => {});
		return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
	};
}

async function readAll(stream) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out + decoder.decode();
}
