#!/usr/bin/env node
// Fleet wallet audit — where the platform's SOL is, and where it has been going.
//
// Answers three questions that recur every time the x402 rail goes dry:
//   1. WHERE IS THE MONEY?   Balance of every wallet the platform knows about:
//      the SOLANA_SIGNERS registry engines plus every agent custody wallet in
//      agent_identities, bucketed by owner so platform capital is never confused
//      with a customer's.
//   2. WHERE IS IT GOING?    Per-wallet on-chain flow trace: inflow, outflow, fee
//      burn as signer, and the counterparties ranked by net SOL moved.
//   3. IS ANY OF IT LEAKING? Reconciles the real (mode='live') funding ledger and
//      the confirmed custody spend categories against realised position P&L, so
//      "dispersed into agent wallets" is never misread as "lost".
//
// Read-only. Never moves funds, never needs a signer secret.
//
// Usage:
//   node scripts/audit-wallet-flows.mjs                    # balances + ledger reconciliation
//   node scripts/audit-wallet-flows.mjs --trace <pubkey>   # add an on-chain flow trace
//   node scripts/audit-wallet-flows.mjs --trace <pubkey> --max 8000
//
// Requires DATABASE_URL and a Solana RPC in .env (SOLANA_RPC_FALLBACK_URLS /
// SOLANA_RPC_FALLBACKS / QUICKNODE_RPC_URL are all used, in that order).

import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sql } = await import('../api/_lib/db.js');

const args = process.argv.slice(2);
const traceAddr = args.includes('--trace') ? args[args.indexOf('--trace') + 1] : null;
const maxSigs = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : 4000;
const SOL_USD = Number(process.env.AUDIT_SOL_USD || 73.08);

const endpoints = [
	...(process.env.SOLANA_RPC_FALLBACK_URLS || '').split(',').filter(Boolean),
	...(process.env.SOLANA_RPC_FALLBACKS || '').split(',').filter(Boolean),
	process.env.QUICKNODE_RPC_URL,
].filter(Boolean);
if (!endpoints.length) {
	console.error('no Solana RPC configured (SOLANA_RPC_FALLBACK_URLS / SOLANA_RPC_FALLBACKS / QUICKNODE_RPC_URL)');
	process.exit(1);
}
const conns = endpoints.map((u) => new Connection(u, 'confirmed'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cursor = 0;
async function rpc(fn, tries = 5) {
	let last;
	for (let i = 0; i < tries; i++) {
		try { return await fn(conns[cursor++ % conns.length]); }
		catch (e) { last = e; await sleep(300 * (i + 1)); }
	}
	throw last;
}

// Registry engine wallets. Several registry roles share one physical keypair, so
// the label lists every role that resolves to the address. Source of truth is
// GET /api/cron/relayer-balance-check, which prints name -> pubkey for the live
// service; refresh this map from there if a role is re-keyed.
const REGISTRY = {
	WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW: 'economy-master + three-buyback + club-treasury + platform-treasury + marketplace-payer',
	wwwqvAbN4RjaRvfGsorxMuauq7SWVcV13Aa7GaqHGUn: 'pump-cron-relayer + sns-parent-owner + coin-treasury + circulation-treasury',
	wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU: 'pump-x402-launcher',
	X4o2UuVNMxnrgkzVy97kPF5gmS6CLRCVJGB48VastML: 'coin-launcher-master + x402-ring-payer',
	Huch5SM1bw6jXPJR5HA21k8aNYF4h1LRjfbJH6XLmh6Z: 'a2a-payer',
	'5uShZo7i8JqT7YuWR4iqheydkrVgBtno4XNUboP7Knm1': 'ring-allowlist-1',
	B89JLEsez4RBwZjrNmyDNMvSzwQJ1zJeFbtVD61fZyU4: 'ring-allowlist-2',
	GyDwo9K9wd9re8hpBwkpdSMpX5b9CGq72QYLqZp6bDuX: 'ring-allowlist-3',
};
const PLATFORM_ACCOUNT = 'three-ws@users.three.ws.local';

function bucket(owner) {
	if (owner === 'PLATFORM') return 'platform: registry engines';
	if (owner === PLATFORM_ACCOUNT) return 'platform: three-ws agents';
	if (owner.endsWith('@agents.three.ws')) return 'platform: circulation personas';
	if (owner.endsWith('@wallet.local')) return 'wallet-auth accounts';
	return 'signup accounts';
}

const agents = await sql`
	SELECT a.name, a.meta->>'solana_address' AS addr, COALESCE(u.email, '?') AS owner
	FROM agent_identities a LEFT JOIN users u ON u.id = a.user_id
	WHERE a.meta->>'solana_address' IS NOT NULL AND a.deleted_at IS NULL`;

const wallets = new Map();
for (const [addr, label] of Object.entries(REGISTRY)) wallets.set(addr, { addr, label, owner: 'PLATFORM' });
for (const a of agents) {
	const hit = wallets.get(a.addr);
	if (hit) { hit.label += ` + agent:${a.name}`; continue; }
	wallets.set(a.addr, { addr: a.addr, label: a.name, owner: a.owner });
}
const all = [...wallets.values()];

// ── balances ──────────────────────────────────────────────────────────────────
// getMultipleAccounts caps vary by provider (QuickNode's free tier allows 5), so
// keep the chunk small enough to work everywhere and lean on RPC rotation.
const CHUNK = 50;
for (let i = 0; i < all.length; i += CHUNK) {
	const chunk = all.slice(i, i + CHUNK);
	const keyed = chunk.map((w) => { try { return { w, pk: new PublicKey(w.addr) }; } catch { return null; } }).filter(Boolean);
	try {
		const infos = await rpc((c) => c.getMultipleAccountsInfo(keyed.map((k) => k.pk)));
		infos.forEach((info, n) => { keyed[n].w.sol = (info?.lamports || 0) / 1e9; });
	} catch (e) {
		console.error(`  balance chunk ${i} failed: ${e?.message}`);
	}
	await sleep(120);
}
all.forEach((w) => { if (w.sol == null) w.sol = 0; });
const ranked = [...all].sort((a, b) => b.sol - a.sol);
const total = ranked.reduce((s, w) => s + w.sol, 0);

console.log(`\n${'='.repeat(80)}\nWHERE THE MONEY IS`);
console.log(`${'='.repeat(80)}`);
console.log(`fleet total   ${total.toFixed(4)} SOL   ($${(total * SOL_USD).toFixed(2)} at $${SOL_USD}/SOL)   across ${ranked.length} wallets\n`);

const buckets = new Map();
for (const w of ranked) {
	const b = buckets.get(bucket(w.owner)) || { sol: 0, n: 0, funded: 0 };
	b.sol += w.sol; b.n++; if (w.sol > 0.001) b.funded++;
	buckets.set(bucket(w.owner), b);
}
console.log(`${'bucket'.padEnd(32)} ${'SOL'.padStart(10)} ${'USD'.padStart(10)}  wallets  funded`);
for (const [k, b] of [...buckets].sort((a, b) => b[1].sol - a[1].sol)) {
	console.log(`${k.padEnd(32)} ${b.sol.toFixed(4).padStart(10)} ${('$' + (b.sol * SOL_USD).toFixed(2)).padStart(10)}  ${String(b.n).padStart(7)}  ${String(b.funded).padStart(6)}`);
}

console.log('\n--- registry engines (the wallets that actually run the economy) ---');
for (const w of ranked.filter((x) => x.owner === 'PLATFORM')) {
	console.log(`  ${w.sol.toFixed(6).padStart(11)}  ${w.addr}  ${w.label}`);
}
console.log('\n--- top 15 balances fleet-wide ---');
for (const w of ranked.slice(0, 15)) {
	console.log(`  ${w.sol.toFixed(5).padStart(10)}  ${w.label.slice(0, 34).padEnd(34)} ${w.owner}`);
}

// ── ledger reconciliation ─────────────────────────────────────────────────────
console.log(`\n${'='.repeat(80)}\nWHERE IT HAS BEEN GOING (last 7 days, confirmed on-chain only)\n${'='.repeat(80)}`);

const spend = await sql`
	SELECT category, COUNT(*)::int AS n,
	       ROUND(SUM(amount_lamports) / 1e9::numeric, 4) AS sol,
	       ROUND(SUM(usd)::numeric, 2) AS usd
	FROM agent_custody_events
	WHERE created_at > now() - interval '7 days' AND status IN ('ok', 'confirmed') AND event_type = 'spend'
	GROUP BY 1 ORDER BY 3 DESC NULLS LAST`;
console.log('agent spend by category:');
for (const r of spend) console.log(`  ${String(r.sol ?? 0).padStart(9)} SOL  $${String(r.usd ?? 0).padStart(8)}  x${String(r.n).padStart(5)}  ${r.category}`);

// mode='live' matters: the bulk of sniper_funding_events rows are paper-trading
// simulations (signature='SIMULATED') and reading them as spend invents a leak
// that never happened.
const [live] = await sql`
	SELECT COUNT(*)::int AS n, ROUND(SUM(lamports) / 1e9::numeric, 4) AS sol
	FROM sniper_funding_events WHERE mode = 'live'`;
const [sim] = await sql`
	SELECT COUNT(*)::int AS n, ROUND(SUM(lamports) / 1e9::numeric, 4) AS sol
	FROM sniper_funding_events WHERE mode <> 'live'`;
console.log(`\nmaster -> agent funding ledger:`);
console.log(`  live       ${String(live?.sol ?? 0).padStart(9)} SOL  x${live?.n ?? 0}`);
console.log(`  simulated  ${String(sim?.sol ?? 0).padStart(9)} SOL  x${sim?.n ?? 0}   (paper only, no on-chain transfer)`);

const [snipe] = await sql`
	SELECT COUNT(*)::int AS closed,
	       ROUND(SUM(entry_quote_lamports) / 1e9::numeric, 4) AS sol_in,
	       ROUND(SUM(exit_quote_lamports) / 1e9::numeric, 4) AS sol_out,
	       ROUND(SUM(realized_pnl_lamports) / 1e9::numeric, 4) AS pnl
	FROM agent_sniper_positions WHERE status = 'closed'`;
console.log(`\nsniper positions (lifetime, closed): ${snipe?.closed} positions, ${snipe?.sol_in} SOL in -> ${snipe?.sol_out} SOL out, realised P&L ${snipe?.pnl} SOL`);

// ── optional flow trace ───────────────────────────────────────────────────────
if (traceAddr) {
	console.log(`\n${'='.repeat(80)}\nFLOW TRACE ${traceAddr}\n${'='.repeat(80)}`);
	const pk = new PublicKey(traceAddr);
	let before, sigs = [];
	while (sigs.length < maxSigs) {
		const batch = await rpc((c) => c.getSignaturesForAddress(pk, { limit: 1000, before }));
		if (!batch.length) break;
		sigs.push(...batch);
		before = batch[batch.length - 1].signature;
		await sleep(60);
	}
	sigs = sigs.slice(0, maxSigs);
	if (!sigs.length) { console.log('no signatures'); process.exit(0); }
	console.log(`${sigs.length} signatures  ${new Date(sigs.at(-1).blockTime * 1000).toISOString()} -> ${new Date(sigs[0].blockTime * 1000).toISOString()}`);

	const labelOf = new Map(ranked.map((w) => [w.addr, `${w.label.slice(0, 30)} [${w.owner}]`]));
	let inflow = 0, outflow = 0, feeBurn = 0, parsed = 0;
	const edges = new Map();
	for (let i = 0; i < sigs.length; i += 20) {
		const chunk = sigs.slice(i, i + 20);
		let txs;
		try { txs = await rpc((c) => c.getParsedTransactions(chunk.map((s) => s.signature), { maxSupportedTransactionVersion: 0 })); }
		catch { await sleep(400); continue; }
		for (const tx of txs) {
			if (!tx?.meta) continue;
			parsed++;
			const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
			const k = keys.indexOf(traceAddr);
			if (k < 0) continue;
			if (k === 0) feeBurn += tx.meta.fee / 1e9;
			const delta = (tx.meta.postBalances[k] - tx.meta.preBalances[k]) / 1e9;
			if (Math.abs(delta) < 5e-7) continue;
			if (delta > 0) inflow += delta; else outflow += delta;
			let cp = null, best = 0;
			keys.forEach((key, x) => {
				if (x === k) return;
				const d = (tx.meta.postBalances[x] - tx.meta.preBalances[x]) / 1e9;
				if (Math.sign(d) === -Math.sign(delta) && Math.abs(d) > best) { best = Math.abs(d); cp = key; }
			});
			const tag = cp || '(net fee burn)';
			const e = edges.get(tag) || { net: 0, n: 0 };
			e.net += delta; e.n++;
			edges.set(tag, e);
		}
		await sleep(90);
	}
	console.log(`parsed ${parsed} txs`);
	console.log(`  inflow   +${inflow.toFixed(6)} SOL`);
	console.log(`  outflow  ${outflow.toFixed(6)} SOL`);
	console.log(`  net      ${(inflow + outflow).toFixed(6)} SOL`);
	console.log(`  fee burn as signer: ${feeBurn.toFixed(6)} SOL`);
	console.log('\n  counterparties by net SOL (most negative = where SOL went):');
	for (const [cp, e] of [...edges].sort((a, b) => a[1].net - b[1].net).slice(0, 15)) {
		console.log(`   ${e.net.toFixed(6).padStart(12)}  x${String(e.n).padStart(5)}  ${cp}  ${labelOf.get(cp) || ''}`);
	}
}
