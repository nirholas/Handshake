import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const t = await sql`select to_regclass('public.avatar_thumbnail_backfill') as t`;
console.log('table avatar_thumbnail_backfill:', t[0].t || 'MISSING');
const idx = await sql`select indexname from pg_indexes where tablename in ('avatar_thumbnail_backfill','avatars') and indexname like '%thumbnail%'`;
console.log('indexes:', idx.map(i=>i.indexname).join(', ') || 'none');
