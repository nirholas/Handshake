import { neonConfig } from '@neondatabase/serverless';
neonConfig.fetchEndpoint = 'http://127.0.0.1:54490/sql';
neonConfig.useSecureWebSocket = false;
process.env.DATABASE_URL = 'postgres://postgres:pg@127.0.0.1:5432/main';
const { toolDefs } = await import('./api/_mcp/tools/trader.js');
const profile = toolDefs.find((t) => t.name === 'trader_profile');
const r = await profile.handler(
	{ agent_id: '22222222-2222-4222-8222-222222222222', window: 'all' },
	{ userId: null, rateKey: null, scope: '' },
);
const p = r.structuredContent;
console.log('recent_trades:', JSON.stringify(p.recent_trades, null, 1));
console.log('open_positions:', JSON.stringify(p.open_positions, null, 1));
console.log('win_rate_pct:', p.metrics.win_rate_pct, 'recommendation:', p.recommendation);
