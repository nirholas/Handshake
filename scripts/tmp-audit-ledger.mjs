import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const byErr = await sql`
  select coalesce(last_error,'(none)') e, count(*)::int n, max(attempts) max_att
  from avatar_thumbnail_backfill group by e order by n desc limit 10`;
console.table(byErr.map(r=>({error:r.e.slice(0,46), rows:r.n, max_attempts:r.max_att})));
const [tot] = await sql`select count(*)::int n from avatar_thumbnail_backfill`;
const [ret] = await sql`select count(*)::int n from avatar_thumbnail_backfill where attempts>=3`;
console.log('ledger rows:', tot.n, '| retired (attempts>=3):', ret.n);
