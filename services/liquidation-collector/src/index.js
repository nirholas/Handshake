// three.ws liquidation-collector: standalone always-on Node service.
//
// Subscribes to the PUBLIC futures liquidation WebSocket streams of Binance,
// Bybit, and OKX, classifies each liquidation by USD size, keeps a rolling
// 4-hour in-memory window, and serves an aggregate REST snapshot consumed by
// `api/coin/liquidations.js` (proxy), which feeds the "liquidations pulse"
// strip on three.ws/coins.
//
// This file owns the wiring only: sockets, reconnects, lane health, and the
// HTTP surface. Message parsing and the aggregate math live in
// `src/collector.js` so they are testable without a network.
//
// This process holds long-lived WebSocket connections, so it is NOT deployable
// as a Vercel serverless function. Run it on any always-on Node host (see
// README.md) and point `LIQUIDATION_COLLECTOR_URL` at it.

import { createServer } from 'node:http';
import { WebSocket } from 'ws';

import {
	TRACKED,
	buildSnapshot,
	bybitTopics,
	createStore,
	parseBinanceMessage,
	parseBybitMessage,
	parseOkxMessage,
	readBybitAck,
} from './collector.js';
import { createOkxContractRegistry } from './okx-contracts.js';

const RECONNECT_MS = 5_000;
const PING_MS = 20_000;
const BINANCE_RECHECK_MS = 60 * 60 * 1000;
const BINANCE_PING_URL = 'https://fapi.binance.com/fapi/v1/ping';

const store = createStore();
const okxContracts = createOkxContractRegistry();

// ---------------------------------------------------------------------------
// Lane health
//
// A silently dead lane is the failure mode this service is most exposed to:
// both Bybit (a retired topic name) and Binance (a geo-restricted host) kept
// an open, quiet socket while contributing nothing. /health reports each lane
// so "connected" can never be mistaken for "delivering".
// ---------------------------------------------------------------------------

const streams = {
	Binance: { state: 'starting', events: 0, lastEventAt: null, note: '' },
	Bybit: { state: 'starting', events: 0, lastEventAt: null, note: '' },
	OKX: { state: 'starting', events: 0, lastEventAt: null, note: '' },
};

function setState(exchange, state, note = '') {
	streams[exchange].state = state;
	streams[exchange].note = note;
}

function record(exchange, entries) {
	if (entries.length === 0) return;
	for (const entry of entries) store.push(entry);
	streams[exchange].events += entries.length;
	streams[exchange].lastEventAt = Date.now();
}

/** @type {Set<WebSocket>} */
const sockets = new Set();
let shuttingDown = false;

function track(ws) {
	sockets.add(ws);
	ws.on('close', () => sockets.delete(ws));
}

// ---------------------------------------------------------------------------
// Binance: wss://fstream.binance.com/ws/!forceOrder@arr
//
// Binance answers 451 "restricted location" to US-hosted callers, and its
// WebSocket endpoint accepts the connection but never pushes a frame, so an
// open socket proves nothing. We probe the public REST ping first and report
// the lane as `restricted` (rechecked hourly) rather than pretending to be
// connected. Hosting the service outside a restricted region lights it up
// with no code change.
// ---------------------------------------------------------------------------

async function binanceAccessible() {
	try {
		const resp = await fetch(BINANCE_PING_URL, { signal: AbortSignal.timeout(10_000) });
		if (resp.ok) return { ok: true, reason: '' };
		if (resp.status === 451) {
			return { ok: false, reason: 'Binance blocks this host region (HTTP 451); host the collector outside a restricted region to enable this lane' };
		}
		return { ok: false, reason: `Binance ping responded ${resp.status}` };
	} catch (err) {
		return { ok: false, reason: `Binance ping failed: ${err.message}` };
	}
}

async function startBinance() {
	if (shuttingDown) return;
	const access = await binanceAccessible();
	if (!access.ok) {
		setState('Binance', 'restricted', access.reason);
		console.warn(`[Binance] lane disabled: ${access.reason}`);
		setTimeout(startBinance, BINANCE_RECHECK_MS).unref?.();
		return;
	}
	connectBinance();
}

function connectBinance() {
	setState('Binance', 'connecting');
	const ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
	track(ws);
	let ping;

	ws.on('open', () => {
		setState('Binance', 'connected');
		console.log('[Binance] connected');
		ping = setInterval(() => ws.ping(), PING_MS);
	});

	ws.on('message', (data) => {
		record('Binance', parseBinanceMessage(data.toString(), TRACKED));
	});

	ws.on('close', () => {
		clearInterval(ping);
		if (shuttingDown) return;
		setState('Binance', 'reconnecting');
		console.log('[Binance] disconnected, reconnecting in 5s');
		setTimeout(startBinance, RECONNECT_MS).unref?.();
	});

	ws.on('error', (err) => {
		setState('Binance', 'error', err.message);
		console.error('[Binance] error', err.message);
		ws.terminate();
	});
}

// ---------------------------------------------------------------------------
// Bybit: wss://stream.bybit.com/v5/public/linear
//
// One subscribe frame per topic, each tagged with a req_id, so a single
// unlisted instrument cannot reject the whole batch and every ack is
// attributable. The retired `liquidation.{SYMBOL}` topic answered
// "handler not found" for years while the lane looked healthy; failed acks
// are now logged and surfaced on /health.
// ---------------------------------------------------------------------------

function connectBybit() {
	setState('Bybit', 'connecting');
	const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
	track(ws);
	let ping;
	const rejected = [];

	ws.on('open', () => {
		setState('Bybit', 'connected');
		console.log('[Bybit] connected');
		for (const topic of bybitTopics(TRACKED)) {
			ws.send(JSON.stringify({ op: 'subscribe', req_id: topic, args: [topic] }));
		}
		ping = setInterval(() => ws.send(JSON.stringify({ op: 'ping' })), PING_MS);
	});

	ws.on('message', (data) => {
		const raw = data.toString();
		const ack = readBybitAck(raw);
		if (ack) {
			if (ack.op === 'subscribe' && !ack.ok) {
				rejected.push(ack.topic || ack.message);
				setState('Bybit', 'degraded', `rejected topics: ${rejected.join(', ')}`);
				console.error(`[Bybit] subscribe rejected for ${ack.topic}: ${ack.message}`);
			}
			return;
		}
		record('Bybit', parseBybitMessage(raw, TRACKED));
	});

	ws.on('close', () => {
		clearInterval(ping);
		if (shuttingDown) return;
		setState('Bybit', 'reconnecting');
		console.log('[Bybit] disconnected, reconnecting in 5s');
		setTimeout(connectBybit, RECONNECT_MS).unref?.();
	});

	ws.on('error', (err) => {
		setState('Bybit', 'error', err.message);
		console.error('[Bybit] error', err.message);
		ws.terminate();
	});
}

// ---------------------------------------------------------------------------
// OKX: wss://ws.okx.com:8443/ws/v5/public, channel liquidation-orders
// (all SWAP instruments, real-time). Sizes are converted from contracts to
// base units via the instrument registry.
// ---------------------------------------------------------------------------

function connectOKX() {
	setState('OKX', 'connecting');
	const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
	track(ws);
	let ping;

	ws.on('open', () => {
		setState('OKX', 'connected');
		console.log('[OKX] connected');
		ws.send(
			JSON.stringify({
				op: 'subscribe',
				args: [{ channel: 'liquidation-orders', instType: 'SWAP' }],
			}),
		);
		ping = setInterval(() => ws.send('ping'), PING_MS);
	});

	ws.on('message', (data) => {
		record('OKX', parseOkxMessage(data.toString(), okxContracts, TRACKED));
	});

	ws.on('close', () => {
		clearInterval(ping);
		if (shuttingDown) return;
		setState('OKX', 'reconnecting');
		console.log('[OKX] disconnected, reconnecting in 5s');
		setTimeout(connectOKX, RECONNECT_MS).unref?.();
	});

	ws.on('error', (err) => {
		setState('OKX', 'error', err.message);
		console.error('[OKX] error', err.message);
		ws.terminate();
	});
}

// ---------------------------------------------------------------------------
// REST API (consumed by api/coin/liquidations.js)
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
		'access-control-allow-origin': '*',
	});
	res.end(payload);
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');

	if (req.method === 'OPTIONS') {
		res.writeHead(204, {
			'access-control-allow-origin': '*',
			'access-control-allow-methods': 'GET, OPTIONS',
		});
		res.end();
		return;
	}

	if (req.method !== 'GET') {
		sendJson(res, 405, { error: 'method_not_allowed' });
		return;
	}

	if (url.pathname === '/health') {
		sendJson(res, 200, {
			ok: true,
			cached: store.size,
			uptime: process.uptime(),
			okxContracts: okxContracts.size,
			streams,
		});
		return;
	}

	if (url.pathname === '/liquidations') {
		sendJson(res, 200, buildSnapshot(store.entries));
		return;
	}

	sendJson(res, 404, { error: 'not_found' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[collector] ${signal} received, closing streams`);
	okxContracts.stop();
	for (const ws of sockets) ws.close();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 5_000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await okxContracts.refresh();
okxContracts.start();

startBinance();
connectBybit();
connectOKX();

const port = parseInt(process.env.PORT ?? '3033', 10);
server.listen(port, () => {
	console.log(`liquidation-collector listening on :${port}`);
});
