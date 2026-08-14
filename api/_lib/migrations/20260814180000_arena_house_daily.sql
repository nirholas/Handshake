-- The house arena: schema support for the always-on daily competition that
-- api/_lib/arena-house.js keeps running.
--
-- Two changes, both small, both load-bearing:
--
-- 1. A partial unique index over (network, starts_at) for rows carrying an
--    entry_rules.house marker. The daily is created by a cron that can run on
--    several instances at once, and "create today's arena if it does not exist"
--    is a check-then-insert with a real race window between the two halves.
--    Without this index a concurrent tick produces two boards for the same day,
--    splitting the entrants and making the attested result ambiguous. With it,
--    the loser of the race inserts nothing and reads the winner's row instead.
--    Partial on purpose: user-created tournaments are free to share a start
--    time with each other and with the house, and are untouched by the index.
--
-- 2. Retire the one hand-made row left on the live board. A tournament named
--    "test" with a "test" description, zero entrants and a window that closed
--    in June was the entire content of https://three.ws/arena. Cancelling it
--    keeps the row and its history (nothing is deleted) while taking it out of
--    the active phases. The guards are deliberately narrow, so this can never
--    catch a real competition: exact name, zero entrants, window already ended,
--    and not already in a terminal state.

create unique index if not exists tournaments_house_window_uniq
    on tournaments (network, starts_at)
    where (entry_rules->>'house') is not null;

update tournaments t
   set status = 'cancelled',
       updated_at = now()
 where t.name = 'test'
   and t.ends_at < now()
   and t.status not in ('cancelled', 'settled', 'closed')
   and not exists (select 1 from tournament_entries e where e.tournament_id = t.id);
