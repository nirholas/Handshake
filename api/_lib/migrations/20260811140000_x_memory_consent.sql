-- Consent-gated X memory seeding.
--
-- Connecting X and seeding an agent used to be the same decision: any user with
-- a live 'x' social_connection could push their posts into an agent's long-term
-- memory with one button, and disconnecting left those memories behind forever.
-- This table makes the seed its own explicit, versioned, revocable grant.
--
-- Every memory row a seed writes carries its consent id in
-- context->>'consent_id', so revoking deletes exactly what the grant produced.
-- The disclosure the owner actually read is stored verbatim on the row: when
-- the wording changes, X_SEED_SCOPE_VERSION moves and the stored version stops
-- authorizing new seeds until the owner agrees to the new text.

create table if not exists x_memory_consents (
	id              uuid primary key default gen_random_uuid(),
	user_id         uuid not null references users(id) on delete cascade,
	agent_id        uuid not null references agent_identities(id) on delete cascade,
	-- X's numeric account id, captured at grant time. A reconnect to a different
	-- X account cannot silently reuse a grant made for the first one.
	x_user_id       text not null,
	username        text not null,
	scope_version   text not null,
	-- The exact disclosure text shown when consent was granted.
	disclosure      jsonb not null default '{}'::jsonb,
	-- The OAuth scopes X actually granted the connection at that moment.
	granted_scopes  text,
	granted_at      timestamptz not null default now(),
	revoked_at      timestamptz,
	revoked_reason  text,
	last_seeded_at  timestamptz,
	memories_seeded int not null default 0,
	posts_read      int not null default 0
);

-- An agent's memory is seeded from at most one live X identity. Pointing it at
-- another account means revoking the first grant, which deletes its rows.
create unique index if not exists x_memory_consents_active_agent
	on x_memory_consents (agent_id) where revoked_at is null;
create index if not exists x_memory_consents_user
	on x_memory_consents (user_id);
create index if not exists x_memory_consents_x_user
	on x_memory_consents (x_user_id) where revoked_at is null;

-- Revocation deletes by consent id, so keep that lookup off a sequential scan.
create index if not exists agent_memories_x_seed_consent
	on agent_memories ((context ->> 'consent_id'))
	where context ->> 'source' = 'x_seed';

-- social_connections.scopes is NOT NULL with no default, but the X OAuth
-- callback (unlike the GitHub one) never supplied it, so every X connect
-- attempt died on a not-null violation before a row was ever written. The
-- callback now records the granted scope string; this default keeps any other
-- writer from hitting the same wall.
alter table social_connections alter column scopes set default '';
