-- Consent-gated Farcaster memory seeding.
--
-- Seeding used to accept any handle: a signed-in user could type someone else's
-- Farcaster name and pull that person's casts into an agent's long-term memory.
-- These two tables make the flow consent-first and revocable.
--
-- farcaster_seed_challenges holds the one-time nonce and the exact text the
-- wallet is asked to sign. The message is stored server-side so verification
-- compares against what WE issued, never against a client-supplied copy.
--
-- farcaster_memory_consents is the durable grant. Every memory row written by a
-- seed carries its consent id in context->>'consent_id', so revocation deletes
-- exactly what the grant produced and nothing else.

create table if not exists farcaster_seed_challenges (
	nonce       text primary key,
	user_id     uuid not null references users(id) on delete cascade,
	agent_id    uuid not null references agent_identities(id) on delete cascade,
	fid         integer not null,
	fname       text,
	-- Canonical signable text. Byte-for-byte comparison at verify time.
	message     text not null,
	cast_limit  int not null,
	created_at  timestamptz not null default now(),
	expires_at  timestamptz not null,
	consumed_at timestamptz
);

create index if not exists farcaster_seed_challenges_agent
	on farcaster_seed_challenges (agent_id) where consumed_at is null;
create index if not exists farcaster_seed_challenges_expiry
	on farcaster_seed_challenges (expires_at);

create table if not exists farcaster_memory_consents (
	id              uuid primary key default gen_random_uuid(),
	user_id         uuid not null references users(id) on delete cascade,
	agent_id        uuid not null references agent_identities(id) on delete cascade,
	fid             integer not null,
	fname           text,
	scope           text not null,
	-- The wallet that proved control of the fid. It must appear in the fid's
	-- public Farcaster verifications, which is what binds grant to identity.
	proof_chain     text not null check (proof_chain in ('solana', 'ethereum')),
	proof_address   text not null,
	proof_signature text not null,
	proof_message   text not null,
	source_lane     text,
	granted_at      timestamptz not null default now(),
	revoked_at      timestamptz,
	last_seeded_at  timestamptz,
	memories_seeded int not null default 0,
	casts_ingested  int not null default 0
);

-- An agent's memory is seeded from at most one live Farcaster identity. Pointing
-- it at a different fid means revoking the first grant, which deletes its rows.
create unique index if not exists farcaster_memory_consents_active_agent
	on farcaster_memory_consents (agent_id) where revoked_at is null;
create index if not exists farcaster_memory_consents_user
	on farcaster_memory_consents (user_id);
create index if not exists farcaster_memory_consents_fid
	on farcaster_memory_consents (fid) where revoked_at is null;

-- Revocation deletes by consent id, so keep that lookup off a sequential scan.
create index if not exists agent_memories_farcaster_consent
	on agent_memories ((context ->> 'consent_id'))
	where context ->> 'source' = 'farcaster_seed';
