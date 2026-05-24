/**
 * data-reactive — declarative wiring of a live data source to the protocol bus.
 *
 * Sources: sse (fetch-based stream, captures named events), ws (with exponential
 * reconnect), poll (setInterval + fetch). Bindings classify each event and return
 * protocol actions to fire.
 */

const MAX_WS_RETRIES = 10;
const WS_BACKOFF_CAP_MS = 30_000;

/**
 * Run all bindings against one parsed event, forwarding matched actions to protocol.
 * @param {import('../agent-protocol.js').AgentProtocol} protocol
 * @param {import('./data-reactive.js').ReactiveBinding[]} bindings
 * @param {any} event
 * @param {{ received: number, emitted: number, errors: number }} stats
 */
function applyBindings(protocol, bindings, event, stats) {
	stats.received++;
	for (const { match, emit } of bindings) {
		if (!match(event)) continue;
		for (const { type, payload } of emit(event)) {
			protocol.emit({ type, payload });
			stats.emitted++;
		}
	}
}

// ── SSE ──────────────────────────────────────────────────────────────────────

/**
 * Reads an SSE stream via fetch so named events (event: <type>) are captured
 * alongside default message events — EventSource requires per-type listeners
 * and can't wildcard, whereas fetch body streaming sees every frame.
 */
async function consumeSSE(url, protocol, bindings, stats, signal) {
	const response = await fetch(url, {
		headers: { Accept: 'text/event-stream' },
		signal,
	});
	if (!response.ok) throw new Error(`[data-reactive] SSE fetch failed: ${response.status}`);

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });

		// SSE frames are separated by double newlines
		const frames = buf.split('\n\n');
		buf = frames.pop(); // keep any incomplete trailing frame

		for (const frame of frames) {
			if (!frame.trim()) continue;
			let data = null;
			for (const line of frame.split('\n')) {
				if (line.startsWith('data:')) data = line.slice(5).trimStart();
			}
			if (data === null) continue;
			let parsed;
			try {
				parsed = JSON.parse(data);
			} catch {
				stats.errors++;
				continue;
			}
			applyBindings(protocol, bindings, parsed, stats);
		}
	}
}

function startSSE(url, protocol, bindings, stats, signal) {
	const ac = new AbortController();
	if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });

	consumeSSE(url, protocol, bindings, stats, ac.signal).catch((err) => {
		if (err?.name !== 'AbortError') console.error('[data-reactive] SSE error:', err);
	});

	return () => ac.abort();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function startWS(url, subscribePayloads, reconnectBaseMs, protocol, bindings, stats, signal) {
	let ws = null;
	let attempt = 0;
	let stopped = false;
	let reconnectTimer = null;

	function connect() {
		if (stopped) return;
		ws = new WebSocket(url);

		ws.addEventListener('open', () => {
			attempt = 0;
			if (!subscribePayloads) return;
			const payloads = Array.isArray(subscribePayloads)
				? subscribePayloads
				: [subscribePayloads];
			for (const p of payloads) ws.send(JSON.stringify(p));
		});

		ws.addEventListener('message', (e) => {
			let parsed;
			try {
				parsed = JSON.parse(e.data);
			} catch {
				stats.errors++;
				return;
			}
			applyBindings(protocol, bindings, parsed, stats);
		});

		ws.addEventListener('error', (e) => {
			console.error('[data-reactive] WS error:', e.message ?? e);
			stats.errors++;
		});

		ws.addEventListener('close', () => {
			if (stopped) return;
			attempt++;
			if (attempt > MAX_WS_RETRIES) {
				console.error('[data-reactive] WS max retries reached, giving up');
				return;
			}
			const delay = Math.min(reconnectBaseMs * 2 ** (attempt - 1), WS_BACKOFF_CAP_MS);
			reconnectTimer = setTimeout(connect, delay);
		});
	}

	connect();
	if (signal) signal.addEventListener('abort', stop, { once: true });

	function stop() {
		stopped = true;
		clearTimeout(reconnectTimer);
		if (ws) {
			ws.close();
			ws = null;
		}
	}

	return stop;
}

// ── Poll ──────────────────────────────────────────────────────────────────────

function startPoll(url, intervalMs, parseFn, protocol, bindings, stats, signal) {
	const defaultParse = (r) => r.json().then((d) => (Array.isArray(d) ? d : [d]));
	const parse = parseFn ?? defaultParse;
	let stopped = false;

	const tick = () => {
		if (stopped) return;
		fetch(url)
			.then((r) => parse(r))
			.then((items) => {
				for (const item of items) applyBindings(protocol, bindings, item, stats);
			})
			.catch((err) => {
				if (err?.name !== 'AbortError') {
					console.error('[data-reactive] poll error:', err);
					stats.errors++;
				}
			});
	};

	// Fire immediately so callers don't wait an entire intervalMs for the first
	// payload — the recurring schedule kicks in after this first tick.
	tick();
	const timer = setInterval(tick, intervalMs);

	function stop() {
		stopped = true;
		clearInterval(timer);
	}

	if (signal) signal.addEventListener('abort', stop, { once: true });

	return stop;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ReactiveBinding
 * @property {(event: any) => boolean} match  — predicate run on each parsed event
 * @property {(event: any) => Array<{type: string, payload: object}>} emit — protocol actions to fire
 */

/**
 * Wire a live data source to the agent protocol bus.
 *
 * @param {Object} opts
 * @param {import('../agent-protocol.js').AgentProtocol} opts.protocol
 * @param {{ kind: 'sse', url: string } |
 *         { kind: 'ws',  url: string, subscribe?: object|object[], reconnectBaseMs?: number } |
 *         { kind: 'poll', url: string, intervalMs: number, parse?: (resp: Response) => Promise<any[]> }} opts.source
 * @param {ReactiveBinding[]} opts.bindings
 * @param {AbortSignal} [opts.signal]
 * @returns {{ stop: () => void, stats: () => { received: number, emitted: number, errors: number } }}
 */
export function startDataReactive({ protocol, source, bindings, signal }) {
	const stats = { received: 0, emitted: 0, errors: 0 };
	let _stop;

	switch (source.kind) {
		case 'sse':
			_stop = startSSE(source.url, protocol, bindings, stats, signal);
			break;
		case 'ws':
			_stop = startWS(
				source.url,
				source.subscribe ?? null,
				source.reconnectBaseMs ?? 1000,
				protocol,
				bindings,
				stats,
				signal,
			);
			break;
		case 'poll':
			_stop = startPoll(
				source.url,
				source.intervalMs,
				source.parse ?? null,
				protocol,
				bindings,
				stats,
				signal,
			);
			break;
		default:
			throw new Error(`[data-reactive] unknown source kind: ${source.kind}`);
	}

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		_stop();
	};

	return { stop, stats: () => ({ ...stats }) };
}
