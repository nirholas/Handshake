begin;

-- Pairing a LAN-only house with a three.ws account.
--
-- Most Home Assistant installs are only reachable from inside the house, so
-- three.ws cannot dial them and a long-lived access token would be useless
-- even if the user handed one over. Those houses dial out instead: a three.ws
-- integration inside Home Assistant opens one outbound WebSocket to the relay
-- and keeps it. This table is the handshake that introduces the two.
--
-- The shape of the secret matters. A pairing code is shown on a screen and
-- typed into another screen, so it is short, it is human-readable, and it is
-- therefore weak: 8 characters from a 32-symbol alphabet is 40 bits. Everything
-- here exists to make that weakness irrelevant rather than to pretend it is not
-- there:
--
--   * It expires in ten minutes (pairing is an activity, not a state).
--   * It is single use, enforced by redeemed_at under a transactional update,
--     so two racing redemptions cannot both win.
--   * It only ever redeems into the ONE home_connections row it was minted for,
--     so a guessed code cannot be pointed at somebody else's house.
--   * It is stored as a sha256 digest, not as the code, so a database read does
--     not hand an attacker a live pairing.
--   * Attempts are counted and the row dies after five wrong ones, which turns
--     40 bits of entropy into far more attempts than any attacker gets.
--
-- What is NOT here, and this is the point of the whole design: no Home
-- Assistant credential. The integration authenticates to Home Assistant locally
-- with a system refresh token it mints for itself, on the user's own machine.
-- three.ws never receives one, so home_connections.access_token_enc stays empty
-- for a relay home and there is nothing here for a breach to take.
--
-- Considered and rejected:
--
--   * A long-lived shared secret instead of a code. It would have to be typed
--     too, and a typed secret that never expires is the worst of both.
--   * Discovery (mDNS, a broadcast, a QR on the local network). Anything that
--     finds a house without the owner deliberately pairing it is a way to pair
--     a house without its owner.
--   * Storing the install token here. It is derived, not stored: it is an HMAC
--     over the relay id, the user id and the home id under
--     HOME_RELAY_SIGNING_KEY, so the relay verifies it with no database at all
--     and a leak of this table leaks no working credential.

create table if not exists home_relay_pairings (
    id           uuid        primary key default gen_random_uuid(),

    -- The home this code was minted for. A code is never a bearer ticket to
    -- "some house": it redeems into exactly this row or into nothing.
    home_id      uuid        not null references home_connections(id) on delete cascade,
    user_id      uuid        not null references users(id) on delete cascade,

    -- sha256 of the normalized code, hex. Never the code itself.
    code_hash    text        not null,

    -- The relay id this pairing hands over. Mirrors home_connections.relay_id,
    -- kept here too so a redemption needs one row read rather than a join.
    relay_id     text        not null,

    expires_at   timestamptz not null,
    redeemed_at  timestamptz,

    -- What redeemed it, for the connect UI and for an audit that has to answer
    -- "what actually paired with my house".
    redeemed_by  jsonb,

    attempts     integer     not null default 0,
    created_at   timestamptz not null default now()
);

-- The redemption path's only lookup: a code, unredeemed, unexpired.
create unique index if not exists home_relay_pairings_code_uniq
    on home_relay_pairings (code_hash);

-- The connect UI's lookup: this home's current pending code, if any.
create index if not exists home_relay_pairings_home_idx
    on home_relay_pairings (home_id, created_at desc);

-- The sweeper's working set. Expired and redeemed rows are pruned by
-- /api/cron/home-relay-sweep rather than living forever: a redeemed pairing has
-- no further use, and an expired one is noise.
create index if not exists home_relay_pairings_expiry_idx
    on home_relay_pairings (expires_at)
    where redeemed_at is null;

commit;
