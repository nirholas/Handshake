import { neonConfig } from '@neondatabase/serverless';
neonConfig.fetchEndpoint = 'http://127.0.0.1:54490/sql';
neonConfig.useSecureWebSocket = false;
process.env.DATABASE_URL = 'postgres://postgres:pg@127.0.0.1:5432/main';
const { getTraderStats } = await import('./api/_lib/trader-stats.js');
const s = await getTraderStats({ agentId: '22222222-2222-4222-8222-222222222222', network: 'mainnet', window: 'all' });
console.log('metrics keys:', Object.keys(s.metrics).join(','));
console.log('closed[0]:', JSON.stringify(s.closed[0], null, 1));
console.log('open[0]:', JSON.stringify(s.open[0], null, 1));
