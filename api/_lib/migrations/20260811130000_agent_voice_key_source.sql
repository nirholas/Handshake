-- Which ElevenLabs credential owns an agent's bound voice.
--
-- A cloned voice_id only resolves against the account it was created on, so the
-- credential and the voice are inseparable: synthesizing an owner-cloned voice
-- with the platform key returns 404 from ElevenLabs. voice_key_source records
-- the lane so playback can pick the same credential the clone was made with.
--
--   'owner'    — the agent owner's own ElevenLabs key (users.provider_keys.elevenlabs).
--                The owner's ElevenLabs account is billed; no platform credits apply.
--   'platform' — the platform ELEVENLABS_API_KEY. Metered to $THREE credits.
--   NULL       — legacy rows written before this column existed; treated as 'platform'.
--
-- The voice columns themselves are re-declared idempotently here so a fresh
-- database gets them from the migration runner rather than from the manual
-- specs/schema/voice-cloning.sql apply.
alter table agent_identities add column if not exists voice_provider   text default 'browser';
alter table agent_identities add column if not exists voice_id         text;
alter table agent_identities add column if not exists voice_cloned_at  timestamptz;
alter table agent_identities add column if not exists voice_key_source text;
