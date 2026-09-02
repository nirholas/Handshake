begin;

-- Materialize provenance: the certificate a physical print carries.
--
-- A print is only a collectible if its scarcity and its lineage can be checked
-- by someone who does not trust us. So the moment an order ships, three facts
-- are frozen together: the SHA-256 of the exact bytes that were printed, the
-- edition number claimed out of that model's series, and a Solana memo
-- transaction carrying both. The QR on the package resolves to /cert/<id>,
-- which renders the original model plus the raw memo payload, so verification
-- needs neither this database nor a block explorer.
--
-- One certificate per order, enforced by a unique index rather than by handler
-- discipline: the issuer is idempotent because the database says so.

create table if not exists print_certificates (
    -- 24 lowercase hex characters (12 random bytes). Short on purpose: it is
    -- printed on a card and encoded into a QR that has to scan off paper at
    -- arm's length, where a 36-character uuid measurably costs modules.
    id                  text        primary key,
    order_id            uuid        not null references print_orders(id) on delete cascade,
    creation_id         uuid        references forge_creations(id) on delete set null,

    -- The edition series this number was claimed from. For a print of a forge
    -- creation that is the creation id; for a direct GLB upload, which has no
    -- creation row, it is 'sha256:<hash>' so identical bytes still form one
    -- honest series instead of every upload minting a fresh "edition 1 of 1".
    series_key          text        not null,
    edition_no          integer     not null,
    -- The creator's cap at claim time. Null is an open edition. Copied here
    -- rather than read live so a later cap change cannot rewrite what a
    -- shipped certificate already promised.
    edition_of          integer,

    -- SHA-256 of the prepared GLB: the canonical 3D representation, and the
    -- one /cert renders. Hex, lowercase, 64 chars.
    glb_sha256          text        not null,
    glb_bytes           bigint,
    -- The manufacturing asset actually handed to the printer (stl or 3mf) and
    -- its own hash, so "these bytes were printed" is checkable too, not just
    -- "this model was printed".
    print_asset_kind    text,
    print_asset_key     text,
    print_asset_sha256  text,

    material_id         text,
    -- Frozen at issuance: what the buyer sees on the certificate never moves
    -- when the catalog is retuned.
    material_label      text,
    printed_at          timestamptz not null default now(),

    -- The attestation. `memo` is the exact JSON string signed on-chain, stored
    -- verbatim so the page can render the bytes a verifier hashes, and network
    -- says which cluster to resolve the signature on.
    network             text        not null default 'devnet',
    memo                text        not null,
    solana_signature    text,
    attested_at         timestamptz,
    attest_attempts     integer     not null default 0,
    attest_error        text,

    qr_key              text,
    qr_url              text,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    constraint print_certificates_id_chk check (id ~ '^[0-9a-f]{24}$'),
    constraint print_certificates_sha_chk check (glb_sha256 ~ '^[0-9a-f]{64}$'),
    constraint print_certificates_edition_chk check (edition_no >= 1),
    constraint print_certificates_cap_chk check (edition_of is null or edition_no <= edition_of),
    constraint print_certificates_network_chk check (network in ('mainnet', 'devnet')),
    constraint print_certificates_asset_kind_chk
        check (print_asset_kind is null or print_asset_kind in ('stl', '3mf', 'glb'))
);

-- One certificate per order. This is the issuer's idempotency key: a retried
-- shipped-transition finds the existing row instead of minting a second one.
create unique index if not exists print_certificates_order_uniq
    on print_certificates (order_id);

-- The edition guard. Two orders of the same model shipping at the same instant
-- both compute "max + 1" and race; the loser takes a unique violation and
-- recomputes, so no two certificates ever carry the same edition number.
create unique index if not exists print_certificates_series_edition_uniq
    on print_certificates (series_key, edition_no);

-- The reconciliation sweep's working set: certificates whose memo never landed.
create index if not exists print_certificates_unattested_idx
    on print_certificates (created_at)
    where solana_signature is null;

-- A model's edition history, newest first, for the model page's badge.
create index if not exists print_certificates_series_idx
    on print_certificates (series_key, edition_no desc);

do $$ begin
    create trigger print_certificates_set_updated_at before update on print_certificates
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

-- The creator's scarcity control. Null (the default, and every existing row) is
-- an open edition: print as many as people order. A number caps the series, is
-- enforced at quote time, and is what the certificate renders as "3 of 25".
alter table forge_creations
    add column if not exists print_edition_limit integer;

do $$ begin
    alter table forge_creations
        add constraint forge_creations_print_edition_limit_chk
        check (print_edition_limit is null or print_edition_limit between 1 and 10000);
exception when duplicate_object then null; end $$;

commit;
