#!/usr/bin/env node
// scripts/trading-bot-report.mjs
//
// One-shot status report for every autonomous trading bot on the platform:
// the pump.fun snipers (agent_sniper_strategies) and the Strategy Object
// runtime (agent_strategy_equips). For each bot it reports posture (enabled /
// kill switch / trigger), lifetime realised PnL, win/loss split, open
// positions marked to their last quote, how much SOL has ever been funded into
// its wallet, and the LIVE on-chain balance of that wallet (SOL + surviving
// SPL token positions) read straight from a Solana RPC.
//
// Read-only: it never signs, funds, or closes anything.
//
// Usage:
//   node scripts/trading-bot-report.mjs                 # table report
//   node scripts/trading-bot-report.mjs --json          # machine-readable
//   node scripts/trading-bot-report.mjs --no-chain      # DB only, skip RPC
//   node scripts/trading-bot-report.mjs --all           # include never-traded bots
//
// Env: DATABASE_URL (.env.local), SOLANA_RPC_URL (optional; falls back to the
// public mainnet endpoint, which is rate limited but fine for a few wallets).

import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { solPriceUsd } from '../api/_lib/sol-price.js';

for (const file of ['.env.local', '.env']) {
	try {
		for (const line of readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n')) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch { /* file absent: env may already be exported */ }
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const skipChain = args.includes('--no-chain');
const includeIdle = args.includes('--all');

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is not set. It lives in .env.local (Neon) or on the Cloud Run service.');
	process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOL = 1e9;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const num = (v) => (v == null ? 0 : Number(v));
const sol = (n, d = 4) => (n >= 0 ? ' ' : '') + n.toFixed(d);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The public mainnet endpoint answers a burst of a dozen wallets with HTTP 429,
// which reads as "wallet unreadable" in the report when it is really back
// pressure. Back off and retry so a balance is reported, not an error string.
async function rpc(method, params, attempt = 0) {
	const res = await fetch(RPC, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (res.status === 429 || res.status >= 500) {
		if (attempt >= 5) throw new Error(`${method}: HTTP ${res.status} after ${attempt + 1} attempts`);
		await sleep(600 * 2 ** attempt);
		return rpc(method, params, attempt + 1);
	}
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
	const body = await res.json();
	if (body.error) throw new Error(`${method}: ${body.error.message}`);
	return body.result;
}

// Jupiter lite price API, the same source api/_lib/balances.js values SPL
// holdings with. Unpriced mints (dead pools, delisted) come back absent and are
// counted as zero rather than guessed at.
const priceCache = new Map();
async function tokenPricesUsd(mints) {
	const missing = mints.filter((m) => !priceCache.has(m));
	for (let i = 0; i < missing.length; i += 40) {
		const chunk = missing.slice(i, i + 40);
		try {
			const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${chunk.join(',')}`);
			const data = res.ok ? await res.json() : {};
			for (const mint of chunk) priceCache.set(mint, Number(data?.[mint]?.usdPrice) || 0);
		} catch {
			for (const mint of chunk) priceCache.set(mint, 0);
		}
		await sleep(200);
	}
	return Object.fromEntries(mints.map((m) => [m, priceCache.get(m) || 0]));
}

async function chainState(wallet) {
	const balance = await rpc('getBalance', [wallet]);
	const holdings = [];
	for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
		const accounts = await rpc('getTokenAccountsByOwner', [wallet, { programId }, { encoding: 'jsonParsed' }]);
		for (const entry of accounts.value) {
			const info = entry.account.data.parsed.info;
			if (Number(info.tokenAmount.uiAmount) > 0) holdings.push({ mint: info.mint, amount: info.tokenAmount.uiAmountString });
		}
	}
	const prices = holdings.length ? await tokenPricesUsd(holdings.map((h) => h.mint)) : {};
	for (const h of holdings) h.usd = Number(h.amount) * (prices[h.mint] || 0);
	holdings.sort((a, b) => b.usd - a.usd);
	return { solBalance: balance.value / SOL, holdings, holdingsUsd: holdings.reduce((n, h) => n + h.usd, 0) };
}

// Live SOL/USD off the platform's own nine-source failover chain, so the dollar
// column is spot and not the last value some cron happened to stamp.
async function livePrice() {
	try {
		return await solPriceUsd();
	} catch {
		const row = await sql`select sol_price_usd from sniper_trade_analytics where sol_price_usd > 0 order by ts desc limit 1`;
		return row.length ? Number(row[0].sol_price_usd) : null;
	}
}

async function loadSnipers() {
	return sql`
		select s.id, s.label, s.agent_id, s.enabled, s.kill_switch, s.network, s.trigger,
		       s.decision_mode, s.experiment_group, s.auto_fund_enabled, s.auto_optimize,
		       (s.per_trade_lamports / 1e9)::float per_trade_sol,
		       (s.daily_budget_lamports / 1e9)::float daily_budget_sol,
		       s.max_concurrent_positions,
		       i.name agent_name,
		       (select count(*)::int from agent_sniper_positions p
		         where p.strategy_id = s.id and p.status = 'closed') closed_count,
		       (select count(*)::int from agent_sniper_positions p
		         where p.strategy_id = s.id and p.status = 'open') open_count,
		       (select count(*)::int from agent_sniper_positions p
		         where p.strategy_id = s.id and p.status = 'failed') failed_count,
		       (select count(*)::int from agent_sniper_positions p
		         where p.strategy_id = s.id and p.status = 'closed' and p.realized_pnl_lamports > 0) wins,
		       (select count(*)::int from agent_sniper_positions p
		         where p.strategy_id = s.id and p.status = 'closed' and p.realized_pnl_lamports <= 0) losses,
		       (select coalesce(sum(p.realized_pnl_lamports), 0)::float / 1e9 from agent_sniper_positions p
		         where p.strategy_id = s.id) realized_pnl_sol,
		       (select coalesce(sum(p.entry_quote_lamports), 0)::float / 1e9 from agent_sniper_positions p
		         where p.strategy_id = s.id and p.status in ('open', 'closed')) deployed_sol,
		       (select coalesce(sum(p.last_value_lamports), 0)::float / 1e9 from agent_sniper_positions p
		         where p.strategy_id = s.id and p.status = 'open') open_marked_sol,
		       (select coalesce(sum(p.entry_quote_lamports), 0)::float / 1e9 from agent_sniper_positions p
		         where p.strategy_id = s.id and p.status = 'open') open_cost_sol,
		       (select max(p.opened_at) from agent_sniper_positions p where p.strategy_id = s.id) last_trade_at,
		       (select p.wallet from agent_sniper_positions p
		         where p.strategy_id = s.id and p.wallet is not null and p.wallet <> 'pending'
		         order by p.opened_at desc limit 1) wallet,
		       (select coalesce(sum(f.lamports), 0)::float / 1e9 from sniper_funding_events f
		         where f.agent_id = s.agent_id and f.mode = 'live') funded_live_sol,
		       (select coalesce(sum(f.lamports), 0)::float / 1e9 from sniper_funding_events f
		         where f.agent_id = s.agent_id and f.mode <> 'live') funded_sim_sol
		  from agent_sniper_strategies s
		  left join agent_identities i on i.id = s.agent_id
		 order by s.enabled desc, closed_count desc, s.created_at asc`;
}

async function loadEquips() {
	return sql`
		select e.id, e.agent_id, e.network, e.active, e.fires_count, e.last_eval_at, e.last_fired_at,
		       i.name agent_name, st.name strategy_name,
		       (select count(*)::int from agent_strategy_positions p where p.equip_id = e.id) positions,
		       (select coalesce(sum(p.realized_pnl_lamports), 0)::float / 1e9 from agent_strategy_positions p
		         where p.equip_id = e.id) realized_pnl_sol
		  from agent_strategy_equips e
		  left join agent_identities i on i.id = e.agent_id
		  left join agent_strategies st on st.id = e.strategy_id
		 order by e.active desc, e.fires_count desc`;
}

const [snipers, equips, price] = await Promise.all([loadSnipers(), loadEquips(), livePrice()]);

const active = snipers.filter((b) => b.enabled || b.closed_count > 0 || b.open_count > 0);
const reported = includeIdle ? snipers : active;

if (!skipChain) {
	for (const bot of reported) {
		if (!bot.wallet) continue;
		try {
			Object.assign(bot, await chainState(bot.wallet));
		} catch (err) {
			bot.chainError = err.message;
		}
		await sleep(250);
	}
}

const totals = reported.reduce(
	(acc, b) => {
		acc.realized += num(b.realized_pnl_sol);
		acc.deployed += num(b.deployed_sol);
		acc.fundedLive += num(b.funded_live_sol);
		acc.fundedSim += num(b.funded_sim_sol);
		acc.holdingsUsd += num(b.holdingsUsd);
		acc.wins += b.wins;
		acc.losses += b.losses;
		acc.failed += b.failed_count;
		acc.openMarked += num(b.open_marked_sol);
		acc.balance += num(b.solBalance);
		return acc;
	},
	{ realized: 0, deployed: 0, fundedLive: 0, fundedSim: 0, holdingsUsd: 0, wins: 0, losses: 0, failed: 0, openMarked: 0, balance: 0 },
);

if (asJson) {
	console.log(JSON.stringify({ generated_at: new Date().toISOString(), sol_price_usd: price, totals, snipers: reported, equips }, null, 2));
	process.exit(0);
}

const usd = (s) => (price ? ` ($${(s * price).toFixed(2)})` : '');
const when = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : 'never');

console.log(`\nAUTONOMOUS TRADING BOTS  ·  ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
console.log(`SOL reference price: ${price ? `$${price.toFixed(2)}` : 'unknown'}   RPC: ${RPC.replace(/\?.*/, '')}`);

console.log('\nPUMP.FUN SNIPERS');
for (const b of reported) {
	const posture = b.kill_switch ? 'KILLED' : b.enabled ? 'ARMED' : 'off';
	console.log(`\n  ${b.agent_name || '(unnamed)'}  [${b.label || 'no label'}]  ${posture}`);
	console.log(`    trigger ${b.trigger} · ${b.decision_mode || 'rules'} · ${b.network} · ${b.per_trade_sol} SOL/trade, ${b.daily_budget_sol} SOL/day, max ${b.max_concurrent_positions} open`);
	console.log(`    trades: ${b.closed_count} closed (${b.wins}W/${b.losses}L), ${b.open_count} open, ${b.failed_count} failed entries · last ${when(b.last_trade_at)}`);
	console.log(`    realized PnL: ${sol(num(b.realized_pnl_sol))} SOL${usd(num(b.realized_pnl_sol))} on ${num(b.deployed_sol).toFixed(3)} SOL deployed`);
	if (b.open_count) console.log(`    open positions: cost ${num(b.open_cost_sol).toFixed(4)} SOL, marked ${num(b.open_marked_sol).toFixed(4)} SOL`);
	console.log(`    auto-funded: ${num(b.funded_live_sol).toFixed(4)} SOL live${num(b.funded_sim_sol) > 0 ? ` (plus ${num(b.funded_sim_sol).toFixed(2)} SOL simulated, no real money)` : ''}`);
	if (b.wallet) {
		if (b.chainError) console.log(`    wallet ${b.wallet}: chain read failed (${b.chainError})`);
		else if (b.solBalance == null) console.log(`    wallet ${b.wallet} (chain read skipped)`);
		else {
			console.log(`    wallet ${b.wallet}: ${b.solBalance.toFixed(6)} SOL${usd(b.solBalance)} live`);
			if (b.holdings?.length) {
				console.log(`    holding ${b.holdings.length} token bag(s) worth $${b.holdingsUsd.toFixed(2)}:`);
				for (const h of b.holdings) console.log(`      ${('$' + h.usd.toFixed(2)).padStart(10)}  ${h.amount.padStart(18)}  ${h.mint}`);
			} else console.log('    holding: no SPL token balances');
		}
	} else {
		console.log('    wallet: none yet (never executed a trade)');
	}
}

console.log('\nSTRATEGY OBJECT RUNTIME (task-05 equips)');
for (const e of equips) {
	console.log(`  ${e.active ? 'active' : 'off   '}  ${(e.agent_name || e.agent_id).slice(0, 24).padEnd(25)} ${(e.strategy_name || '-').slice(0, 22).padEnd(23)} fires ${String(e.fires_count).padStart(3)} · positions ${e.positions} · PnL ${sol(num(e.realized_pnl_sol))} SOL · last eval ${when(e.last_eval_at)}`);
}

console.log('\nTOTALS');
console.log(`  Bots reported: ${reported.length} (${reported.filter((b) => b.enabled && !b.kill_switch).length} armed)`);
console.log(`  Closed trades: ${totals.wins + totals.losses} (${totals.wins}W / ${totals.losses}L${totals.wins + totals.losses ? `, ${((totals.wins / (totals.wins + totals.losses)) * 100).toFixed(1)}% win rate` : ''})`);
console.log(`  Failed entries: ${totals.failed}`);
console.log(`  Capital deployed into entries: ${totals.deployed.toFixed(3)} SOL${usd(totals.deployed)}`);
console.log(`  Realized PnL: ${sol(totals.realized)} SOL${usd(totals.realized)}`);
console.log(`  Open positions marked: ${totals.openMarked.toFixed(4)} SOL${usd(totals.openMarked)}`);
console.log(`  Real auto-funding into bot wallets: ${totals.fundedLive.toFixed(3)} SOL${usd(totals.fundedLive)}`);
console.log(`  Simulated funding (paper, never moved): ${totals.fundedSim.toFixed(3)} SOL`);
if (!skipChain) {
	console.log(`  Live SOL held across bot wallets: ${totals.balance.toFixed(6)} SOL${usd(totals.balance)}`);
	console.log(`  Live token bags held: $${totals.holdingsUsd.toFixed(2)}`);
	console.log(`  Total live on-chain value: $${(totals.balance * (price || 0) + totals.holdingsUsd).toFixed(2)}`);
}
console.log('');
