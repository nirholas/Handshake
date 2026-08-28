// Sources: where messages come from.
//
// A source is an object `{ name, start(emit) => stop }`. It calls `emit(raw)`
// with anything message-shaped (the rules engine's `toMessage` normalises it)
// and returns a function that tears itself down. That is the entire contract,
// so an integrator can write one in five lines for a feed nobody here has
// heard of, and the three below cover almost everything else:
//
//   pollSource  any JSON endpoint, on an interval, with visibility backoff
//   sseSource   any EventSource endpoint (server-sent events)
//   railSource  the three.ws delivery rail: your terminal, CI, or an agent
//               POSTs, and the browser you are looking at says it out loud

/**
 * Poll a JSON endpoint and emit what it returns.
 *
 * Polling stops while the tab is hidden and resumes (with an immediate read) on
 * return, because a poll nobody is looking at is a request nobody needed.
 *
 * @param {object} opts
 * @param {string} opts.url endpoint returning an array, or an object with an array
 * @param {number} [opts.intervalMs=30000]
 * @param {(body:any)=>any[]} [opts.select] pull the array out of the response
 * @param {(item:any)=>any} [opts.map] shape one item into a message
 * @param {RequestInit} [opts.fetchOptions] credentials, headers, and the rest
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function pollSource({
	url,
	intervalMs = 30_000,
	select = defaultSelect,
	map = (x) => x,
	fetchOptions = { credentials: 'include' },
	fetchImpl = globalThis.fetch?.bind(globalThis),
}) {
	return {
		name: `poll:${url}`,
		start(emit) {
			let timer = 0;
			let stopped = false;

			const tick = async () => {
				if (stopped) return;
				try {
					const res = await fetchImpl(url, fetchOptions);
					if (res.ok) {
						const body = await res.json();
						for (const item of select(body) || []) emit(map(item));
					}
				} catch {
					/* a network blip is not an error worth surfacing to a human */
				}
				schedule();
			};

			const schedule = () => {
				clearTimeout(timer);
				if (stopped) return;
				timer = setTimeout(tick, intervalMs);
			};

			const onVisibility = () => {
				if (globalThis.document?.visibilityState === 'visible') tick();
				else clearTimeout(timer);
			};
			globalThis.document?.addEventListener?.('visibilitychange', onVisibility);

			tick();
			return () => {
				stopped = true;
				clearTimeout(timer);
				globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
			};
		},
	};
}

function defaultSelect(body) {
	if (Array.isArray(body)) return body;
	for (const key of ['messages', 'items', 'notifications', 'events', 'data']) {
		if (Array.isArray(body?.[key])) return body[key];
	}
	return [];
}

/**
 * Subscribe to a server-sent-events endpoint.
 * @param {object} opts
 * @param {string} opts.url
 * @param {string[]} [opts.events=['message']] event names to listen for
 * @param {boolean} [opts.withCredentials=true]
 * @param {(data:any)=>any} [opts.map]
 * @param {typeof EventSource} [opts.EventSourceImpl]
 */
export function sseSource({
	url,
	events = ['message'],
	withCredentials = true,
	map = (x) => x,
	EventSourceImpl = globalThis.EventSource,
}) {
	return {
		name: `sse:${url}`,
		start(emit) {
			if (!EventSourceImpl) return () => {};
			const es = new EventSourceImpl(url, { withCredentials });
			const handler = (e) => {
				let payload = e.data;
				try {
					payload = JSON.parse(e.data);
				} catch {
					/* a plain string line is a valid message */
				}
				emit(map(payload));
			};
			for (const name of events) es.addEventListener(name, handler);
			return () => {
				for (const name of events) es.removeEventListener(name, handler);
				es.close();
			};
		},
	};
}

/**
 * The three.ws delivery rail.
 *
 * Anything that can make an HTTPS request (a deploy script, a CI job, a cron,
 * an AI agent holding an API key) POSTs to /api/herald/announce, and this
 * source hands it to the avatar in the browser the human is actually looking
 * at. The stream is per-account and session-authenticated: nobody can address
 * your avatar but you and the keys you issued.
 *
 * @param {object} [opts]
 * @param {string} [opts.origin='https://three.ws'] rail origin
 * @param {typeof EventSource} [opts.EventSourceImpl]
 */
export function railSource({ origin = 'https://three.ws', EventSourceImpl } = {}) {
	const base = String(origin || '').replace(/\/$/, '');
	const source = sseSource({
		url: `${base}/api/herald/stream`,
		events: ['announce'],
		EventSourceImpl,
	});
	return { ...source, name: 'rail' };
}

/**
 * A source fed by hand. `herald.announce()` uses one of these internally; it is
 * exported because bridging an in-page event bus is a two-liner with it.
 */
export function manualSource() {
	let push = null;
	const pending = [];
	return {
		name: 'manual',
		start(emit) {
			push = emit;
			while (pending.length) emit(pending.shift());
			return () => {
				push = null;
			};
		},
		/** Feed a message in. Safe before start(): it is queued, not lost. */
		send(message) {
			if (push) push(message);
			else pending.push(message);
		},
	};
}
