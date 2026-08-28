begin;

-- The avatar delivery channel: the corner companion walks on screen and says a
-- notification out loud (src/notification-herald.js, channel "avatar" in
-- api/_lib/notify-prefs.js). Its click-throughs belong in the same
-- sent/opened/returned funnel every other channel is measured by, so the check
-- constraint has to accept the new name.
alter table notification_events
    drop constraint if exists notification_events_channel_check;

alter table notification_events
    add constraint notification_events_channel_check
    check (channel in ('in_app', 'push', 'email', 'telegram', 'avatar'));

commit;
