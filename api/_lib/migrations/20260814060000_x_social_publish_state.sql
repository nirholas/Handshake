-- Reconcile x_scheduled_posts and x_pending_reviews with the columns the app
-- actually reads and writes.
--
-- Two generations of these tables exist in the tree. The original pair
-- (2026-05-13-x-scheduled-posts.sql, 2026-05-13-x-pro-features.sql) matches the
-- code: /api/cron/run-x-scheduled-posts and /api/x/schedule read posted_at,
-- tweet_id, error and attempts, and /api/x/reviews reads status, resolved_at and
-- thread_parts. The later marketplace rollforward
-- (2026-05-25-marketplace-and-social-tables.sql,
-- 2026-05-25-marketplace-social-rollforward.sql) and api/_lib/schema.sql declare a
-- DIFFERENT pair (published_at; reviewed_at/approved), and every one of those
-- statements is CREATE TABLE IF NOT EXISTS, so whichever file a given database ran
-- first silently decides its shape. A database provisioned from schema.sql gets
-- the second shape, and then the publisher cron fails on every tick with
-- `column "attempts" does not exist` while /api/x/schedule 500s on GET and POST.
--
-- This makes the shape deterministic from either starting point. Every statement
-- is a no-op on a database that already carries the first shape.

alter table x_scheduled_posts add column if not exists posted_at         timestamptz;
alter table x_scheduled_posts add column if not exists tweet_id          text;
alter table x_scheduled_posts add column if not exists error             text;
alter table x_scheduled_posts add column if not exists attempts          int not null default 0;
alter table x_scheduled_posts add column if not exists thread_parts      jsonb;
alter table x_scheduled_posts add column if not exists reply_to_tweet_id text;

-- Rows a schema.sql-shaped database already published were only ever marked in
-- published_at. Carry them over, or the cron would treat every one of them as
-- still due and re-post it.
do $$
begin
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'x_scheduled_posts'
		  and column_name = 'published_at'
	) then
		update x_scheduled_posts
		set posted_at = published_at
		where posted_at is null and published_at is not null;
	end if;
end
$$;

create index if not exists x_scheduled_due_idx
	on x_scheduled_posts (scheduled_at)
	where posted_at is null and error is null;

alter table x_pending_reviews add column if not exists thread_parts jsonb;
alter table x_pending_reviews add column if not exists resolved_at  timestamptz;
alter table x_pending_reviews add column if not exists status       text not null default 'pending';

-- The original table constrained status inline, which Postgres auto-named
-- x_pending_reviews_status_check. Add it only where it is missing, so this does
-- not fail on a database that already has it.
do $$
begin
	if not exists (
		select 1 from pg_constraint where conname = 'x_pending_reviews_status_check'
	) then
		alter table x_pending_reviews
			add constraint x_pending_reviews_status_check
			check (status in ('pending', 'approved', 'rejected'));
	end if;
end
$$;

-- Same carry-over for the review queue: a schema.sql-shaped database recorded the
-- decision in approved/reviewed_at, which /api/x/reviews cannot see, so an already
-- resolved draft would sit in the pending list forever.
do $$
begin
	if exists (
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'x_pending_reviews'
		  and column_name = 'approved'
	) then
		update x_pending_reviews
		set status      = case when approved then 'approved' else 'rejected' end,
		    resolved_at = coalesce(resolved_at, reviewed_at)
		where approved is not null and status = 'pending';
	end if;
end
$$;

create index if not exists x_pending_reviews_user_pending_idx
	on x_pending_reviews (user_id, created_at desc)
	where status = 'pending';
