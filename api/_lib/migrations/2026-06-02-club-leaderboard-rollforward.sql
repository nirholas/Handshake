-- Roll-forward for GET /api/club/leaderboard 500s — schema drift on prod.
-- Apply: npm run db:migrate -- --apply --file 2026-06-02-club-leaderboard-rollforward.sql
--
-- The leaderboard joins club_dancer_wallets ⋈ club_tips and reads
-- t.amount_atomics / t.paid_at / t.created_at. On production those columns or
-- tables were missing (Postgres 42703 column-not-found / 42P01 undefined-table
-- swallowed by the endpoint's catch), so every request 500'd.
--
-- The canonical definitions live in 2026-05-22-club-tips.sql and
-- 2026-05-23-club-dancer-wallets.sql. If those are recorded as applied in
-- schema_migrations but the live tables drifted (partial apply / applied to a
-- different DB), the runner will not re-run them. This dated rollforward has a
-- later filename so it runs regardless, and is fully idempotent
-- (CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so it is a no-op on any
-- environment already in sync. Mirrors the 2026-05-25 rollforward precedent.

begin;

-- ── club_tips — live-tip ledger the leaderboard sums over ────────────────────
create table if not exists club_tips (
    id              uuid        primary key default gen_random_uuid(),
    ticket_id       text        not null unique,
    dancer          text        not null,
    dance           text        not null,
    clip            text,
    label           text,
    payer           text,
    network         text,
    amount_atomics  numeric,
    asset           text,
    started_at      timestamptz not null,
    ends_at         timestamptz not null,
    paid_at         timestamptz,
    paid_tx         text,
    created_at      timestamptz not null default now()
);

-- Backfill columns the leaderboard query depends on, in case the table predates
-- them. All no-ops once the table is current.
alter table club_tips add column if not exists amount_atomics numeric;
alter table club_tips add column if not exists paid_at        timestamptz;
alter table club_tips add column if not exists paid_tx        text;
alter table club_tips add column if not exists created_at     timestamptz not null default now();

create index if not exists club_tips_created_at_desc
    on club_tips (created_at desc);
create index if not exists club_tips_dancer_created
    on club_tips (dancer, created_at desc);
create index if not exists club_tips_unpaid_by_dancer_net
    on club_tips (dancer, network, asset)
    where paid_at is null;

-- ── club_dancer_wallets — dancer registry the leaderboard left-joins from ────
create table if not exists club_dancer_wallets (
    dancer          text         primary key,
    display_name    text         not null,
    bio             text,
    evm_address     text,
    solana_address  text,
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now()
);

-- Seed the four built-in stage slots so the leaderboard renders rows even with
-- zero tips. Names match /api/x402/dance-tip and src/club.js.
insert into club_dancer_wallets (dancer, display_name) values
    ('1', 'Nyx'),
    ('2', 'Ari'),
    ('3', 'Sable'),
    ('4', 'Vesper')
on conflict (dancer) do update
    set display_name = excluded.display_name,
        updated_at   = now();

-- ── club_payouts — referenced by the same subsystem; keep it in sync too ─────
create table if not exists club_payouts (
    id                uuid        primary key default gen_random_uuid(),
    dancer            text        not null references club_dancer_wallets(dancer),
    network           text        not null,
    asset             text        not null,
    amount_atomics    numeric     not null,
    tx                text        not null,
    swept_tip_count   integer     not null,
    created_at        timestamptz not null default now()
);
create index if not exists club_payouts_dancer_created
    on club_payouts (dancer, created_at desc);

commit;
