-- three.ws Premium — monthly developer pass, paid on Solana in $THREE / SOL / USDC.
--
-- premium_quotes:  short-lived (10 min) price locks. A quote freezes the USD plan
--                  price into an exact atomic amount for the chosen asset at the
--                  oracle price of that moment, so verification compares the
--                  landed transaction against the locked number — never a
--                  re-fetched price.
-- premium_passes:  the purchase ledger AND the entitlement source of truth. One
--                  row per successful purchase; the wallet's current pass is the
--                  row with the latest expires_at. Renewals append a row whose
--                  period starts at the previous expiry (no lost days).
--
-- Apply with: node scripts/apply-migrations.mjs --apply --file 2026-07-11-premium-passes.sql

create table if not exists premium_quotes (
	id             uuid primary key default gen_random_uuid(),
	wallet         text not null,
	plan           text not null default 'premium',
	asset          text not null check (asset in ('THREE', 'SOL', 'USDC')),
	amount_atomics bigint not null check (amount_atomics > 0),
	usd_price      numeric(12, 4) not null,
	asset_usd      numeric(20, 10),          -- oracle price used (null for USDC parity)
	price_source   text,                     -- which oracle produced asset_usd
	status         text not null default 'pending' check (status in ('pending', 'used', 'expired')),
	tx_signature   text,                     -- set when the quote is consumed
	user_id        uuid,                     -- session user at quote time, when present
	created_at     timestamptz not null default now(),
	expires_at     timestamptz not null
);

create index if not exists premium_quotes_wallet_idx
	on premium_quotes (wallet, created_at desc);

create table if not exists premium_passes (
	id                  uuid primary key default gen_random_uuid(),
	wallet              text not null,
	user_id             uuid,                -- session user at purchase time, when present
	plan                text not null default 'premium',
	asset               text not null check (asset in ('THREE', 'SOL', 'USDC')),
	amount_atomics      bigint not null,
	usd_price           numeric(12, 4) not null,
	tx_signature        text not null unique,
	network             text not null default 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	api_subscription_id text,                -- linked x402_subscriptions key id
	started_at          timestamptz not null default now(),
	expires_at          timestamptz not null,
	created_at          timestamptz not null default now(),
	meta                jsonb not null default '{}'::jsonb
);

create index if not exists premium_passes_wallet_idx
	on premium_passes (wallet, expires_at desc);
create index if not exists premium_passes_user_idx
	on premium_passes (user_id, expires_at desc);
