import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
for (const s of ['forge','studio']) {
  const rows = await sql`select id, source_meta, storage_key from avatars where source=${s} and visibility='public' and deleted_at is null and thumbnail_key is null limit 3`;
  console.log(`\n=== source=${s} ===`);
  rows.forEach(r=>console.log(' meta:', JSON.stringify(r.source_meta), '\n storage_key:', r.storage_key));
}
const t = await sql`select table_name from information_schema.tables where table_name like '%forge%'`;
console.log('\nforge tables:', t.map(x=>x.table_name).join(', '));
