import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared, test-controlled state for the fake DB + mocks. vi.hoisted lets the
// mock factories (hoisted above imports) read/write it.
const H = vi.hoisted(() => ({
	configs: [],
	agent: { id: 'agent-1', user_id: 'user-1', name: 'Nova', avatar_id: 'av-1', solana_address: 'AgentAddr1111', twitter: 'https://x.com/nova_agent', website: 'https://nova.example', telegram: null },
	queueCount: 5,
	lastRun: [], // [] ⇒ cadence not gated
	fund: { ok: true, signature: 'fund-sig', lamports: 30_000_000 },
	masterSol: 10,
	agentSol: 1, // agent wallet balance for the self-funded user path
}));

// Query-aware fake `sql`: routes by the joined template text, ignores values.
vi.mock('../api/_lib/db.js', () => {
	const sql = (strings, ...vals) => {
		if (!Array.isArray(strings)) return { __frag: true }; // sql(identifier) fragment
		const q = strings.join(' ').toLowerCase();
		const rows =
			q.includes('create ') || q.includes('insert into launcher_config') ? []
			: q.includes('from launcher_config where enabled') ? H.configs
			: q.includes('select created_at from launcher_runs') ? H.lastRun
			: q.includes('as c from launcher_runs') ? [{ c: 0 }]
			: q.includes('as c from launcher_queue') ? [{ c: H.queueCount }]
			: q.includes('from launcher_queue q') ? [H.agent]
			: q.includes('insert into launcher_runs') ? [{ id: 'run-1' }]
			: q.includes('select status from launcher_runs') ? []
			: [];
		return Promise.resolve(rows);
	};
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/launcher-funding.js', () => ({
	masterBalanceSol: vi.fn(async () => H.masterSol),
	dailySpentSol: vi.fn(async () => 0),
	fundAgentForLaunch: vi.fn(async () => H.fund),
}));

vi.mock('../api/_lib/launcher-sources.js', () => ({
	pickSource: vi.fn(async () => ({
		kind: 'random',
		name: 'Turbo Otter',
		symbol: 'TURBOTTR',
		description: 'test coin',
		trigger_source: 'random',
		trigger_detail: { top_narrative: 'otters' },
	})),
}));

vi.mock('../api/_lib/auth.js', () => ({ createSession: vi.fn(async () => 'session-token') }));
vi.mock('../api/_lib/agent-pumpfun.js', () => ({ solanaConnection: vi.fn(() => ({})) }));
// Agent-wallet balance read for the self-funded user path.
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	getSolBalance: vi.fn(async () => ({ sol: H.agentSol, lamports: Math.round(H.agentSol * 1e9) })),
}));

import { runLauncherTick } from '../api/_lib/launcher-engine.js';
import { fundAgentForLaunch } from '../api/_lib/launcher-funding.js';

function makeConfig(over = {}) {
	return {
		id: 'cfg-global', scope: 'global', user_id: null,
		enabled: true, dry_run: true, paused: false, pause_reason: null,
		mode: 'random', sources: [], categories: [],
		target_cadence_seconds: 60, max_per_hour: 30,
		per_launch_sol: 0.03, dev_buy_sol: 0, daily_sol_cap: 1,
		buyback_bps: 5000, network: 'devnet', ...over,
	};
}

beforeEach(() => {
	H.configs = [];
	H.lastRun = [];
	H.queueCount = 5;
	H.fund = { ok: true, signature: 'fund-sig', lamports: 30_000_000 };
	H.masterSol = 10;
	H.agentSol = 1;
	vi.clearAllMocks();
});

function makeUserConfig(over = {}) {
	return makeConfig({
		id: 'cfg-user', scope: 'user', user_id: 'user-1',
		dry_run: false, dev_buy_sol: 0.01, daily_sol_cap: 1, ...over,
	});
}

describe('runLauncherTick — disabled', () => {
	it('is fully inert when no config is enabled (no scopes, no spend)', async () => {
		H.configs = [];
		const out = await runLauncherTick();
		expect(out.ok).toBe(true);
		expect(out.scopes).toBe(0);
		expect(out.results).toEqual([]);
		expect(fundAgentForLaunch).not.toHaveBeenCalled();
	});
});

describe('runLauncherTick — dry run', () => {
	it('selects a coin + agent and records a dry_run without moving SOL', async () => {
		H.configs = [makeConfig({ dry_run: true })];
		const out = await runLauncherTick();
		expect(out.scopes).toBe(1);
		const r = out.results[0];
		expect(r.dry_run).toBe(true);
		expect(r.name).toBe('Turbo Otter');
		expect(r.symbol).toBe('TURBOTTR');
		expect(fundAgentForLaunch).not.toHaveBeenCalled(); // the safety contract
	});
});

describe('runLauncherTick — live', () => {
	it('funds the agent and launches through the real signed path', async () => {
		H.configs = [makeConfig({ dry_run: false })];

		// build-metadata then launch-agent over the internal authenticated fetch.
		const fetchMock = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('action=build-metadata')) {
				return { status: 200, json: async () => ({ metadata_url: 'ipfs://meta' }) };
			}
			if (u.includes('action=launch-agent')) {
				return { status: 200, json: async () => ({ mint: 'MINTxyz', signature: 'launch-sig' }) };
			}
			return { status: 404, json: async () => ({}) };
		});
		vi.stubGlobal('fetch', fetchMock);

		const out = await runLauncherTick();
		const r = out.results[0];
		expect(fundAgentForLaunch).toHaveBeenCalledTimes(1);
		expect(r.mint).toBe('MINTxyz');
		expect(r.symbol).toBe('TURBOTTR');
		// metadata build + launch = two internal POSTs
		expect(fetchMock).toHaveBeenCalledTimes(2);

		vi.unstubAllGlobals();
	});

	it('forwards the dev buy and the agent socials into the real launch', async () => {
		H.configs = [makeConfig({ dry_run: false, dev_buy_sol: 0.01, per_launch_sol: 0.04 })];

		const bodies = {};
		const fetchMock = vi.fn(async (url, opts) => {
			const u = String(url);
			const body = opts?.body ? JSON.parse(opts.body) : {};
			if (u.includes('action=build-metadata')) {
				bodies.meta = body;
				return { status: 200, json: async () => ({ metadata_url: 'ipfs://meta' }) };
			}
			if (u.includes('action=launch-agent')) {
				bodies.launch = body;
				return { status: 200, json: async () => ({ mint: 'MINTxyz', signature: 'launch-sig' }) };
			}
			return { status: 404, json: async () => ({}) };
		});
		vi.stubGlobal('fetch', fetchMock);

		await runLauncherTick();

		// Dev buy rides through to the on-chain initial buy.
		expect(bodies.launch.sol_buy_in).toBe(0.01);
		// The agent's own X + site are forwarded; absent telegram is omitted (server
		// falls back to the three.ws channel).
		expect(bodies.meta.twitter).toBe('https://x.com/nova_agent');
		expect(bodies.meta.website).toBe('https://nova.example');
		expect(bodies.meta).not.toHaveProperty('telegram');

		vi.unstubAllGlobals();
	});

	it('records a skip (no launch) when the master balance is too low', async () => {
		H.configs = [makeConfig({ dry_run: false })];
		H.masterSol = 0.001; // below per_launch + buffer
		const out = await runLauncherTick();
		expect(out.results[0].skipped).toMatch(/master low/);
		expect(fundAgentForLaunch).not.toHaveBeenCalled();
	});
});

describe('runLauncherTick — live user scope (self-funded)', () => {
	function stubLaunchFetch(overrides = {}) {
		const fetchMock = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('action=build-metadata')) {
				return { status: 200, json: async () => ({ metadata_url: 'ipfs://meta' }) };
			}
			if (u.includes('action=launch-agent')) {
				if (overrides.launch) return overrides.launch;
				return { status: 200, json: async () => ({ mint: 'MINTuser', signature: 'launch-sig' }) };
			}
			return { status: 404, json: async () => ({}) };
		});
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	it('launches from the agent wallet without ever touching the master', async () => {
		H.configs = [makeUserConfig()];
		const fetchMock = stubLaunchFetch();

		const out = await runLauncherTick();
		const r = out.results[0];
		expect(r.mint).toBe('MINTuser');
		// The self-funded contract: no master balance read, no master transfer.
		expect(fundAgentForLaunch).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		vi.unstubAllGlobals();
	});

	it('skips with the deposit address (never fails) when the agent wallet is unfunded', async () => {
		H.configs = [makeUserConfig()];
		H.agentSol = 0.001; // below base + dev buy + buffer
		const fetchMock = stubLaunchFetch();

		const out = await runLauncherTick();
		const r = out.results[0];
		expect(r.skipped).toMatch(/unfunded/);
		expect(r.deposit_to).toBe('AgentAddr1111');
		expect(r.error).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled(); // caught before any launch work
		expect(fundAgentForLaunch).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
	});

	it('treats a 402 from the launch preflight as a recoverable skip, not a failure', async () => {
		H.configs = [makeUserConfig()];
		stubLaunchFetch({
			launch: {
				status: 402,
				json: async () => ({ error: 'insufficient_funds', error_description: 'deposit to AgentAddr1111' }),
			},
		});

		const out = await runLauncherTick();
		const r = out.results[0];
		expect(r.skipped).toMatch(/unfunded/);
		expect(r.error).toBeUndefined();
		expect(r.breaker_tripped).toBeUndefined();

		vi.unstubAllGlobals();
	});

	it('skips when the launch would exceed the daily SOL cap remainder', async () => {
		H.configs = [makeUserConfig({ dev_buy_sol: 0.5, daily_sol_cap: 0.1 })];
		const fetchMock = stubLaunchFetch();

		const out = await runLauncherTick();
		expect(out.results[0].skipped).toMatch(/daily SOL cap/);
		expect(fetchMock).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
	});
});
