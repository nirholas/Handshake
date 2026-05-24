-- Migration: user_subdomains — tracks `<label>.threews.sol` SNS claims minted
-- by api/threews/subdomain.js. Without this table every reader of /api/threews/
-- (subdomain check, me, dashboard widget) 500s with `relation does not exist`.
--
-- Apply: npm run db:migrate -- --apply --file 2026-05-25-user-subdomains.sql
-- Idempotent.

begin;

create table if not exists user_subdomains (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    label           text not null,                            -- e.g. "nich" for nich.threews.sol
    parent          text not null,                            -- platform parent label, e.g. "threews"
    owner_wallet    text not null,                            -- on-chain owner (base58 Solana pubkey)
    url_record      text,                                     -- SNS URL record set at mint time
    signature       text,                                     -- Solana tx signature of the mint
    created_at      timestamptz not null default now()
);

-- One claim per <label>.<parent>. Without this the availability check has
-- to scan + dedup in code, and a concurrent double-mint could insert twice.
create unique index if not exists user_subdomains_label_parent
    on user_subdomains(label, parent);

create index if not exists user_subdomains_user
    on user_subdomains(user_id, created_at desc);

commit;
