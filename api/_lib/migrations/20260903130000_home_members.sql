begin;

-- Households: who else lives here, what they are allowed to do, and how they
-- got in.
--
-- home_connections is keyed on a single user_id and stays that way. That column
-- is the creating owner and it is never rewritten: membership lands BESIDE it,
-- so nothing that already reads home_connections has to change its shape to
-- keep working. What changes is the question the code above asks. Instead of
-- "is this row's user_id the caller", it becomes "what is this caller's role in
-- this home", and the answer for a house with one person in it is still
-- "owner", derived from the backfill below.
--
-- Why this table has to exist at all: a house has more than one person in it.
-- Without membership the only way to give a partner, a house sitter or a
-- colleague access is to hand over the account password, which for a system
-- that opens doors is the worst outcome available. For the enterprise cases (a
-- hotel, an office, a serviced building) the roles and the attribution ARE the
-- purchase decision.
--
-- Two tables:
--
--   home_members   who is in this household, with what role and what scope
--   home_invites   a single-use, expiring, role-bound way to become a member
--
-- The one row in the role matrix that justifies the whole design: a `guest`
-- can never confirm a guarded action. A house sitter should be able to turn the
-- lights on and should NOT be able to authorise unlocking the front door. Every
-- other distinction here is convenience; that one is the product.
--
-- Considered and rejected:
--
--   * Custom roles. Five roles cover households, house sitters, offices and
--     hotels. Anything past that needs a policy engine with its own evaluation
--     order, its own conflict rules and its own audit surface, and that is a
--     different product decision than "let my partner turn the lights on".
--
--   * A granted_domain style scope ("all locks"). Same reason home_entity_grants
--     refused one: a scope that names a domain is a scope nobody can reason
--     about at the moment they grant it. entity_scope names areas and entities,
--     both of which the user can see in their own house.
--
--   * Enforcing scope in the UI. The filtered room graph is built server side,
--     before serialization, because a guest who can read the state of a room
--     they were not given has already been given that room. A hidden card in a
--     browser is not a permission boundary.
--
--   * Multiple owners per home. The partial unique index below allows exactly
--     one, which is what makes "you cannot remove the last owner" a schema fact
--     rather than an application check somebody forgets. Ownership transfer,
--     when it is needed, is an UPDATE of that one row, not a second owner.

create table if not exists home_members (
    home_id      uuid        not null references home_connections(id) on delete cascade,
    user_id      uuid        not null references users(id) on delete cascade,

    -- owner  : the creating account. One per home. Can disconnect the house.
    -- admin  : full control including invites, cannot disconnect the house.
    -- member : lives here. Acts, confirms guarded actions, edits the layout.
    --          Cannot invite and cannot grant a standing allowance.
    -- guest  : visiting. Scoped reads and scoped ungated actions, and NEVER a
    --          confirmation of a guarded action.
    -- viewer : scoped reads only. A wall display, a monitoring seat.
    role         text        not null,

    -- {"mode":"all"} or {"mode":"allow","areas":[...],"entities":[...]}.
    -- Meaningful for guest and viewer; owner, admin and member are always
    -- whole-house and the store normalizes their scope to {"mode":"all"} so a
    -- stale allowlist on a promoted member cannot silently narrow them.
    entity_scope jsonb       not null default '{"mode":"all"}'::jsonb,

    invited_by   uuid        references users(id) on delete set null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),

    primary key (home_id, user_id),

    constraint home_members_role_chk check (role in ('owner', 'admin', 'member', 'guest', 'viewer')),

    -- The scope is read by the graph projection on every state push. A malformed
    -- one there is a silent unfiltered read, so it is rejected at write time.
    constraint home_members_scope_chk check (
        jsonb_typeof(entity_scope) = 'object'
        and entity_scope->>'mode' in ('all', 'allow')
    )
);

-- "Who is in this household" (the member list) and "which homes can this person
-- see" (every list view, every resolution) are the only two access patterns.
create index if not exists home_members_user_idx on home_members (user_id);

-- Exactly one owner per home. This is what makes removing the last owner
-- impossible rather than merely discouraged.
create unique index if not exists home_members_one_owner_uniq
    on home_members (home_id)
    where role = 'owner';

-- Every home that already existed belongs to the account that created it.
-- Idempotent, so re-running the migration on a database that has already been
-- backfilled is a no-op rather than a conflict.
insert into home_members (home_id, user_id, role, invited_by)
select id, user_id, 'owner', user_id from home_connections
on conflict (home_id, user_id) do nothing;

-- The owner row is created by the database, not by the application.
--
-- api/_lib/home/store.js (the connection store) does not know this table exists,
-- and it should not have to: "a connection has an owner" is an integrity fact
-- about the data, not a step in one code path. A trigger makes it true for every
-- writer, including a future admin tool, a support script and a manual insert,
-- and it means a home can never exist in a state where nobody can administer it.
--
-- Only on INSERT: createConnection upserts, so re-connecting a house with a
-- rotated token updates the existing row and must not disturb a membership list
-- that has since grown.
create or replace function home_connections_seed_owner() returns trigger
language plpgsql as $$
begin
    insert into home_members (home_id, user_id, role, invited_by)
    values (new.id, new.user_id, 'owner', new.user_id)
    on conflict (home_id, user_id) do nothing;
    return new;
end;
$$;

drop trigger if exists home_connections_seed_owner_trg on home_connections;
create trigger home_connections_seed_owner_trg
    after insert on home_connections
    for each row execute function home_connections_seed_owner();


-- An invitation to join a household.
--
-- Addressed to an email rather than a user id because the person being invited
-- usually does not have an account yet, and requiring them to register before
-- they can be invited is the kind of ordering that kills an onboarding flow.
-- Accepting still requires an account: the existing registration and sign-in
-- paths do that job and this table does not invent a second one.
--
-- The plaintext token leaves the server exactly once, in the invite link. What
-- is stored is sha256 of it, for the same reason a password is not stored: an
-- invite is a bearer credential for a role in a building, and a leaked database
-- must not be a set of working keys.
--
-- Single use is `accepted_at is null`, checked in the same UPDATE that sets it,
-- so two simultaneous redemptions cannot both win.
create table if not exists home_invites (
    id           uuid        primary key default gen_random_uuid(),
    home_id      uuid        not null references home_connections(id) on delete cascade,

    -- Lowercased before write. The acceptance path does not require the
    -- accepting account's email to match: the token is the credential, and an
    -- invite forwarded to the right person's other address is a support ticket
    -- we do not want. The email is who it was addressed to, and it is shown in
    -- the pending list so the inviter can see what they sent and to whom.
    email        text        not null,

    -- No 'owner': ownership is not something an invite can hand out.
    role         text        not null,
    entity_scope jsonb       not null default '{"mode":"all"}'::jsonb,

    token_hash   text        not null unique,

    invited_by   uuid        not null references users(id) on delete cascade,
    expires_at   timestamptz not null,
    accepted_at  timestamptz,
    accepted_by  uuid        references users(id) on delete set null,
    revoked_at   timestamptz,
    created_at   timestamptz not null default now(),

    constraint home_invites_role_chk check (role in ('admin', 'member', 'guest', 'viewer')),
    constraint home_invites_scope_chk check (
        jsonb_typeof(entity_scope) = 'object'
        and entity_scope->>'mode' in ('all', 'allow')
    )
);

-- One live invite per person per home, so a re-invite replaces rather than
-- stacks. A spent or revoked invite does not participate, which is what allows
-- re-inviting someone who was removed.
create unique index if not exists home_invites_home_email_live_uniq
    on home_invites (home_id, lower(email))
    where accepted_at is null and revoked_at is null;

-- The pending list for one home, and the redemption lookup by token.
create index if not exists home_invites_home_idx on home_invites (home_id, created_at desc);

commit;
