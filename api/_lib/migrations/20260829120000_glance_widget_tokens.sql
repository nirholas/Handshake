begin;

-- Widget tokens for the Glance card.
--
-- A home screen widget outlives a browser session: Android's WorkManager
-- fetches the card from an OS process with no cookie jar, and a phone keeps
-- the widget for months. So a widget authenticates with its own credential,
-- minted by the signed-in owner, scoped to reading their own card and nothing
-- else, and revocable from /glance without touching the session that minted
-- it. Only the sha256 of the token is stored; the plaintext is shown once at
-- creation and handed straight to the app through the threews:// link.
create table if not exists glance_widget_tokens (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references users(id) on delete cascade,
    token_hash    text not null unique,                 -- sha256(plaintext)
    token_prefix  text not null,                        -- "glw_" plus six characters, for the revoke list
    label         text not null,                        -- what the owner sees ("Pixel 7"), never required to be unique
    platform      text not null default 'android',      -- android | macos | ios | other
    agent_id      uuid references agent_identities(id) on delete set null,   -- pinned agent, null = first owned
    created_at    timestamptz not null default now(),
    last_used_at  timestamptz,
    revoked_at    timestamptz
);

create index if not exists glance_widget_tokens_user_idx
    on glance_widget_tokens(user_id, created_at desc);

commit;
