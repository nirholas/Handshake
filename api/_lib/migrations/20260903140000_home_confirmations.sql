begin;

-- The pending-confirmation record: how a language model's request to open a
-- physical building is carried across the model boundary without ever letting
-- the model satisfy it.
--
-- Home Assistant's own Assist tools are polymorphic. Its published description
-- of `intent__HassTurnOff` reads: "Turns off/closes a device or entity. For
-- locks, this performs an 'unlock' action." So a model told to turn something
-- off can open a front door, and nothing in the tool name says so. The gate in
-- packages/home-bridge/src/safety.js catches that; this table is what makes the
-- gate's verdict survive the trip through a model that may be fully hijacked.
--
-- The mechanism, stated once so nobody re-derives it wrong:
--
--   1. The model's tool schema has no `confirmed` property at all. A model
--      cannot set a field that does not exist in its schema. That, and not
--      validation, is why a model cannot self-approve.
--   2. A guarded call returns a row from this table instead of acting. The row
--      freezes the RESOLVED action (domain, service, service data, and the
--      entity ids the gate actually resolved), so what a human is shown and
--      what later executes cannot drift apart.
--   3. A human satisfies it out of band through a session-and-CSRF endpoint the
--      model has no access to. Redemption is a single atomic claim.
--
-- Considered and rejected:
--
--   * A signed token (JWT) instead of a row. A JWT is stateless, which is
--     exactly wrong here: single-use is the property that matters most, and it
--     cannot be enforced without server state. A row that is claimed by an
--     UPDATE ... WHERE redeemed_at IS NULL RETURNING gets single-use for free.
--
--   * Accepting the action alongside the id at redemption time. Then the
--     confirmation would authorize whatever the caller re-sent, and a
--     confirmation minted for lock.office_door could execute against
--     lock.front_door. The action is frozen here at mint and read from here at
--     redemption; the redeem endpoint takes an id and nothing else.
--
--   * A longer TTL "for convenience". This is a physical action with a human
--     standing in front of it. 90 seconds is how long a person takes to read a
--     sentence and press a button. A confirmation that has to survive longer
--     (pushed to a phone, answered from another room) is a different flow with
--     its own record, not a laxer default here.

create table if not exists home_confirmations (
    id           uuid        primary key default gen_random_uuid(),

    -- Bound to the home AND the user at mint. Redemption re-checks both, so a
    -- confirmation minted by one member of a household cannot be redeemed by
    -- another, and one minted for the office cannot be spent on the house.
    home_id      uuid        not null references home_connections(id) on delete cascade,
    user_id      uuid        not null references users(id) on delete cascade,

    -- The frozen, RESOLVED action. `service_data` is what will be passed to
    -- Home Assistant verbatim; `entity_ids` is what the gate resolved, not the
    -- raw argument the model produced (an argument can be a name, an area, or a
    -- device class, and re-resolving it later could hit a different set).
    domain       text        not null,
    service      text        not null,
    service_data jsonb       not null default '{}'::jsonb,
    entity_ids   text[]      not null default '{}',

    -- Why the gate fired, and the plain-language sentence a human is shown.
    -- The sentence is generated server-side from the resolved entities and
    -- their friendly names; it is never model output, because the whole point
    -- is that the human is told what will really happen.
    risk         text,
    summary      text        not null,

    -- Which surface asked: chat, mcp, voice, or api. An operator reviewing an
    -- incident needs to know whether a door was opened from a phone or by a
    -- model in a tool loop.
    source       text        not null default 'api',

    expires_at   timestamptz not null,

    -- Exactly one of these is set once the record is retired. Both null means
    -- pending, which is what the redemption claim tests for.
    redeemed_at  timestamptz,
    redeemed_by  uuid        references users(id) on delete set null,
    expired_at   timestamptz,

    -- 'ok' or 'failed' after redemption: a confirmed unlock that Home Assistant
    -- then refused is a materially different event from one that opened a door.
    outcome      text,

    created_at   timestamptz not null default now(),

    constraint home_confirmations_source_chk
        check (source in ('chat', 'mcp', 'voice', 'api')),
    constraint home_confirmations_outcome_chk
        check (outcome is null or outcome in ('ok', 'failed')),
    constraint home_confirmations_risk_chk
        check (risk is null or risk in ('security', 'physical'))
);

-- The redemption claim's index: id is the primary key, so this one serves the
-- other two hot reads, the pending list for a home and the expiry sweep.
create index if not exists home_confirmations_pending_idx
    on home_confirmations (home_id, created_at desc)
    where redeemed_at is null and expired_at is null;

create index if not exists home_confirmations_expiry_idx
    on home_confirmations (expires_at)
    where redeemed_at is null and expired_at is null;

commit;
