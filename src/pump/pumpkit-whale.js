// Whale-trade watcher for pump.fun tokens.
//
// Subscribes to on-chain logs for the pump bonding-curve program, decodes
// TradeEvent with the Anchor Borsh coder, and fires onTrade() for any trade
// whose USD value meets the minUsd threshold.
//
// All heavy imports are lazy so the module cold-starts cheaply.

import { getSolPriceUsd } from '../shared/usd-price.js';

// api.mainnet-beta.solana.com refuses most browser origins outright, so the
// whale feed used to be dead on arrival with nothing on screen saying why. Every
// other browser Solana caller goes through our own proxy, which fronts the
// keyed, rotating server chain; do the same here and keep the public endpoint
// as the fallback for a non-browser caller that has no origin to proxy from,
// and for the case where our own proxy is the thing that is down.
const RPC_HTTP_ENDPOINTS = (() => {
	const list = [];
	try {
		if (typeof location !== 'undefined' && location.origin) list.push(`${location.origin}/api/solana-rpc`);
	} catch { /* no origin to proxy from; the public endpoint below still works */ }
	list.push('https://api.mainnet-beta.solana.com');
	return list;
})();

// The subscription leg is a SEPARATE list, and it has to be. /api/solana-rpc is
// an HTTP-only proxy, so web3.js deriving its wsEndpoint from the http one
// (wss://<origin>/api/solana-rpc) can never complete a logsSubscribe: the whale
// feed would look calm forever instead of reporting that it is deaf. These are
// the same free WS hosts src/pump/wallet-monitor.js rotates across.
const WS_ENDPOINTS = [
	'wss://api.mainnet-beta.solana.com',
	'wss://solana-rpc.publicnode.com',
	'wss://solana.drpc.org',
];

const RPC_ATTEMPT_TIMEOUT_MS = 10_000;
const WS_PROBE_TIMEOUT_MS = 6_000;

// A fetch for the Connection that walks RPC_HTTP_ENDPOINTS in order with a
// per-attempt deadline. Without it a single stalled proxy hung every RPC read
// the whale feed makes, with no second chance and no way to time out.
function rotatingRpcFetch(endpoints) {
	return async function rpcFetch(_url, init) {
		let lastErr;
		for (const endpoint of endpoints) {
			try {
				const res = await fetch(endpoint, { ...init, signal: AbortSignal.timeout(RPC_ATTEMPT_TIMEOUT_MS) });
				if (res.ok) return res;
				lastErr = new Error(`${endpoint} responded ${res.status}`);
			} catch (err) {
				lastErr = err;
			}
		}
		throw new Error(`all ${endpoints.length} Solana RPC endpoints failed (${lastErr?.message || 'unknown'})`, {
			cause: lastErr,
		});
	};
}

/**
 * The first WS endpoint that completes a handshake, or null when none does.
 *
 * Only runs in a browser: outside one there is no blocked-origin problem to
 * route around, the first endpoint is reachable, and a probe would turn every
 * test run into a live network call.
 *
 * @param {string[]} endpoints
 * @param {(url: string) => WebSocket} [factory]  Injectable for tests.
 */
export async function pickWsEndpoint(endpoints, factory) {
	const open = factory || (typeof WebSocket !== 'undefined' ? (url) => new WebSocket(url) : null);
	if (!open) return endpoints[0] ?? null;
	for (const url of endpoints) {
		const reached = await new Promise((resolve) => {
			let settled = false;
			let sock;
			const done = (ok) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (!ok) { try { sock?.close(); } catch { /* already closing */ } }
				resolve(ok);
			};
			const timer = setTimeout(() => done(false), WS_PROBE_TIMEOUT_MS);
			try {
				sock = open(url);
			} catch {
				done(false);
				return;
			}
			sock.onopen = () => { try { sock.close(); } catch { /* already closing */ } done(true); };
			sock.onerror = () => done(false);
			sock.onclose = () => done(false);
		});
		if (reached) return url;
	}
	return null;
}
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const LAMPORTS_PER_SOL = 1_000_000_000;
const NATIVE_SOL = 'So11111111111111111111111111111111111111112';

let _cachedSolPrice = 0;

// SOL/USD through the shared four-provider chain (Jupiter, CoinGecko, Coinbase,
// DefiLlama). The previous single call hit Jupiter's retired price/v2 host and
// then silently used a hard-coded 150, which made every USD threshold wrong
// rather than merely stale. Now the last real price is reused, and with no
// price ever seen the caller gets 0 so a threshold is skipped, not faked.
async function fetchSolPrice() {
	const p = await getSolPriceUsd().catch(() => 0);
	if (p > 0) _cachedSolPrice = p;
	return _cachedSolPrice;
}

/**
 * Subscribe to pump.fun trade events for a specific mint.
 * Calls onTrade for every buy/sell whose USD value is >= minUsd.
 * Returns after the subscription is set up; runs until signal fires.
 *
 * When no SOL price can be had from any provider, a USD threshold cannot be
 * evaluated at all. Faking one silently mis-sizes every alert, and skipping in
 * silence is worse still: the caller cannot tell a blind feed from a quiet
 * market. `onStatus` is told once, so a UI can say so instead of showing an
 * empty list that looks like calm.
 *
 * @param {{ mint: string, minUsd?: number, onTrade: Function, onStatus?: Function, signal: AbortSignal }} opts
 */
export async function watchWhaleTrades({ mint, minUsd = 5000, onTrade, onStatus, signal }) {
	const [{ Connection, PublicKey }, { EventParser, BorshCoder }, { PUMP_PROGRAM_ID, pumpIdl }] =
		await Promise.all([
			import('@solana/web3.js'),
			import('@coral-xyz/anchor'),
			import('@pump-fun/pump-sdk'),
		]);

	if (signal?.aborted) return;

	// In a browser, find a WS host that actually answers before subscribing; on
	// the server the first entry is reachable and no probe is needed.
	const wsEndpoint = (typeof window !== 'undefined')
		? await pickWsEndpoint(WS_ENDPOINTS)
		: WS_ENDPOINTS[0];
	if (signal?.aborted) return;
	if (!wsEndpoint) {
		onStatus?.({
			code: 'subscription_unavailable',
			message: 'No Solana WebSocket endpoint accepted a connection, so live whale trades cannot be streamed right now.',
		});
		return;
	}

	const connection = new Connection(RPC_HTTP_ENDPOINTS[0], {
		commitment: 'confirmed',
		wsEndpoint,
		fetch: rotatingRpcFetch(RPC_HTTP_ENDPOINTS),
	});
	const coder = new BorshCoder(pumpIdl);
	const parser = new EventParser(PUMP_PROGRAM_ID, coder);
	const mintStr = mint instanceof PublicKey ? mint.toBase58() : String(mint);
	const programPk = new PublicKey(PUMP_PROGRAM);

	const solPrice = await fetchSolPrice();
	if (signal?.aborted) return;
	if (!(solPrice > 0)) {
		onStatus?.({
			code: 'usd_price_unavailable',
			message: 'SOL/USD is unavailable from every provider, so the USD alert threshold cannot be applied right now.',
		});
	}

	let subId = null;

	const cleanup = () => {
		if (subId !== null) {
			connection.removeOnLogsListener(subId).catch(() => {});
			subId = null;
		}
	};

	signal?.addEventListener('abort', cleanup);

	subId = connection.onLogs(
		programPk,
		(logInfo) => {
			if (signal?.aborted) {
				cleanup();
				return;
			}
			if (logInfo.err) return;
			try {
				for (const event of parser.parseLogs(logInfo.logs)) {
					if (event.name !== 'TradeEvent') continue;
					const d = event.data;
					// Anchor's coder emits snake_case fields with the current pump
					// IDL; older toolchains camelCased them — read both.
					const f = (a, b) => (d[a] !== undefined ? d[a] : d[b]);
					if (d.mint?.toString() !== mintStr) continue;
					const sol = Number(f('sol_amount', 'solAmount')?.toString() ?? '0') / LAMPORTS_PER_SOL;
					const usd = sol * solPrice;
					if (usd < minUsd) continue;
					onTrade({
						signature: logInfo.signature,
						wallet: d.user?.toString() ?? null,
						sideBuy: !!f('is_buy', 'isBuy'),
						usd,
						sol,
						ts: Number(f('timestamp', 'timestamp')?.toString() ?? '0') * 1000 || Date.now(),
					});
				}
			} catch {}
		},
		'confirmed',
	);
}
