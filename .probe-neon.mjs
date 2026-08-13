import { neon, neonConfig } from '@neondatabase/serverless';
neonConfig.fetchEndpoint = 'http://127.0.0.1:54490/sql';
neonConfig.useSecureWebSocket = false;
neonConfig.poolQueryViaFetch = true;
const sql = neon('postgres://postgres:pg@127.0.0.1:5432/main');
console.log(await sql`select version()`);
