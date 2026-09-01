begin;

-- Agent Spotlight: the community showcase.
--
-- /agents lists every registered agent (3,300+ rows, most of them still wearing
-- the onboarding default name). That is a directory, not a showcase. This table
-- is the curated layer on top of it: one entry per agent, written BY a human
-- about what the agent actually does, and ranked by what the community votes up.
--
-- The entry stores the pitch, never a copy of the agent. Name, description,
-- skills, avatar and on-chain identity are always read live from
-- agent_identities on the join, so an entry can never drift from the agent it
-- points at, and deleting the agent removes the entry with it.

create table if not exists agent_showcase (
    id            uuid primary key default gen_random_uuid(),
    agent_id      uuid        not null references agent_identities(id) on delete cascade,
    -- The community member who wrote the entry. Null only for 'curated' entries,
    -- which three.ws editorial wrote about someone else's public agent; the
    -- builder is always credited from agent_identities.user_id on read.
    submitted_by  uuid        references users(id) on delete set null,
    -- 'community': the builder (or anyone) submitted it through /spotlight.
    -- 'curated':   three.ws wrote it up. Rendered with a distinct badge so a
    --              visitor is never told a builder said something they did not.
    source        text        not null default 'community',
    title         text        not null,
    tagline       text        not null,
    -- The long-form write-up: what it does, how it was built, what it is for.
    story         text,
    -- Where the agent can be seen working: an embed on the builder's own site, a
    -- recording, a live surface on three.ws. Rendered as a link, never fetched.
    demo_url      text,
    category      text        not null,
    tags          text[]      not null default '{}'::text[],
    -- Editor's pick. Sorting never reads this except on the 'featured' rail, so
    -- promoting an entry cannot bury the community's own ranking.
    featured_at   timestamptz,
    -- Moderation: 'published' is visible, 'hidden' is retained but unlisted.
    status        text        not null default 'published',
    view_count    integer     not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    deleted_at    timestamptz,
    constraint agent_showcase_source_chk   check (source in ('community', 'curated')),
    constraint agent_showcase_status_chk   check (status in ('published', 'hidden')),
    constraint agent_showcase_title_chk    check (char_length(title) between 3 and 90),
    constraint agent_showcase_tagline_chk  check (char_length(tagline) between 10 and 160),
    constraint agent_showcase_story_chk    check (story is null or char_length(story) <= 4000),
    constraint agent_showcase_tags_chk     check (cardinality(tags) <= 6),
    constraint agent_showcase_category_chk check (category in (
        'trading', 'research', 'creative', 'productivity', 'developer',
        'social', 'gaming', 'commerce', 'education', 'other'
    ))
);

-- One live entry per agent: the showcase is a curated list, not a feed the same
-- agent can flood. A re-submission updates the existing row.
create unique index if not exists agent_showcase_agent_uniq
    on agent_showcase (agent_id) where deleted_at is null;

-- The default browse: published entries, newest first.
create index if not exists agent_showcase_published_idx
    on agent_showcase (created_at desc)
    where status = 'published' and deleted_at is null;

create index if not exists agent_showcase_category_idx
    on agent_showcase (category, created_at desc)
    where status = 'published' and deleted_at is null;

create index if not exists agent_showcase_featured_idx
    on agent_showcase (featured_at desc)
    where featured_at is not null and status = 'published' and deleted_at is null;

create index if not exists agent_showcase_submitter_idx
    on agent_showcase (submitted_by, created_at desc) where deleted_at is null;

create index if not exists agent_showcase_tags_idx
    on agent_showcase using gin (tags);

-- Upvotes. One row per (entry, voter); counts are computed on read rather than
-- denormalised onto agent_showcase, so a lost vote can never leave a counter
-- wrong, and the read path degrades to zero votes if this table is missing.
create table if not exists agent_showcase_votes (
    entry_id   uuid        not null references agent_showcase(id) on delete cascade,
    user_id    uuid        not null references users(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (entry_id, user_id)
);

create index if not exists agent_showcase_votes_entry_idx on agent_showcase_votes (entry_id);
create index if not exists agent_showcase_votes_user_idx  on agent_showcase_votes (user_id, created_at desc);

do $$ begin
    create trigger agent_showcase_set_updated_at before update on agent_showcase
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

commit;
