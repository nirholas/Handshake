-- The @trythreews post archive: every X post the platform's own account has
-- published, with its engagement measured repeatedly over time.
--
-- This is NOT x_posts. That table is per-platform-user and only ever holds what
-- a user published THROUGH three.ws (api/x/post.js), keyed to users(id). The
-- account's own timeline is a different corpus: it predates the publishing
-- feature, most of it was posted by hand, and it is the only body of evidence
-- we have about what actually lands with the audience. Storing it here keeps
-- the two apart, so a marketing question never has to be answered by scanning
-- rows that belong to somebody else's agent.
--
-- Three tables because engagement is a time series, not a fact:
--
--   x_account_imports        one row per scrape file ingested, hashed so the
--                            same file cannot be counted twice
--   x_account_posts          one row per post, carrying its latest metrics
--   x_account_post_snapshots one row per post per import, so "this post was at
--                            40 likes on day one and 187 by day three" is a
--                            query rather than a guess
--
-- On view counts: X's web timeline renders views abbreviated ("6.3K"), so a
-- scraped view number is precise to two significant figures and nothing more.
-- The label is stored verbatim next to the parsed integer and views_exact
-- records which one it is, so an analysis can weigh an exact 236 differently
-- from a rounded 6.3K instead of silently treating 6300 as measured.
--
-- Draft: written by this change, NOT applied. Run `npm run db:status` to
-- confirm it reads as pending before `npm run db:migrate` applies it, and read
-- that status first: db:migrate applies EVERY pending migration, not just this
-- one.

create table if not exists x_account_imports (
	id             uuid primary key default gen_random_uuid(),
	handle         text        not null,          -- account handle, no leading @
	source_file    text        not null,          -- repo-relative path of the scrape
	source_sha256  text        not null,          -- content hash: the idempotency key
	scraped_at     timestamptz not null,          -- when the scrape ran, from the file
	tweet_count    integer     not null,
	inserted_count integer     not null default 0,
	updated_count  integer     not null default 0,
	imported_at    timestamptz not null default now()
);

-- Re-running the importer on a file already ingested is a no-op, not a second
-- set of snapshots at a bogus timestamp.
create unique index if not exists x_account_imports_source_uniq
	on x_account_imports (handle, source_sha256);

create table if not exists x_account_posts (
	tweet_id      text primary key,
	handle        text        not null,          -- the archived account
	-- Who actually wrote the post, read from its permalink. A profile scrape
	-- returns the whole timeline, so a repost of someone else's post arrives
	-- with THEIR handle and THEIR engagement. 145 of the first 359 @trythreews
	-- rows are exactly that, and the scraper's own isRetweet flag was false on
	-- every one of them. Analysis filters on author_handle = handle.
	author_handle text        not null,
	url           text        not null,
	text          text        not null,
	posted_at     timestamptz not null,

	is_retweet    boolean     not null default false,
	is_reply      boolean     not null default false,
	is_pinned     boolean     not null default false,
	has_image     boolean     not null default false,
	has_video     boolean     not null default false,
	has_card      boolean     not null default false,

	hashtags      text[]      not null default '{}',
	mentions      text[]      not null default '{}',
	urls          text[]      not null default '{}',

	-- Latest observed engagement. Nullable because a scrape can miss a counter
	-- (X hides view counts on some post types), and 0 is a real value that must
	-- not stand in for "not measured".
	likes         integer,
	retweets      integer,
	replies       integer,
	views         integer,
	views_label   text,
	views_exact   boolean     not null default false,

	measured_at   timestamptz,                    -- scrape time behind the metrics above
	first_seen_at timestamptz not null default now(),
	updated_at    timestamptz not null default now()
);

-- "Best posts" and "what did we ship that week" are the two queries this table
-- exists to answer, and both only ever look at posts the account wrote itself.
create index if not exists x_account_posts_handle_posted_idx
	on x_account_posts (handle, posted_at desc);

create index if not exists x_account_posts_own_likes_idx
	on x_account_posts (handle, likes desc nulls last)
	where author_handle = handle;

create table if not exists x_account_post_snapshots (
	id          bigserial   primary key,
	tweet_id    text        not null references x_account_posts(tweet_id) on delete cascade,
	import_id   uuid        not null references x_account_imports(id) on delete cascade,
	captured_at timestamptz not null,
	likes       integer,
	retweets    integer,
	replies     integer,
	views       integer,
	views_label text
);

-- One measurement per post per scrape instant. A re-import of the same file is
-- already blocked by the import hash; this stops two different files scraped in
-- the same second from double-counting a post.
create unique index if not exists x_account_post_snapshots_uniq
	on x_account_post_snapshots (tweet_id, captured_at);

create index if not exists x_account_post_snapshots_post_idx
	on x_account_post_snapshots (tweet_id, captured_at desc);
