-- Add avatar_url and profile_image_url to agent_identities.
-- Referenced by api/users/[username].js public profile endpoint.

alter table agent_identities
    add column if not exists avatar_url         text,
    add column if not exists profile_image_url  text;
