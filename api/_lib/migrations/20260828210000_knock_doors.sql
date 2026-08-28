begin;

-- Knock: a priced, machine-payable door to a person.
--
-- Every account can open a public door at /knock/<username>. A visitor (a
-- human on the page, or an agent over x402) pays the price the owner set and
-- gets exactly one message through. The payment settles in USDC straight to
-- the owner's own wallet; the message becomes a companion event, so the
-- owner's 3D companion walks on and delivers it in person.
--
-- Nothing here holds funds. amount_atomics/tx_hash are the settled receipt the
-- x402 layer already produced, recorded so the owner can see what a knock was
-- worth and so the inbox can rank by it.

create table if not exists knock_doors (
    user_id            uuid primary key references users(id) on delete cascade,
    -- A door is shut until its owner opens it. Nobody gets knocked at by default.
    open               boolean     not null default false,
    -- Price of one knock, in USDC atomic units (6 decimals). 0 means the door
    -- is free, which routes through /api/knock/send instead of the x402 lane.
    price_atomics      bigint      not null default 50000,
    -- Where the money goes. Solana is the home chain and the default lane; the
    -- Base leg is optional and only advertised when set.
    pay_to_solana      text,
    pay_to_base        text,
    -- What the door says to a visitor before they write.
    headline           text,
    greeting           text,
    max_chars          integer     not null default 600,
    -- Knocks accepted per UTC day, after which the door answers 429 and says so.
    daily_cap          integer     not null default 25,
    -- Listed in the public /knock directory. An open door can still be unlisted,
    -- for someone who wants a reachable link without being browsable.
    listed             boolean     not null default true,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    constraint knock_doors_price_chk     check (price_atomics between 0 and 1000000000),
    constraint knock_doors_max_chars_chk check (max_chars between 40 and 2000),
    constraint knock_doors_cap_chk       check (daily_cap between 1 and 1000)
);

create index if not exists knock_doors_listed_idx
    on knock_doors (open, listed, price_atomics)
    where open and listed;

create table if not exists knock_messages (
    id                 uuid primary key default gen_random_uuid(),
    recipient_user_id  uuid        not null references users(id) on delete cascade,
    sender_name        text        not null,
    sender_url         text,
    sender_kind        text        not null default 'unknown',
    -- Settled payment receipt. A free-door knock carries amount_atomics 0 and
    -- no wallet, which is exactly how the inbox tells the two apart.
    payer_wallet       text,
    network            text,
    tx_hash            text,
    amount_atomics     bigint      not null default 0,
    asset              text,
    subject            text,
    message            text        not null,
    status             text        not null default 'pending',
    -- The companion event this knock became, so opening one from the inbox and
    -- opening it from the companion feed mark the same thing read.
    companion_event_id uuid        references companion_events(id) on delete set null,
    reply_text         text,
    -- Caller-supplied dedupe key: a retried POST after a settled payment must
    -- not knock twice.
    request_id         text,
    read_at            timestamptz,
    replied_at         timestamptz,
    created_at         timestamptz not null default now(),
    constraint knock_messages_status_chk
        check (status in ('pending', 'read', 'replied', 'dismissed')),
    constraint knock_messages_kind_chk
        check (sender_kind in ('agent', 'human', 'unknown')),
    constraint knock_messages_amount_chk check (amount_atomics >= 0)
);

create index if not exists knock_messages_inbox_idx
    on knock_messages (recipient_user_id, created_at desc);
create index if not exists knock_messages_unread_idx
    on knock_messages (recipient_user_id, amount_atomics desc)
    where status = 'pending';
create unique index if not exists knock_messages_request_uniq
    on knock_messages (recipient_user_id, request_id)
    where request_id is not null;

-- Anyone the owner never wants to hear from again. Matched on the lowercased
-- payer wallet or sender name, whichever the knock carried.
create table if not exists knock_blocks (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid        not null references users(id) on delete cascade,
    subject            text        not null,
    note               text,
    created_at         timestamptz not null default now()
);

create unique index if not exists knock_blocks_subject_uniq
    on knock_blocks (user_id, lower(subject));

commit;
