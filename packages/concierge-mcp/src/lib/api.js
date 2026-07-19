// Real HTTP access to the three.ws Concierge API and to arbitrary web pages
// concierge_ask grounds its answers in. No mocks, no fixtures, every call is a
// live request. Errors are normalized into a single shape so tool handlers can
// surface a clean message + status to the MCP client.

import { THREE_WS_BASE, HTTP_TIMEOUT_MS, PAGE_FETCH_TIMEOUT_MS, USER_AGENT } from '../config.js';

const MAX_PAGE_BYTES = 2_000_000; // never buffer more than ~2MB of HTML

/**
 * Fetch a web page's HTML for grounding. Follows redirects (fetch default),
 * enforces a byte cap and timeout, and rejects non-HTML responses.
 * @param {string} url  http(s) URL
 * @returns {Promise<string>} the HTML text (truncated to the byte cap)
 */
export async function fetchPage(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw Object.assign(new Error(`not a valid URL: ${url}`), { code: 'bad_request' });
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw Object.assign(new Error(`only http(s) URLs are supported (got ${parsed.protocol})`), {
			code: 'bad_request',
		});
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(parsed, {
			headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
			signal: controller.signal,
			redirect: 'follow',
		});
	} catch (err) {
		clearTimeout(timer);
		if (err?.name === 'AbortError') {
			throw Object.assign(new Error(`fetching ${url} timed out after ${PAGE_FETCH_TIMEOUT_MS}ms`), {
				code: 'timeout',
			});
		}
		throw Object.assign(new Error(`failed to fetch ${url}: ${err?.message || err}`), {
			code: 'network_error',
		});
	}
	clearTimeout(timer);

	if (!res.ok) {
		throw Object.assign(new Error(`${url} returned HTTP ${res.status}`), {
			code: 'upstream_error',
			status: res.status,
		});
	}
	const ct = res.headers.get('content-type') || '';
	if (ct && !/html|xml|text\/plain/i.test(ct)) {
		throw Object.assign(new Error(`${url} is not an HTML page (content-type: ${ct})`), {
			code: 'unsupported_media',
		});
	}

	// Read with a byte cap so a giant page can't exhaust memory.
	const reader = res.body?.getReader();
	if (!reader) return await res.text();
	const decoder = new TextDecoder();
	let html = '';
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.length;
		html += decoder.decode(value, { stream: true });
		if (bytes >= MAX_PAGE_BYTES) {
			try {
				await reader.cancel();
			} catch {
				/* already closed */
			}
			break;
		}
	}
	html += decoder.decode();
	return html;
}

/**
 * Ask the three.ws Concierge a question and accumulate the streamed answer.
 * Posts the same body the browser widget posts and reads the SSE response.
 *
 * @param {{ question: string, site: object,
 *          history?: {role:'user'|'assistant', content:string}[],
 *          persona?: string, lang?: string }} params
 * @returns {Promise<{ answer: string, provider: string|null, model: string|null }>}
 */
export async function askConcierge({ question, site, history = [], persona, lang }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(`${THREE_WS_BASE}/api/concierge`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'text/event-stream',
				'user-agent': USER_AGENT,
			},
			body: JSON.stringify({ message: question, history, site, persona, lang }),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (err?.name === 'AbortError') {
			throw Object.assign(new Error(`concierge answer timed out after ${HTTP_TIMEOUT_MS}ms`), {
				code: 'timeout',
			});
		}
		throw Object.assign(new Error(`concierge request failed: ${err?.message || err}`), {
			code: 'network_error',
		});
	}

	if (!res.ok) {
		clearTimeout(timer);
		let detail = '';
		try {
			detail = (await res.json())?.message || '';
		} catch {
			/* non-JSON error body */
		}
		throw Object.assign(new Error(detail || `concierge returned HTTP ${res.status}`), {
			code: 'upstream_error',
			status: res.status,
		});
	}

	// Read the SSE stream: accumulate `chunk` text, capture `done` metadata.
	let answer = '';
	let provider = null;
	let model = null;
	let streamError = null;
	let buf = '';
	const decoder = new TextDecoder();
	const reader = res.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const data = frame
					.split('\n')
					.filter((l) => l.startsWith('data:'))
					.map((l) => l.slice(5).trim())
					.join('\n');
				if (!data || data === '[DONE]') continue;
				let evt;
				try {
					evt = JSON.parse(data);
				} catch {
					continue;
				}
				if (evt.type === 'chunk' && typeof evt.text === 'string') answer += evt.text;
				else if (evt.type === 'done') {
					provider = evt.provider ?? provider;
					model = evt.model ?? model;
				} else if (evt.type === 'error') {
					streamError = evt.error || 'concierge stream error';
				}
			}
		}
	} finally {
		clearTimeout(timer);
	}

	if (streamError && !answer) {
		throw Object.assign(new Error(streamError), { code: 'stream_error' });
	}
	return { answer: answer.trim(), provider, model };
}
