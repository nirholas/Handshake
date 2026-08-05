-- Model detail page (/m/:id): per-model page views + signed-in comments.
--
-- view_count is a real impression counter for the model page (distinct from
-- views_requested/views_used, which are MULTIVIEW camera counts on the same
-- table). Incremented fail-soft by the page read; never trusted for money.
--
-- forge_comments is modeled on agent_reviews (uuid PK, FK-to-target CASCADE,
-- user FK, text body) but without the UNIQUE(target, user) constraint:
-- comments are many-per-user, reviews are one-per-user.

alter table forge_creations
	add column if not exists view_count integer not null default 0;

create table if not exists forge_comments (
	id uuid primary key,
	creation_id uuid not null references forge_creations(id) on delete cascade,
	user_id uuid not null references users(id) on delete cascade,
	body text not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index if not exists forge_comments_creation_idx
	on forge_comments (creation_id, created_at desc);
create index if not exists forge_comments_user_idx
	on forge_comments (user_id, created_at desc);
