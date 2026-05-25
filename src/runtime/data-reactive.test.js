import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AgentProtocol } from '../agent-protocol.js';
import { startDataReactive } from './data-reactive.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Bind a server to an OS-assigned port; resolves with the port number. */
function listen(server) {
	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server.address().port));
	});
}

/** Resolve once `n` protocol events of `type` have been received. */
function waitForEvents(protocol, type, n) {
	return new Promise((resolve) => {
		const events = [];
		protocol.on(type, (action) => {
			events.push(action);
			if (events.length >= n) resolve(events);
		});
	});
}

/** Simple binding that matches every event and forwards it as the given protocol type. */
function passthrough(type) {
	return [{ match: () => true, emit: (e) => [{ type, payload: e }] }];
}

// ── SSE ───────────────────────────────────────────────────────────────────────

describe('startDataReactive — sse', () => {
	it('fires bindings for each named event chunk', async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			});
			res.write('event: mint\ndata: {"symbol":"AAA","price":1}\n\n');
			res.write('event: mint\ndata: {"symbol":"BBB","price":2}\n\n');
			res.end();
		});

		const port = await listen(server);
		const protocol = new AgentProtocol();
		const done = waitForEvents(protocol, 'mint', 2);

		const { stop, stats } = startDataReactive({
			protocol,
			source: { kind: 'sse', url: `http://127.0.0.1:${port}` },
			bindings: passthrough('mint'),
		});

		const events = await done;
		stop();
		await new Promise((r) => server.close(r));

		expect(events).toHaveLength(2);
		expect(events[0].payload.symbol).toBe('AAA');
		expect(events[1].payload.symbol).toBe('BBB');
		expect(stats().received).toBe(2);
		expect(stats().emitted).toBe(2);
		expect(stats().errors).toBe(0);
	});

	it('increments errors on malformed JSON and keeps going', async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write('data: not-json\n\n');
			res.write('data: {"ok":true}\n\n');
			res.end();
		});

		const port = await listen(server);
		const protocol = new AgentProtocol();
		const done = waitForEvents(protocol, 'ok', 1);

		const { stop, stats } = startDataReactive({
			protocol,
			source: { kind: 'sse', url: `http://127.0.0.1:${port}` },
			bindings: passthrough('ok'),
		});

		await done;
		stop();
		await new Promise((r) => server.close(r));

		expect(stats().received).toBe(1);
		expect(stats().errors).toBe(1);
	});
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

describe('startDataReactive — ws', () => {
	it('delivers messages and reconnects after server closes the socket', async () => {
		let connectionCount = 0;
		const wss = new WebSocketServer({ port: 0 });
		await new Promise((r) => wss.on('listening', r));
		const port = wss.address().port;

		wss.on('connection', (socket) => {
			connectionCount++;
			if (connectionCount === 1) {
				// Send first message then close to trigger reconnect
				socket.send(JSON.stringify({ n: 1 }));
				socket.close();
			} else {
				socket.send(JSON.stringify({ n: 2 }));
			}
		});

		const protocol = new AgentProtocol();
		const done = waitForEvents(protocol, 'data', 2);

		const { stop, stats } = startDataReactive({
			protocol,
			source: {
				kind: 'ws',
				url: `ws://127.0.0.1:${port}`,
				reconnectBaseMs: 50, // fast reconnect for tests
			},
			bindings: passthrough('data'),
		});

		const events = await done;
		stop();
		await new Promise((r) => wss.close(r));

		expect(events).toHaveLength(2);
		expect(events[0].payload.n).toBe(1);
		expect(events[1].payload.n).toBe(2);
		expect(connectionCount).toBeGreaterThanOrEqual(2);
		expect(stats().received).toBe(2);
		expect(stats().emitted).toBe(2);
	});

	it('sends subscribe payloads on open', async () => {
		const received = [];
		const wss = new WebSocketServer({ port: 0 });
		await new Promise((r) => wss.on('listening', r));
		const port = wss.address().port;

		const gotSubscribe = new Promise((resolve) => {
			wss.on('connection', (socket) => {
				socket.on('message', (msg) => {
					received.push(JSON.parse(msg.toString()));
					resolve();
				});
			});
		});

		const protocol = new AgentProtocol();
		const { stop } = startDataReactive({
			protocol,
			source: {
				kind: 'ws',
				url: `ws://127.0.0.1:${port}`,
				subscribe: { action: 'subscribeNewToken' },
				reconnectBaseMs: 50,
			},
			bindings: passthrough('data'),
		});

		await gotSubscribe;
		stop();
		await new Promise((r) => wss.close(r));

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({ action: 'subscribeNewToken' });
	});
});

// ── Poll ──────────────────────────────────────────────────────────────────────
//
// The server is created before fake timers are enabled so that real I/O
// (socket bind, accept) is not affected. Only setInterval/clearInterval are
// faked — this leaves fetch's internal async machinery (setTimeout, setImmediate,
// etc.) on real timers so network requests complete normally.  After advancing
// fake time we restore real timers and await a short grace period so any
// in-flight fetches can finish before asserting.

describe('startDataReactive — poll', () => {
	let server, port;

	beforeAll(async () => {
		server = createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify([{ symbol: 'PUMP' }]));
		});
		port = await listen(server);
	});

	afterAll(() => new Promise((r) => server.close(r)));

	it('fires bindings on each interval tick', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

		const protocol = new AgentProtocol();
		const emitted = [];
		protocol.on('tick', (a) => emitted.push(a));

		const { stop, stats } = startDataReactive({
			protocol,
			source: { kind: 'poll', url: `http://127.0.0.1:${port}`, intervalMs: 1000 },
			bindings: passthrough('tick'),
		});

		// Fire two interval ticks
		await vi.advanceTimersByTimeAsync(2100);

		// Restore real timers and wait for in-flight fetches to land
		vi.useRealTimers();
		await new Promise((r) => setTimeout(r, 200));

		stop();

		expect(emitted.length).toBeGreaterThanOrEqual(2);
		expect(stats().received).toBeGreaterThanOrEqual(2);
		expect(emitted[0].payload.symbol).toBe('PUMP');
		expect(stats().errors).toBe(0);
	});

	it('wraps a non-array response in an array', async () => {
		const singleServer = createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ symbol: 'SINGLE' }));
		});
		const singlePort = await listen(singleServer);

		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

		const protocol = new AgentProtocol();
		const emitted = [];
		protocol.on('item', (a) => emitted.push(a));

		const { stop } = startDataReactive({
			protocol,
			source: { kind: 'poll', url: `http://127.0.0.1:${singlePort}`, intervalMs: 500 },
			bindings: passthrough('item'),
		});

		await vi.advanceTimersByTimeAsync(600);
		vi.useRealTimers();
		await new Promise((r) => setTimeout(r, 200));

		stop();
		await new Promise((r) => singleServer.close(r));

		expect(emitted.length).toBeGreaterThanOrEqual(1);
		expect(emitted[0].payload.symbol).toBe('SINGLE');
	});
});

// ── stop ──────────────────────────────────────────────────────────────────────

describe('startDataReactive — stop', () => {
	it('poll: is idempotent and halts counter updates', async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify([{ x: 1 }]));
		});
		const port = await listen(server);

		const protocol = new AgentProtocol();
		const { stop, stats } = startDataReactive({
			protocol,
			source: { kind: 'poll', url: `http://127.0.0.1:${port}`, intervalMs: 50 },
			bindings: passthrough('ev'),
		});

		// Wait until at least one tick has been received. A fixed sleep here
		// flaked on slow CI workers where the first fetch + parse round-trip
		// took longer than the budget — poll up to 3s for a real signal.
		const t0 = Date.now();
		while (stats().received < 1 && Date.now() - t0 < 3000) {
			await new Promise((r) => setTimeout(r, 25));
		}
		const snapshot = { ...stats() };
		expect(snapshot.received).toBeGreaterThanOrEqual(1);

		stop();
		stop(); // idempotent — must not throw

		// Advance real time; no new ticks should fire
		await new Promise((r) => setTimeout(r, 200));
		await new Promise((r) => server.close(r));

		expect(stats().received).toBe(snapshot.received);
		expect(stats().emitted).toBe(snapshot.emitted);
	});

	it('AbortSignal wires stop automatically', async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify([{ x: 1 }]));
		});
		const port = await listen(server);

		const ac = new AbortController();
		const protocol = new AgentProtocol();

		const { stats } = startDataReactive({
			protocol,
			source: { kind: 'poll', url: `http://127.0.0.1:${port}`, intervalMs: 50 },
			bindings: passthrough('ev'),
			signal: ac.signal,
		});

		// Wait for a tick then abort via signal
		await new Promise((r) => setTimeout(r, 120));
		ac.abort();
		const afterAbort = { ...stats() };

		// Wait longer; no new ticks should fire
		await new Promise((r) => setTimeout(r, 200));
		await new Promise((r) => server.close(r));

		expect(stats().received).toBe(afterAbort.received);
	});
});
