begin;

-- Agent Genome stud-fee integrity.
--
-- 1. `stud_fee_signature` had no uniqueness constraint, so api/genome/breed.js
--    could only guard replay with a read-then-write SELECT. Two breedings
--    submitted concurrently with the SAME settlement signature both passed that
--    check and both were recorded: one $THREE payment bought two children from a
--    paid stud. A unique index makes the guard atomic in the database, which is
--    the only place it can be atomic.
-- 2. `stud_fee_lamports` is misnamed for this feature: the fee settles in $THREE
--    (an SPL token), never in lamports, and breed.js consequently recorded a flat
--    0 for every paid breeding. `stud_fee_atomics` records the amount the
--    on-chain verification actually observed landing in the stud owner's wallet,
--    in the token's smallest unit, so a paid pairing has a truthful ledger row.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.

alter table genome_breedings
    add column if not exists stud_fee_atomics bigint not null default 0;

create unique index if not exists genome_breedings_stud_fee_signature
    on genome_breedings (stud_fee_signature)
    where stud_fee_signature is not null;

commit;
