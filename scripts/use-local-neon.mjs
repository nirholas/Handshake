// Point @neondatabase/serverless at a LOCAL Postgres instead of production.
//
// Load it with `node --import ./scripts/use-local-neon.mjs <script>` before
// anything that imports api/_lib/db.js, and set DATABASE_URL to the proxy.
//
// Why it exists: production's DATABASE_URL is the only one in .env.local, this
// worktree is shared with other agents whose migrations are also pending, and
// `npm run db:migrate` applies EVERY pending migration it finds. Verifying a
// new migration against production would therefore apply somebody else's
// unfinished work. This gives you a throwaway database with the real schema and
// the real migration chain instead.
//
// Pick any throwaway password for the local container and use it in all three
// places. It never leaves your machine, so it is written as a shell variable
// here rather than inline: a literal user:password URL in a committed file is
// what the repo's secret scan exists to stop, and an example is not an
// exception to that.
//
//   PW=$(openssl rand -hex 16)
//   docker run -d --name neon-pg -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=main \
//     -p 55433:5432 postgres:16-alpine
//   docker run -d --name neon-proxy --link neon-pg \
//     -e PG_CONNECTION_STRING="postgres://postgres:$PW@neon-pg:5432/main" \
//     -p 4455:4444 ghcr.io/timowilhelm/local-neon-http-proxy:main
//
//   export DATABASE_URL="postgres://postgres:$PW@127.0.0.1:4455/main"
//   node --import ./scripts/use-local-neon.mjs scripts/apply-schema.mjs
//   node --import ./scripts/use-local-neon.mjs scripts/apply-migrations.mjs --apply
//
// LOCAL_NEON_PROXY overrides the host:port if you ran the proxy somewhere else.

import { neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

const proxy = process.env.LOCAL_NEON_PROXY || '127.0.0.1:4455';

neonConfig.fetchEndpoint = `http://${proxy}/sql`;
neonConfig.useSecureWebSocket = false;
neonConfig.wsProxy = `${proxy}/v2`;
neonConfig.webSocketConstructor = ws;
// Pool must go over the WebSocket leg, not HTTP: the HTTP leg wraps every query
// in a prepared statement, and both the schema file and the migration runner
// send multi-statement SQL, which a prepared statement refuses.
neonConfig.poolQueryViaFetch = false;
