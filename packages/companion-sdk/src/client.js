/*
 * The companion client: push a message in, listen for deliveries out.
 *
 * Isomorphic on purpose. In a browser it uses the platform `fetch` and
 * `EventSource`; in Node 18+ it uses the built-in `fetch` and its own SSE
 * reader over the response body (Node has no EventSource), so the same object
 * works in a page, in an Electron renderer, in a CLI, and in a worker.
 *
 *   import { createCompanionClient } from '@three-ws/companion';
 *
 *   const companion = createCompanionClient({ token: process.env.COMPANION_TOKEN });
 *
 *   await companion.send({ title: 'Build finished', sender: 'CI', priority: 'high' });
 *
 *   const stop = companion.stream({
 *     onDelivery: (d) => console.log(`${d.speaker}: ${d.spoken_line}`),
 *   });
 *
 * The token is the bridge token from three.ws/companion. It can post messages
 * and receive that user's deliveries, and rotating it on that page revokes
 * every device at once. A browser page that already has a signed-in session can
 * omit it entirely and pass `credentials: 'include'` behaviour by default.
 */

const DEFAULT_API_BASE = 'https://three.ws';

class CompanionError extends Error {
	constructor(message, { status = 0, code = null } = {}) {
		super(message);
		this.name = 'CompanionError';
		this.status = status;
		this.code = code;
	}
}

export { CompanionError };

/**
 * @param {object} [options]
 * @param {string} [options.apiBase='https://three.ws'] where the API lives.
 * @param {string} [options.token] bridge token. Omit inside a signed-in page.
 * @param {typeof fetch} [options.fetch] override (tests, proxies, Electron).
 * @param {number} [options.retryMs=3000] reconnect delay for the stream.
 */
export function createCompanionClient({
	apiBase = DEFAULT_API_BASE,
	token = null,
	fetch: fetchImpl = null,
	retryMs = 3000,
} = {}) {
	const base = String(apiBase).replace(/\/+$/, '');
	const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
	if (!doFetch) {
		throw new CompanionError('no fetch implementation: pass one, or run on Node 18+ / a modern browser');
	}

	function headers(extra = {}) {
		return {
			accept: 'application/json',
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...extra,
		};
	}

	async function call(path, { method = 'GET', body = null } = {}) {
		const res = await doFetch(`${base}${path}`, {
			method,
			credentials: token ? 'omit' : 'include',
			headers: headers(body ? { 'content-type': 'application/json' } : {}),
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		const text = await res.text();
		let data = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = null;
			}
		}
		if (!res.ok) {
			throw new CompanionError(data?.message || data?.error || `request failed (${res.status})`, {
				status: res.status,
				code: data?.code || null,
			});
		}
		return data;
	}

	return {
		/**
		 * Hand the companion something to consider. Returns the triage verdict:
		 * what it scored, why, the line it would say, and whether it spoke.
		 *
		 * @param {{ title:string, body?:string, sender?:string, sender_id?:string,
		 *           app?:string, url?:string, id?:string,
		 *           priority?:'high'|'normal'|'low', occurred_at?:string }} event
		 */
		send(event) {
			if (!event?.title) throw new CompanionError('an event needs a title');
			return call('/api/companion/ingest', { method: 'POST', body: event });
		},

		/** Recent deliveries, newest first. */
		list({ limit = 30, before = null, minImportance = 0 } = {}) {
			const params = new URLSearchParams({ limit: String(limit) });
			if (before) params.set('before', before);
			if (minImportance) params.set('min_importance', String(minImportance));
			return call(`/api/companion/events?${params}`);
		},

		/** Say that a body has performed this one, so no other body repeats it. */
		markDelivered(id) {
			return call(`/api/companion/events/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				body: { delivered: true },
			});
		},

		dismiss(id) {
			return call(`/api/companion/events/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				body: { dismissed: true },
			});
		},

		/** The people this companion knows, with the body and voice each one uses. */
		contacts() {
			return call('/api/companion/contacts');
		},

		/** Poll every connected source right now. */
		checkNow() {
			return call('/api/companion/poll', { method: 'POST' });
		},

		/**
		 * Subscribe to live deliveries. Returns a stop function.
		 *
		 * Reconnects on its own with the last delivery's timestamp, so a laptop
		 * that slept wakes up and catches whatever it missed (bounded server side
		 * to the last few hours, because a monologue is not a delivery).
		 *
		 * @param {object} handlers
		 * @param {(delivery:object) => void} handlers.onDelivery
		 * @param {(hello:object) => void} [handlers.onOpen]
		 * @param {(err:Error) => void} [handlers.onError]
		 */
		stream({ onDelivery, onOpen, onError, since = null } = {}) {
			if (typeof onDelivery !== 'function') throw new CompanionError('stream() needs an onDelivery handler');
			let stopped = false;
			let cleanup = () => {};
			let cursor = since;

			const useEventSource = !token && typeof EventSource === 'function';

			const connect = async () => {
				if (stopped) return;
				const url = `${base}/api/companion/stream${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`;

				if (useEventSource) {
					// Same-origin page with a session: the browser's own EventSource
					// handles reconnection and cookie auth for us.
					const source = new EventSource(url, { withCredentials: true });
					cleanup = () => source.close();
					source.addEventListener('hello', (e) => onOpen?.(safeParse(e.data)));
					source.addEventListener('delivery', (e) => {
						const delivery = safeParse(e.data);
						if (!delivery) return;
						cursor = delivery.created_at || cursor;
						onDelivery(delivery);
					});
					source.onerror = () => onError?.(new CompanionError('stream interrupted'));
					return;
				}

				// Token auth (desktop app, CLI, server): EventSource cannot send an
				// Authorization header, so the SSE frames are read off the body.
				const controller = new AbortController();
				cleanup = () => controller.abort();
				try {
					const res = await doFetch(url, { headers: headers({ accept: 'text/event-stream' }), signal: controller.signal });
					if (!res.ok || !res.body) {
						throw new CompanionError(`stream refused (${res.status})`, { status: res.status });
					}
					for await (const frame of readSse(res.body)) {
						if (stopped) break;
						if (frame.event === 'hello') onOpen?.(safeParse(frame.data));
						else if (frame.event === 'delivery') {
							const delivery = safeParse(frame.data);
							if (!delivery) continue;
							cursor = delivery.created_at || cursor;
							onDelivery(delivery);
						} else if (frame.event === 'warning') {
							onError?.(new CompanionError(safeParse(frame.data)?.message || 'stream warning'));
						}
					}
				} catch (err) {
					if (!stopped && err?.name !== 'AbortError') onError?.(err);
				}
				// The server retires a connection every few minutes on purpose;
				// coming straight back is the normal path, not an error path.
				if (!stopped) setTimeout(connect, retryMs);
			};

			connect();
			return () => {
				stopped = true;
				cleanup();
			};
		},
	};
}

function safeParse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Minimal Server-Sent Events reader over a fetch body stream. Yields
 * { event, data } per frame and ignores comments (heartbeats) and retry lines.
 * Exported for anyone writing their own transport on top of the stream.
 */
export async function* readSse(stream) {
	const decoder = new TextDecoder();
	let buffer = '';
	const reader = stream.getReader ? stream.getReader() : null;

	const chunks = reader
		? (async function* () {
			while (true) {
				const { value, done } = await reader.read();
				if (done) return;
				yield value;
			}
		})()
		: stream; // Node streams are async-iterable already.

	for await (const chunk of chunks) {
		buffer += decoder.decode(chunk, { stream: true });
		let index = buffer.indexOf('\n\n');
		while (index !== -1) {
			const raw = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const frame = parseFrame(raw);
			if (frame) yield frame;
			index = buffer.indexOf('\n\n');
		}
	}
}

function parseFrame(raw) {
	let event = 'message';
	const data = [];
	for (const line of raw.split('\n')) {
		if (!line || line.startsWith(':')) continue;
		if (line.startsWith('event:')) event = line.slice(6).trim();
		else if (line.startsWith('data:')) data.push(line.slice(5).trim());
	}
	if (!data.length) return null;
	return { event, data: data.join('\n') };
}
