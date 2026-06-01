-- Migration: account-level friends graph, direct messages, and mute list.
--
-- Friends are keyed to accounts (users.id), not ephemeral session/socket ids, so
-- a friendship survives reconnects and realm changes. Presence + which realm a
-- friend is in is volatile and lives in Redis (see api/_lib/presence-store.js);
-- only the durable social graph and the message history live here.

begin;

-- A single row models the relationship in both directions. `requester_id` sent
-- the invite; `addressee_id` received it. While `status = 'pending'` only the
-- addressee may accept/decline. Once `accepted`, both sides see each other as a
-- friend regardless of which column they sit in. Declining or removing deletes
-- the row outright (no tombstone) so a fresh request can be sent later.
create table if not exists friendships (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references users(id) on delete cascade,
  addressee_id  uuid not null references users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  constraint friendships_no_self  check (requester_id <> addressee_id),
  constraint friendships_pair_uniq unique (requester_id, addressee_id)
);
-- "who wants to be my friend" (incoming) and "who have I asked" (outgoing) +
-- "list my friends" all key off one side of the pair plus status.
create index if not exists friendships_addressee_idx on friendships (addressee_id, status);
create index if not exists friendships_requester_idx on friendships (requester_id, status);

-- Direct messages between two accounts. Delivered live over the socket when the
-- recipient is online (see social-hub on the multiplayer server) and always
-- persisted here so an offline recipient reads them on next login. `read_at`
-- drives unread badges and is stamped when the recipient opens the thread.
create table if not exists direct_messages (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references users(id) on delete cascade,
  recipient_id  uuid not null references users(id) on delete cascade,
  body          text not null,
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);
-- A thread is every message between an unordered pair, newest first. Indexing on
-- the canonical (least, greatest) ordering lets either direction hit one index.
create index if not exists dm_pair_idx
  on direct_messages (least(sender_id, recipient_id), greatest(sender_id, recipient_id), created_at desc);
-- Unread badge: count messages addressed to me that I haven't opened yet.
create index if not exists dm_unread_idx
  on direct_messages (recipient_id, sender_id) where read_at is null;

-- Mute list (Task 14): if `muter_id` mutes `muted_id`, the muted account's
-- direct messages are suppressed for the muter — never delivered, never stored
-- on the muter's side, and never counted as unread. Mutually independent: a mute
-- by A does not stop A from messaging B.
create table if not exists user_mutes (
  muter_id   uuid not null references users(id) on delete cascade,
  muted_id   uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (muter_id, muted_id),
  constraint user_mutes_no_self check (muter_id <> muted_id)
);

commit;
