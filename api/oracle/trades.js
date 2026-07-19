/**
 * Oracle — live trade tape for a single coin (SSE).
 *
 *   GET /api/oracle/trades?mint=<base58>&network=mainnet
 *
 * Opens a PumpPortal WebSocket subscription for the requested mint and fans
 * each buy/sell event to the caller via SSE. Every trade is annotated with the
 * wallet's label and score from the coin's existing pump_coin_wallets roster so
 * the client can render Smart Money, KOL, Sniper, etc. badges in real time
 * without an extra round-trip per trade.
 *
 * Events: hello, trade, ping, bye.
 * Max duration: 45 s (client must reconnect on 'bye').
 */

import { cors, method, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { knownWallet } from '../_lib/oracle/known-wallets.js';
import WebSocket from 'ws';
import { pumpPortalWsUrl, handlePumpPortalAck } from '../_lib/pumpportal.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const MINT_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_DURATION_MS = 45_000;
const PING_INTERVAL_MS = 12_000;

// ── wallet annotation cache ───────────────────────────────────────────────────
// Pre-load the known traders for this coin once; annotate each trade in memory.

async function loadWalletRoster(mint, network) {
	try {
		const rows = await sql`
			select
				w.wallet,
				coalesce(r.label, 'unproven')    as label,
				coalesce(r.score, 0)::numeric    as score,
				r.win_rate,
				r.tag
			from pump_coin_wallets w
			left join wallet_reputation r using (wallet, network)
			where w.mint = ${mint} and w.network = ${network}
			limit 200
		`;
		const map = new Map();
		for (const r of rows) {
			// Fold in the seed if the live DB doesn't have a label yet.
			let label = r.label;
			let score = Number(r.score);
			let tag   = r.tag;
			if (label === 'unproven' || !label) {
				const known = knownWallet(r.wallet);
				if (known) { label = known.label; score = known.score; tag = known.tag || tag; }
			}
			map.set(r.wallet, { label, score, win_rate: r.win_rate, tag });
		}
		return map;
	} catch {
		return new Map();
	}
}

// Annotate a raw PumpPortal trade message with the pre-loaded roster data.
function annotate(msg, roster) {
	const wallet = msg.traderPublicKey || null;
	const rep    = wallet ? (roster.get(wallet) || null) : null;
	// Fall back to the cold-start seed for wallets not in this coin's roster.
	let label = rep?.label || null;
	let score = rep?.score ?? null;
	let tag   = rep?.tag   || null;
	if (!label && wallet) {
		const known = knownWallet(wallet);
		if (known) { label = known.label; score = known.score; tag = known.tag || null; }
	}
	const isBuy     = msg.txType === 'buy';
	const solAmount = typeof msg.solAmount     === 'number' ? msg.solAmount     : null;
	const mcSol     = typeof msg.marketCapSol  === 'number' ? msg.marketCapSol  : null;
	return {
		sig:       msg.signature   || null,
		wallet,
		is_buy:    isBuy,
		sol:       solAmount,
		tokens:    typeof msg.tokenAmount === 'number' ? msg.tokenAmount : null,
		mc_sol:    mcSol,
		label,
		score,
		tag,
		ts:        Math.floor(Date.now() / 1000),
	};
}

export default async function handleOracleTrades(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url     = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const mint    = url.searchParams.get('mint') || '';
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';

	if (!MINT_RE.test(mint)) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'invalid mint' }));
		return;
	}

	// Pre-load the roster (non-blocking — if it fails we still stream trades).
	const roster = await loadWalletRoster(mint, network);

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'Connection':    'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active || res.writableEnded) return;
		try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
	};

	send('hello', { mint, network, roster_size: roster.size, ts: Date.now() });

	// ── PumpPortal WS ────────────────────────────────────────────────────────
	let ws = null;
	let pingTimer   = null;
	let stopTimer   = null;

	function cleanup() {
		if (!active) return;
		active = false;
		clearInterval(pingTimer);
		clearTimeout(stopTimer);
		try { ws?.close(); } catch {}
		try { res.end(); } catch {}
	}

	function openWs() {
		ws = new WebSocket(pumpPortalWsUrl());

		ws.on('open', () => {
			ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
		});

		ws.on('message', (raw) => {
			if (!active) return;
			let msg;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			if (handlePumpPortalAck(msg, (line) => console.warn('[oracle-trades]', line))) return;
			if ((msg.txType === 'buy' || msg.txType === 'sell') && msg.mint === mint) {
				send('trade', annotate(msg, roster));
			}
		});

		ws.on('error', (err) => {
			// Transient WS errors — log and let the stop timer close the SSE.
			console.warn('[oracle/trades] ws error:', err?.message);
		});

		ws.on('close', () => {
			if (active) send('bye', { reason: 'ws_closed' });
			cleanup();
		});
	}

	openWs();

	pingTimer = setInterval(() => send('ping', { ts: Date.now() }), PING_INTERVAL_MS);
	stopTimer = setTimeout(() => {
		send('bye', { reason: 'rotate' });
		cleanup();
	}, MAX_DURATION_MS);

	req.on('close', cleanup);
	req.on('error', cleanup);
}
