begin;

-- Materialize: the physical lane of the forge.
--
-- A user (or a paying agent) turns a finished 3D generation into a real,
-- high-precision print. This migration lands the fulfillment half of that
-- product: the order row every surface reads, the timeline every status change
-- writes, and the webhook ledger that makes a provider's retried callback
-- harmless.
--
-- The order's status is a state machine, enforced in exactly one module
-- (api/_lib/print-store.js). The database carries the vocabulary as a check
-- constraint so a handler that bypasses the module still cannot invent a state,
-- but it deliberately does NOT encode the legal transitions: those live in code
-- next to the events they emit, where they can be read and tested.

create table if not exists print_orders (
    id                  uuid primary key default gen_random_uuid(),
    -- Null only for agent orders paid over x402, which carry a payer wallet
    -- instead of a session. Exactly one of the two is always present.
    user_id             uuid references users(id) on delete set null,
    payer_wallet        text,
    -- The generation being printed. Null for a direct GLB upload, which still
    -- records source_glb_url so the operator can always reach the mesh.
    creation_id         uuid references forge_creations(id) on delete set null,
    source_glb_url      text        not null,
    -- { stl, 3mf, glb } object-storage URLs written by the prepare step. The
    -- operator console hands these to the bureau; the adapter hands them to a
    -- partner API.
    prepared_asset_urls jsonb       not null default '{}'::jsonb,
    -- The printability report as it stood when the order was placed. Frozen on
    -- purpose: a later re-analysis must never change what was sold.
    analysis            jsonb       not null default '{}'::jsonb,
    material_id         text        not null,
    target_height_mm    numeric(8,2),
    quantity            integer     not null default 1,
    -- The itemized quote, including its signed token. Every money number a
    -- human or an operator sees is read from here, never recomputed.
    quote               jsonb       not null default '{}'::jsonb,
    price_usdc          numeric(14,6) not null default 0,
    status              text        not null default 'created',
    -- Which fulfillment adapter owns the job: 'manual' (a human operator
    -- driving a real bureau) or a contracted partner's adapter key.
    provider            text,
    provider_order_id   text,
    -- The adapter's own last-seen state, verbatim. Diagnostic only; nothing
    -- reads it to make a decision, so a partner changing their payload shape
    -- cannot break the state machine.
    provider_state      jsonb       not null default '{}'::jsonb,
    -- The first real PII this platform stores. Minimum fields, surfaced only to
    -- the operator console and the provider adapter, never logged, never in an
    -- analytics event.
    shipping            jsonb,
    tracking_number     text,
    carrier             text,
    -- Copied from the adapter's declared lead time when the job is submitted,
    -- so the reconciliation sweep can tell a slow job from a stalled one even
    -- after the catalog's lead times are retuned.
    lead_time_days      integer,
    submitted_at        timestamptz,
    -- Set when the stall sweep has already told the operator about this order,
    -- so a stuck job is reported once rather than every five minutes.
    stall_alerted_at    timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint print_orders_status_chk check (status in (
        'created', 'quoted', 'paid', 'screening', 'submitted', 'printing',
        'quality_check', 'shipped', 'delivered', 'rejected', 'canceled', 'refunded'
    )),
    constraint print_orders_quantity_chk check (quantity between 1 and 500),
    constraint print_orders_owner_chk check (user_id is not null or payer_wallet is not null)
);

-- The operator queue reads by status, newest first: this is its index.
create index if not exists print_orders_status_idx on print_orders (status, created_at desc);
-- A buyer's order list.
create index if not exists print_orders_user_idx on print_orders (user_id, created_at desc) where user_id is not null;
-- Webhook lookup: a provider identifies the job by their own id, not ours.
create unique index if not exists print_orders_provider_uniq
    on print_orders (provider, provider_order_id)
    where provider_order_id is not null;
-- The reconciliation sweep's working set: live jobs a provider owns.
create index if not exists print_orders_open_idx
    on print_orders (submitted_at)
    where status in ('submitted', 'printing', 'quality_check', 'shipped');

-- The timeline. Every status change appends a row here; no column is ever
-- mutated to represent history, so an order's story is always reconstructable
-- and an operator's note can never be overwritten by the next transition.
create table if not exists print_order_events (
    id         uuid        primary key default gen_random_uuid(),
    order_id   uuid        not null references print_orders(id) on delete cascade,
    status     text        not null,
    note       text,
    -- Who caused it. 'operator' rows also carry the operator's user id so a
    -- refund or a rejection is always attributable to a person.
    actor      text        not null default 'system',
    actor_id   uuid        references users(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint print_order_events_actor_chk check (actor in ('system', 'operator', 'provider', 'buyer')),
    constraint print_order_events_note_chk check (note is null or char_length(note) <= 2000)
);

create index if not exists print_order_events_order_idx on print_order_events (order_id, created_at asc);

-- Webhook idempotency ledger. A provider that retries a delivery (every serious
-- one does) must not append the same timeline row twice, and a replay must not
-- drive the state machine backwards. The unique key is the provider's own
-- delivery id; when a provider sends none, the adapter derives a stable one by
-- hashing the payload, so "the same event twice" is still one row.
create table if not exists print_webhook_deliveries (
    provider     text        not null,
    delivery_id  text        not null,
    order_id     uuid        references print_orders(id) on delete cascade,
    applied      boolean     not null default false,
    received_at  timestamptz not null default now(),
    primary key (provider, delivery_id)
);

create index if not exists print_webhook_deliveries_order_idx on print_webhook_deliveries (order_id, received_at desc);

do $$ begin
    create trigger print_orders_set_updated_at before update on print_orders
        for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

commit;
