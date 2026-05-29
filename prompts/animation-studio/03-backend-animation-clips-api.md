# Task 3 — Backend: animation_clips table + /api/animations CRUD

> Read `prompts/animation-studio/00-README.md` first (backend patterns, DB/auth/migration
> conventions, the `mocap_clips` precedent). Follow `CLAUDE.md`. No mocks, real DB, wire 100%.
>
> This task is **independent of the frontend** and can run in parallel with Tasks 1–2. Tasks 4, 5,
> and 6 depend on it.

You are adding the persistence layer for user-created animations: a table and a REST API to
create, list, read, update, and delete animation clips owned by a user, with public/private
visibility and fields ready for monetization (Task 6).

**Mirror the existing `mocap_clips` implementation closely** — it already solves auth, ownership,
slugs, visibility, soft-delete, and large-payload storage. Read it before writing:
- [api/mocap/clips.js](../../api/mocap/clips.js) (GET list + POST create)
- [api/mocap/[id].js](../../api/mocap/[id].js) (GET / PATCH / DELETE)
- [api/_lib/migrations/2026-05-24-mocap-clips.sql](../../api/_lib/migrations/2026-05-24-mocap-clips.sql)
- [api/_lib/db.js](../../api/_lib/db.js), [api/_lib/auth.js](../../api/_lib/auth.js),
  [api/_lib/schema.sql](../../api/_lib/schema.sql)

## What to build

### 1. Migration: `animation_clips`
Create `api/_lib/migrations/<today's date>-animation-clips.sql` (use the real current date,
`YYYY-MM-DD`). Mirror `mocap_clips` columns and indexes:

- `id uuid pk default gen_random_uuid()`
- `owner_id uuid not null references users(id) on delete cascade`
- `avatar_id uuid references avatars(id) on delete set null` (the rig the animation targets)
- `slug text not null`, `name text not null`, `description text`
- `kind text not null default 'animation' check (kind in ('animation','loop','sequence'))`
- `format text not null default 'three.ws.animation.v1'`
- `duration_ms int not null default 0`, `frame_count int not null default 0`
- `fps int`, `loop boolean not null default true`
- `clip jsonb` — the baked `AnimationClip.toJSON()` (see README clip format). For large clips,
  support `storage_key text` (R2) exactly like `mocap_clips.frames`/`storage_key` does.
- `thumbnail_key text`
- `tags text[] not null default '{}'`
- `visibility text not null default 'private' check (visibility in ('private','unlisted','public'))`
- `price_amount numeric(30,9)`, `price_currency text` (populated by Task 6; nullable here)
- `play_count bigint not null default 0`
- `created_at`, `updated_at`, `deleted_at timestamptz`
- `unique (owner_id, slug)`
- Indexes mirroring mocap: owner+created_at (where not deleted), visibility+created_at (where
  public, not deleted), kind+created_at, and a GIN index on `tags`.
- `updated_at` trigger using the shared `set_updated_at()` function (guard with the
  `EXCEPTION WHEN duplicate_object` block like other migrations).

Also add the table definition to [api/_lib/schema.sql](../../api/_lib/schema.sql) after
`mocap_clips`, so fresh deploys get it. Apply locally with `npm run db:migrate` and confirm via
`npm run db:status` (do **not** edit the file after it's applied — roll forward).

### 2. API: `api/animations/clips.js` (GET list, POST create)
- Use a `resolveAuth(req, scope)` helper identical in spirit to mocap's (`getSessionUser` →
  `authenticateBearer`). Use the avatars scopes already in use (`'avatars:read'` / `'avatars:write'`)
  unless a more specific scope already exists.
- **POST create:** validate with `zod` (mirror mocap's `createSchema`). Accept
  `{ name, slug?, description?, avatar_id?, tags?, visibility?, fps?, loop?, clip: { name, duration,
  tracks[] } }`. Validate the clip JSON shape (tracks have `name`, `times`, `values`, `type`).
  Enforce reasonable size limits; if the inline JSON exceeds the inline cap (mirror mocap's
  threshold), store to R2 and set `storage_key` instead of `clip`. Auto-generate a unique slug if
  absent. If `avatar_id` is provided, verify the avatar is owned by the caller (mirror mocap's
  ownership check). Insert with `sql`...`` tagged template; return the created row.
- **GET list:** mirror mocap's dynamic-WHERE logic — unauthenticated → only `visibility='public'`;
  authenticated → own clips, plus public when `include_public=true`. Support `limit`, `cursor`
  (created_at DESC), `visibility`, and a `tag` filter. Never return soft-deleted rows.

### 3. API: `api/animations/[id].js` (GET, PATCH, DELETE)
- **GET:** return a single clip by id. Private clips → 404 for non-owners; public/unlisted →
  visible. Optionally increment `play_count` on a query flag (mirror any mocap behavior). Resolve
  `clip` from R2 when `storage_key` is set (presigned or inlined per mocap's read path).
- **PATCH:** owner-only; update `name`, `description`, `tags`, `visibility`, `avatar_id` (re-check
  ownership), `loop`. Do not allow changing `owner_id`.
- **DELETE:** owner-only **soft delete** (`deleted_at = now()`), mirroring mocap.

### 4. Errors, validation, security
- Handle all error boundaries: unauthenticated (401), not-owner/not-found (404), validation (400),
  oversized payload (413/400). Use the same error helper/shape the mocap endpoints use.
- No SQL injection (tagged templates only). No leaking other users' private clips. Rate/size limits
  consistent with mocap.

## Definition of done
- `npm run db:migrate` applies cleanly; `npm run db:status` shows it applied; schema.sql updated.
- POST creates a clip (verify with a real authenticated request — e.g. via the dev server and a
  signed-in session, or a documented `curl` using a session cookie/API key). GET lists own +
  public correctly; private clips are invisible to others. PATCH and soft-DELETE work and respect
  ownership. Verify each with real requests and paste the responses in your summary.
- Avatar-ownership check rejects linking an avatar the caller doesn't own.
- Add contract tests mirroring any existing API test pattern under `tests/` if present.
- `npm test` green. Run `completionist` on changed files; fix all findings.
- Handoff note: the exact request/response shapes for create + list + get, so Task 4 (save UI),
  Task 5 (playback), and Task 6 (monetization) can integrate without guessing.

Do not build UI here. Do not wire payments here (Task 6 adds pricing on top of these rows).
Do not push unless the user explicitly approves (then both remotes per CLAUDE.md).
