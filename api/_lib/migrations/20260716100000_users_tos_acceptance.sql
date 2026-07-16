-- Terms of Service clickwrap state. Stamped at account creation (the register
-- form and wallet/Privy sign-in surfaces send tosAccepted with every auth
-- call) and re-stamped on later sign-ins when the accepted version is newer.
-- The append-only evidentiary record lives in audit_log (action 'tos-accept');
-- these columns are the cheap-to-query current state per user.
alter table users add column if not exists tos_accepted_version int;
alter table users add column if not exists tos_accepted_at timestamptz;
