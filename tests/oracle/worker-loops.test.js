/**
 * Oracle worker: core-path smoke tests (workers/oracle/*).
 *
 * The worker's three loops run in production inside the every-2-minutes
 * /api/cron/oracle-score driver, which imports these exact modules. The pure
 * pieces they call (conviction, agent-eval, settle) are covered by their own
 * suites; what was untested is the worker layer itself, where a silent break
 * looks like "the feed just stopped warming":
 *
 *   · loadConfig():      boot-time validation. A live deploy without
 *                        JWT_SECRET can never decrypt an agent wallet, so it
 *                        must fail loud at boot instead of logging failed
 *                        fills forever.
 *   · executeAction():   the simulate path every production action takes today
 *                        (no ORACLE_MODE is set on the Cloud Run service).
 *                        It must spend nothing, never touch a keypair, and
 *                        still respect the hard per-trade cap.
 *   · actOnFreshCoins(): the kill switch and the armed-watch fan-out.
 *   · runSettlePass():   writes the graded outcome back to the ledger.
 *
 * The DB is mocked with a tagged-template `sql` that routes on real query text,
 * so the assertions are about the queries the worker actually issues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls = [];
let routes = [];

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
		calls.push({ text, values });
		for (const [fragment, rows] of routes) {
			if (text.includes(fragment)) return rows;
		}
		return [];
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

// Live execution decrypts an agent's custodial keypair. Simulate mode must never
// reach it; the spy proves that rather than assuming it.
const loadAgentKeypair = vi.fn(async () => {
	throw new Error('simulate mode must never load an agent keypair');
});
vi.mock('../../workers/oracle/keys.js', () => ({ loadAgentKeypair, clearKeyCache: () => {} }));

const { loadConfig } = await import('../../workers/oracle/config.js');
const { executeAction } = await import('../../workers/oracle/executor.js');
const { actOnFreshCoins } = await import('../../workers/oracle/agent-loop.js');
const { runSettlePass } = await import('../../workers/oracle/settle-loop.js');

const ORACLE_ENV = [
	'DATABASE_URL', 'JWT_SECRET', 'ORACLE_MODE', 'ORACLE_NETWORK', 'ORACLE_GLOBAL_KILL',
	'ORACLE_SCORE_INTERVAL_MS', 'ORACLE_AGENT_INTERVAL_MS', 'ORACLE_SETTLE_INTERVAL_MS',
	'ORACLE_SCORE_BATCH', 'ORACLE_RESCORE_AFTER_SEC', 'ORACLE_MAX_TRADE_SOL',
	'ORACLE_USE_JITO', 'JITO_TIP_SOL', 'JITO_BUNDLE_URL', 'TELEGRAM_BOT_TOKEN',
];
let saved;

beforeEach(() => {
	saved = Object.fromEntries(ORACLE_ENV.map((k) => [k, process.env[k]]));
	for (const k of ORACLE_ENV) delete process.env[k];
	process.env.DATABASE_URL = 'postgresql://oracle:test@localhost:5432/oracle_test';
	calls.length = 0;
	routes = [];
	vi.clearAllMocks();
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe('loadConfig', () => {
	it('defaults to the safe posture: simulate on mainnet, kill switch off', () => {
		const cfg = loadConfig();
		expect(cfg.mode).toBe('simulate');
		expect(cfg.network).toBe('mainnet');
		expect(cfg.globalKill).toBe(false);
		expect(cfg.scoreIntervalMs).toBe(15_000);
		expect(cfg.agentIntervalMs).toBe(3_000);
		expect(cfg.settleIntervalMs).toBe(60_000);
		expect(cfg.scoreBatch).toBe(20);
		expect(cfg.rescoreAfterSec).toBe(180);
		expect(cfg.maxTradeSolHardCap).toBe(0.25);
		expect(cfg.useJito).toBe(false);
	});

	it('treats any unrecognised mode or network as the safe one', () => {
		process.env.ORACLE_MODE = 'LIVE-ish';
		process.env.ORACLE_NETWORK = 'testnet';
		const cfg = loadConfig();
		expect(cfg.mode).toBe('simulate');
		expect(cfg.network).toBe('mainnet');
	});

	it('accepts live mode only with the secret that decrypts agent wallets', () => {
		process.env.ORACLE_MODE = 'live';
		expect(() => loadConfig()).toThrow(/JWT_SECRET/);
		process.env.JWT_SECRET = 'test-jwt-secret-value';
		expect(loadConfig().mode).toBe('live');
	});

	it('refuses to boot without a database', () => {
		delete process.env.DATABASE_URL;
		expect(() => loadConfig()).toThrow(/DATABASE_URL/);
	});

	it('honours devnet and the interval overrides', () => {
		process.env.ORACLE_NETWORK = 'devnet';
		process.env.ORACLE_SCORE_INTERVAL_MS = '4000';
		process.env.ORACLE_SCORE_BATCH = '5';
		process.env.ORACLE_GLOBAL_KILL = '1';
		const cfg = loadConfig();
		expect(cfg.network).toBe('devnet');
		expect(cfg.scoreIntervalMs).toBe(4000);
		expect(cfg.scoreBatch).toBe(5);
		expect(cfg.globalKill).toBe(true);
	});

	it('falls back to the default when an interval is unparseable', () => {
		process.env.ORACLE_AGENT_INTERVAL_MS = 'soon';
		expect(loadConfig().agentIntervalMs).toBe(3_000);
	});

	it('caps the Jito tip at 0.01 SOL however large the env value is', () => {
		process.env.ORACLE_USE_JITO = '1';
		process.env.JITO_TIP_SOL = '5';
		const cfg = loadConfig();
		expect(cfg.useJito).toBe(true);
		expect(cfg.jitoTipSol).toBe(0.01);
	});
});

const simulateCfg = { mode: 'simulate', network: 'mainnet', globalKill: false, maxTradeSolHardCap: 0.25 };
const watch = {
	agent_id: 'agent-1', user_id: 'user-1', network: 'mainnet', armed: true, mode: 'simulate',
	min_score: 60, min_tier: 'strong', categories: [], per_trade_sol: 0.05, max_daily_sol: 1,
	max_open: 5, require_smart_money: true, size_scaling: false, telegram_chat_id: null,
	agent_name: 'Test Oracle Agent',
};
const coin = {
	mint: 'THREEsynthetic1111111111111111111111111111', symbol: 'SYNTH', name: 'Synthetic',
	score: 72, tier: 'strong', category: 'ai', smart_wallet_count: 3, badges: [],
	scored_at: '2026-08-11T00:00:00.000Z',
};

/** The single `insert into oracle_watch_actions` issued by a pass, as a named row. */
function insertedAction() {
	const call = calls.find((c) => c.text.startsWith('insert into oracle_watch_actions'));
	if (!call) return null;
	const [agent_id, user_id, network, mint, symbol, conviction, tier, mode, size_sol, status, reason, entry_mc_usd, tx_signature] = call.values;
	return { agent_id, user_id, network, mint, symbol, conviction, tier, mode, size_sol, status, reason, entry_mc_usd, tx_signature };
}

describe('executeAction (simulate path)', () => {
	it('logs a filled simulate action and never loads a keypair', async () => {
		const res = await executeAction({ cfg: simulateCfg, watch, coin, size: 0.05, reason: 'conviction 72' });
		expect(res).toEqual({ status: 'filled' });
		expect(loadAgentKeypair).not.toHaveBeenCalled();

		const row = insertedAction();
		expect(row).not.toBeNull();
		expect(row.mode).toBe('simulate');
		expect(row.status).toBe('filled');
		expect(row.size_sol).toBe(0.05);
		expect(row.mint).toBe(coin.mint);
		expect(row.conviction).toBe(72);
		expect(row.tx_signature).toBeNull();
	});

	it('clamps the size to the hard per-trade cap, whatever the watch asked for', async () => {
		await executeAction({ cfg: simulateCfg, watch, coin, size: 9, reason: 'oversized' });
		expect(insertedAction().size_sol).toBe(0.25);
	});

	it('records the entry market cap when the brain has one', async () => {
		routes = [['from pump_coin_outcomes', [{ last_market_cap_usd: '41250.5' }]]];
		await executeAction({ cfg: simulateCfg, watch, coin, size: 0.05, reason: 'conviction 72' });
		expect(insertedAction().entry_mc_usd).toBe(41250.5);
	});

	it('stays in simulate when the worker is live but the watch is not', async () => {
		await executeAction({ cfg: { ...simulateCfg, mode: 'live' }, watch, coin, size: 0.05, reason: 'r' });
		expect(loadAgentKeypair).not.toHaveBeenCalled();
		expect(insertedAction().mode).toBe('simulate');
	});
});

describe('actOnFreshCoins', () => {
	it('acts once for an armed watch whose bar the coin clears', async () => {
		routes = [['from oracle_agent_watch w', [watch]]];
		const acted = await actOnFreshCoins(simulateCfg, [coin]);
		expect(acted).toBe(1);
		expect(insertedAction().agent_id).toBe('agent-1');
	});

	it('does not act when the coin is below the watch threshold', async () => {
		routes = [['from oracle_agent_watch w', [watch]]];
		const acted = await actOnFreshCoins(simulateCfg, [{ ...coin, score: 41, tier: 'watch' }]);
		expect(acted).toBe(0);
		expect(insertedAction()).toBeNull();
	});

	it('does not act on a coin this agent already has an action for', async () => {
		routes = [
			['from oracle_agent_watch w', [watch]],
			['select agent_id, mint from oracle_watch_actions', [{ agent_id: 'agent-1', mint: coin.mint }]],
		];
		expect(await actOnFreshCoins(simulateCfg, [coin])).toBe(0);
		expect(insertedAction()).toBeNull();
	});

	it('stops at the agent open-position cap', async () => {
		routes = [
			['from oracle_agent_watch w', [watch]],
			['group by agent_id', [{ agent_id: 'agent-1', open_count: 5, spent_today: '0' }]],
		];
		expect(await actOnFreshCoins(simulateCfg, [coin])).toBe(0);
	});

	it('the global kill switch halts every action without touching the database', async () => {
		routes = [['from oracle_agent_watch w', [watch]]];
		expect(await actOnFreshCoins({ ...simulateCfg, globalKill: true }, [coin])).toBe(0);
		expect(calls).toHaveLength(0);
	});
});

describe('runSettlePass', () => {
	const openAction = {
		id: 'action-1', agent_id: 'agent-1', size_sol: '0.05', entry_mc_usd: '20000',
		symbol: 'SYNTH', conviction: 72, tier: 'strong', mode: 'simulate', mint: coin.mint,
		agent_name: 'Test Oracle Agent',
	};

	it('grades a graduated coin as a win and writes the mark back', async () => {
		routes = [['join pump_coin_outcomes o', [{
			...openAction, graduated: true, rugged: false, ath_multiple: '3.4', last_market_cap_usd: '60000',
		}]]];
		expect(await runSettlePass(simulateCfg)).toBe(1);

		const update = calls.find((c) => c.text.startsWith('update oracle_watch_actions'));
		expect(update).toBeTruthy();
		const [outcome, peak, pnl, id] = update.values;
		expect(outcome).toBe('win');
		expect(peak).toBe(3.4);
		// 0.05 SOL marked from a 20k entry to a 60k last cap = +0.1 SOL.
		expect(pnl).toBeCloseTo(0.1, 6);
		expect(id).toBe('action-1');
	});

	it('leaves an action open while its coin has no resolved signal', async () => {
		routes = [['join pump_coin_outcomes o', [{
			...openAction, graduated: false, rugged: false, ath_multiple: null, last_market_cap_usd: null,
		}]]];
		expect(await runSettlePass(simulateCfg)).toBe(0);
		expect(calls.find((c) => c.text.startsWith('update oracle_watch_actions'))).toBeUndefined();
	});

	it('is a no-op when nothing is settleable', async () => {
		expect(await runSettlePass(simulateCfg)).toBe(0);
	});
});
