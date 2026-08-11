begin;

-- Signed, IPFS-pinned agent manifests
-- ===================================
-- An agent's system prompt is its behavior. Held only in this database it is a
-- claim; signed and content-addressed it is evidence. Every persona save now
-- compiles the agent's configuration into a canonical manifest, signs the digest
-- with the platform ed25519 attester identity (the same key behind 3D provenance
-- credentials), and pins the envelope to IPFS. The CID is the portable, permanent
-- pointer anyone can fetch and check without asking us for anything.
--
-- Two halves, mirroring how persona state is already stored:
--   1. agent_identities.manifest_*  — the CURRENT published manifest, so the
--      agent record answers "what is pinned right now" in one row read.
--   2. agent_manifest_pins          — every manifest ever published, envelope
--      included. Keeping the envelope means verification by CID still works when
--      a gateway is slow or the deployment has no pinning provider configured,
--      and it is what lets a CID resolve back to its agent for the live diff.

-- ── Live agent: the currently published manifest ──────────────────────────────
alter table agent_identities add column if not exists manifest_cid          text;
alter table agent_identities add column if not exists manifest_digest       text;
alter table agent_identities add column if not exists manifest_issuer       text;
alter table agent_identities add column if not exists manifest_signature    text;
alter table agent_identities add column if not exists manifest_pin_provider text;
alter table agent_identities add column if not exists manifest_signed_at    timestamptz;

comment on column agent_identities.manifest_cid is
	'IPFS CID of the currently published signed manifest envelope. NULL when the agent has never been published or no pinning provider is configured (the envelope is still in agent_manifest_pins and verifiable by digest).';

create index if not exists agent_identities_manifest_cid
	on agent_identities (manifest_cid) where manifest_cid is not null;

-- ── History: every signed envelope we ever produced ───────────────────────────
create table if not exists agent_manifest_pins (
	id         bigserial   primary key,
	agent_id    uuid       not null references agent_identities(id) on delete cascade,
	cid         text,
	digest      text       not null,
	-- Digest of the manifest body alone (no issuer, no timestamp): the key that
	-- answers "did this agent's configuration actually change" so a repeated save
	-- of identical settings does not pin a duplicate document.
	body_digest text       not null,
	issuer     text        not null,
	signature  text        not null,
	provider   text,
	envelope   jsonb       not null,
	reason     text,
	created_at timestamptz not null default now()
);

-- The digest covers the manifest, the issuer, and the signing timestamp, so it
-- is unique per publish and is the natural idempotency key: re-publishing an
-- unchanged manifest within the same millisecond must not create a second row.
create unique index if not exists agent_manifest_pins_digest on agent_manifest_pins (digest);
create index if not exists agent_manifest_pins_cid on agent_manifest_pins (cid) where cid is not null;
create index if not exists agent_manifest_pins_agent on agent_manifest_pins (agent_id, created_at desc);

commit;
