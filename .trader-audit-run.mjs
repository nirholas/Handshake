// Live exercise of api/_mcp/tools/trader.js against a real Postgres 16 reached
// through the Neon HTTP driver (local-neon-http-proxy). No stubs: the handlers
// run their real SQL against the repo's real schema.
import { neonConfig } from '@neondatabase/serverless';
neonConfig.fetchEndpoint = 'http://127.0.0.1:54490/sql';
neonConfig.useSecureWebSocket = false;
process.env.DATABASE_URL = 'postgres://postgres:pg@127.0.0.1:5432/main';

const { sql } = await import('./api/_lib/db.js');
const { toolDefs } = await import('./api/_mcp/tools/trader.js');
const byName = Object.fromEntries(toolDefs.map((t) => [t.name, t]));

const USER = '11111111-1111-4111-8111-111111111111';
const LEADER = '22222222-2222-4222-8222-222222222222';
const PRIVATE = '33333333-3333-4333-8333-333333333333';
const WALLET = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const LEADERW = 'THREEsynthetic1111111111111111111111111111';

await sql`delete from copy_subscriptions where copier_user_id = ${USER}`;
await sql`delete from agent_sniper_positions where agent_id in (${LEADER}, ${PRIVATE})`;
await sql`delete from agent_identities where id in (${LEADER}, ${PRIVATE})`;
await sql`delete from users where id = ${USER}`;
await sql`insert into users (id, email) values (${USER}, 'trader-audit@three.ws')`;
await sql`insert into agent_identities (id, user_id, name, is_public)
          values (${LEADER}, ${USER}, 'Audit Leader', true)`;
await sql`insert into agent_identities (id, user_id, name, is_public)
          values (${PRIVATE}, ${USER}, 'Private Leader', false)`;
const [strategy] = await sql`insert into agent_sniper_strategies (agent_id, user_id, network, per_trade_lamports)
                             values (${LEADER}, ${USER}, 'mainnet', 100000000) returning id`;

// Two closed wins and one open position, all with real lamport columns.
const mk = (mint, pnl, closed) => sql`
  insert into agent_sniper_positions
    (strategy_id, user_id, agent_id, wallet, mint, symbol, name, network, status,
     entry_quote_lamports, exit_quote_lamports, realized_pnl_lamports, realized_pnl_pct,
     buy_sig, sell_sig, opened_at, closed_at)
  values (${strategy.id}, ${USER}, ${LEADER}, ${LEADERW}, ${mint}, 'AUD', 'Audit Coin', 'mainnet', ${closed ? 'closed' : 'open'},
     ${1_000_000_000}, ${closed ? 1_000_000_000 + pnl : null}, ${closed ? pnl : null}, ${closed ? (pnl / 1e9) * 100 : null},
     ${'buysig' + mint}, ${closed ? 'sellsig' + mint : null}, now() - interval '2 days', ${closed ? new Date().toISOString() : null})`;
await mk('THREEsynthetica111111111111111111111111111', 400_000_000, true);
await mk('THREEsyntheticb111111111111111111111111111', 250_000_000, true);
await mk('THREEsyntheticc111111111111111111111111111', 0, false);

const authed = { userId: USER, rateKey: null, scope: 'agents:read agents:write' };
const anon = { userId: null, rateKey: null, scope: '' };

const show = (label, r) => {
	const text = r.content?.[0]?.text ?? '';
	console.log(`\n### ${label} ${r.isError ? '[isError]' : '[ok]'}\n${text.slice(0, 900)}`);
};

show('trader_leaderboard (real board)', await byName.trader_leaderboard.handler({ limit: 5, window: 'all' }, anon));
show('trader_profile (real agent)', await byName.trader_profile.handler({ agent_id: LEADER, window: 'all' }, anon));
show('trader_profile (bad uuid)', await byName.trader_profile.handler({ agent_id: 'nope' }, anon));
show('trader_profile (unknown uuid)', await byName.trader_profile.handler({ agent_id: '44444444-4444-4444-8444-444444444444' }, anon));
show('trader_profile (private agent)', await byName.trader_profile.handler({ agent_id: PRIVATE }, anon));
show('copy_status (anonymous)', await byName.copy_status.handler({}, anon));
show('copy_status (empty)', await byName.copy_status.handler({}, authed));
show('copy_subscribe (bad wallet)', await byName.copy_subscribe.handler({ leader_agent_id: LEADER, copier_wallet: 'nope' }, authed));
show('copy_subscribe (bad config)', await byName.copy_subscribe.handler({ leader_agent_id: LEADER, copier_wallet: WALLET, sizing_rule: 'fixed', fixed_sol: 0, per_trade_cap_sol: 1, daily_budget_sol: 1 }, authed));
show('copy_subscribe (private leader)', await byName.copy_subscribe.handler({ leader_agent_id: PRIVATE, copier_wallet: WALLET, fixed_sol: 0.1 }, authed));
show('copy_subscribe (create)', await byName.copy_subscribe.handler({ leader_agent_id: LEADER, copier_wallet: WALLET, fixed_sol: 0.1, per_trade_cap_sol: 0.2, daily_budget_sol: 1, telegram_chat_id: '-1002233445566', perf_fee_bps: 500 }, authed));
show('copy_subscribe (update, same key)', await byName.copy_subscribe.handler({ leader_agent_id: LEADER, copier_wallet: WALLET, sizing_rule: 'multiplier', multiplier: 2, per_trade_cap_sol: 0.3, daily_budget_sol: 2 }, authed));
show('copy_status (populated)', await byName.copy_status.handler({}, authed));

const [row] = await sql`select telegram_chat_id, leader_wallet, perf_fee_bps, sizing_rule, multiplier
                        from copy_subscriptions where copier_user_id = ${USER}`;
console.log('\n### persisted row:', JSON.stringify(row));

const concurrent = await Promise.all([
	byName.copy_subscribe.handler({ leader_agent_id: LEADER, copier_wallet: WALLET, fixed_sol: 0.11, per_trade_cap_sol: 0.2, daily_budget_sol: 1 }, authed),
	byName.copy_subscribe.handler({ leader_agent_id: LEADER, copier_wallet: WALLET, fixed_sol: 0.12, per_trade_cap_sol: 0.2, daily_budget_sol: 1 }, authed),
]);
console.log('\n### concurrent upserts isError flags:', concurrent.map((r) => !!r.isError));
const [count] = await sql`select count(*)::int as n from copy_subscriptions where copier_user_id = ${USER}`;
console.log('### rows after concurrent upserts:', count.n);
