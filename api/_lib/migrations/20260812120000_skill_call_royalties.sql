-- Per-call skill royalties on the platform x402 rail (Roadmap phase 3).
--
-- Until now royalty_ledger only served in-process skill invocations billed
-- through api/_lib/royalty.js, so every column assumed a registered agent
-- caller (agent_id NOT NULL) and a later EIP-7710 redeem (status pending →
-- settled by the settle-royalties cron). The /api/x402/skill-call rail is
-- different: the caller is an anonymous paying wallet, and the USDC already
-- routed to the author at settle time. This migration widens the ledger so
-- both lanes coexist:
--
--   * agent_id becomes nullable (x402 callers have no agent_identities row).
--   * network / payer / source / platform_fee_usd record settlement
--     provenance: which rail charged whom, and the platform's cut in USD.
--   * The status CHECK gains no new values: x402 rows land 'settled'
--     directly (money already moved), runtime rows keep pending → settling →
--     settled.
--
-- Apply: node scripts/apply-migrations.mjs --apply --file 20260812120000_skill_call_royalties.sql
-- Idempotent.

begin;

alter table royalty_ledger
    alter column agent_id drop not null;

alter table royalty_ledger
    add column if not exists network          text,
    add column if not exists payer            text,
    add column if not exists source           text not null default 'skill-runtime',
    add column if not exists platform_fee_usd numeric(10,6);

commit;
