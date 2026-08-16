// wallet-card.mjs: size up one smart trader with both tools on this server.
//
//   1. get_wallet_portfolio  the wallet's live holdings card + real 30d P&L
//   2. get_wallet_trades     that same wallet's buys/sells of one mint
//
// Every call hits the live public three.ws KOL API. Nothing here needs a key, a
// signer, or a payment, and both tools are read-only.
//
//   node examples/wallet-card.mjs                   # picks a tracked wallet for you
//   node examples/wallet-card.mjs <wallet>          # a wallet you care about
//   node examples/wallet-card.mjs <wallet> <mint>   # and a token to inspect
//
// With no wallet argument the example reads one off the public KOL leaderboard
// at runtime, so it stays runnable without pasting an address in. The mint
// defaults to $THREE, the only coin this platform promotes.

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FORWARDED_ENV = ['THREE_WS_BASE', 'THREE_WS_TIMEOUT_MS'];
const BASE = (process.env.THREE_WS_BASE || 'https://three.ws').replace(/\/+$/, '');
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Both tools read live third-party market data through three.ws. A throttled or
// unconfigured provider is a real state of this system, not a bug in the
// example: render it plainly and keep going, so an outage is never mistaken for
// a wallet with nothing to show.
const OUTAGE_CODES = new Set(['upstream_unavailable', 'upstream_error', 'timeout', 'network_error']);

const [walletArg, mintArg] = process.argv.slice(2);
const mint = mintArg || THREE;

function childEnv() {
	const env = getDefaultEnvironment();
	for (const key of FORWARDED_ENV) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

/** Unwrap an MCP tool result's JSON payload from its text content block. */
function payload(result) {
	const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
	try {
		return JSON.parse(text);
	} catch {
		return { ok: false, raw: text };
	}
}

/**
 * Call a tool. A provider outage comes back as `{ ok: false }` for the caller to
 * render; anything else (a bad argument, an unknown tool) fails loudly.
 */
async function call(client, name, args) {
	const data = payload(await client.callTool({ name, arguments: args }));
	if (!data.ok && !OUTAGE_CODES.has(data.error)) {
		throw new Error(`${name} failed: ${data.message || data.error || data.raw || 'unknown error'}`);
	}
	return data;
}

/**
 * A tracked wallet to demo with, read live off the public leaderboard. Ranking
 * the KOL set is intel-mcp's job (kol_leaderboard), not this server's, so the
 * example reads it directly rather than pretending this server exposes it.
 */
async function pickWallet() {
	const res = await fetch(`${BASE}/api/kol/leaderboard?limit=1`, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`leaderboard lookup failed (HTTP ${res.status}). Pass a wallet address instead.`);
	const { items } = await res.json();
	const wallet = items?.[0]?.wallet;
	if (!wallet) throw new Error('the leaderboard is empty right now. Pass a wallet address instead.');
	return wallet;
}

/** USD with thousands separators, or a clearly-marked unknown. */
function usd(value) {
	if (value == null) return 'unknown (no data to measure)';
	return `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const wallet = walletArg || (await pickWallet());
if (!walletArg) console.log(`no wallet given, using the top tracked wallet: ${wallet}`);

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER_PATH],
	env: childEnv(),
	stderr: 'inherit',
});
const client = new Client({ name: 'kol-mcp-wallet-card-example', version: '1.0.0' });
await client.connect(transport);

try {
	// -- 1. get_wallet_portfolio ------------------------------------------
	const card = await call(client, 'get_wallet_portfolio', { wallet });
	console.log(`\nget_wallet_portfolio: ${wallet}`);
	if (!card.ok) {
		console.log(`  provider outage: ${card.message}`);
	} else {
		if (!card.has_activity) console.log('  no holdings and no trades on record for this wallet yet');
		console.log(`  holdings:   ${card.holdings} position(s) worth ${usd(card.portfolio_value_usd)}`);
		const top = card.top_token;
		console.log(`  top token:  ${top ? `${top.symbol} at ${usd(top.valueUsd)}` : 'none'}`);
		console.log(`  realized:   ${usd(card.realized_pnl_usd)} over ${card.pnl_window ?? 'an unreported window'}`);
		// A null P&L field is an honest "unknown", never a flat record: printing it
		// as $0 would report an unmeasured wallet as a break-even trader.
		const win = card.win_rate == null ? 'unknown (no closed trades)' : `${(card.win_rate * 100).toFixed(1)}%`;
		console.log(`  win rate:   ${win}`);
		console.log(`  trades:     ${card.total_trades ?? 'unknown'} (source: ${card.pnl_source ?? 'none'})`);
	}

	// -- 2. get_wallet_trades ---------------------------------------------
	const feed = await call(client, 'get_wallet_trades', { wallet, mint, limit: 5 });
	console.log(`\nget_wallet_trades: ${mint}`);
	if (!feed.ok) {
		console.log(`  provider outage: ${feed.message}`);
	} else if (feed.count === 0) {
		console.log('  this wallet has not traded that mint in the feed window');
	} else {
		for (const trade of feed.trades) {
			const when = trade.time ? new Date(trade.time).toISOString().replace('T', ' ').slice(0, 16) : 'unknown time';
			console.log(`  - ${String(trade.side ?? '?').padEnd(4)} ${trade.amountSol ?? '?'} SOL  ${usd(trade.usd)}  ${when}`);
		}
	}

	console.log('\nBoth calls were read-only. Nothing was signed, spent, or modified.');
} finally {
	await client.close();
}
