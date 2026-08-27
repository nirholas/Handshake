-- seeker_genesis_verifications: which linked wallets hold a Seeker Genesis Token.
--
-- A Solana Seeker phone mints one soulbound Token-2022 token into its owner's
-- wallet. A user who holds it in a wallet linked to their account is a verified
-- Seeker owner, and the product shows a "Seeker verified" badge for them.
-- Checking that live on every render would cost a Helius call per page, so
-- /api/seeker/verify scans once and records the result here; /api/seeker/status
-- and the badge read this table. A re-verify that no longer finds the token
-- deletes the row, so the badge tracks the wallet rather than a stale claim.
--
-- One row per (user, wallet). token_mint is the device-specific SGT mint that
-- satisfied the check, kept so the same phone can be recognised across users.
--
-- Idempotent.

begin;

create table if not exists seeker_genesis_verifications (
    user_id         uuid not null references users(id) on delete cascade,
    wallet_address  text not null,
    token_mint      text not null,
    verified_at     timestamptz not null default now(),
    last_checked_at timestamptz not null default now(),
    primary key (user_id, wallet_address)
);

create index if not exists seeker_genesis_verifications_wallet
    on seeker_genesis_verifications(wallet_address);

commit;
