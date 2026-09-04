-- Migration: the escrowed knock lane on knock_doors and knock_messages.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260904010000_knock_escrow.sql
-- Idempotent.
--
-- The two existing lanes both settle before the recipient has done anything:
-- the free lane charges nothing, and the x402 lane sends the sender's USDC
-- straight to the recipient's wallet the moment it clears. The knock_doors
-- comment says it plainly, "Nothing here holds funds", and for a door you were
-- introduced to that is right. For a stranger it is the whole risk: a door can
-- bank every knock and answer none, and there is no recourse, so at volume
-- paying a stranger stops being rational and the price signal dies with it.
--
-- The escrowed lane parks the payment in a vault owned by the knock's own PDA
-- on the knock_escrow program (contracts/knock-escrow). The recipient is paid
-- by answering inside the reply window; if they refuse, or the window lapses,
-- every unit goes back to the sender and anybody at all can crank that refund.
--
-- Nothing below holds funds either, and that is deliberate: three.ws never has
-- custody, never signs for either side, and cannot release an escrow. These
-- columns are a CACHE of what the chain already says, so the inbox can show a
-- countdown and rank by it without an RPC round trip per row. The chain stays
-- authoritative: api/_lib/knock/escrow.js re-reads the account before it
-- believes anything here.

begin;

alter table knock_doors
    -- Off by default. Turning it on changes what a stranger is agreeing to, so
    -- it is the owner's explicit choice, never a silent upgrade of a live door.
    add column if not exists escrow_enabled boolean not null default false,
    -- How long the owner has to answer before the sender can take the money
    -- back. Mirrors the program's 1-hour..30-day band; the program is the one
    -- that enforces it, this is what the door advertises.
    add column if not exists escrow_window_hours integer not null default 24;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'knock_doors_escrow_window_chk'
    ) then
        alter table knock_doors
            add constraint knock_doors_escrow_window_chk
            check (escrow_window_hours between 1 and 720);
    end if;
end $$;

alter table knock_messages
    -- The knock's PDA: the address of the on-chain record this message was paid
    -- through. Unique because one escrowed knock buys exactly one message, and
    -- a second row against the same PDA would mean a delivered message the
    -- sender never paid for.
    add column if not exists escrow_knock text,
    -- The deadline, copied from the chain so the inbox can sort by "answer this
    -- before the money goes back" without reading 30 accounts to render a page.
    add column if not exists escrow_expires_at timestamptz,
    -- Last known on-chain state: pending, answered, refunded, refused.
    add column if not exists escrow_state text;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'knock_messages_escrow_state_chk'
    ) then
        alter table knock_messages
            add constraint knock_messages_escrow_state_chk
            check (escrow_state is null
                   or escrow_state in ('pending', 'answered', 'refunded', 'refused'));
    end if;
end $$;

create unique index if not exists knock_messages_escrow_knock_key
    on knock_messages (escrow_knock)
    where escrow_knock is not null;

-- The inbox's escrow view: what is still owed an answer, soonest deadline first.
create index if not exists knock_messages_escrow_pending_idx
    on knock_messages (recipient_user_id, escrow_expires_at)
    where escrow_state = 'pending';

commit;
