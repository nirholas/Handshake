// Core-path smoke test: real on-chain fixture logs → the real normalizers →
// the real HTTP/WS/SSE server, asserted over real sockets on a real port.
//
// This is the path every consumer depends on (api/robinhood/coin-trades.js
// polls /recent; the in-world chart screen renders what comes out), so it is
// covered end to end. Nothing is stubbed except the firehose's health()
// reporter, which is the injection seam createServer() already takes, the
// events themselves are the same objects the orchestrator emits, built from
// logs captured on Robinhood Chain mainnet (tests/fixtures/*.json).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

import { createServer } from '../src/server.js';
import { normalizeCurveTrade, normalizeLaunch } from '../src/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tradedFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/traded-logs.json'), 'utf8'));
const launchFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/launch-swap-logs.json'), 'utf8'));

const bi = (v) => BigInt(v);

function realTradeEvent(index = 0, atMs = 1_800_000_000_000) {
	const raw = tradedFixture.traded[index];
	return normalizeCurveTrade({
		trade: {
			launchpad: 'odyssey', token: raw.args.token, trader: raw.args.trader,
			isBuy: raw.args.isBuy, tokenAmount: bi(raw.args.tokenAmount),
			quoteAmount: bi(raw.args.quoteAmount), fee: bi(raw.args.fee),
			blockNumber: bi(raw.blockNumber), transactionHash: raw.transactionHash,
		},
		name: 'Fixture Coin', symbol: 'FIX', ethUsd: 3000, atMs,
	});
}

function realLaunchEvent(atMs = 1_800_000_000_000) {
	const raw = launchFixture.noxa[0];
	return normalizeLaunch({
		launch: {
			launchpad: 'noxa', token: raw.args.token, creator: raw.args.deployer,
			pool: raw.args.pool ?? null, blockNumber: bi(raw.blockNumber),
			transactionHash: raw.transactionHash,
		},
		name: 'Fixture Coin', symbol: 'FIX', ethUsd: 3000, atMs,
	});
}

const health = () => ({ network: 'mainnet', chain_id: 4663, tracked_pools: 0 });

/** Boot the real server on an ephemeral port. */
async function boot() {
	const { server, onEvent, recent, close } = createServer({ health });
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address();
	return { base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}`, onEvent, recent, close };
}

test('/healthz reports firehose state and subscriber counts', async (t) => {
	const app = await boot();
	t.after(() => app.close());

	const body = await fetch(`${app.base}/healthz`).then((r) => r.json());
	assert.equal(body.ok, true);
	assert.equal(body.network, 'mainnet');
	assert.deepEqual(body.subscribers, { sse: 0, ws: 0 });
	assert.deepEqual(body.buffer, { launch: 0, trade: 0, graduation: 0 });
	assert.equal(body.firehose.chain_id, 4663);
});

test('/recent serves buffered events newest-first and filters by kind', async (t) => {
	const app = await boot();
	t.after(() => app.close());

	const older = realTradeEvent(0, 1_800_000_000_000);
	const newer = { ...realTradeEvent(0, 1_800_000_060_000), tx: '0xdeadbeef', tx_signature: '0xdeadbeef' };
	app.onEvent({ kind: 'trade', data: older });
	app.onEvent({ kind: 'trade', data: newer });
	app.onEvent({ kind: 'launch', data: realLaunchEvent() });

	const all = await fetch(`${app.base}/recent?limit=10`).then((r) => r.json());
	assert.equal(all.events.length, 3);
	assert.equal(all.events[0].data.tx, '0xdeadbeef'); // newest timestamp first

	const trades = await fetch(`${app.base}/recent?kind=trade`).then((r) => r.json());
	assert.equal(trades.events.length, 2);
	assert.ok(trades.events.every((e) => e.kind === 'trade'));

	// The pump-compatible fields api/robinhood/coin-trades.js reads must survive
	// the round trip through the buffer.
	const t0 = trades.events[0].data;
	for (const field of ['tx', 'user', 'is_buy', 'sol_amount', 'usd_amount', 'price_usd', 'timestamp']) {
		assert.ok(field in t0, `missing consumer field ${field}`);
	}
});

test('/recent dedupes a re-emitted event by signature + mint', async (t) => {
	const app = await boot();
	t.after(() => app.close());

	const ev = realTradeEvent();
	app.onEvent({ kind: 'trade', data: ev });
	app.onEvent({ kind: 'trade', data: { ...ev } }); // same tx, e.g. backfill after live

	const body = await fetch(`${app.base}/recent?kind=trade`).then((r) => r.json());
	assert.equal(body.events.length, 1);
});

test('SSE replays the buffer then streams live events, honouring ?kinds=', async (t) => {
	const app = await boot();
	t.after(() => app.close());

	app.onEvent({ kind: 'launch', data: realLaunchEvent() });
	app.onEvent({ kind: 'trade', data: realTradeEvent() });

	const controller = new AbortController();
	t.after(() => controller.abort());
	const res = await fetch(`${app.base}/events?kinds=trade`, { signal: controller.signal });
	assert.equal(res.headers.get('content-type'), 'text/event-stream');

	const frames = [];
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let pending = '';
	const pump = (async () => {
		while (frames.length < 3) {
			const { value, done } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			const chunks = pending.split('\n\n');
			pending = chunks.pop(); // trailing partial frame, if any
			for (const chunk of chunks) {
				const line = chunk.trim();
				if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
			}
		}
	})();

	// Give the replay + status frames a tick, then push a live event.
	await new Promise((r) => setTimeout(r, 50));
	app.onEvent({ kind: 'trade', data: { ...realTradeEvent(), tx: '0xlive', tx_signature: '0xlive' } });
	await pump;

	const replayed = frames.filter((f) => f.replay === true);
	assert.equal(replayed.length, 1, 'only the trade replays when kinds=trade');
	assert.equal(replayed[0].kind, 'trade');
	assert.ok(frames.some((f) => f.kind === 'status'), 'connect status frame');
	assert.ok(frames.some((f) => f.data?.tx === '0xlive'), 'live event streamed');
});

test('WebSocket subscribers get the replay buffer and live fan-out', async (t) => {
	const app = await boot();
	t.after(() => app.close());

	app.onEvent({ kind: 'trade', data: realTradeEvent() });

	const ws = new WebSocket(`${app.wsBase}/ws?kinds=trade`);
	// Subscribe before the handshake resolves: the server pushes the replay
	// buffer the instant the connection lands, so a listener attached after
	// 'open' can miss it.
	const messages = [];
	ws.on('message', (buf) => messages.push(JSON.parse(buf.toString())));
	await once(ws, 'open');

	await new Promise((r) => setTimeout(r, 50));
	app.onEvent({ kind: 'trade', data: { ...realTradeEvent(), tx: '0xlive-ws', tx_signature: '0xlive-ws' } });
	await new Promise((r) => setTimeout(r, 50));

	assert.ok(messages.some((m) => m.replay === true && m.kind === 'trade'), 'replayed buffer');
	assert.ok(messages.some((m) => m.data?.tx === '0xlive-ws'), 'live event');

	const healthz = await fetch(`${app.base}/healthz`).then((r) => r.json());
	assert.equal(healthz.subscribers.ws, 1);

	// close() must drop a live WebSocket rather than wait on it forever.
	await app.close();
	await once(ws, 'close');
});

test('unknown routes 404 and / serves the status page', async (t) => {
	const app = await boot();
	t.after(() => app.close());

	const missing = await fetch(`${app.base}/nope`);
	assert.equal(missing.status, 404);

	const root = await fetch(`${app.base}/`);
	assert.equal(root.status, 200);
	assert.match(root.headers.get('content-type'), /text\/html/);
});
