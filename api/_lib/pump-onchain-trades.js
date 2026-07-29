// Pump.fun on-chain trade firehose — the free, first-party replacement for
// PumpPortal's paywalled `subscribeTokenTrade`.
//
// Every pump.fun bonding-curve trade is an Anchor `TradeEvent` emitted by the
// pump program, so the chain itself is the authoritative trade stream and the
// platform's existing Solana RPC failover chain (SOLANA_RPC_URL → QuickNode →
// Helius → public lanes; see api/_lib/solana/connection.js) can serve it with
// no third-party unlock. One `logsSubscribe` on the program covers ALL mints —
// unlike PumpPortal there is no per-mint subscription to manage or be refused.
//
// The module keeps ONE process-wide subscription per network, refcounted across
// consumers (the sniper intel watcher and the serverless observer cron both
// attach here). Events are normalized to the exact message shape PumpPortal
// emits ({ txType, mint, traderPublicKey, solAmount, tokenAmount, signature })
// so existing recordTrade() paths consume either source unchanged, and callers
// dedupe the overlap by signature when both are live.
//
// Resilience: web3.js reconnects its socket on drops, and a stall watchdog
// tears the whole connection down and rebuilds on the next endpoint in the
// chain if no trade lands for STALL_MS — pump.fun is never silent that long,
// so a quiet minute always means a dead socket, not a quiet market.

import { solanaRpcEndpoints, resolveWsEndpoint } from './solana/connection.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const PUMP_TOKEN_DECIMALS = 1_000_000; // pump.fun tokens are minted with 6 decimals
const STALL_MS = 60_000;        // steady-state: silence this long means a dead socket
const FIRST_EVENT_MS = 20_000;  // a lane that connects but delivers nothing rotates fast
const REBUILD_DELAY_MS = 2_000;

// A sustained program-wide logsSubscribe pushes ~1-2M notifications/day. On the
// metered keyed lanes (QuickNode credits, Helius credits, Alchemy CUs) that is
// real spend, and both QuickNode and Helius throttle high-volume sockets anyway
// (verified: QuickNode ws goes silent under load, Helius ws 429s the upgrade).
// So the firehose inverts the platform's HTTP ordering: keyless free lanes
// first, keyed/paid lanes as reserve. PUMP_ONCHAIN_WS_URLS pins an explicit
// list (comma-separated http(s) urls) ahead of everything when set.
const KEYED_LANE_RE = /quiknode\.pro|api-key=|alchemy\.com|rpc\.ankr\.com|drpc\.org|api\.tatum\.io/i;

// ── WebSocket lane health ─────────────────────────────────────────────────────
// Serving JSON-RPC over HTTP does NOT imply serving it over a WebSocket, and the
// two failure modes need opposite handling. Some lanes in the shared RPC chain
// answer the ws upgrade with a redirect or a flat refusal — measured 2026-07-29:
// solana.leorpc.com → 301, solana-mainnet.gateway.tatum.io → 405 — while their
// HTTP side is perfectly healthy. web3.js hands the socket to rpc-websockets,
// which treats ANY failure as transient and reconnects in a tight background
// loop for the life of a warm instance: 100 `ws error: Unexpected server
// response: 301` lines an hour, a firehose lane wasted on a host that can never
// serve it, and recovery delayed until the stall watchdog fires.
//
// So each lane's socket is probed once before it is used. A structural refusal
// (redirect / auth / not-found / method-not-allowed) benches the lane for the
// process; a transient one (throttle, gateway error, reset) benches it briefly
// and it comes back. Probing costs one short-lived socket per lane per process.
const WS_PROBE_TIMEOUT_MS = 4_000;
const WS_TRANSIENT_BENCH_MS = 5 * 60_000;

/** @type {Map<string, {kind:'structural'|'transient', until:number, detail:string}>} */
const _wsBench = new Map();

/**
 * Classify a ws upgrade failure from the `ws` library's error message. PURE, so
 * the bench policy is unit-testable without a socket.
 *
 * @param {string} message
 * @returns {'structural'|'transient'}
 */
export function classifyWsFailure(message) {
	const m = String(message || '');
	const status = Number(m.match(/Unexpected server response:\s*(\d{3})/)?.[1] || 0);
	// A redirect, an entitlement refusal, or "this host does not do websockets
	// here" answers identically for as long as the process lives — retrying is
	// pure waste. 402 sits here rather than with the throttles: it means the
	// account is out of credit, which no amount of backoff fixes (measured
	// 2026-07-29 on solana-mainnet.gateway.tatum.io). Restoring credit clears the
	// bench on the next process start.
	if (status && [301, 302, 307, 308, 401, 402, 403, 404, 405, 410, 501].includes(status)) return 'structural';
	// Anything else (429 throttle, 5xx, reset, timeout, TLS blip) can recover.
	return 'transient';
}

/** True when `url`'s socket is currently benched. Expired transient benches clear. */
function wsBenched(url) {
	const b = _wsBench.get(url);
	if (!b) return false;
	if (b.kind === 'transient' && Date.now() >= b.until) {
		_wsBench.delete(url);
		return false;
	}
	return true;
}

function benchWs(url, message) {
	const kind = classifyWsFailure(message);
	const prior = _wsBench.get(url);
	_wsBench.set(url, {
		kind,
		until: kind === 'structural' ? Infinity : Date.now() + WS_TRANSIENT_BENCH_MS,
		detail: String(message || '').slice(0, 160),
	});
	// One line per lane per verdict — never the per-reconnect storm this replaces.
	if (!prior || prior.kind !== kind) {
		console.warn(`[pump-onchain-trades] ws lane benched (${kind}): ${hostOf(url)} — ${String(message || '').slice(0, 120)}`);
	}
}

function hostOf(url) {
	try { return new URL(url).host; } catch { return String(url); }
}

/**
 * Open the socket once to see whether this lane can serve a subscription at all.
 * Resolves { ok: true } on a live socket, { ok: false, message } otherwise.
 * Never throws.
 *
 * @param {string} wsUrl
 */
async function probeWs(wsUrl) {
	let WebSocketImpl;
	try {
		({ default: WebSocketImpl } = await import('ws'));
	} catch {
		return { ok: true }; // no probe available ⇒ do not block the lane
	}
	return new Promise((resolve) => {
		let socket;
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket?.terminate?.(); } catch { /* already closed */ }
			resolve(result);
		};
		const timer = setTimeout(() => done({ ok: false, message: 'probe timeout' }), WS_PROBE_TIMEOUT_MS);
		if (timer.unref) timer.unref();
		try {
			socket = new WebSocketImpl(wsUrl, { handshakeTimeout: WS_PROBE_TIMEOUT_MS });
		} catch (err) {
			return done({ ok: false, message: err?.message || 'probe construct failed' });
		}
		socket.on('open', () => done({ ok: true }));
		socket.on('error', (err) => done({ ok: false, message: err?.message || 'probe error' }));
		socket.on('unexpected-response', (_req, res) => done({ ok: false, message: `Unexpected server response: ${res.statusCode}` }));
	});
}

function firehoseEndpoints(network) {
	const pinned = String(process.env.PUMP_ONCHAIN_WS_URLS || '')
		.split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
	const chain = solanaRpcEndpoints(network);
	const free = chain.filter((u) => !KEYED_LANE_RE.test(u));
	const keyed = chain.filter((u) => KEYED_LANE_RE.test(u));
	const all = [...new Set([...pinned, ...free, ...keyed])];
	const live = all.filter((u) => !wsBenched(u));
	// Never strand the firehose: if every lane is benched, drop the transient
	// benches and retry them rather than going dark. Structural benches stand —
	// a host that redirects the upgrade cannot serve the stream at any point.
	if (live.length) return live;
	for (const [url, b] of _wsBench) if (b.kind === 'transient') _wsBench.delete(url);
	const revived = all.filter((u) => !wsBenched(u));
	return revived.length ? revived : all;
}

/** Read-only view of benched sockets, for the ops/health surface. */
export function wsLaneHealth() {
	return [..._wsBench.entries()].map(([url, b]) => ({
		host: hostOf(url),
		kind: b.kind,
		detail: b.detail,
		until: b.until === Infinity ? null : new Date(b.until).toISOString(),
	}));
}

// Per-network singleton state.
const _streams = new Map(); // network -> { listeners:Set, stop, ... }

/** Lazy heavy deps, shared across rebuilds. */
let _deps = null;
async function loadDeps() {
	if (_deps) return _deps;
	const [web3, anchor, pumpSdk] = await Promise.all([
		import('@solana/web3.js'),
		import('@coral-xyz/anchor'),
		import('@pump-fun/pump-sdk'),
	]);
	const coder = new anchor.BorshCoder(pumpSdk.pumpIdl);
	const parser = new anchor.EventParser(pumpSdk.PUMP_PROGRAM_ID, coder);
	_deps = { web3, parser, programId: pumpSdk.PUMP_PROGRAM_ID };
	return _deps;
}

/**
 * Read a decoded Anchor event field tolerantly of the coder's naming. The
 * current anchor + pump IDL combination emits snake_case fields (`sol_amount`,
 * `is_buy`); older toolchains camelCased them. Callers pass the camelCase name;
 * the snake_case form is derived. Exported for the other TradeEvent consumers
 * (pump-fun-mcp trade history / whale watch) that hit the same casing drift.
 */
export function eventField(data, camel) {
	if (data == null) return undefined;
	if (data[camel] !== undefined) return data[camel];
	return data[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
}

/** Normalize an Anchor TradeEvent into the PumpPortal wire shape. */
function normalizeTradeEvent(data, signature) {
	const isBuy = eventField(data, 'isBuy');
	const solAmount = eventField(data, 'solAmount');
	const tokenAmount = eventField(data, 'tokenAmount');
	const timestamp = eventField(data, 'timestamp');
	return {
		txType: isBuy ? 'buy' : 'sell',
		mint: data.mint.toString(),
		traderPublicKey: data.user.toString(),
		solAmount: Number(solAmount.toString()) / LAMPORTS_PER_SOL,
		tokenAmount: Number(tokenAmount.toString()) / PUMP_TOKEN_DECIMALS,
		signature,
		// Chain time when present; consumers that want wall-clock use their own.
		timestampMs: Number(timestamp?.toString?.() ?? 0) * 1000 || Date.now(),
	};
}

async function buildConnection(state) {
	const { web3 } = await loadDeps();
	const endpoints = firehoseEndpoints(state.network);
	if (!endpoints.length) throw new Error('no solana rpc endpoints configured');

	// Walk the chain until a lane's socket actually opens. Probing here (rather
	// than discovering it through rpc-websockets' endless reconnect) means a
	// structurally ws-hostile lane costs one short-lived socket, once, instead of
	// a permanent error storm — and the rotation happens now, not after the stall
	// watchdog's 20s.
	for (let attempt = 0; attempt < endpoints.length; attempt++) {
		const url = endpoints[state.endpointIdx % endpoints.length];
		state.endpointIdx = (state.endpointIdx + 1) % endpoints.length;
		const wsUrl = resolveWsEndpoint(url, state.network);
		const probe = await probeWs(wsUrl);
		if (!probe.ok) {
			benchWs(url, probe.message);
			continue;
		}
		state.endpointUrl = url;
		return new web3.Connection(url, {
			commitment: 'confirmed',
			wsEndpoint: wsUrl,
			disableRetryOnRateLimit: true,
		});
	}
	throw new Error(`no solana ws lane accepted a subscription (${endpoints.length} tried)`);
}

async function startSubscription(state) {
	if (state.stopped) return;
	const { parser, programId } = await loadDeps();
	let connection;
	try {
		connection = await buildConnection(state);
	} catch (err) {
		console.warn('[pump-onchain-trades] connection build failed:', err?.message);
		scheduleRebuild(state);
		return;
	}
	state.connection = connection;
	state.lastEventAt = Date.now();
	state.everReceived = false;

	if (process.env.PUMP_ONCHAIN_DEBUG) console.log('[pump-onchain-trades] subscribing on', state.endpointUrl);
	try {
		state.subId = await connection.onLogs(
			programId,
			(logInfo) => {
				if (process.env.PUMP_ONCHAIN_DEBUG && !state._dbgRaw) { state._dbgRaw = 1; console.log('[pump-onchain-trades] first raw notification'); }
				if (state.stopped || logInfo.err) return;
				let parsed;
				try { parsed = [...parser.parseLogs(logInfo.logs)]; } catch (e) {
					if (process.env.PUMP_ONCHAIN_DEBUG && !state._dbgParseErr) { state._dbgParseErr = 1; console.log('[pump-onchain-trades] parse error:', e?.message); }
					return;
				}
				if (process.env.PUMP_ONCHAIN_DEBUG && parsed.length && !state._dbgEv) { state._dbgEv = 1; console.log('[pump-onchain-trades] first events:', parsed.map((e) => e.name).join(',')); }
				for (const event of parsed) {
					if (event.name !== 'TradeEvent') continue;
					state.lastEventAt = Date.now();
					state.everReceived = true;
					let msg;
					try { msg = normalizeTradeEvent(event.data, logInfo.signature); } catch (e) {
						if (process.env.PUMP_ONCHAIN_DEBUG && !state._dbgNormErr) { state._dbgNormErr = 1; console.log('[pump-onchain-trades] normalize error:', e?.message, 'keys:', Object.keys(event.data || {}).join(',')); }
						continue;
					}
					if (process.env.PUMP_ONCHAIN_DEBUG && !state._dbgDispatch) { state._dbgDispatch = 1; console.log('[pump-onchain-trades] dispatching to', state.listeners.size, 'listeners'); }
					for (const fn of state.listeners) {
						try { fn(msg); } catch {}
					}
				}
			},
			'confirmed',
		);
	} catch (err) {
		console.warn('[pump-onchain-trades] logsSubscribe failed:', err?.message);
		scheduleRebuild(state);
		return;
	}

	// Stall watchdog: pump.fun global trade flow never pauses for a minute, so
	// silence means a dead/throttled socket, not a quiet market. A lane that
	// never delivered anything rotates fast (FIRST_EVENT_MS); one that was
	// flowing gets the longer steady-state allowance.
	clearInterval(state.watchdog);
	state.watchdog = setInterval(() => {
		if (state.stopped) return;
		const limit = state.everReceived ? STALL_MS : FIRST_EVENT_MS;
		if (Date.now() - state.lastEventAt > limit) {
			console.warn(`[pump-onchain-trades] no trades for ${limit}ms on ${hostOf(state.endpointUrl)} — rotating endpoint`);
			// A lane whose socket opened but delivered nothing is silently broken
			// (accepted the subscription, never pushed). Bench it briefly so the
			// rotation does not land straight back on it; the transient bench
			// expires on its own and structural lanes were already filtered out.
			if (!state.everReceived && state.endpointUrl) benchWs(state.endpointUrl, 'subscription delivered no events');
			teardownConnection(state);
			scheduleRebuild(state, 0);
		}
	}, FIRST_EVENT_MS / 2);
	if (state.watchdog.unref) state.watchdog.unref();
}

function teardownConnection(state) {
	clearInterval(state.watchdog);
	state.watchdog = null;
	const { connection, subId } = state;
	state.connection = null;
	state.subId = null;
	if (connection && subId != null) {
		connection.removeOnLogsListener(subId).catch(() => {});
	}
}

function scheduleRebuild(state, delay = REBUILD_DELAY_MS) {
	if (state.stopped || state.rebuildTimer) return;
	state.rebuildTimer = setTimeout(() => {
		state.rebuildTimer = null;
		startSubscription(state).catch((err) => {
			console.warn('[pump-onchain-trades] rebuild failed:', err?.message);
			scheduleRebuild(state);
		});
	}, delay);
	if (state.rebuildTimer.unref) state.rebuildTimer.unref();
}

/**
 * Attach to the shared pump.fun trade firehose.
 *
 * @param {object} opts
 * @param {(msg: {txType:'buy'|'sell', mint:string, traderPublicKey:string,
 *   solAmount:number, tokenAmount:number, signature:string, timestampMs:number}) => void} opts.onTrade
 * @param {string} [opts.network='mainnet']
 * @returns {() => void} detach — tears the shared stream down with the last consumer
 */
export function subscribePumpOnchainTrades({ onTrade, network = 'mainnet' }) {
	if (typeof onTrade !== 'function') throw new Error('onTrade callback required');
	let state = _streams.get(network);
	if (!state) {
		state = {
			network,
			listeners: new Set(),
			connection: null,
			subId: null,
			watchdog: null,
			rebuildTimer: null,
			endpointIdx: 0,
			lastEventAt: 0,
			stopped: false,
		};
		_streams.set(network, state);
		startSubscription(state).catch((err) => {
			console.warn('[pump-onchain-trades] start failed:', err?.message);
			scheduleRebuild(state);
		});
	}
	state.listeners.add(onTrade);

	return () => {
		state.listeners.delete(onTrade);
		if (state.listeners.size === 0) {
			state.stopped = true;
			clearTimeout(state.rebuildTimer);
			state.rebuildTimer = null;
			teardownConnection(state);
			_streams.delete(network);
		}
	};
}
