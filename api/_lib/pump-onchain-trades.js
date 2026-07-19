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

function firehoseEndpoints(network) {
	const pinned = String(process.env.PUMP_ONCHAIN_WS_URLS || '')
		.split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
	const chain = solanaRpcEndpoints(network);
	const free = chain.filter((u) => !KEYED_LANE_RE.test(u));
	const keyed = chain.filter((u) => KEYED_LANE_RE.test(u));
	return [...new Set([...pinned, ...free, ...keyed])];
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
	const url = endpoints[state.endpointIdx % endpoints.length];
	state.endpointIdx = (state.endpointIdx + 1) % endpoints.length;
	state.endpointUrl = url;
	return new web3.Connection(url, {
		commitment: 'confirmed',
		wsEndpoint: resolveWsEndpoint(url, state.network),
		disableRetryOnRateLimit: true,
	});
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
			console.warn(`[pump-onchain-trades] no trades for ${limit}ms on ${state.endpointUrl ? new URL(state.endpointUrl).host : '?'} — rotating endpoint`);
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
