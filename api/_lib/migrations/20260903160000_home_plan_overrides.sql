begin;

-- Plans, entitlements and quotas for the Home lane.
--
-- Two changes, both of which exist because of a commitment the product makes
-- rather than because of a schema convenience.
--
-- ── 1. home_plan_overrides: the enterprise row ───────────────────────────────
--
-- Enterprise limits are configurable per account, not hardcoded, because that is
-- what the sales conversation is. A hotel does not buy "Pro", it buys 400 rooms
-- and a year of attribution, and the shape of that deal is known on the call and
-- not at deploy time. Encoding it as a tier constant means every new customer is
-- a code change; encoding it as a row means it is an admin action.
--
-- The note column is not decoration. "Why does this account have 400 homes" is a
-- question somebody asks six months after the person who agreed it has moved on,
-- and the answer has to be in the row rather than in a memory.
--
-- Considered and rejected:
--
--   * Columns per dimension. The dimension list is a product decision that will
--     move (relay connections did not exist two orders ago), and a migration per
--     pricing experiment is how a pricing experiment stops happening. jsonb,
--     validated in api/_lib/home/entitlements.js against the known dimension
--     set, so an unknown key cannot install a limit nothing reads.
--
--   * Storing the resolved limits rather than the deltas. A stored resolution
--     goes stale the moment a plan default moves, and then the enterprise
--     account is the ONE account that silently keeps the old defaults. Only the
--     agreed overrides live here; everything else resolves live.
--
--   * A tier row instead of an account row. Inventing a sixth account tier per
--     customer pollutes a display ladder that users see with rows only a
--     salesperson understands.

create table if not exists home_plan_overrides (
    user_id    uuid        primary key references users(id) on delete cascade,

    -- { "homes": 400, "members": "unlimited", "logRetentionDays": 365 }. Only
    -- keys in HOME_DIMENSIONS survive the writer; the string "unlimited" is the
    -- only non-numeric value accepted, and it means no limit.
    limits     jsonb       not null default '{}'::jsonb,

    -- Why this account has these numbers, in a sentence, for the person who asks
    -- in six months. Nullable only because a correction of a miscount is a valid
    -- write with nothing to say.
    note       text,

    -- The admin who agreed it. Kept when they leave (set null), because the fact
    -- that a human authorised it survives the human's account.
    set_by     uuid        references users(id) on delete set null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- ── 2. Pausing a home, which is what a downgrade does instead of disconnecting ─
--
-- Downgrading never silently disconnects a house. When an account drops below
-- the number of homes it has connected, the excess are marked inactive here with
-- a written explanation and the user chooses which to keep. Nothing is deleted,
-- the credential is NOT scrubbed (that is what revoke does and it is
-- irreversible), and the action log keeps its lineage.
--
-- This is a different state from `revoked_at`, and conflating them would be the
-- bug: revoke is the user saying "take my house off this platform" and it throws
-- the key away. A pause is the platform saying "your plan covers fewer of these
-- right now", and it must be reversible by paying, by cancelling another home,
-- or by the user changing their mind. Two columns, because "why is this paused"
-- has to be answerable on the page without a second lookup.
--
-- A paused home still answers safety actions. Locking up, closing a garage or a
-- valve and arming an alarm are never refused by a commercial limit, on any
-- plan, in any state. See api/_lib/home/entitlements.js `isQuotaExempt`.

alter table home_connections add column if not exists deactivated_at     timestamptz;
alter table home_connections add column if not exists deactivated_reason text;

-- The list view's real working set: an account's homes that are actually live.
-- The existing user index does not carry the pause state, so a fleet with many
-- paused homes would scan them on every quota check.
create index if not exists home_connections_user_active_idx
    on home_connections(user_id, created_at desc)
    where revoked_at is null and deactivated_at is null;

commit;
