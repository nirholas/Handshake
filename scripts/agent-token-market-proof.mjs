#!/usr/bin/env node
/**
 * Prove the agent-token market lane end to end, for free, against a real
 * cluster.
 *
 * An agent token is only a real economic object if its market state reaches the
 * agent's pages. That path is:
 *
 *     pump_agent_mints (our launch record)
 *       → GET /api/pump/curve  (api/_lib/pump-curve-view.js: on-chain read)
 *       → mapCurve()           (src/pump/coin-status-card.js: normalization)
 *       → the chip / row the profile renders
 *
 * This script walks exactly that path with real data and prints what a visitor
 * would see. Nothing is signed, nothing is broadcast, nothing is spent: it is a
 * read of state that already exists on chain, so it is safe to run at any time
 * and is the free proof lane for the launch-to-profile round trip.
 *
 * Usage:
 *   node scripts/agent-token-market-proof.mjs                # devnet (default)
 *   node scripts/agent-token-market-proof.mjs --network mainnet
 *   node scripts/agent-token-market-proof.mjs --mint <base58> [--network …]
 *   node scripts/agent-token-market-proof.mjs --limit 3
 *
 * Where the mints come from when you do not name one:
 *   · mainnet: three.ws's own launch directory, read live from
 *     https://three.ws/api/pump/launches. Coin-agnostic: no mint is hardcoded
 *     here, the platform's own records supply them at runtime.
 *   · devnet: the rehearsal cluster has no launch feed to read, so the script
 *     discovers a live bonding curve straight from the pump.fun program's own
 *     accounts and reverse-resolves its mint through the curve's token account.
 *
 * Exit code is 1 if no mint could be rendered, so this doubles as a check.
 */

import { JSDOM } from 'jsdom';
import { getCurveView } from '../api/_lib/pump-curve-view.js';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BONDING_CURVE_SPACE = 150;
const LAUNCH_FEED = 'https://three.ws/api/pump/launches';

function arg(name, fallback = null) {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const network = arg('network', 'devnet') === 'mainnet' ? 'mainnet' : 'devnet';
const limit = Math.max(1, Math.min(10, Number(arg('limit', 2)) || 2));
const explicitMint = arg('mint');

function rpcUrl() {
	return network === 'devnet'
		? process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com'
		: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

async function rpc(method, params) {
	const r = await fetch(rpcUrl(), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!r.ok) throw new Error(`${method} → HTTP ${r.status}`);
	const body = await r.json();
	if (body.error) throw new Error(`${method} → ${body.error.message}`);
	return body.result;
}

/** three.ws's own launch records: the mainnet source of truth for agent tokens. */
async function mintsFromLaunchFeed() {
	const r = await fetch(`${LAUNCH_FEED}?limit=${limit}`);
	if (!r.ok) throw new Error(`launch feed → HTTP ${r.status}`);
	const body = await r.json();
	const rows = body.launches || body.data?.launches || [];
	return rows.map((row) => ({
		mint: row.mint,
		meta: { symbol: row.symbol || '', name: row.name || '', createdAt: Date.parse(row.created_at) || null },
		via: 'three.ws launch directory',
	}));
}

/**
 * Devnet discovery: every live bonding curve is an account of the pump.fun
 * program, and the curve PDA holds the coin's own supply: so its token account
 * names the mint the curve belongs to.
 */
async function mintsFromCluster() {
	const accounts = await rpc('getProgramAccounts', [
		PUMP_PROGRAM,
		{ encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
	]);
	const curves = accounts.filter((a) => a.account.space === BONDING_CURVE_SPACE);
	console.log(`  ${curves.length} live bonding curves on ${network}`);

	const found = [];
	for (const curve of curves) {
		if (found.length >= limit) break;
		const owned = await rpc('getTokenAccountsByOwner', [
			curve.pubkey,
			{ programId: TOKEN_PROGRAM },
			{ encoding: 'jsonParsed' },
		]);
		const info = owned?.value?.[0]?.account?.data?.parsed?.info;
		// A curve holding no supply has already sold out or migrated: skip it, we
		// want a coin whose curve still has state worth rendering.
		if (!info?.mint || Number(info.tokenAmount?.uiAmount) <= 0) continue;
		found.push({ mint: info.mint, meta: null, via: `curve ${curve.pubkey.slice(0, 8)}…` });
	}
	return found;
}

/**
 * The widget calls `/api/pump/curve` as a same-origin relative URL. There is no
 * HTTP server in a script run, so route that one path to the handler the real
 * route relays verbatim (api/pump/curve.js is a thin shell over getCurveView).
 * Same code, same body, same cluster: only the transport is skipped. Every
 * other request falls through to the network untouched.
 */
function routeApiCallsInProcess() {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const href = String(input?.url || input);
		// pump.fun's indexer proxy has no in-process handler to borrow (it is a
		// server-side proxy), so a relative call goes to the live site instead.
		if (href.startsWith('/api/')) {
			if (!href.startsWith('/api/pump/curve')) return realFetch(`https://three.ws${href}`, init);
		}
		if (href.startsWith('/api/pump/curve')) {
			const params = new URLSearchParams(href.split('?')[1] || '');
			const result = await getCurveView({
				mint: params.get('mint') || '',
				network: params.get('network') === 'devnet' ? 'devnet' : 'mainnet',
			});
			return new Response(JSON.stringify(result.body), {
				status: result.httpStatus,
				headers: { 'content-type': 'application/json' },
			});
		}
		return realFetch(input, init);
	};
}

async function main() {
	// The renderer is browser code; give it a real DOM to render into.
	const dom = new JSDOM('<!doctype html><body></body>');
	globalThis.window = dom.window;
	globalThis.document = dom.window.document;
	routeApiCallsInProcess();
	const { mapCurve, mountCoinStatus } = await import('../src/pump/coin-status-card.js');

	console.log(`\nAgent-token market proof: ${network}`);
	console.log('─'.repeat(64));

	let targets;
	if (explicitMint) {
		targets = [{ mint: explicitMint, meta: null, via: 'command line' }];
	} else {
		console.log('· discovering real mints');
		targets = network === 'mainnet' ? await mintsFromLaunchFeed() : await mintsFromCluster();
	}
	if (!targets.length) {
		console.error('no mint found to prove against');
		process.exit(1);
	}

	let rendered = 0;
	for (const target of targets) {
		console.log(`\n▸ ${target.mint}  (${target.via})`);

		// 1. The server path behind GET /api/pump/curve.
		const view = await getCurveView({ mint: target.mint, network });
		console.log(`  curve read      : HTTP ${view.httpStatus}`);
		if (view.httpStatus !== 200) {
			console.log(`  body            : ${JSON.stringify(view.body)}`);
			continue;
		}
		const raised = view.body.curve?.realSolReserves;
		console.log(
			`  on-chain state  : complete=${Boolean(view.body.curve?.complete)}` +
				` progressBps=${view.body.graduation?.progressBps ?? 'n/a'}` +
				` realSolReserves=${raised ?? 'n/a'}`,
		);

		// 2. The normalization every variant of the widget reads from.
		const coin = mapCurve(view.body, target.mint, {
			network,
			meta: target.meta,
			// Devnet SOL has no dollar value, so a devnet coin stays in SOL.
			solUsd: null,
		});
		if (!coin) {
			console.log('  normalized      : no renderable market state');
			continue;
		}
		console.log(
			`  normalized      : mcap=${coin.mcap} price=${coin.price}` +
				` grad=${coin.graduationPct?.toFixed?.(2)}% denom=${coin.denom} source=${coin.source}`,
		);

		// 3. What the agent's profile actually paints.
		for (const variant of ['chip', 'row']) {
			const host = document.createElement('div');
			document.body.appendChild(host);
			const handle = mountCoinStatus(host, target.mint, {
				variant,
				network,
				refreshMs: 0,
				meta: target.meta || undefined,
			});
			await new Promise((resolve) => setTimeout(resolve, 2500));
			const text = host.textContent.replace(/\s+/g, ' ').trim();
			console.log(`  profile ${variant.padEnd(4)}   : ${text || '(empty)'}`);
			handle.destroy();
			host.remove();
			if (text) rendered += 1;
		}
	}

	console.log('\n' + '─'.repeat(64));
	if (!rendered) {
		console.error('nothing rendered: the market lane is broken on this cluster');
		process.exit(1);
	}
	console.log(`rendered ${rendered} live market views on ${network}. No transaction was signed or sent.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
