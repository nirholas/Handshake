import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const c = await sql`select column_name from information_schema.columns where table_name='forge_creations' order by ordinal_position`;
console.log('forge_creations cols:', c.map(x=>x.column_name).join(', '));
const [a] = await sql`select count(*)::int n from forge_creations where preview_key is not null`;
const [b] = await sql`select count(*)::int n from forge_creations where preview_image_url is not null`;
console.log('fc with preview_key:', a.n, '| with preview_image_url:', b.n);
const [cov] = await sql`
  select count(*)::int n from avatars a
  join forge_creations f on f.id=(a.source_meta->>'forge_creation_id')::uuid
  where a.visibility='public' and a.deleted_at is null and a.thumbnail_key is null
    and f.preview_key is not null`;
console.log('missing-thumb avatars adoptable via fc.preview_key:', cov.n);
const s = await sql`select preview_key, preview_image_url from forge_creations where preview_key is not null limit 2`;
s.forEach(r=>console.log(' key:', r.preview_key, '\n url:', r.preview_image_url));
