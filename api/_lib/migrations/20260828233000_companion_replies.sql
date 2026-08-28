begin;

-- Replying from the delivery.
--
-- The companion brings you a message; the natural next thing a person does is
-- answer it, and making them go find the app to do that is where the illusion
-- of a personal assistant breaks. `reply_to` carries whatever the lane needs to
-- route an answer back (for Telegram: the chat id and the message id it is a
-- reply to), stored per event because a source can span many chats.
--
-- Nullable on purpose: a calendar reminder and a phone-bridge notification have
-- nothing to reply to, and the UI reads exactly this column to decide whether to
-- offer the box at all.
alter table companion_events add column if not exists reply_to jsonb;

-- What the user actually sent back, so a delivery reads as a conversation
-- rather than a receipt: the feed shows the reply under the message.
alter table companion_events add column if not exists replied_at timestamptz;
alter table companion_events add column if not exists reply_text text;

commit;
