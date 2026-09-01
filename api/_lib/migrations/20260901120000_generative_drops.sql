begin;

-- Generative 3D drops: supply-capped collections of AI-forged, rigged
-- characters.
--
-- A drop stores its SPEC, not its art. Every item's traits are re-derivable
-- from (seed, index, layers) by api/_lib/drops.js, so the rows below are a
-- materialized cache of a pure function plus the mutable reveal/mint state
-- layered on top. That split is deliberate: it lets a holder recompute the
-- whole supply from the published spec and check it against what we served,
-- and it lets us re-forge a lost GLB years later without having stored a
-- per-item random seed.

create table if not exists drops (
    id                  uuid primary key default gen_random_uuid(),
    owner_id            uuid        not null references users(id) on delete cascade,
    slug                text        not null,
    name                text        not null,
    -- Ticker-style short name shown on cards and carried into token metadata.
    symbol              text        not null,
    description         text,
    -- The base text-to-3D style every item in the supply shares. Item prompts
    -- are this plus the item's rolled trait fragments (drops.itemPrompt).
    style               text        not null,
    supply              integer     not null,
    -- The roll seed. Published once the drop goes live; before that it is the
    -- one field that makes the provenance hash a commitment rather than a
    -- description, so a draft's seed is never served.
    seed                text        not null,
    -- sha256 over (version, seed, supply, style, layers). Published at create
    -- time; recomputable by anyone from the spec.
    provenance_hash     text        not null,
    -- Normalized trait layers: [{key, name, options:[{value, weight, prompt}]}]
    layers              jsonb       not null,
    -- draft: spec still editable, nothing revealed, seed withheld.
    -- live:  spec frozen, seed published, items revealable.
    -- closed: no further reveals.
    status              text        not null default 'draft',
    visibility          text        not null default 'public',
    cover_item_index    integer,
    -- Metaplex Core collection address once the drop is anchored on Solana.
    -- Null until the creator mints the collection; items reference it on mint.
    collection_address  text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    deleted_at          timestamptz,
    constraint drops_status_chk check (status in ('draft', 'live', 'closed')),
    constraint drops_visibility_chk check (visibility in ('private', 'unlisted', 'public')),
    constraint drops_supply_chk check (supply between 1 and 10000),
    constraint drops_slug_chk check (slug ~ '^[a-z0-9][a-z0-9-]{1,47}$')
);

create unique index if not exists drops_slug_uniq
    on drops (slug) where deleted_at is null;
create index if not exists drops_owner_idx
    on drops (owner_id, created_at desc) where deleted_at is null;
-- The /drops index: public, live collections, newest first.
create index if not exists drops_public_idx
    on drops (status, created_at desc)
    where visibility = 'public' and deleted_at is null;

create table if not exists drop_items (
    id                  uuid primary key default gen_random_uuid(),
    drop_id             uuid        not null references drops(id) on delete cascade,
    -- Zero-based token index. The (seed, index) pair is the whole input to the
    -- trait roll, so this column is part of the item's identity, not a display
    -- ordinal.
    idx                 integer     not null,
    traits              jsonb       not null,
    rarity_score        numeric(12, 4) not null,
    rarity_rank         integer     not null,
    rarity_tier         text        not null,
    -- sealed:    rolled, art not generated yet (the pre-reveal state)
    -- revealing: a forge job is in flight
    -- revealed:  glb_url is populated and durable
    -- failed:    the forge lane gave up; retryable, see reveal_error
    status              text        not null default 'sealed',
    -- Forge job handle and the forge_creations row it materialized into, so a
    -- reveal can be resumed after a restart instead of paying to generate twice.
    forge_job_id        text,
    creation_id         uuid,
    glb_url             text,
    thumbnail_url       text,
    rigged              boolean     not null default false,
    reveal_error        text,
    reveal_attempts     integer     not null default 0,
    revealed_at         timestamptz,
    -- Metaplex Core asset address and the wallet holding it, once minted.
    mint_address        text,
    owner_wallet        text,
    minted_at           timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint drop_items_status_chk
        check (status in ('sealed', 'revealing', 'revealed', 'failed')),
    constraint drop_items_tier_chk
        check (rarity_tier in ('common', 'rare', 'epic', 'legendary'))
);

create unique index if not exists drop_items_drop_idx_uniq
    on drop_items (drop_id, idx);
-- The default grid order on a drop page, and the rarity leaderboard.
create index if not exists drop_items_rank_idx
    on drop_items (drop_id, rarity_rank);
-- "What is still sealed" for the reveal queue, and "what is revealed" for the
-- gallery, both without scanning the whole supply.
create index if not exists drop_items_status_idx
    on drop_items (drop_id, status);
create index if not exists drop_items_mint_idx
    on drop_items (mint_address) where mint_address is not null;

-- Reuse the shared updated_at trigger the rest of the schema is on, so these
-- rows age the same way every other table's do.
do $$
begin
    if exists (select 1 from pg_proc where proname = 'set_updated_at') then
        if not exists (select 1 from pg_trigger where tgname = 'drops_set_updated_at') then
            create trigger drops_set_updated_at before update on drops
                for each row execute function set_updated_at();
        end if;
        if not exists (select 1 from pg_trigger where tgname = 'drop_items_set_updated_at') then
            create trigger drop_items_set_updated_at before update on drop_items
                for each row execute function set_updated_at();
        end if;
    end if;
end $$;

commit;
