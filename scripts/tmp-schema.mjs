import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const cols = await sql`select column_name, data_type from information_schema.columns where table_name='avatars' order by ordinal_position`;
console.log('avatars cols:', cols.map(c=>c.column_name).join(', '));
const src = await sql`select source, count(*)::int n from avatars where visibility='public' and deleted_at is null and storage_key is not null and (thumbnail_key is null or thumbnail_key ~ '^https?://') group by source order by n desc`;
console.log('\nmissing-thumb avatars by source:'); console.table(src);
