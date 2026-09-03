begin;

-- three.ws Home: voice satellites.
--
-- A Home Assistant instance can be told to treat a Wyoming service as one of
-- its voice satellites. This is the record of a person having pointed one at a
-- three.ws agent, so that the agent's face, voice and body appear on the far
-- end of a pipeline that Home Assistant already owns.
--
-- Two tables, and the split matters. A pairing code is a bearer credential that
-- lives for minutes and buys exactly one satellite; a satellite is a durable
-- identity that lives until it is revoked. Keeping them in one table would mean
-- a short-lived secret and a long-lived one sharing a lifecycle, which is how a
-- code ends up still redeemable a year later.
--
-- Neither table holds a Home Assistant credential. The satellite never sees one
-- either: authentication for the pipeline happens inside the house, between
-- Home Assistant and the service on its own network, and never crosses this
-- platform.

create table if not exists home_satellites (
    id                uuid        primary key default gen_random_uuid(),
    -- Who it belongs to. A satellite hears a room, so ownership is not a
    -- convenience column: it is the whole authorisation model.
    user_id           uuid        not null references users(id) on delete cascade,
    -- Which agent shows up on it. This is what makes the satellite a face
    -- rather than a speaker.
    agent_id          uuid        not null references agent_identities(id) on delete cascade,
    -- What Home Assistant calls the device.
    name              text        not null,
    -- Suggested area, passed straight through to the Home Assistant device
    -- registry. User-supplied and therefore untrusted; it is never interpreted.
    area              text,
    -- The signing key for this satellite's own viewer tokens. It is what lets a
    -- browser on the same network as the house attach without three.ws being
    -- reachable at all, so it is a real credential and is encrypted at rest
    -- with the same primitive as a home's access token (AES-256-GCM through
    -- api/_lib/secret-box.js), never hashed: the service has to be handed the
    -- plaintext back at claim time and again if it is ever re-provisioned.
    viewer_secret_enc text        not null,
    -- Reported by the service on every session refresh, so an operator can see
    -- which houses are running a build that predates a protocol change.
    version           text,
    wyoming_version   text,
    created_at        timestamptz not null default now(),
    last_seen_at      timestamptz,
    revoked_at        timestamptz
);

create index if not exists home_satellites_user_idx
    on home_satellites (user_id, created_at desc)
    where revoked_at is null;

create index if not exists home_satellites_agent_idx
    on home_satellites (agent_id)
    where revoked_at is null;

create table if not exists home_satellite_codes (
    id           uuid        primary key default gen_random_uuid(),
    -- SHA-256 of the code, never the code. A pairing code is typed into a
    -- terminal and pasted into chat logs; storing it in the clear would make a
    -- database read equivalent to owning every unclaimed satellite.
    code_hash    text        not null unique,
    user_id      uuid        not null references users(id) on delete cascade,
    agent_id     uuid        not null references agent_identities(id) on delete cascade,
    -- The name the satellite gets if it does not choose one.
    name         text,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    -- Set on redemption. Single use is enforced here, not in application code:
    -- two racing claims both pass a `claimed_at is null` read, and only the
    -- conditional UPDATE below decides which one wins.
    claimed_at   timestamptz,
    satellite_id uuid        references home_satellites(id) on delete set null
);

create index if not exists home_satellite_codes_user_idx
    on home_satellite_codes (user_id, created_at desc);

-- Expired, unclaimed codes are swept by the same retention pass that clears the
-- rest of the home tables. The index is what makes that sweep cheap.
create index if not exists home_satellite_codes_expiry_idx
    on home_satellite_codes (expires_at)
    where claimed_at is null;

commit;
