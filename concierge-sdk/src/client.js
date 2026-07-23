/**
 * Streaming answer client: @three-ws/concierge
 * =============================================
 *
 * POSTs the visitor's question + conversation history + the harvested site
 * snapshot to the answer endpoint and reads the SSE reply incrementally, so
 * tokens render (and speak) as they arrive instead of after the full answer.
 *
 * Wire format (matches /api/concierge on three.ws):
 *   → POST { message, history[], site{...}, shopping?{...}, persona?, lang? }
 *   ← SSE  data: { type: 'chunk', text }   repeated
 *          data: { type: 'done', provider?, model? }
 *          data: { type: 'error', error }
 *
 * Any OpenAI-compatible endpoint can be substituted by hosts that run their
 * own backend, set `endpoint` and keep the same request/SSE contract.
 */

export const DEFAULT_ENDPOINT = 'https://three.ws/api/concierge';

export const MAX_HISTORY_TURNS = 20;
export const MAX_MESSAGE_CHARS = 2000;

/**
 * Parse one SSE frame body (the text after `data: `) into an event object.
 * Returns null for keep-alives / malformed frames, the stream must survive
 * both without surfacing an error to the visitor.
 */
export function parseSseEvent(raw) {
	const s = String(raw || '').trim();
	if (!s || s === '[DONE]') return null;
	try {
		const evt = JSON.parse(s);
		return evt && typeof evt === 'object' ? evt : null;
	} catch {
		return null;
	}
}

/**
 * Incremental SSE buffer: feed it network chunks, get complete events out.
 * Split on blank lines per the SSE spec; multi-line `data:` fields join.
 */
export function createSseBuffer(onEvent) {
	let buf = '';
	return {
		push(text) {
			buf += text;
			let idx;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const data = frame
					.split('\n')
					.filter((l) => l.startsWith('data:'))
					.map((l) => l.slice(5).trim())
					.join('\n');
				const evt = parseSseEvent(data);
				if (evt) onEvent(evt);
			}
		},
	};
}

/**
 * Ask the concierge a question.
 *
 * @param {{ endpoint?: string, message: string,
 *          history?: {role:'user'|'assistant', content:string}[],
 *          site?: object, shopping?: object, persona?: string, lang?: string,
 *          signal?: AbortSignal,
 *          onChunk?: (text:string)=>void }} opts
 * @returns {Promise<{ text: string, provider?: string, model?: string }>}
 */
export async function askConcierge(opts) {
	const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
	const history = (opts.history || [])
		.slice(-MAX_HISTORY_TURNS)
		.map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			message: String(opts.message).slice(0, MAX_MESSAGE_CHARS),
			history,
			site: opts.site || {},
			shopping: opts.shopping || undefined,
			persona: opts.persona || undefined,
			lang: opts.lang || (typeof navigator !== 'undefined' ? navigator.language : undefined),
		}),
		signal: opts.signal,
	});

	if (!res.ok) {
		let detail = '';
		try {
			const body = await res.json();
			detail = body?.error || body?.message || '';
		} catch {
			/* non-JSON error body */
		}
		const err = new Error(detail || `concierge endpoint returned HTTP ${res.status}`);
		err.status = res.status;
		throw err;
	}

	let text = '';
	let meta = {};
	let streamError = null;
	const sse = createSseBuffer((evt) => {
		if (evt.type === 'chunk' && typeof evt.text === 'string') {
			text += evt.text;
			opts.onChunk?.(evt.text);
		} else if (evt.type === 'done') {
			meta = { provider: evt.provider, model: evt.model };
		} else if (evt.type === 'error') {
			streamError = new Error(evt.error || 'concierge stream error');
		}
	});

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		sse.push(decoder.decode(value, { stream: true }));
	}
	sse.push(decoder.decode());

	if (streamError && !text) throw streamError;
	return { text, ...meta };
}
