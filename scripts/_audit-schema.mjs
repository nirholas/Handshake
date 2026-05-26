#!/usr/bin/env node
// One-shot audit: verifies each schema object from root migrations/ exists in DB.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const tables = [
  'skill_purchases',
  'agent_payment_intents',
  'marketplace_themes',
  'avatar_regen_jobs',
  'user_subdomains',
  'asset_prices',
  'asset_purchases',
  'asset_purchase_receipts',
];

const columns = [
  ['users', 'referral_code'],
  ['users', 'referred_by_id'],
  ['users', 'referral_earnings_total'],
  ['users', 'provider_keys'],
  ['avatars', 'featured'],
  ['avatars', 'view_count'],
  ['avatars', 'usdz_key'],
  ['avatars', 'halfbody_key'],
];

async function tableExists(name) {
  const r = await sql`
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = ${name}
  `;
  return r.length > 0;
}

async function columnExists(table, column) {
  const r = await sql`
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and column_name = ${column}
  `;
  return r.length > 0;
}

const out = { tables: {}, columns: {} };
for (const t of tables) out.tables[t] = await tableExists(t);
for (const [t, c] of columns) out.columns[`${t}.${c}`] = await columnExists(t, c);

const nullableRow = await sql`
  select is_nullable from information_schema.columns
  where table_schema='public' and table_name='avatar_regen_jobs' and column_name='source_avatar_id'
`;
out['avatar_regen_jobs.source_avatar_id.nullable'] =
  nullableRow[0]?.is_nullable === 'YES';

const ck = await sql`
  select pg_get_constraintdef(c.oid) as def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'avatars' and c.conname like 'avatars_source_check%'
`;
out['avatars.source_check.def'] = ck[0]?.def || null;
out['avatars.source_check.allows_reconstruct'] =
  ck[0]?.def?.includes('reconstruct') ?? false;

const indexes = [
  'idx_users_referral_code',
  'idx_users_referred_by_id',
  'idx_avatars_featured',
  'idx_avatars_usdz_key',
  'idx_avatar_regen_jobs_user',
  'idx_avatar_regen_jobs_status',
  'user_subdomains_label_parent',
  'user_subdomains_user',
  'asset_prices_item_unique',
  'asset_purchases_buyer',
];
out.indexes = {};
for (const name of indexes) {
  const r = await sql`select 1 from pg_indexes where schemaname='public' and indexname=${name}`;
  out.indexes[name] = r.length > 0;
}

console.log(JSON.stringify(out, null, 2));
