# Runtime feature flags

DB-backed switches that flip platform behavior **without a redeploy**. Use them
to arm or disarm crons and request-path features at runtime instead of editing a
Cloud Run env var and waiting for a new revision.

- **Table:** `app_flags` (`key`, `enabled`, `value` jsonb, `updated_by`, `updated_at`) — migration `api/_lib/migrations/20260630120000_app_flags.sql`.
- **Helper:** [api/_lib/flags.js](../../api/_lib/flags.js): `getFlag`, `isFlagEnabled`, `setFlag`, `listFlags`.
- **Flipping a flag:** SQL against `app_flags` (below), or `setFlag()` from a
  script running with `DATABASE_URL`. The former admin HTTP API and control
  room were removed with the admin panel.

## How it resolves

A flag read takes a `fallback` (normally the matching env var). When **no row
exists**, the flag reports the fallback, so adopting a flag changes nothing until
someone sets it. When a **row exists**, it is authoritative. Reads are cached
in-process for 30 s, so a toggle propagates fleet-wide within ~30 s; `setFlag()`
clears the local cache immediately. Every read is fail-soft: a DB error resolves
to the fallback, never an exception — a flags outage cannot take down a cron.

```js
import { isFlagEnabled } from '../_lib/flags.js';
// DB flag is the live control; env var is the fallback default.
const enabled = await isFlagEnabled('avaturn_seed', { fallback: env.AVATURN_SEED_ENABLED });
```

## Reading & flipping a flag

Flip directly in SQL (e.g. from the Neon console):

```sql
insert into app_flags (key, enabled) values ('avaturn_seed', true)
on conflict (key) do update set enabled = excluded.enabled, updated_at = now();
```

`POST` only accepts a `key` listed in `KNOWN_FLAGS`, so a typo can't strand a
dead row. Register a new flag by adding it there with its env fallback and a
one-line description.

## Flags

| key | env fallback | controls |
|---|---|---|
| `avaturn_seed` | `AVATURN_SEED_ENABLED` | The per-minute headless [avatar seed cron](../../api/cron/avaturn-seed-cron.js) — forges a fully-rigged avatar and publishes it public to the gallery. Off by default; arm it to start seeding. |
| `avaturn_seed_photo` | _(none)_ | Diverse-humans lane. When on **and** `AVATURN_API_KEY` is set, each tick draws a person from a gender/age/ethnicity/build matrix, generates their face ([avaturn-photo.js](../../api/_lib/avaturn-photo.js) → text→image), and reconstructs it with Avaturn v2 into a distinct rigged human — so the gallery fills with genuinely different people, not one base face reskinned. Falls back to the catalog lane on any failure. Requires `avaturn_seed` to also be on. |
