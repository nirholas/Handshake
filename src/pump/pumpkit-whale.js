// Whale-trade watcher for pump.fun tokens.
//
// Subscribes to on-chain logs for the pump bonding-curve program, decodes
// TradeEvent with the Anchor Borsh coder, and fires onTrade() for any trade
// whose USD value meets the minUsd threshold.
//
// All heavy imports are lazy so the module cold-starts cheaply.

import { getSolPriceUsd } from '../shared/usd-price.js';

const RPC_MAINNET = 'https://api.mainnet-beta.solana.com';
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
 * @param {{ mint: string, minUsd?: number, onTrade: Function, signal: AbortSignal }} opts
 */
export async function watchWhaleTrades({ mint, minUsd = 5000, onTrade, signal }) {
	const [{ Connection, PublicKey }, { EventParser, BorshCoder }, { PUMP_PROGRAM_ID, pumpIdl }] =
		await Promise.all([
			import('@solana/web3.js'),
			import('@coral-xyz/anchor'),
			import('@pump-fun/pump-sdk'),
		]);

	if (signal?.aborted) return;

	const connection = new Connection(RPC_MAINNET, 'confirmed');
	const coder = new BorshCoder(pumpIdl);
	const parser = new EventParser(PUMP_PROGRAM_ID, coder);
	const mintStr = mint instanceof PublicKey ? mint.toBase58() : String(mint);
	const programPk = new PublicKey(PUMP_PROGRAM);

	const solPrice = await fetchSolPrice();
	if (signal?.aborted) return;

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
