import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const MISSING = sql`thumbnail_key is null or thumbnail_key ~ '^https?://'`;
const [tot] = await sql`select count(*)::int n from avatars where visibility='public' and deleted_at is null and storage_key is not null and (thumbnail_key is null or thumbnail_key ~ '^https?://')`;
console.log('total missing:', tot.n);

const [fc] = await sql`
  select count(*)::int n from avatars a
  join forge_creations f on f.id = (a.source_meta->>'forge_creation_id')::uuid
  where a.visibility='public' and a.deleted_at is null and a.storage_key is not null
    and (a.thumbnail_key is null or a.thumbnail_key ~ '^https?://')
    and f.preview_image_url is not null`;
console.log('  covered by forge_creations.preview_image_url:', fc.n);

const [cl] = await sql`
  select count(*)::int n from avatars a
  join avatars s on s.id = (a.source_meta->>'cloned_from')::uuid
  where a.visibility='public' and a.deleted_at is null and a.storage_key is not null
    and (a.thumbnail_key is null or a.thumbnail_key ~ '^https?://')
    and s.thumbnail_key is not null and s.thumbnail_key !~ '^https?://'`;
console.log('  covered by cloned_from source thumbnail:', cl.n);

// what preview_image_url extensions look like
const ext = await sql`
  select right(f.preview_image_url, 5) e, count(*)::int n from avatars a
  join forge_creations f on f.id = (a.source_meta->>'forge_creation_id')::uuid
  where f.preview_image_url is not null group by e order by n desc limit 6`;
console.log('\npreview_image_url suffixes:'); console.table(ext);
